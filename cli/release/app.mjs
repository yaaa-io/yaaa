/**
 * The app every distribution ships: the CLI bundled into one file, its skills and assets, and node-notifier pinned by
 * release/bundle/package-lock.json. The installer's tarballs (build.mjs) and the npm package (npm.mjs) both build it
 * here, so they can't drift.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
export const cliRoot = resolve(here, '..');
export const pkgDir = join(cliRoot, 'packages/cli');
const bundleDir = join(here, 'bundle');

/** The CLI's version, checked against VERSION in @yaaa/client: `yaaa update` compares that with releases/latest. */
export function cliVersion() {
  const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  const reported = readFileSync(join(cliRoot, 'packages/client/src/connect.ts'), 'utf8').match(/export const VERSION = '([^']+)'/)?.[1];
  if (reported !== version)
    throw new Error(`packages/cli/package.json is ${version} but VERSION in packages/client/src/connect.ts is ${reported}; make them match`);
  return version;
}

/** node-notifier's version in release/bundle, checked against the major version packages/cli asks for. */
export function notifierVersion() {
  const pinned = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')).dependencies['node-notifier'];
  const wanted = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).dependencies['node-notifier'];
  if (pinned.split('.')[0] !== wanted.replace(/^[\^~]/, '').split('.')[0])
    throw new Error(`release/bundle pins node-notifier ${pinned}, but packages/cli wants ${wanted}; update release/bundle`);
  return pinned;
}

/**
 * Builds the app into `dir`: dist/yaaa.mjs (and its LEGAL.txt), skills/, assets/, and node_modules/ with node-notifier.
 * Leaves release/bundle's package.json in `dir`; the caller writes its own. `trusted` are the release keys `yaaa update`
 * accepts; `allowHttp` only for a --dev-key build. dist/yaaa.mjs keeps dist/main.js's `#!/usr/bin/env node`, so it also
 * runs on its own (npm's bin).
 */
export async function buildApp(dir, { trusted, allowHttp = false, log = () => {} }) {
  if (!existsSync(join(pkgDir, 'dist/main.js'))) throw new Error('build the CLI first: pnpm build');
  await build({
    entryPoints: [join(pkgDir, 'dist/main.js')],
    outfile: join(dir, 'dist/yaaa.mjs'),
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
    define: { __YAAA_RELEASE_KEYS__: JSON.stringify(trusted), __YAAA_ALLOW_HTTP__: JSON.stringify(allowHttp) },
    logLevel: 'warning',
  });
  cpSync(join(pkgDir, 'skills'), join(dir, 'skills'), { recursive: true });
  cpSync(join(pkgDir, 'assets'), join(dir, 'assets'), { recursive: true });

  // node-notifier at the exact versions in release/bundle/package-lock.json, so every build installs the same files.
  const notifier = notifierVersion();
  cpSync(join(bundleDir, 'package.json'), join(dir, 'package.json'));
  cpSync(join(bundleDir, 'package-lock.json'), join(dir, 'package-lock.json'));
  log(`installing node-notifier ${notifier}`);
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: dir,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  // Windows-only helpers aren't needed on macOS or Linux.
  for (const d of ['snoreToast', 'notifu']) rmSync(join(dir, 'node_modules/node-notifier/vendor', d), { recursive: true, force: true });
  rmSync(join(dir, 'package-lock.json'), { force: true });
  rmSync(join(dir, 'node_modules/.package-lock.json'), { force: true });
  return { notifier };
}

/** Writes `dir`/package.json. */
export function writePackageJson(dir, pkg) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}
