import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiOrigin, CliError, ConfigStore, connect, credentialsFor, Exit, toYaaaError, type Credentials } from '@yaaa/client';

const PROD = 'https://api.yaaa.io';
const LOCAL = 'http://localhost:7080';
const main = fileURLToPath(new URL('../dist/main.js', import.meta.url));

const creds = (over: Partial<Credentials> = {}): Credentials => ({
  account_id: 'acct_test',
  access_token: 'access',
  refresh_token: 'refresh-secret',
  // Already expired, so any use would try a refresh first.
  access_expires_at: new Date(Date.now() - 60_000).toISOString(),
  ...over,
});

/** A TCP listener that only counts connections: proof that nothing was sent to it. */
async function listener(): Promise<{ url: string; connections: () => number; close: () => Promise<void> }> {
  let n = 0;
  const server: Server = createServer((s) => {
    n++;
    s.destroy();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, connections: () => n, close: () => new Promise((ok) => server.close(() => ok())) };
}

/** Runs the built CLI with its own config folder. */
function cli(home: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, YAAA_HOME: home, NO_COLOR: '1' };
  delete env.YAAA_API_URL;
  delete env.YAAA_PROFILE;
  return new Promise((ok) =>
    execFile(process.execPath, [main, ...args], { env }, (e, stdout, stderr) => ok({ code: e ? Number(e.code ?? 1) : 0, stdout, stderr })),
  );
}

let home: string;
let store: ConfigStore;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yaaa-creds-'));
  store = new ConfigStore(home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('apiOrigin', () => {
  it('compares APIs by scheme, host and port', () => {
    expect(apiOrigin('https://API.yaaa.io/')).toBe(PROD);
    expect(apiOrigin('https://api.yaaa.io:443')).toBe(PROD);
    expect(apiOrigin('http://localhost:7080/')).toBe(LOCAL);
    expect(apiOrigin('http://localhost:7081')).not.toBe(LOCAL);
  });
});

describe('credentials belong to one API', () => {
  it('are used for the API they were saved with', () => {
    store.saveCredentials('default', creds({ api_url: PROD }));
    expect(credentialsFor(store, 'default', 'https://api.yaaa.io/')?.account_id).toBe('acct_test');
  });

  it('are refused for another API, with the profile that fits', () => {
    store.saveCredentials('default', creds({ api_url: PROD }));
    let err: unknown;
    try {
      credentialsFor(store, 'default', LOCAL);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exit).toBe(Exit.auth);
    expect((err as CliError).message).toContain(`signed in to ${PROD}, not ${LOCAL}`);
    expect((err as CliError).message).toContain('--profile local');
  });

  it("treat credentials saved before api_url as the profile's own", () => {
    store.saveCredentials('local', creds());
    expect(store.signedInTo('local')).toBe(LOCAL);
    expect(credentialsFor(store, 'local', LOCAL)).toBeDefined();
    expect(() => credentialsFor(store, 'local', PROD)).toThrow(/signed in to http:\/\/localhost:7080/);
  });

  it('send no token and make no refresh call to another API', async () => {
    const other = await listener();
    try {
      store.saveCredentials('default', creds({ api_url: PROD }));
      const clients = connect({ apiUrl: other.url, profile: 'default', store, timeoutMs: 2000 });
      await expect(clients.accessToken()).rejects.toMatchObject({ exit: Exit.auth });
      const call = await clients.auth.getAccount({}).then(() => undefined, (e: unknown) => toYaaaError(e));
      expect(call).toMatchObject({ exit: Exit.auth, reason: 'UNAUTHENTICATED' });
      expect(other.connections()).toBe(0);
    } finally {
      await other.close();
    }
  });
});

describe('commands with a profile signed in to another API', () => {
  const save = (c: Credentials) =>
    writeFileSync(join(home, 'config.json'), JSON.stringify({ credentials: { default: c } }), { mode: 0o600 });

  it('init refuses (exit 5) and keeps the credentials', async () => {
    const other = await listener();
    try {
      save(creds({ api_url: PROD }));
      const r = await cli(home, ['--api-url', other.url, 'init', '--no-skills', '--json']);
      expect(r.code).toBe(Exit.conflict);
      expect(r.stderr + r.stdout).toContain(`signed in to ${PROD}`);
      expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).credentials.default.api_url).toBe(PROD);
      expect(other.connections()).toBe(0);
    } finally {
      await other.close();
    }
  });

  it("logout refuses (exit 5) rather than send the refresh token elsewhere", async () => {
    const other = await listener();
    try {
      save(creds({ api_url: PROD }));
      const r = await cli(home, ['--api-url', other.url, 'logout', '--json']);
      expect(r.code).toBe(Exit.conflict);
      expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).credentials.default).toBeDefined();
      expect(other.connections()).toBe(0);
    } finally {
      await other.close();
    }
  });

  it('doctor says which API the profile is signed in to', async () => {
    save(creds({ api_url: PROD }));
    // Nothing listens on port 9: the API check fails, which is fine here.
    const r = await cli(home, ['--api-url', 'http://127.0.0.1:9', 'doctor', '--json']);
    const report = JSON.parse(r.stdout);
    expect(report.account.ok).toBe(false);
    expect(report.account.signed_in_to).toBe(PROD);
    expect(report.account.error).toContain(`not http://127.0.0.1:9`);
  });
});
