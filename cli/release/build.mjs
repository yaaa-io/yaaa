#!/usr/bin/env node
/**
 * Builds what `curl -fsSL <base>/install | sh` downloads, into one folder (default ../dist/release):
 *
 *   install                                  the install script, with <base>, the release keys and Node's hashes in it
 *   releases/latest                          the version `install` picks by default
 *   releases/<v>/yaaa-<v>-<platform>.tar.gz  Node + the bundled CLI, per platform
 *   releases/<v>/yaaa-<v>-<platform>.tar.gz.sha256
 *   releases/<v>/manifest.json               every tarball's (and install's) sha256
 *   releases/<v>/manifest.json.sig           the manifest's Ed25519 signature, base64
 *
 * Serve the folder at <base>: a bucket behind yaaa.io in production, or any static file server locally.
 *
 *   YAAA_RELEASE_SIGNING_KEY=<key.pem> node release/build.mjs --base-url https://yaaa.io [--platforms …|host] [--out dir]
 *   node release/build.mjs --dev-key --base-url http://localhost:7090 --platforms host
 *
 * A release for publishing is signed with the key in YAAA_RELEASE_SIGNING_KEY (a file path), whose public key has to
 * be pinned in packages/cli/src/release-keys.ts. --dev-key signs with a local key in ../.dev/release-dev-key.pem
 * instead (made on first use), trusts it as well, and allows plain http: for trying the installer on this machine or in
 * the sandbox, never for publishing (release/verify.mjs refuses it).
 *
 * Run `pnpm build` first. Node downloads are checked against the hashes pinned in release/node.json (written by
 * release/node-hashes.mjs) and cached in ../.dev/cache.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { PLATFORMS } from './platforms.mjs';
import { pinnedKeys, publicKeyOf, readPrivateKey, sha256, signBytes, verifyBytes, writeNewKey } from './signing.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..');
const pkgDir = join(cliRoot, 'packages/cli');
const repo = resolve(cliRoot, '..');

/** The Node runtime yaaa ships (the current LTS), with its pinned hashes. */
const node = JSON.parse(readFileSync(join(here, 'node.json'), 'utf8'));
const NODE_VERSION = node.version;

