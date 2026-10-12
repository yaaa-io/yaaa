import { execFileSync } from 'node:child_process';
import { isWsl } from '@yaaa/client';

/** Whether a command is on the PATH. */
function onPath(bin: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ways to open a URL in the browser, best first. In WSL the browser is Windows': wslview when it's installed (it
 * comes with wslu, which Ubuntu no longer installs by default); else PowerShell's Start-Process with the URL quoted;
 * else rundll32's FileProtocolHandler, for when PowerShell is blocked by policy. Both hand the whole URL, fragment
 * included, to the default browser. Not explorer.exe: it takes a URL with a query or fragment (yaaa's desk and
 * passkey links) for a path and opens Documents, exiting 1 either way. Not cmd's `start`: it splits a URL at `&`
 * and warns about the WSL folder it starts in. (Checked on Windows 11 with WSL2 Ubuntu.)
 */
export function openers(
  url: string,
  wsl = isWsl(),
  platform: NodeJS.Platform = process.platform,
): Array<{ bin: string; args: string[] }> {
  if (platform === 'darwin') return [{ bin: 'open', args: [url] }];
  if (platform === 'win32') return [{ bin: 'cmd', args: ['/c', 'start', '""', url] }];
  if (wsl)
    return [
      { bin: 'wslview', args: [url] },
      { bin: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url.replace(/'/g, "''")}'`] },
      { bin: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] },
    ];
  return [{ bin: 'xdg-open', args: [url] }];
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a URL is one yaaa may hand to the browser: https, or http to this machine (a local API). Anything else
 * (file:, javascript:, a custom scheme an app registered, or plain http elsewhere) is never opened, wherever the
 * URL came from.
 */
export function openable(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
  } catch {
    return false;
  }
}

/**
 * Opens a URL in the user's browser. False when nothing could, or the URL isn't one to open (see openable), so the
 * caller prints the link instead.
 */
export function openUrl(url: string): boolean {
  if (!openable(url)) return false;
  for (const o of openers(url)) {
    if (!onPath(o.bin)) continue;
    try {
      execFileSync(o.bin, o.args, { stdio: 'ignore', timeout: 10_000 });
      return true;
    } catch {
      // Try the next way.
    }
  }
  return false;
}
