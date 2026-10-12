#!/bin/sh
# Installs yaaa: curl -fsSL https://yaaa.io/install | sh
#
# yaaa comes with its own Node runtime, so it works whether or not Node is installed, and never touches yours.
# Everything goes into ~/.yaaa, plus a `yaaa` command in ~/.local/bin.
#
# Settings (environment variables):
#   YAAA_VERSION=0.1.0        install that version instead of the latest
#   YAAA_INSTALL_DIR=<dir>    where yaaa lives (default ~/.yaaa)
#   YAAA_BIN_DIR=<dir>        where the `yaaa` command goes (default ~/.local/bin)
#   YAAA_NO_MODIFY_PATH=1     don't add the command's folder to your shell's PATH
#
# Uninstall: rm -rf ~/.yaaa ~/.local/bin/yaaa (your account settings stay in ~/.config/yaaa).
#
# Each release is signed: before installing, this script checks the version's manifest.json against the release keys
# written in below, and the tarball against the sha256 in that manifest. This script is itself what you trust on a first
# install (it carries the keys), so fetch it over https from yaaa.io; `yaaa update` checks the same signature itself.
#
# Everything is inside main(), which runs on the last line, so a download cut off halfway runs nothing.

set -eu

BASE_URL="__YAAA_BASE_URL__"
# The public keys yaaa releases are signed with (base64 Ed25519, from cli/packages/cli/src/release-keys.ts).
RELEASE_KEYS="__YAAA_RELEASE_KEYS__"
# The sha256 of the Node binary inside each platform's tarball (cli/release/node.json). That Node checks the
# release's signature, so it's checked first.
NODE_SHA256="__YAAA_NODE_SHA256__"

say() { printf '%s\n' "$*"; }
err() { printf 'yaaa install: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

# https only, redirects included (plain http only when the release itself is on http, which is a local test build).
case "$BASE_URL" in https://*) secure=1 ;; *) secure=0 ;; esac

fetch() { # fetch <url> <file>
  if has curl; then
    if [ "$secure" = 1 ]; then curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1" || err "couldn't download $1"
    else curl -fsSL --retry 3 -o "$2" "$1" || err "couldn't download $1"; fi
  elif has wget; then
    if [ "$secure" = 1 ]; then wget -q --https-only -O "$2" "$1" || err "couldn't download $1"
    else wget -q -O "$2" "$1" || err "couldn't download $1"; fi
  else err "needs curl or wget"; fi
}

# Checks the release before anything in it is trusted: run by a Node that's known (below) with
#   <manifest.json> <manifest.json.sig> <version> <tarball name> <tarball file> <key>...
# it exits non-zero unless one of the keys signed the manifest, the manifest is for that version, and the tarball
# matches the sha256 the manifest gives it.
VERIFY_JS='
const c = require("crypto"), f = require("fs");
const [manifest, sig, version, name, file, ...keys] = process.argv.slice(1);
const fail = (s) => { console.error("yaaa install: " + s); process.exit(1); };
const body = f.readFileSync(manifest);
const s = Buffer.from(f.readFileSync(sig, "utf8").trim(), "base64");
const signed = keys.some((k) => {
  try { return c.verify(null, body, c.createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" }), s); }
  catch (e) { return false; }
});
if (!signed) fail("the release is not signed by the yaaa release key; nothing was installed");
const m = JSON.parse(body);
if (m.name !== "yaaa" || m.version !== version) fail("the signed manifest is for " + m.version + ", not " + version);
const want = m.files && Object.prototype.hasOwnProperty.call(m.files, name) ? m.files[name].sha256 : "";
if (!want) fail("yaaa " + version + " has no " + name);
const got = c.createHash("sha256").update(f.readFileSync(file)).digest("hex");
if (got !== want) fail("the download does not match the signed manifest; try again");
'

sha256() {
  if has sha256sum; then sha256sum "$1" | cut -d' ' -f1
  elif has shasum; then shasum -a 256 "$1" | cut -d' ' -f1
  else err "needs sha256sum or shasum to check the download"; fi
}

platform() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin) os=darwin
      # A shell running under Rosetta reports x86_64 on Apple silicon; install the native build.
      if [ "$arch" = x86_64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi ;;
    Linux) os=linux
      if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then
        err "Alpine and other musl-based Linux aren't supported yet (yaaa's Node runtime needs glibc)"
      fi ;;
    # Git Bash, MSYS2 and Cygwin on Windows. yaaa runs on Windows inside WSL, which is Linux.
    MINGW* | MSYS* | CYGWIN*)
      err "on Windows, install yaaa inside WSL: run \`wsl --install\` in PowerShell, open Ubuntu, and run this command there (https://yaaa.io/docs/#windows)" ;;
    *) err "$os isn't supported yet: yaaa installs on macOS, Linux, and Windows with WSL" ;;
  esac
  case "$arch" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) err "$arch processors aren't supported yet" ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

# Adds `export PATH=...` for the bin folder to the user's shell startup file, once.
add_to_path() {
  dir=$1
  case ":$PATH:" in *":$dir:"*) return 0 ;; esac
  if [ "${YAAA_NO_MODIFY_PATH:-}" = 1 ]; then
    say "Add $dir to your PATH to run yaaa."
    return 0
  fi
  case "$(basename "${SHELL:-sh}")" in
    zsh) rc="${ZDOTDIR:-$HOME}/.zshrc"; line="export PATH=\"$dir:\$PATH\"" ;;
    bash) if [ "$(uname -s)" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi
      line="export PATH=\"$dir:\$PATH\"" ;;
    fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path \"$dir\"" ;;
    *) rc="$HOME/.profile"; line="export PATH=\"$dir:\$PATH\"" ;;
  esac
  if [ -f "$rc" ] && grep -qF "$dir" "$rc"; then return 0; fi
  mkdir -p "$(dirname "$rc")"
  printf '\n# yaaa\n%s\n' "$line" >>"$rc"
  say "Added $dir to your PATH in $rc. Open a new terminal, or run: $line"
}

