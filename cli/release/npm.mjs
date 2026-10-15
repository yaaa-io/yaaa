#!/usr/bin/env node
/**
 * Builds the npm package, @yaaa-io/cli, into one folder (default ../dist/npm), from the same app as the installer's
 * tarballs (release/app.mjs), and checks what `npm pack` would publish from it:
 *
 *   node release/npm.mjs [--out dir]
 *
 * The package runs on the person's own Node (22.12 or newer) and updates with npm, not `yaaa update`. node-notifier
 * comes bundled (bundleDependencies) at the versions release/bundle pins, because npm ignores a published package's
 * `overrides`, and nothing runs at install time. yaaa-io/yaaa's publish workflow publishes it with trusted publishing
 * and provenance; see .github/workflows/publish.yml there.
 *
 * Run `pnpm build` first.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildApp, cliRoot, cliVersion, writePackageJson } from './app.mjs';
import { npmReadme } from './readme.mjs';
import { pinnedKeys } from './signing.mjs';

export const NPM_NAME = '@yaaa-io/cli';
/** What unpacked package may grow to before the check fails: a sudden jump means something got in by mistake. */
const MAX_UNPACKED = 6e6;

const repo = resolve(cliRoot, '..');
const { values: args } = parseArgs({ options: { out: { type: 'string', default: join(repo, 'dist/npm') } } });
const out = resolve(args.out);
const log = (s) => console.log(`npm: ${s}`);

const version = cliVersion();
// `yaaa update` doesn't replace an npm install, but the bundle still carries the keys it would trust, as the
// installer's does.
const keys = await pinnedKeys();
if (keys.placeholder || keys.real.length === 0) throw new Error('packages/cli/src/release-keys.ts still has the placeholder key');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
log(`bundling ${NPM_NAME} ${version}`);
const { notifier } = await buildApp(out, { trusted: keys.real, log });
chmodSync(join(out, 'dist/yaaa.mjs'), 0o755);
cpSync(join(cliRoot, 'LICENSE'), join(out, 'LICENSE'));
cpSync(join(cliRoot, 'NOTICE'), join(out, 'NOTICE'));
// The README, with a table of this version's commands (release/readme.mjs).
writeFileSync(join(out, 'README.md'), await npmReadme());
writePackageJson(out, {
  name: NPM_NAME,
  version,
  description: 'yaaa: your shopping agent, in your terminal. Search stores, watch prices and restocks, and buy, from your AI agents.',
  keywords: ['cli', 'ai-agents', 'shopping', 'mcp', 'shopify', 'agent-skills'],
  homepage: 'https://yaaa.io',
  bugs: { url: 'https://github.com/yaaa-io/yaaa/issues' },
  // Provenance checks this against the repo the publish workflow runs in.
  repository: { type: 'git', url: 'git+https://github.com/yaaa-io/yaaa.git', directory: 'cli' },
  license: 'Apache-2.0',
  type: 'module',
  bin: { yaaa: 'dist/yaaa.mjs' },
  engines: { node: '>=22.12' },
  os: ['darwin', 'linux'],
  dependencies: { 'node-notifier': notifier },
  bundleDependencies: ['node-notifier'],
  files: ['dist', 'skills', 'assets', 'NOTICE'],
  publishConfig: { access: 'public', provenance: true },
});

// What would be published: only these paths, and nothing that must never leave the repo.
const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: out, encoding: 'utf8' }));
const allowed = /^(package\.json|README\.md|LICENSE|NOTICE|dist\/yaaa\.mjs(\.LEGAL\.txt)?|skills\/.+|assets\/.+|node_modules\/.+)$/;
const never = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_(rsa|ed25519).*)$|\.map$/;
const bad = packed.files.map((f) => f.path).filter((p) => !allowed.test(p) || never.test(p));
if (bad.length) throw new Error(`the package would publish files it shouldn't:\n  ${bad.join('\n  ')}`);
if (packed.unpackedSize > MAX_UNPACKED)
  throw new Error(`the package unpacks to ${(packed.unpackedSize / 1e6).toFixed(1)} MB, over the ${MAX_UNPACKED / 1e6} MB budget`);
// In the private repo, the same check for private references as the public mirror gets.
const ossCheck = join(repo, 'scripts/oss-check.sh');
if (existsSync(ossCheck)) execFileSync('bash', [ossCheck, '--refs-only', out], { stdio: 'inherit' });

const reported = execFileSync(process.execPath, [join(out, 'dist/yaaa.mjs'), '--version'], {
  encoding: 'utf8',
  env: { ...process.env, YAAA_NO_UPDATE_CHECK: '1' },
}).trim();
if (reported !== version) throw new Error(`the bundle says it's ${reported}, not ${version}`);
log(`${packed.filename}: ${packed.entryCount} files, ${(packed.size / 1e6).toFixed(1)} MB packed, ${(packed.unpackedSize / 1e6).toFixed(1)} MB unpacked`);
log(`done: ${out} (npm publish ${out} --provenance --access public)`);
