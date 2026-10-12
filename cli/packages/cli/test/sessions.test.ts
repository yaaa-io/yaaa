import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttp2Server, type Http2Server } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { CliError, ConfigStore, connect, credentialsFor, Exit, RefreshRequestSchema, RefreshResponseSchema, type Credentials } from '@yaaa/client';

const main = fileURLToPath(new URL('../dist/main.js', import.meta.url));

const creds = (over: Partial<Credentials> = {}): Credentials => ({
  account_id: 'acct_test',
  access_token: 'access-0',
  refresh_token: 'refresh-0',
  access_expires_at: new Date(Date.now() - 60_000).toISOString(),
  ...over,
});

/** Runs the built CLI with its own config folder, without a terminal (as an agent runs it). */
function cli(home: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, YAAA_HOME: home, NO_COLOR: '1' };
  delete env.YAAA_API_URL;
  delete env.YAAA_PROFILE;
  return new Promise((ok) => {
    const child = execFile(process.execPath, [main, ...args], { env }, (e, stdout, stderr) => ok({ code: e ? Number(e.code ?? 1) : 0, stdout, stderr }));
    child.stdin?.end(input ?? '');
  });
}

/**
 * A gRPC server with only AuthService/Refresh: it hands out refresh-<n> tokens, and counts the calls and the tokens it
 * was given, so a test can see whether one refresh token was presented twice.
 */