const { values: args } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'https://yaaa.io' },
    platforms: { type: 'string', default: PLATFORMS.join(',') },
    out: { type: 'string', default: join(repo, 'dist/release') },
    'dev-key': { type: 'boolean', default: false },
  },
});
const dev = args['dev-key'];
const base = args['base-url'].replace(/\/$/, '');
if (!/^https?:\/\/[^\s"'`$\\]+$/.test(base)) throw new Error(`--base-url must be a plain http(s) URL: ${base}`);
// https, except to this machine; a --dev-key build may use http anywhere (the sandbox reaches the host by name).
const loopback = /^http:\/\/(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?(\/|$)/i.test(base);
if (base.startsWith('http:') && !loopback && !dev) throw new Error(`--base-url must be https (or http://localhost): ${base}`);
// `host` is this machine's platform, for a quick local build.
const host = `${process.platform}-${process.arch}`;
const platforms = args.platforms.split(',').map((p) => (p.trim() === 'host' ? host : p.trim()));
for (const p of platforms) if (!PLATFORMS.includes(p)) throw new Error(`unknown platform ${p}; use ${PLATFORMS.join(', ')}`);
const out = resolve(args.out);

const cliPkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const version = cliPkg.version;
// The CLI reports VERSION (@yaaa/client); `yaaa update` compares it with releases/latest, so the two must agree.
const reported = readFileSync(join(cliRoot, 'packages/client/src/connect.ts'), 'utf8').match(/export const VERSION = '([^']+)'/)?.[1];
if (reported !== version)
  throw new Error(`packages/cli/package.json is ${version} but VERSION in packages/client/src/connect.ts is ${reported}; make them match`);
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
const log = (s) => console.log(`release: ${s}`);

if (!existsSync(join(pkgDir, 'dist/main.js'))) throw new Error('build the CLI first: pnpm build');

// 0. The signing key, before anything is built, and the keys the CLI and the installer will trust.
const pinned = await pinnedKeys();
let signingKey;
let trusted;
if (dev) {
  const devKey = join(repo, '.dev/release-dev-key.pem');
  if (!existsSync(devKey)) {
    writeNewKey(devKey);
    log(`made a local signing key in ${devKey} (for --dev-key builds on this machine only)`);
  }
  signingKey = readPrivateKey(devKey);
  trusted = [...pinned.real, publicKeyOf(signingKey)];
  log('signing with the local dev key: for this machine and the sandbox, never for publishing');
} else {
  if (pinned.placeholder || pinned.real.length === 0)
    throw new Error(
      'packages/cli/src/release-keys.ts still has the placeholder key: make a key with release/keygen.mjs and pin it, or build with --dev-key for a local try',
    );
  const keyFile = process.env.YAAA_RELEASE_SIGNING_KEY;
  if (!keyFile) throw new Error('set YAAA_RELEASE_SIGNING_KEY to the release signing key file, or build with --dev-key for a local try');
  signingKey = readPrivateKey(keyFile);
  if (!pinned.real.includes(publicKeyOf(signingKey)))
    throw new Error("YAAA_RELEASE_SIGNING_KEY's public key isn't pinned in packages/cli/src/release-keys.ts");
  trusted = pinned.real;
}

const work = join(repo, '.dev/release-work');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// 1. The app, the same on every platform: one bundled file, plus what has to stay on disk.
const app = join(work, 'app');
log(`bundling yaaa ${version}`);
await build({
  entryPoints: [join(pkgDir, 'dist/main.js')],
  outfile: join(app, 'dist/yaaa.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  keepNames: true,
  legalComments: 'external',
  // node-notifier runs helper apps that ship inside its package (terminal-notifier on macOS), so it stays a real
  // package next to the bundle.
  external: ['node-notifier'],
  // Some dependencies are CommonJS and call require(); give the ES module bundle one.
  banner: { js: "import { createRequire as __yaaaRequire } from 'node:module'; const require = __yaaaRequire(import.meta.url);" },
  // The keys `yaaa update` trusts, and whether it may download over http (only a --dev-key build); see src/release.ts.
  define: { __YAAA_RELEASE_KEYS__: JSON.stringify(trusted), __YAAA_ALLOW_HTTP__: JSON.stringify(dev) },
  logLevel: 'warning',
});
cpSync(join(pkgDir, 'skills'), join(app, 'skills'), { recursive: true });
cpSync(join(pkgDir, 'assets'), join(app, 'assets'), { recursive: true });
// node-notifier at the exact versions in release/bundle/package-lock.json, so every release build installs the same
// files.
const bundleDir = join(here, 'bundle');
const notifierVersion = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')).dependencies['node-notifier'];
const wantMajor = cliPkg.dependencies['node-notifier'].replace(/^[\^~]/, '').split('.')[0];
if (notifierVersion.split('.')[0] !== wantMajor)
  throw new Error(`release/bundle pins node-notifier ${notifierVersion}, but packages/cli wants ${cliPkg.dependencies['node-notifier']}; update release/bundle`);
cpSync(join(bundleDir, 'package.json'), join(app, 'package.json'));
cpSync(join(bundleDir, 'package-lock.json'), join(app, 'package-lock.json'));
log(`installing node-notifier ${notifierVersion}`);
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: app });
writeFileSync(
  join(app, 'package.json'),
  JSON.stringify({ name: '@yaaa/cli', version, type: 'module', private: true, dependencies: { 'node-notifier': notifierVersion } }, null, 2) + '\n',
);
// Windows-only helpers aren't needed on macOS or Linux.
for (const dir of ['snoreToast', 'notifu']) rmSync(join(app, 'node_modules/node-notifier/vendor', dir), { recursive: true, force: true });
rmSync(join(app, 'package-lock.json'), { force: true });
rmSync(join(app, 'node_modules/.package-lock.json'), { force: true });

// 2. Per platform: Node's runtime + the app, as yaaa-<v>-<platform>/{bin/node, bin/yaaa, app/}.
const cache = join(repo, '.dev/cache/node');
mkdirSync(cache, { recursive: true });

// Only the platforms being built are replaced, so a Linux build for a sandbox keeps the macOS one (and its URL).
const releaseDir = join(out, 'releases', version);
mkdirSync(releaseDir, { recursive: true });

for (const platform of platforms) {
  const nodeName = `node-v${NODE_VERSION}-${platform}`;
  const nodeTar = join(cache, `${nodeName}.tar.gz`);
  if (!existsSync(nodeTar)) {
    log(`downloading Node ${NODE_VERSION} for ${platform}`);
    run('curl', ['--proto', '=https', '--tlsv1.2', '-fsSL', '-o', nodeTar, `https://nodejs.org/dist/v${NODE_VERSION}/${nodeName}.tar.gz`]);
  }
  if (sha256(nodeTar) !== node.tarballs[platform]) {
    rmSync(nodeTar);
    throw new Error(`${nodeName}.tar.gz doesn't match the hash pinned in release/node.json; run again to download it fresh`);
  }

  const name = `yaaa-${version}-${platform}`;
  const dir = join(work, name);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  run('tar', ['-xzf', nodeTar, '-C', work, `${nodeName}/bin/node`, `${nodeName}/LICENSE`]);
  cpSync(join(work, nodeName, 'bin/node'), join(dir, 'bin/node'));
  // install.sh checks this binary against node.json before it uses it to verify the release.
  if (sha256(join(dir, 'bin/node')) !== node.binaries[platform]) throw new Error(`${nodeName}/bin/node doesn't match release/node.json`);
  cpSync(join(work, nodeName, 'LICENSE'), join(dir, 'NODE-LICENSE'));
  cpSync(join(cliRoot, 'LICENSE'), join(dir, 'LICENSE'));
  cpSync(join(cliRoot, 'NOTICE'), join(dir, 'NOTICE'));
  cpSync(app, join(dir, 'app'), { recursive: true });
  // A launcher that works from wherever the folder is; the installer writes its own into ~/.local/bin.
  writeFileSync(
    join(dir, 'bin/yaaa'),
    '#!/bin/sh\nd=$(cd "$(dirname "$0")/.." && pwd)\nexec "$d/bin/node" "$d/app/dist/yaaa.mjs" "$@"\n',
  );
  chmodSync(join(dir, 'bin/yaaa'), 0o755);

  const tarball = join(releaseDir, `${name}.tar.gz`);
  // On macOS, keep tar's extended attributes and ._ resource files out, or GNU tar warns about them on Linux.
  const macFlags = process.platform === 'darwin' ? ['--no-xattrs', '--no-mac-metadata'] : [];
  run('tar', [...macFlags, '-czf', tarball, '-C', work, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  writeFileSync(`${tarball}.sha256`, `${sha256(tarball)}  ${name}.tar.gz\n`);
  log(`${name}.tar.gz ${(readFileSync(tarball).length / 1e6).toFixed(1)} MB`);
}

// 3. The script, with what it checks a release against written in.
const script = readFileSync(join(here, 'install.sh'), 'utf8')
  .replace('__YAAA_BASE_URL__', base)
  .replace('__YAAA_RELEASE_KEYS__', trusted.join(' '))
  .replace('__YAAA_NODE_SHA256__', PLATFORMS.map((p) => `${p}=${node.binaries[p]}`).join(' '));
const unfilled = script.match(/__YAAA_[A-Z0-9_]+__/);
if (unfilled) throw new Error(`install.sh has a setting build.mjs doesn't fill in: ${unfilled[0]}`);
writeFileSync(join(out, 'install'), script);
chmodSync(join(out, 'install'), 0o755);

// 4. The signed manifest: every tarball of this version in the folder (platforms built earlier too), and install.
const files = {};
for (const f of readdirSync(releaseDir).sort())
  if (f.startsWith(`yaaa-${version}-`) && f.endsWith('.tar.gz')) files[f] = { sha256: sha256(join(releaseDir, f)), size: statSync(join(releaseDir, f)).size };
files.install = { sha256: sha256(join(out, 'install')), size: statSync(join(out, 'install')).size };
const manifest = Buffer.from(JSON.stringify({ name: 'yaaa', version, files }, null, 2) + '\n');
const signature = signBytes(manifest, signingKey);
if (!verifyBytes(manifest, signature, trusted)) throw new Error("the manifest's signature doesn't verify");
writeFileSync(join(releaseDir, 'manifest.json'), manifest);
writeFileSync(join(releaseDir, 'manifest.json.sig'), `${signature}\n`);
log(`signed releases/${version}/manifest.json (${Object.keys(files).length} files)`);

// 5. The pointer to this version, last.
writeFileSync(join(out, 'releases/latest'), `${version}\n`);
rmSync(work, { recursive: true, force: true });
log(`done: ${out} (curl -fsSL ${base}/install | sh)`);
