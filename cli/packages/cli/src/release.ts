import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { get as httpsGet } from 'node:https';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { RELEASE_KEY_PLACEHOLDER, RELEASE_KEYS } from './release-keys.js';

/**
 * Set by release/build.mjs in the bundle the installer ships: the keys that build trusts (the pinned ones, plus a
 * developer's local key in a `--dev-key` build), and whether it may download over plain http (only `--dev-key` builds,
 * for a sandbox reaching the host). Undefined when yaaa runs from the workspace or npm.
 */
declare const __YAAA_RELEASE_KEYS__: readonly string[] | undefined;
declare const __YAAA_ALLOW_HTTP__: boolean | undefined;

/** A release that can't be installed. `retryable` when it's the download that failed, not the release's checks. */
export class ReleaseError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** The release keys this yaaa trusts, without the placeholder. */
export function trustedReleaseKeys(): readonly string[] {
  const keys = typeof __YAAA_RELEASE_KEYS__ !== 'undefined' ? __YAAA_RELEASE_KEYS__ : RELEASE_KEYS;
  return usableKeys(keys);
}

export function usableKeys(keys: readonly string[]): readonly string[] {
  return keys.filter((k) => k && k !== RELEASE_KEY_PLACEHOLDER && !k.startsWith('PLACEHOLDER'));
}

const allowHttpBuild = (): boolean => typeof __YAAA_ALLOW_HTTP__ !== 'undefined' && __YAAA_ALLOW_HTTP__ === true;

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** https, or http to this machine. A `--dev-key` build also accepts any http URL. */
export function isSecureUrl(url: string, allowHttp = allowHttpBuild()): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && (allowHttp || LOOPBACK.test(u.hostname));
}

export function assertSecureUrl(url: string, allowHttp = allowHttpBuild()): void {
  if (!isSecureUrl(url, allowHttp)) throw new ReleaseError(`${url} isn't an https URL; yaaa downloads releases over https only`);
}

export interface GetOptions {
  /** How long the connection may sit idle. */
  timeoutMs: number;
  headers?: Record<string, string>;
  allowHttp?: boolean;
}

/**
 * A GET that follows up to 5 redirects itself, so that every hop has to be https (or loopback). It uses node:http(s)
 * rather than fetch, whose HTTP client can fail an assertion when a server closes the connection mid-download.
 */
export function secureGet(url: string, o: GetOptions, hops = 0): Promise<IncomingMessage> {
  try {
    assertSecureUrl(url, o.allowHttp ?? allowHttpBuild());
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? httpsGet : httpGet)(u, { headers: o.headers, timeout: o.timeoutMs }, (res) => {
      const location = res.headers.location;
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (hops >= 5) return reject(new ReleaseError(`${url} redirects too many times`));
        let next: string;
        try {
          next = new URL(location, url).toString();
        } catch {
          return reject(new ReleaseError(`${url} redirects to a bad URL`));
        }
        secureGet(next, o, hops + 1).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new ReleaseError(`${url} timed out`, true)));
    req.on('error', (e) => reject(e instanceof ReleaseError ? e : new ReleaseError(`couldn't download ${url}: ${e.message}`, true)));
  });
}