async function refreshServer(delayMs = 150): Promise<{ url: string; presented: string[]; close: () => Promise<void> }> {
  const presented: string[] = [];
  const server: Http2Server = createHttp2Server();
  // The clients keep their connections open; close them with the server.
  const sessions = new Set<import('node:http2').ServerHttp2Session>();
  server.on('session', (s) => {
    sessions.add(s);
    s.on('close', () => sessions.delete(s));
  });
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => {
      if (headers[':path'] !== '/yaaa.v1.AuthService/Refresh') {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '12' }, { endStream: true });
        return;
      }
      const body = Buffer.concat(chunks);
      const req = fromBinary(RefreshRequestSchema, body.subarray(5));
      presented.push(req.refreshToken);
      const n = presented.length;
      setTimeout(() => {
        const msg = toBinary(
          RefreshResponseSchema,
          create(RefreshResponseSchema, {
            accessToken: `access-${n}`,
            refreshToken: `refresh-${n}`,
            accessTokenExpiresAt: timestampFromDate(new Date(Date.now() + 3600_000)),
          }),
        );
        const frame = Buffer.alloc(5 + msg.length);
        frame.writeUInt32BE(msg.length, 1);
        Buffer.from(msg).copy(frame, 5);
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
        stream.end(frame);
      }, delayMs);
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, presented, close: () => new Promise((ok) => { for (const s of sessions) s.destroy(); server.close(() => ok()); }) };
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yaaa-sessions-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('the config file', () => {
  it('is written whole, 0600, with no temporary files or lock left behind', () => {
    const store = new ConfigStore(home);
    store.saveCredentials('default', creds({ api_url: 'https://api.yaaa.io' }));
    store.set('default', 'alerts_cursor', '7');
    expect(readdirSync(home).sort()).toEqual(['config.json']);
    if (process.platform !== 'win32') expect(statSync(join(home, 'config.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).state.default.alerts_cursor).toBe('7');
  });

  it("that doesn't parse is never written back, and says how to fix it", () => {
    const file = join(home, 'config.json');
    writeFileSync(file, '{"credentials": {"default": {"refresh_token": "keep-me"', { mode: 0o600 });
    const store = new ConfigStore(home);
    expect(() => store.credentials('default')).toThrow(CliError);
    expect(() => store.set('default', 'alerts_cursor', '1')).toThrow(/isn't valid JSON/);
    expect(() => store.saveCredentials('default', creds())).toThrow(CliError);
    expect(readFileSync(file, 'utf8')).toBe('{"credentials": {"default": {"refresh_token": "keep-me"');
  });

  it('a command reports it instead of starting over', async () => {
    writeFileSync(join(home, 'config.json'), 'not json', { mode: 0o600 });
    const r = await cli(home, ['--api-url', 'http://127.0.0.1:9', 'init', '--no-skills', '--json']);
    expect(r.code).toBe(Exit.unexpected);
    expect(r.stdout).toContain("isn't valid JSON");
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe('not json');
  });

  it('keeps every change when several processes write at once', async () => {
    const client = fileURLToPath(new URL('../../client/dist/index.js', import.meta.url));
    const script = (i: number) =>
      `import(${JSON.stringify(client)}).then(({ ConfigStore }) => { const s = new ConfigStore(${JSON.stringify(home)}); for (let j = 0; j < 20; j++) s.set('p${i}', 'k' + j, String(j)); })`;
    await Promise.all(
      [0, 1, 2, 3].map(
        (i) => new Promise<void>((ok, fail) => execFile(process.execPath, ['--input-type=module', '-e', script(i)], (e) => (e ? fail(e) : ok()))),
      ),
    );
    const state = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).state;
    for (const i of [0, 1, 2, 3]) expect(Object.keys(state[`p${i}`])).toHaveLength(20);
  });
});

describe('refreshing', () => {
  it('two processes refreshing at once present the refresh token once; the second uses the first one’s result', async () => {
    const api = await refreshServer();
    try {
      // Two stores on one folder behave like two processes: each has its own in-memory state.
      new ConfigStore(home).saveCredentials('default', creds({ api_url: api.url }));
      const a = connect({ apiUrl: api.url, profile: 'default', store: new ConfigStore(home), timeoutMs: 5000 });
      const b = connect({ apiUrl: api.url, profile: 'default', store: new ConfigStore(home), timeoutMs: 5000 });
      const [ta, tb] = await Promise.all([a.accessToken(), b.accessToken()]);
      expect(api.presented).toEqual(['refresh-0']);
      expect(ta).toBe('access-1');
      expect(tb).toBe('access-1');
      expect(new ConfigStore(home).credentials('default')?.refresh_token).toBe('refresh-1');
    } finally {
      await api.close();
    }
  });
});

describe('credentials whose API is unknown', () => {
  it('are sent nowhere', () => {
    const store = new ConfigStore(home);
    store.saveCredentials('staging', creds()); // an unnamed profile, saved without api_url by an older yaaa
    let err: unknown;
    try {
      credentialsFor(store, 'staging', 'https://staging.yaaa.example');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exit).toBe(Exit.auth);
    expect((err as CliError).message).toContain("doesn't say which API");
  });

  it("get their profile's API written in when the profile names one", () => {
    const store = new ConfigStore(home);
    store.saveCredentials('local', creds());
    expect(credentialsFor(store, 'local', 'http://localhost:7080')?.api_url).toBe('http://localhost:7080');
    expect(store.credentials('local')?.api_url).toBe('http://localhost:7080');
  });
});

describe('secrets only on a terminal', () => {
  const signedIn = () =>
    writeFileSync(join(home, 'config.json'), JSON.stringify({ credentials: { default: creds({ api_url: 'http://127.0.0.1:9' }) } }), { mode: 0o600 });

  for (const [args, command] of [
    [['recovery-key'], 'yaaa recovery-key'],
    [['recovery-key', '--replace'], 'yaaa recovery-key --replace'],
    [['desk'], 'yaaa desk'],
    [['login'], 'yaaa login'],
  ] as const) {
    it(`\`${command}\` without one says to run it in a terminal and calls nothing`, async () => {
      signedIn();
      // Nothing listens on port 9: any call would fail, so exit 0 shows nothing was called.
      const r = await cli(home, ['--api-url', 'http://127.0.0.1:9', ...args, '--json']);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out).toMatchObject({ needs_terminal: true, command });
      expect(out.recovery_key).toBeUndefined();
      expect(out.url).toBeUndefined();
      expect(out.message).toContain('their own terminal');
    });
  }

  it('`init --restore -` reads the key from stdin', async () => {
    // The restore call fails (nothing listens), but only after the key was read: an empty stdin is refused before.
    const empty = await cli(home, ['--api-url', 'http://127.0.0.1:9', 'init', '--restore', '-', '--no-skills', '--json'], '');
    expect(empty.code).toBe(Exit.usage);
    expect(JSON.parse(empty.stdout).error.message).toContain('Give the recovery key');
    const given = await cli(home, ['--api-url', 'http://127.0.0.1:9', 'init', '--restore', '-', '--no-skills', '--json'], 'AAAA-BBBB\n');
    expect(given.code).toBe(Exit.retryable);
  });
});

/** A gRPC server that refuses every call as unauthenticated, like an API whose account was removed. */
async function refusingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Http2Server = createHttp2Server();
  const sessions = new Set<import('node:http2').ServerHttp2Session>();
  server.on('session', (s) => {
    sessions.add(s);
    s.on('close', () => sessions.delete(s));
  });
  server.on('stream', (stream) => {
    stream.on('data', () => undefined);
    stream.on('end', () => stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '16', 'grpc-message': 'refused' }, { endStream: true }));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((ok) => { for (const s of sessions) s.destroy(); server.close(() => ok()); }) };
}

describe('init with a saved sign-in', () => {
  it('that the API refuses says how to get the account back, instead of "Using"', async () => {
    const api = await refusingServer();
    try {
      new ConfigStore(home).saveCredentials('default', creds({ api_url: api.url }));
      const r = await cli(home, ['--api-url', api.url, 'init', '--no-skills', '--json']);
      expect(r.code).toBe(Exit.auth);
      const msg = JSON.parse(r.stdout).error.message as string;
      expect(msg).toContain('acct_test');
      expect(msg).toContain('yaaa init --restore');
      expect(msg).toContain('yaaa logout');
    } finally {
      await api.close();
    }
  });

  it('with the API unreachable still sets up the skills', async () => {
    new ConfigStore(home).saveCredentials('default', creds({ api_url: 'http://127.0.0.1:9' }));
    const r = await cli(home, ['--api-url', 'http://127.0.0.1:9', 'init', '--no-skills', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ account_id: 'acct_test', created: false });
  });
});
