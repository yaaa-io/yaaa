/**
 * Release signing, shared by build.mjs, keygen.mjs and verify.mjs. A release's manifest.json lists every file of a
 * version with its sha256; manifest.json.sig is an Ed25519 signature over its exact bytes, in base64. Public keys are
 * base64 SPKI DER, pinned in packages/cli/src/release-keys.ts.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const cliRoot = resolve(here, '..');
export const repo = resolve(cliRoot, '..');

/** The pinned keys, from the built CLI (`pnpm build` first), so the CLI and the installer can't disagree. */
export async function pinnedKeys() {
  const file = join(cliRoot, 'packages/cli/dist/release-keys.js');
  if (!existsSync(file)) throw new Error('build the CLI first: pnpm build');
  const { RELEASE_KEYS, RELEASE_KEY_PLACEHOLDER } = await import(pathToFileURL(file).href);
  const isPlaceholder = (k) => !k || k === RELEASE_KEY_PLACEHOLDER || k.startsWith('PLACEHOLDER');
  return { all: [...RELEASE_KEYS], real: RELEASE_KEYS.filter((k) => !isPlaceholder(k)), placeholder: RELEASE_KEYS.some(isPlaceholder) };
}

export const publicKeyOf = (key) => createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');

/** Reads an Ed25519 private key from a PEM file, checking it's one and that only its owner can read it. */
export function readPrivateKey(path) {
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) throw new Error(`${path} can be read by others; chmod 600 it`);
  let key;
  try {
    key = createPrivateKey(readFileSync(path));
  } catch {
    // Never echo the file: it's a secret.
    throw new Error(`${path} isn't a PEM private key`);
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${path} isn't an Ed25519 key`);
  return key;
}

/** Writes a new Ed25519 private key (PKCS#8 PEM, mode 600) to `path`, which mustn't exist; returns its public key. */
export function writeNewKey(path) {
  const { privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return publicKeyOf(privateKey);
}

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

export const signBytes = (bytes, privateKey) => sign(null, bytes, privateKey).toString('base64');

export function verifyBytes(bytes, signature, keys) {
  const sig = Buffer.from(signature.trim(), 'base64');
  return keys.some((k) => {
    try {
      return verify(null, bytes, createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }), sig);
    } catch {
      return false;
    }
  });
}
