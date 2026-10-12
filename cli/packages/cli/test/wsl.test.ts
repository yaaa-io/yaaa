import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Exit, isWsl } from '@yaaa/client';
import { openers } from '../src/open.js';

const main = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const installer = fileURLToPath(new URL('../../../release/install.sh', import.meta.url));

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((ok) =>
    execFile(bin, args, { env }, (e, stdout, stderr) => ok({ code: e ? Number(e.code ?? 1) : 0, out: stdout + stderr })),
  );
}

describe('isWsl', () => {
  const none = () => {
    throw new Error('no such file');
  };
  it('is Linux with WSL in the environment or a Microsoft kernel', () => {
    expect(isWsl('linux', { WSL_DISTRO_NAME: 'Ubuntu' }, none)).toBe(true);
    expect(isWsl('linux', {}, () => '5.15.153.1-microsoft-standard-WSL2\n')).toBe(true);
    expect(isWsl('linux', {}, () => '6.8.0-45-generic\n')).toBe(false);
    expect(isWsl('linux', {}, none)).toBe(false);
    expect(isWsl('darwin', { WSL_DISTRO_NAME: 'Ubuntu' }, none)).toBe(false);
  });
});

describe('opening links in WSL', () => {
  it('tries wslview, then PowerShell with the URL quoted, then rundll32; never explorer.exe or cmd', () => {
    const url = "https://yaaa.io/desk/login?a=1&b=it's#token";
    const o = openers(url, true, 'linux');
    expect(o.map((x) => x.bin)).toEqual(['wslview', 'powershell.exe', 'rundll32.exe']);
    // Quoted for PowerShell: & stays inside the string, and ' is doubled.
    expect(o[1]!.args.at(-1)).toBe("Start-Process 'https://yaaa.io/desk/login?a=1&b=it''s#token'");
    // rundll32 gets the whole URL, fragment included, as one argument.
    expect(o[2]!.args).toEqual(['url.dll,FileProtocolHandler', url]);
    expect(openers(url, false, 'linux').map((x) => x.bin)).toEqual(['xdg-open']);
  });
});

describe('the installer on Windows shells', () => {
  for (const os of ['MINGW64_NT-10.0-19045', 'MSYS_NT-10.0-19045', 'CYGWIN_NT-10.0-19045']) {
    it(`points ${os.split('_')[0]} to WSL, before downloading anything`, async () => {
      const bin = mkdtempSync(join(tmpdir(), 'yaaa-uname-'));
      try {
        writeFileSync(join(bin, 'uname'), `#!/bin/sh\ncase "$1" in -s) echo ${os};; -m) echo x86_64;; esac\n`);
        chmodSync(join(bin, 'uname'), 0o755);
        const r = await run('sh', [installer], { PATH: `${bin}:/usr/bin:/bin`, HOME: bin });
        expect(r.code).toBe(1);
        expect(r.out).toContain('install yaaa inside WSL');
        expect(r.out).toContain('wsl --install');
        expect(r.out).not.toContain('Installing yaaa');
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    });
  }
});

describe('notify status', () => {
  it('reports the desktop notifier without an account, and says why email and Discord are unknown', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaaa-notify-'));
    try {
      const env = { ...process.env, YAAA_HOME: home, NO_COLOR: '1', YAAA_NO_UPDATE_CHECK: '1' };
      const r = await run(process.execPath, [main, 'notify', 'status', '--json'], env);
      expect(r.code).toBe(0);
      const j = JSON.parse(r.out);
      expect(j).toMatchObject({ email: null, discord: null });
      expect(typeof j.installed).toBe('boolean');
      expect(j.channels_error).toBeTruthy();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// WSL itself can only be imitated on Linux: WSL_DISTRO_NAME makes isWsl() true there.
describe.runIf(process.platform === 'linux')('in WSL (imitated with WSL_DISTRO_NAME)', () => {
  const env = (home: string): NodeJS.ProcessEnv => ({ ...process.env, YAAA_HOME: home, HOME: home, WSL_DISTRO_NAME: 'Ubuntu', NO_COLOR: '1', YAAA_NO_UPDATE_CHECK: '1' });

  it("notify install refuses (exit 5) and points to email, Discord, and the desk", async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaaa-wsl-'));
    try {
      const r = await run(process.execPath, [main, 'notify', 'install'], env(home));
      expect(r.code).toBe(Exit.conflict);
      expect(r.out).toContain("don't reach Windows from WSL");
      expect(r.out).toContain('yaaa notify email');
      const s = await run(process.execPath, [main, 'notify', 'status', '--json'], env(home));
      expect(JSON.parse(s.out)).toMatchObject({ installed: false, supported: false });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('doctor reports the platform as linux-wsl', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaaa-wsl-'));
    try {
      const r = await run(process.execPath, [main, '--api-url', 'http://127.0.0.1:9', 'doctor', '--json'], env(home));
      expect(JSON.parse(r.out).platform).toBe('linux-wsl');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