main() {
  target=$(platform)
  install_dir="${YAAA_INSTALL_DIR:-$HOME/.yaaa}"
  bin_dir="${YAAA_BIN_DIR:-$HOME/.local/bin}"

  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t yaaa)
  trap 'rm -rf "$tmp"' EXIT INT TERM

  version="${YAAA_VERSION:-}"
  if [ -z "$version" ]; then
    fetch "$BASE_URL/releases/latest" "$tmp/latest"
    version=$(tr -d ' \r\n' <"$tmp/latest")
  fi
  case "$version" in "" | *[!0-9A-Za-z.+-]*) err "the latest version from $BASE_URL looks wrong: '$version'" ;; esac

  name="yaaa-$version-$target"
  say "Installing yaaa $version ($target)…"
  fetch "$BASE_URL/releases/$version/manifest.json" "$tmp/manifest.json"
  fetch "$BASE_URL/releases/$version/manifest.json.sig" "$tmp/manifest.json.sig"
  fetch "$BASE_URL/releases/$version/$name.tar.gz" "$tmp/$name.tar.gz"

  # The Node to check the signature with: the one in the tarball, once it matches the hash pinned above (only that one
  # file is unpacked for this); otherwise, for a version that ships another Node, the Node on your PATH.
  mkdir "$tmp/check"
  node_bin=""
  want_node=$(printf '%s\n' $NODE_SHA256 | sed -n "s/^$target=//p")
  if tar -xzf "$tmp/$name.tar.gz" -C "$tmp/check" "$name/bin/node" 2>/dev/null &&
    [ -n "$want_node" ] && [ "$(sha256 "$tmp/check/$name/bin/node")" = "$want_node" ]; then
    node_bin="$tmp/check/$name/bin/node"
  elif has node; then
    node_bin=node
  else
    err "can't check yaaa $version's signature: it ships a Node this script doesn't know, and there's no node on your PATH. Install the latest version instead."
  fi
  # shellcheck disable=SC2086 # one argument per key
  "$node_bin" -e "$VERIFY_JS" "$tmp/manifest.json" "$tmp/manifest.json.sig" "$version" "$name.tar.gz" "$tmp/$name.tar.gz" $RELEASE_KEYS ||
    exit 1
  rm -rf "$tmp/check"

  mkdir -p "$install_dir/versions" "$bin_dir"
  tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
  rm -rf "$install_dir/versions/$version"
  mv "$tmp/$name" "$install_dir/versions/$version"
  touch "$install_dir/versions/$version" # newest first when old versions are cleaned up below
  # `current` switches in one step, so a yaaa that's running keeps working until it exits. A plain mv would follow
  # the old link into its folder, so rename the link itself: -T on GNU, -h on macOS and BSD.
  ln -sfn "versions/$version" "$install_dir/current.tmp"
  if mv -T "$install_dir/current.tmp" "$install_dir/current" 2>/dev/null; then :
  elif mv -h "$install_dir/current.tmp" "$install_dir/current" 2>/dev/null; then :
  else rm -f "$install_dir/current.tmp"; ln -sfn "versions/$version" "$install_dir/current"; fi
  [ "$(readlink "$install_dir/current")" = "versions/$version" ] || err "couldn't switch to $version in $install_dir"

  # The command: a small launcher with fixed paths, so it survives upgrades (and `yaaa notify install` can use it).
  cat >"$bin_dir/yaaa" <<EOF
#!/bin/sh
# yaaa launcher, written by the yaaa installer. yaaa runs on its own Node in $install_dir/current.
# YAAA_LAUNCHER, YAAA_INSTALL_DIR and YAAA_INSTALL_URL tell yaaa how it was installed, for yaaa update.
YAAA_LAUNCHER="$bin_dir/yaaa" YAAA_INSTALL_DIR="$install_dir" YAAA_INSTALL_URL="$BASE_URL" \\
  exec "$install_dir/current/bin/node" "$install_dir/current/app/dist/yaaa.mjs" "\$@"
EOF
  chmod +x "$bin_dir/yaaa"

  # Keep this version and the one before it; remove older ones.
  for old in $(ls -1t "$install_dir/versions" | tail -n +3); do rm -rf "$install_dir/versions/$old"; done

  installed=$("$bin_dir/yaaa" --version 2>/dev/null) || err "yaaa was installed but didn't start; please report this"
  [ "$installed" = "$version" ] || err "installed $version, but yaaa reports $installed; please report this"
  say "✓ Installed yaaa $installed in $install_dir"
  [ "${YAAA_FROM_UPDATE:-}" = 1 ] || add_to_path "$bin_dir"
  # `yaaa update` in versions before signed releases runs this script too; it says what happened itself. (Newer
  # versions install in Node and don't run it.)
  [ "${YAAA_FROM_UPDATE:-}" = 1 ] && return 0
  say ""
  say "Next: run \`yaaa init\` to set up your account and install the skills for your AI agents."
}

main "$@"
