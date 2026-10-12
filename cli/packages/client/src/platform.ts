import { readFileSync } from 'node:fs';

/**
 * Whether this is Linux running in WSL on Windows. WSL sets WSL_DISTRO_NAME (and WSL_INTEROP), and its kernel
 * release names Microsoft, which also catches shells started without WSL's environment.
 */
export function isWsl(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): boolean {
  if (platform !== 'linux') return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(read('/proc/sys/kernel/osrelease'));
  } catch {
    return false;
  }
}

let name: string | undefined;

/** The platform for people and logs: darwin, linux, linux-wsl, or win32. Worked out once per run. */
export function platformName(): string {
  return (name ??= isWsl() ? 'linux-wsl' : process.platform);
}
