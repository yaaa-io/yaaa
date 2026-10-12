import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { releasesUrl, installation } from '../src/installation.js';
import { RELEASE_KEY_PLACEHOLDER, RELEASE_KEYS } from '../src/release-keys.js';
import {
  installRelease,
  isSecureUrl,
  ReleaseError,
  releaseTarball,
  secureGet,
  trustedReleaseKeys,
  usableKeys,
  verifyManifest,
} from '../src/release.js';

const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
};
const signed = (m: object, key: KeyObject) => {
  const body = Buffer.from(JSON.stringify(m));
  return { body, sig: sign(null, body, key).toString('base64') };
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const manifest = (version: string, files: Record<string, Buffer>) => ({
  name: 'yaaa',
  version,
  files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, { sha256: sha(b), size: b.length }])),
});

describe('verifyManifest', () => {
  const k = keyPair();
  const tar = Buffer.from('tarball');
  const m = manifest('1.2.3', { 'yaaa-1.2.3-linux-x64.tar.gz': tar });

  it('accepts a manifest signed by a pinned key, and finds the platform tarball', () => {
    const { body, sig } = signed(m, k.privateKey);
    const v = verifyManifest(body, sig, [k.pub]);
    expect(releaseTarball(v, '1.2.3', 'linux-x64')).toEqual({ name: 'yaaa-1.2.3-linux-x64.tar.gz', sha256: sha(tar), size: tar.length });
  });
  it('accepts either key while a rotation has both pinned', () => {
    const old = keyPair();
    const { body, sig } = signed(m, k.privateKey);
    expect(verifyManifest(body, sig, [old.pub, k.pub]).version).toBe('1.2.3');
  });
  it('rejects a bad signature', () => {
    const { body, sig } = signed(m, k.privateKey);
    const bad = Buffer.from(sig, 'base64');
    bad[0]! ^= 1;
    expect(() => verifyManifest(body, bad.toString('base64'), [k.pub])).toThrow(/isn't signed/);
    expect(() => verifyManifest(body, 'not a signature', [k.pub])).toThrow(ReleaseError);
  });
  it('rejects a signature from a key that isn’t pinned', () => {
    const other = keyPair();
    const { body, sig } = signed(m, other.privateKey);
    expect(() => verifyManifest(body, sig, [k.pub])).toThrow(/isn't signed/);
  });
  it('rejects a manifest changed after signing (a swapped tarball hash)', () => {
    const { sig } = signed(m, k.privateKey);
    const tampered = manifest('1.2.3', { 'yaaa-1.2.3-linux-x64.tar.gz': Buffer.from('something else') });
    expect(() => verifyManifest(Buffer.from(JSON.stringify(tampered)), sig, [k.pub])).toThrow(/isn't signed/);
  });
  it('never trusts the placeholder key, and says so when it is all a build has', () => {
    const { body, sig } = signed(m, k.privateKey);
    expect(() => verifyManifest(body, sig, [RELEASE_KEY_PLACEHOLDER])).toThrow(/no release key/);
    expect(usableKeys([RELEASE_KEY_PLACEHOLDER, k.pub])).toEqual([k.pub]);
    // Until the real key is pinned, a workspace build trusts nothing.
    if (RELEASE_KEYS.every((x) => x === RELEASE_KEY_PLACEHOLDER)) expect(trustedReleaseKeys()).toEqual([]);
  });
  it('rejects a signed manifest for another version or without the platform', () => {
    const { body, sig } = signed(m, k.privateKey);
    const v = verifyManifest(body, sig, [k.pub]);
    expect(() => releaseTarball(v, '1.2.4', 'linux-x64')).toThrow(/for 1.2.3, not 1.2.4/);
    expect(() => releaseTarball(v, '1.2.3', 'darwin-arm64')).toThrow(/no build for darwin-arm64/);
  });
  it('rejects a malformed manifest even when signed', () => {
    const { body, sig } = signed({ name: 'yaaa', version: '1', files: { a: { sha256: 'xyz', size: 1 } } }, k.privateKey);
    expect(() => verifyManifest(body, sig, [k.pub])).toThrow(/malformed/);
  });
});

describe('https only', () => {
  it('allows https and loopback http, nothing else', () => {
    expect(isSecureUrl('https://yaaa.io')).toBe(true);
    expect(isSecureUrl('http://localhost:7090')).toBe(true);
    expect(isSecureUrl('http://127.0.0.1:7090/x')).toBe(true);
    expect(isSecureUrl('http://[::1]:7090')).toBe(true);
    expect(isSecureUrl('http://yaaa.io')).toBe(false);
    expect(isSecureUrl('http://localhost.evil.example')).toBe(false);
    expect(isSecureUrl('ftp://yaaa.io')).toBe(false);
    expect(isSecureUrl('http://host.docker.internal:7091', true)).toBe(true);
  });
  it('refuses an http YAAA_INSTALL_URL', () => {
    const i = installation({ YAAA_LAUNCHER: '/b/yaaa', YAAA_INSTALL_DIR: '/b', YAAA_INSTALL_URL: 'http://yaaa.io' }, '/b/versions/1/app/dist/yaaa.mjs');
    expect(() => releasesUrl(i, {})).toThrow(/https/);
    expect(releasesUrl(i, { YAAA_INSTALL_URL: 'http://localhost:7090' })).toBe('http://localhost:7090');
  });
});

/** A release folder served on loopback, as a local static file server does. */
describe('installRelease', () => {
  const k = keyPair();
  const version = '9.9.9';
  const platform = 'linux-x64';
  const name = `yaaa-${version}-${platform}`;
  let root: string;
  let server: Server;
  let url: string;
  let tarball: Buffer;
  const files = new Map<string, Buffer>();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'yaaa-release-test-'));
    const src = join(root, 'src', name);
    mkdirSync(join(src, 'bin'), { recursive: true });
    mkdirSync(join(src, 'app/dist'), { recursive: true });
    writeFileSync(join(src, 'bin/node'), '#!/bin/sh\necho node\n', { mode: 0o755 });
    writeFileSync(join(src, 'app/dist/yaaa.mjs'), 'console.log("9.9.9")\n');
    execFileSync('tar', ['-czf', join(root, 'src.tar.gz'), '-C', join(root, 'src'), name]);
    tarball = readFileSync(join(root, 'src.tar.gz'));
    const { body, sig } = signed(manifest(version, { [`${name}.tar.gz`]: tarball }), k.privateKey);
    files.set(`/releases/${version}/manifest.json`, body);
    files.set(`/releases/${version}/manifest.json.sig`, Buffer.from(sig));
    files.set(`/releases/${version}/${name}.tar.gz`, tarball);
    files.set('/redirect-away', Buffer.from(''));
    server = createServer((req, res) => {
      if (req.url === '/redirect-away') {
        res.writeHead(302, { location: 'http://example.com/x' }).end();
        return;
      }
      const f = files.get(req.url ?? '');
      if (!f) res.writeHead(404).end();
      else res.writeHead(200).end(f);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server?.close();
    if (root?.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true });
  });

  const dirs = () => {
    const dir = mkdtempSync(join(root, 'install-'));
    return { dir, bin: join(dir, 'bin/yaaa') };
  };

  it('installs a signed release: unpacks it, switches current, writes the launcher, removes older versions', async () => {
    const { dir, bin } = dirs();
    mkdirSync(join(dir, 'versions/0.0.1'), { recursive: true });
    mkdirSync(join(dir, 'versions/0.0.2'), { recursive: true });
    await installRelease({ url, version, dir, bin, platform, keys: [k.pub], keep: ['0.0.2'] });
    expect(readlinkSync(join(dir, 'current'))).toBe(`versions/${version}`);
    expect(existsSync(join(dir, 'current/app/dist/yaaa.mjs'))).toBe(true);
    expect(existsSync(join(dir, 'versions/0.0.2'))).toBe(true);
    expect(existsSync(join(dir, 'versions/0.0.1'))).toBe(false);
    expect(readFileSync(bin, 'utf8')).toContain(`YAAA_INSTALL_URL="${url}"`);
    // Installing it again (yaaa update --to the same version) replaces it in place.
    await installRelease({ url, version, dir, bin, platform, keys: [k.pub] });
    expect(readlinkSync(join(dir, 'current'))).toBe(`versions/${version}`);
  });

  it('installs nothing when the signature is from another key', async () => {
    const { dir, bin } = dirs();
    await expect(installRelease({ url, version, dir, bin, platform, keys: [keyPair().pub] })).rejects.toThrow(/isn't signed/);
    expect(existsSync(join(dir, 'current'))).toBe(false);
  });

  it('installs nothing when the tarball differs from the signed manifest', async () => {
    const { dir, bin } = dirs();
    files.set(`/releases/${version}/${name}.tar.gz`, Buffer.concat([tarball.subarray(0, tarball.length - 1), Buffer.from([tarball.at(-1)! ^ 1])]));
    try {
      await expect(installRelease({ url, version, dir, bin, platform, keys: [k.pub] })).rejects.toThrow(/doesn't match the signed manifest/);
    } finally {
      files.set(`/releases/${version}/${name}.tar.gz`, tarball);
    }
    expect(existsSync(join(dir, 'current'))).toBe(false);
    expect(existsSync(join(dir, 'versions', version))).toBe(false);
  });

  it('refuses plain http beyond this machine, and redirects to it', async () => {
    const { dir, bin } = dirs();
    await expect(installRelease({ url: 'http://yaaa.io', version, dir, bin, platform, keys: [k.pub] })).rejects.toThrow(/https/);
    await expect(secureGet(`${url}/redirect-away`, { timeoutMs: 5000, allowHttp: false })).rejects.toThrow(/https/);
  });
});
