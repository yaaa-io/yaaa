import { realpathSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { assertSecureUrl, secureGetBytes } from './release.js';

/** Where releases come from when the launcher doesn't say (`curl -fsSL https://yaaa.io/install | sh`). */
export const DEFAULT_INSTALL_URL = 'https://yaaa.io';

/** How this yaaa was installed, which decides how it updates. */
export type Installation =
  | { kind: 'installer'; dir: string; bin: string; url: string }
  | { kind: 'homebrew' }
  | { kind: 'npm' }
  | { kind: 'source'; path: string };

/**
 * The installer's launcher sets YAAA_LAUNCHER, YAAA_INSTALL_DIR and YAAA_INSTALL_URL. Without them, the script's path
 * tells Homebrew, npm and a source checkout apart.
 */
export function installation(env: NodeJS.ProcessEnv = process.env, script: string = process.argv[1] ?? ''): Installation {
  let path = script;
  try {
    path = realpathSync(script);
  } catch {
    // Keep the path as given.
  }
  if (env.YAAA_LAUNCHER) {
    // .../<dir>/versions/<v>/app/dist/yaaa.mjs, for launchers written before YAAA_INSTALL_DIR existed.
    const fromPath = path.includes(`${sep}versions${sep}`) ? path.slice(0, path.lastIndexOf(`${sep}versions${sep}`)) : undefined;
    const dir = env.YAAA_INSTALL_DIR || fromPath;
    if (dir) return { kind: 'installer', dir, bin: env.YAAA_LAUNCHER, url: (env.YAAA_INSTALL_URL || DEFAULT_INSTALL_URL).replace(/\/$/, '') };
  }
  if (/[\\/](Cellar|homebrew|linuxbrew)[\\/]/.test(path)) return { kind: 'homebrew' };
  if (path.includes(`${sep}node_modules${sep}`) && !path.includes(`${sep}packages${sep}cli${sep}`)) return { kind: 'npm' };
  return { kind: 'source', path: dirname(path) };
}

/**
 * Where to look for new versions: the installer's URL, or yaaa.io. YAAA_INSTALL_URL overrides it. It has to be https
 * (or http to this machine), so a plain-http URL can't creep into the launcher or an update.
 */
export function releasesUrl(i: Installation, env: NodeJS.ProcessEnv = process.env): string {
  const url = (env.YAAA_INSTALL_URL || (i.kind === 'installer' ? i.url : DEFAULT_INSTALL_URL)).replace(/\/$/, '');
  assertSecureUrl(url);
  return url;
}

/** How to update when yaaa didn't come from the installer. */
export function updateHint(i: Installation): string {
  switch (i.kind) {
    case 'installer':
      return 'yaaa update';
    case 'homebrew':
      return 'brew upgrade yaaa';
    case 'npm':
      return 'npm install -g @yaaa/cli@latest';
    case 'source':
      return 'git pull, then `pnpm install && pnpm build` in cli/ (this yaaa runs from a source checkout)';
  }
}

/** Compares "1.2.3" or "1.2.3-beta.1" versions: negative when a is older. A release beats its pre-releases. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = '', pre] = v.trim().replace(/^v/, '').split('-', 2);
    return { nums: main.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}

/** The newest released version, from <url>/releases/latest. */
export async function latestVersion(url: string, timeoutMs = 5000): Promise<string> {
  const v = (await secureGetBytes(`${url}/releases/latest`, 256, { timeoutMs, headers: { 'cache-control': 'no-cache' } })).toString('utf8').trim();
  if (!/^[0-9][0-9A-Za-z.+-]*$/.test(v)) throw new Error(`${url}/releases/latest isn't a version: '${v.slice(0, 40)}'`);
  return v;
}
