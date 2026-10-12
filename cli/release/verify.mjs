#!/usr/bin/env node
/**
 * Checks a built release before it's published (the publish step runs it):
 *
 *   node release/verify.mjs [dir, default ../dist/release]
 *
 * The latest version's manifest.json has to be signed by a key pinned in packages/cli/src/release-keys.ts (not a
 * developer's --dev-key), every file it lists has to match its sha256, every tarball in the folder has to be listed, and
 * `install` has to be the one the manifest lists.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pinnedKeys, repo, sha256, verifyBytes } from './signing.mjs';

const dir = resolve(process.argv[2] ?? join(repo, 'dist/release'));
const fail = (s) => {
  console.error(`verify: ${s}`);
  process.exit(1);
};

const keys = await pinnedKeys();
if (keys.placeholder || keys.real.length === 0) fail('packages/cli/src/release-keys.ts still has the placeholder key; make one with release/keygen.mjs and pin it');
const version = readFileSync(join(dir, 'releases/latest'), 'utf8').trim();
const vdir = join(dir, 'releases', version);
const body = readFileSync(join(vdir, 'manifest.json'));
if (!verifyBytes(body, readFileSync(join(vdir, 'manifest.json.sig'), 'utf8'), keys.real))
  fail(`releases/${version}/manifest.json isn't signed by a pinned release key (a --dev-key build can't be published)`);
const m = JSON.parse(body.toString('utf8'));
if (m.name !== 'yaaa' || m.version !== version) fail(`the manifest is for ${m.name} ${m.version}, not yaaa ${version}`);
for (const [name, f] of Object.entries(m.files)) {
  const file = name === 'install' ? join(dir, 'install') : join(vdir, name);
  if (!existsSync(file)) fail(`${name} is in the manifest but not in ${dir}`);
  if (sha256(file) !== f.sha256) fail(`${name} doesn't match the manifest`);
}
for (const f of readdirSync(vdir)) if (f.endsWith('.tar.gz') && !m.files[f]) fail(`${f} isn't in the manifest`);
if (!m.files.install) fail('the manifest doesn\'t list install');
console.log(`verify: yaaa ${version} is signed and complete (${Object.keys(m.files).length} files)`);