/** A small file over secureGet, refusing more than maxBytes. */
export async function secureGetBytes(url: string, maxBytes: number, o: GetOptions): Promise<Buffer> {
  const res = await secureGet(url, o);
  if (res.statusCode !== 200) {
    res.resume();
    throw new ReleaseError(`couldn't download ${url} (${res.statusCode})`, true);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) {
      res.destroy();
      throw new ReleaseError(`${url} is larger than expected`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** releases/<v>/manifest.json: every file of a version with its sha256, signed in manifest.json.sig. */
export interface ReleaseManifest {
  name: 'yaaa';
  version: string;
  files: Record<string, { sha256: string; size: number }>;
}

/**
 * Checks `signature` (base64 Ed25519) over the manifest's exact bytes against each key, and returns the manifest when
 * one of them signed it. Keys are base64 SPKI DER; the placeholder never counts.
 */
export function verifyManifest(body: Buffer, signature: string, keys: readonly string[]): ReleaseManifest {
  const usable = usableKeys(keys);
  if (usable.length === 0) throw new ReleaseError('this yaaa has no release key to check updates with; reinstall it with the installer');
  const sig = Buffer.from(signature.trim(), 'base64');
  if (sig.length !== 64) throw new ReleaseError("the release's signature is malformed");
  const signed = usable.some((k) => {
    try {
      const key = createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' });
      return key.asymmetricKeyType === 'ed25519' && verify(null, body, key, sig);
    } catch {
      return false;
    }
  });
  if (!signed) throw new ReleaseError("the release isn't signed by yaaa's release key");
  let m: unknown;
  try {
    m = JSON.parse(body.toString('utf8'));
  } catch {
    throw new ReleaseError("the release's manifest isn't JSON");
  }
  const ok =
    typeof m === 'object' &&
    m !== null &&
    (m as ReleaseManifest).name === 'yaaa' &&
    typeof (m as ReleaseManifest).version === 'string' &&
    typeof (m as ReleaseManifest).files === 'object' &&
    (m as ReleaseManifest).files !== null &&
    Object.values((m as ReleaseManifest).files).every((f) => typeof f?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256) && Number.isSafeInteger(f.size));
  if (!ok) throw new ReleaseError("the release's manifest is malformed");
  return m as ReleaseManifest;
}

/** The tarball for one platform, from a verified manifest that has to be for `version`. */
export function releaseTarball(m: ReleaseManifest, version: string, platform: string): { name: string; sha256: string; size: number } {
  if (m.version !== version) throw new ReleaseError(`the release's manifest is for ${m.version}, not ${version}`);
  const name = `yaaa-${version}-${platform}.tar.gz`;
  const f = Object.hasOwn(m.files, name) ? m.files[name] : undefined;
  if (!f) throw new ReleaseError(`yaaa ${version} has no build for ${platform}`);
  return { name, ...f };
}

/** darwin-arm64, linux-x64, ...: the platforms yaaa releases for (release/platforms.mjs). */
export function releasePlatform(platform: string = process.platform, arch: string = process.arch): string {
  const p = `${platform}-${arch}`;
  if (!['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].includes(p)) throw new ReleaseError(`yaaa isn't released for ${p}`);
  return p;
}

/** Downloads url into file, returning its sha256; anything over maxBytes stops it. */
async function download(url: string, file: string, maxBytes: number, allowHttp: boolean): Promise<string> {
  const res = await secureGet(url, { timeoutMs: 60_000, allowHttp });
  if (res.statusCode !== 200) {
    res.resume();
    throw new ReleaseError(`couldn't download ${url} (${res.statusCode})`, true);
  }
  const hash = createHash('sha256');
  let size = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > maxBytes) return done(new ReleaseError(`${url} is larger than expected`, true));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(res, count, createWriteStream(file, { mode: 0o600 }));
  return hash.digest('hex');
}

/** The launcher in the bin folder, the same one install.sh writes. */
export function launcherScript(installDir: string, launcher: string, url: string): string {
  return `#!/bin/sh
# yaaa launcher, written by the yaaa installer. yaaa runs on its own Node in ${installDir}/current.
# YAAA_LAUNCHER, YAAA_INSTALL_DIR and YAAA_INSTALL_URL tell yaaa how it was installed, for yaaa update.
YAAA_LAUNCHER="${launcher}" YAAA_INSTALL_DIR="${installDir}" YAAA_INSTALL_URL="${url}" \\
  exec "${installDir}/current/bin/node" "${installDir}/current/app/dist/yaaa.mjs" "$@"
`;
}

export interface InstallOptions {
  /** Where releases are: <url>/releases/<version>/... */
  url: string;
  version: string;
  /** The install folder (~/.yaaa): versions/<v>/ and the `current` link. */
  dir: string;
  /** The launcher to (re)write, ~/.local/bin/yaaa. */
  bin: string;
  /** Versions to keep besides the new one (the running one), when older ones are removed. */
  keep?: readonly string[];
  platform?: string;
  keys?: readonly string[];
  allowHttp?: boolean;
  log?: (s: string) => void;
}

/**
 * Installs one version the way install.sh does, checking it first: the manifest's signature against the pinned keys,
 * then the tarball's sha256 against the manifest. It unpacks into a folder inside `dir` and switches the `current` link
 * in one rename, so a yaaa that's running keeps working until it exits.
 */
export async function installRelease(o: InstallOptions): Promise<void> {
  const log = o.log ?? (() => {});
  const platform = o.platform ?? releasePlatform();
  const keys = o.keys ?? trustedReleaseKeys();
  const allowHttp = o.allowHttp ?? allowHttpBuild();
  if (!/^[0-9][0-9A-Za-z.+-]*$/.test(o.version)) throw new ReleaseError(`'${o.version}' isn't a version`);
  assertSecureUrl(o.url, allowHttp);
  const base = `${o.url}/releases/${o.version}`;

  const get = { timeoutMs: 15_000, allowHttp, headers: { 'cache-control': 'no-cache' } };
  const body = await secureGetBytes(`${base}/manifest.json`, 1 << 20, get);
  const sig = (await secureGetBytes(`${base}/manifest.json.sig`, 4096, get)).toString('utf8');
  const tarball = releaseTarball(verifyManifest(body, sig, keys), o.version, platform);
  log(`Downloading yaaa ${o.version} (${platform}, ${(tarball.size / 1e6).toFixed(1)} MB)…`);

  mkdirSync(join(o.dir, 'versions'), { recursive: true });
  const tmp = mkdtempSync(join(o.dir, '.update-'));
  try {
    const file = join(tmp, tarball.name);
    // Anything bigger than the size the manifest gives isn't the file it lists.
    const got = await download(`${base}/${tarball.name}`, file, tarball.size, allowHttp);
    if (got !== tarball.sha256) throw new ReleaseError(`the download of ${tarball.name} doesn't match the signed manifest; try again`);
    log('Checked the signature and checksum.');

    const name = tarball.name.replace(/\.tar\.gz$/, '');
    execFileSync('tar', ['-xzf', file, '-C', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
    const unpacked = join(tmp, name);
    for (const f of ['bin/node', 'app/dist/yaaa.mjs'])
      if (!existsSync(join(unpacked, f))) throw new ReleaseError(`${tarball.name} is missing ${f}`);

    // Into place: move any folder of the same version aside first, so `current` never points at a half-written one.
    const target = join(o.dir, 'versions', o.version);
    if (existsSync(target)) renameSync(target, join(tmp, 'replaced'));
    renameSync(unpacked, target);
    const now = new Date();
    utimesSync(target, now, now); // newest first, as install.sh's cleanup expects

    const link = join(o.dir, 'current');
    const next = join(o.dir, 'current.tmp');
    rmSync(next, { force: true });
    symlinkSync(join('versions', o.version), next);
    // rename(2) replaces the old link itself, never following it.
    renameSync(next, link);

    // The launcher, written beside it and renamed over it.
    mkdirSync(dirname(o.bin), { recursive: true });
    const launcherTmp = `${o.bin}.tmp`;
    writeFileSync(launcherTmp, launcherScript(o.dir, o.bin, o.url));
    chmodSync(launcherTmp, 0o755);
    renameSync(launcherTmp, o.bin);

    // Keep this version and the ones asked for; remove older ones.
    const keep = new Set([o.version, ...(o.keep ?? [])]);
    for (const v of readdirSync(join(o.dir, 'versions'))) {
      const p = join(o.dir, 'versions', v);
      if (!keep.has(v) && statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
