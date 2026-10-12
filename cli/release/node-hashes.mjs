#!/usr/bin/env node
/**
 * Pins the Node runtime yaaa ships, into release/node.json: the sha256 of each platform's nodejs.org tarball (which
 * build.mjs checks every download against) and of the `bin/node` inside it (which install.sh checks before it uses that
 * Node to verify the release signature).
 *
 *   node release/node-hashes.mjs 24.21.0
 *
 * Run it when moving to a new Node version, and commit node.json. It reads nodejs.org's SHASUMS256.txt and checks the
 * file's signature (SHASUMS256.txt.asc) with gpg against Node's release keys
 * (https://github.com/nodejs/node#release-keys; import them first, or point GNUPGHOME at a keyring that has them).
 * Without gpg it refuses, unless --no-gpg says you're checking the hashes another way (for example against a second
 * network, or the hashes in Node's GitHub release notes).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PLATFORMS } from './platforms.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: args, positionals } = parseArgs({ options: { 'no-gpg': { type: 'boolean', default: false } }, allowPositionals: true });
const version = positionals[0];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('usage: node release/node-hashes.mjs <node version, e.g. 24.21.0> [--no-gpg]');

const run = (cmd, argv) => execFileSync(cmd, argv, { stdio: ['ignore', 'inherit', 'inherit'] });
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const curl = (url, file) => run('curl', ['--proto', '=https', '--tlsv1.2', '-fsSL', '-o', file, url]);
const has = (cmd) => {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const work = mkdtempSync(join(tmpdir(), 'yaaa-node-hashes-'));
try {
  const dist = `https://nodejs.org/dist/v${version}`;
  const sums = join(work, 'SHASUMS256.txt');
  curl(`${dist}/SHASUMS256.txt`, sums);
  curl(`${dist}/SHASUMS256.txt.asc`, `${sums}.asc`);
  if (has('gpg')) {
    // A bad signature, or one from a key that isn't in the keyring, stops here.
    run('gpg', ['--verify', `${sums}.asc`, sums]);
    console.log('node-hashes: SHASUMS256.txt is signed by a Node release key');
  } else if (args['no-gpg']) {
    console.warn('node-hashes: gpg not found; SHASUMS256.txt is NOT signature-checked (--no-gpg). Check the hashes below another way.');
  } else {
    throw new Error('gpg not found: install it and import Node release keys, or pass --no-gpg and check the hashes another way');
  }
  const listed = new Map(
    readFileSync(sums, 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).reverse()),
  );

  const tarballs = {};
  const binaries = {};
  for (const platform of PLATFORMS) {
    const name = `node-v${version}-${platform}`;
    const tar = join(work, `${name}.tar.gz`);
    console.log(`node-hashes: ${name}.tar.gz`);
    curl(`${dist}/${name}.tar.gz`, tar);
    const want = listed.get(`${name}.tar.gz`);
    if (!want || sha256(tar) !== want) throw new Error(`${name}.tar.gz doesn't match SHASUMS256.txt`);
    tarballs[platform] = want;
    run('tar', ['-xzf', tar, '-C', work, `${name}/bin/node`]);
    binaries[platform] = sha256(join(work, name, 'bin/node'));
    rmSync(tar);
  }
  const out = resolve(here, 'node.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ version, tarballs, binaries }, null, 2) + '\n');
  console.log(`node-hashes: wrote ${out}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
