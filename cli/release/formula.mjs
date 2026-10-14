#!/usr/bin/env node
/**
 * Writes the Homebrew formula for a published release (#31), from its signed manifest:
 *
 *   node release/formula.mjs [--base-url https://yaaa.io] [--version 0.1.11] [--tap dir]
 *   node release/formula.mjs --dir ../dist/release            (a local build, before it's published)
 *
 * The manifest's signature has to verify with a key pinned in packages/cli/src/release-keys.ts, and the sha256s come
 * from it, never from a download's own .sha256 file. Without --tap it prints the formula; with --tap it writes
 * Formula/yaaa.rb, and the tap's README and CI workflow from release/homebrew/, into that checkout of yaaa-io/homebrew-tap.
 * The formula downloads the installer's tarballs from <base>/releases/<v>/, so Homebrew users get the same files.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PLATFORMS } from './platforms.mjs';
import { pinnedKeys, verifyBytes } from './signing.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'https://yaaa.io' },
    version: { type: 'string' },
    dir: { type: 'string' },
    tap: { type: 'string' },
  },
});
const base = args['base-url'].replace(/\/$/, '');
if (!/^https:\/\/[^\s"'`$\\#{}]+$/.test(base)) throw new Error(`--base-url must be a plain https URL: ${base}`);

/** A file of the release, from the local build (--dir) or from <base>. */
async function read(path) {
  if (args.dir) return readFileSync(join(resolve(args.dir), path));
  const r = await fetch(`${base}/${path}`, { redirect: 'error' });
  if (!r.ok) throw new Error(`${base}/${path} answered HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const version = (args.version ?? (await read('releases/latest')).toString('utf8')).trim().replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error(`not a version: ${version}`);
const body = await read(`releases/${version}/manifest.json`);
const sig = (await read(`releases/${version}/manifest.json.sig`)).toString('utf8');
const keys = await pinnedKeys();
if (keys.placeholder || keys.real.length === 0) throw new Error('packages/cli/src/release-keys.ts still has the placeholder key');
if (!verifyBytes(body, sig, keys.real)) throw new Error(`releases/${version}/manifest.json isn't signed by a pinned release key`);
const manifest = JSON.parse(body.toString('utf8'));
if (manifest.name !== 'yaaa' || manifest.version !== version) throw new Error(`the manifest is for ${manifest.name} ${manifest.version}, not yaaa ${version}`);

const asset = (platform) => {
  const file = `yaaa-${version}-${platform}.tar.gz`;
  const sha = manifest.files[file]?.sha256;
  if (!/^[0-9a-f]{64}$/.test(sha ?? '')) throw new Error(`the manifest has no sha256 for ${file}`);
  return `      url "${base}/releases/${version}/${file}"\n      sha256 "${sha}"`;
};
for (const p of PLATFORMS) asset(p);

const formula = `# Written by cli/release/formula.mjs in yaaa-io/yaaa from yaaa ${version}'s signed manifest. Don't edit it by hand:
# the next release replaces it.
class Yaaa < Formula
  desc "Shopping agent for your terminal and the AI agents in it"
  homepage "https://yaaa.io"
  version "${version}"
  license "Apache-2.0"

  # The installer's tarballs: yaaa with the Node.js it runs on, so nothing else is needed.
  on_macos do
    on_arm do
${asset('darwin-arm64')}
    end
    on_intel do
${asset('darwin-x64')}
    end
  end

  on_linux do
    on_arm do
${asset('linux-arm64')}
    end
    on_intel do
${asset('linux-x64')}
    end
  end

  def install
    libexec.install Dir["*"]
    # YAAA_INSTALLED_BY: yaaa update says to run brew upgrade. YAAA_LAUNCHER: desktop notifications run this path,
    # which survives upgrades.
    (bin/"yaaa").write_env_script libexec/"bin/yaaa",
      YAAA_INSTALLED_BY: "homebrew",
      YAAA_LAUNCHER:     opt_bin/"yaaa"
  end

  def caveats
    <<~EOS
      Set up your account (no sign-up) and the skills for your AI agents:
        yaaa init
    EOS
  end

  test do
    ENV["YAAA_HOME"] = (testpath/".yaaa").to_s
    ENV["YAAA_NO_UPDATE_CHECK"] = "1"
    assert_equal version.to_s, shell_output("#{bin}/yaaa --version").strip
  end
end
`;

if (!args.tap) {
  process.stdout.write(formula);
} else {
  const tap = resolve(args.tap);
  mkdirSync(join(tap, 'Formula'), { recursive: true });
  mkdirSync(join(tap, '.github/workflows'), { recursive: true });
  writeFileSync(join(tap, 'Formula/yaaa.rb'), formula);
  cpSync(join(here, 'homebrew/README.md'), join(tap, 'README.md'));
  cpSync(join(here, 'homebrew/tests.yml'), join(tap, '.github/workflows/tests.yml'));
  console.log(`formula: wrote yaaa ${version} into ${tap}`);
}
