import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttp2Server, type Http2Server, type ServerHttp2Session } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create, fromBinary, toBinary, type DescMessage, type MessageShape } from '@bufbuild/protobuf';
import { anyPack, AnySchema, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import {
  AccountSchema,
  BillingInterval,
  ConfigStore,
  CreateBillingPortalResponseSchema,
  CreatePlusCheckoutRequestSchema,
  CreatePlusCheckoutResponseSchema,
  ErrorDetailSchema,
  ErrorDetail_Reason,
  Exit,
  GetAccountResponseSchema,
  MoneySchema,
  PlanAllowanceSchema,
  PlanUsageSchema,
  PlusPriceSchema,
  PlusSubscriptionSchema,
} from '@yaaa/client';

const main = fileURLToPath(new URL('../dist/main.js', import.meta.url));

const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3#fidkdWxOYHwnPyd1blpxYHZxWjA0';
const PORTAL_URL = 'https://billing.stripe.com/p/session/test_YWNjdF8x';

type Reply = { message: Uint8Array } | { error: { code: number; reason: ErrorDetail_Reason; message: string; metadata: Record<string, string> } };

const ok = <D extends DescMessage>(schema: D, init: Parameters<typeof create<D>>[1]): Reply => ({ message: toBinary(schema, create(schema, init) as MessageShape<D>) });

/** google.rpc.Status with one yaaa ErrorDetail, as the API sends it in grpc-status-details-bin. */
function statusDetails(code: number, message: string, reason: ErrorDetail_Reason, metadata: Record<string, string>): string {
  const detail = anyPack(ErrorDetailSchema, create(ErrorDetailSchema, { reason, message, metadata }));
  const w = new BinaryWriter();
  w.tag(1, WireType.Varint).int32(code);
  w.tag(2, WireType.LengthDelimited).string(message);
  w.tag(3, WireType.LengthDelimited).bytes(toBinary(AnySchema, detail));
  return Buffer.from(w.finish()).toString('base64');
}

/**
 * A gRPC server for the calls `yaaa plus` and `whoami` make. Each path answers with what `replies` holds for it, and
 * every request body is kept, so a test can check what the CLI sent.
 */
async function fakeApi(): Promise<{ url: string; replies: Map<string, Reply>; requests: Map<string, Uint8Array[]>; close: () => Promise<void> }> {
  const replies = new Map<string, Reply>();
  const requests = new Map<string, Uint8Array[]>();
  const server: Http2Server = createHttp2Server();
  const sessions = new Set<ServerHttp2Session>();
  server.on('session', (s) => {
    sessions.add(s);
    s.on('close', () => sessions.delete(s));
  });
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => {
      const path = String(headers[':path']);
      const body = Buffer.concat(chunks).subarray(5);
      requests.set(path, [...(requests.get(path) ?? []), new Uint8Array(body)]);
      const reply = replies.get(path);
      if (!reply) {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '12' }, { endStream: true });
        return;
      }
      if ('error' in reply) {
        const { code, reason, message, metadata } = reply.error;
        stream.respond(
          {
            ':status': 200,
            'content-type': 'application/grpc',
            'grpc-status': String(code),
            'grpc-message': encodeURIComponent(message),
            'grpc-status-details-bin': statusDetails(code, message, reason, metadata),
          },
          { endStream: true },
        );
        return;
      }
      const frame = Buffer.alloc(5 + reply.message.length);
      frame.writeUInt32BE(reply.message.length, 1);
      Buffer.from(reply.message).copy(frame, 5);
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end(frame);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    replies,
    requests,
    close: () =>
      new Promise((done) => {
        for (const s of sessions) s.destroy();
        server.close(() => done());
      }),
  };
}

const CHECKOUT = '/yaaa.v1.BillingService/CreatePlusCheckout';
const PORTAL = '/yaaa.v1.BillingService/CreateBillingPortal';
const GET_ACCOUNT = '/yaaa.v1.AuthService/GetAccount';

const checkout = (interval: 'monthly' | 'yearly', amount: string): Reply =>
  ok(CreatePlusCheckoutResponseSchema, {
    url: CHECKOUT_URL,
    expiresAt: timestampFromDate(new Date('2026-10-14T18:00:00Z')),
    plan: 'plus',
    price: create(PlusPriceSchema, { amount: create(MoneySchema, { amount, currencyCode: 'USD' }), interval }),
  });

const allowance = (used: number, limit: number) => create(PlanAllowanceSchema, { used, limit });

const account = (plan: 'free' | 'plus', plus?: { status: string; cancelAtPeriodEnd?: boolean }): Reply =>
  ok(GetAccountResponseSchema, {
    account: create(AccountSchema, {
      accountId: 'acct_plus',
      plan,
      planUsage: create(PlanUsageSchema, {
        plan,
        priceWatches: allowance(3, plan === 'plus' ? 50 : 5),
        filterWatches: allowance(1, plan === 'plus' ? 25 : 3),
        restocks: allowance(0, plan === 'plus' ? 25 : 3),
        quotesToday: allowance(2, plan === 'plus' ? 200 : 30),
        priceCheckMinutes: plan === 'plus' ? 15 : 60,
        filterCheckMinutes: plan === 'plus' ? 180 : 720,
        longestWatchDays: plan === 'plus' ? 90 : 30,
      }),
      ...(plus
        ? {
            plus: create(PlusSubscriptionSchema, {
              status: plus.status,
              interval: 'monthly',
              renewsAt: timestampFromDate(new Date('2026-11-13T12:00:00Z')),
              cancelAtPeriodEnd: plus.cancelAtPeriodEnd ?? false,
            }),
          }
        : {}),
    }),
  });

let api: Awaited<ReturnType<typeof fakeApi>>;
let home: string;
let bin: string;
let opened: string;

beforeAll(async () => {
  api = await fakeApi();
});
afterAll(() => api.close());

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yaaa-plus-'));
  // Browser openers that only leave a mark: nothing in these tests may open a link.
  bin = join(home, 'bin');
  opened = join(home, 'opened');
  mkdirSync(bin);
  for (const name of ['open', 'xdg-open', 'wslview']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$@" >> "${opened}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  new ConfigStore(home).saveCredentials('default', {
    account_id: 'acct_plus',
    access_token: 'access-0',
    refresh_token: 'refresh-0',
    access_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    api_url: api.url,
  });
  api.replies.clear();
  api.requests.clear();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Runs the built CLI against the fake API, without a terminal (as an agent runs it). */
function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, YAAA_HOME: home, NO_COLOR: '1', PATH: `${bin}:${process.env.PATH}` };
  delete env.YAAA_PROFILE;
  delete env.YAAA_DEV;
  return new Promise((done) => {
    const child = execFile(process.execPath, [main, '--api-url', api.url, ...args], { env }, (e, stdout, stderr) =>
      done({ code: e ? Number(e.code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin?.end('');
  });
}

const sent = () => fromBinary(CreatePlusCheckoutRequestSchema, api.requests.get(CHECKOUT)!.at(-1)!);

describe('yaaa plus', () => {
  it('--json returns the link, when it expires, the plan and the price, and opens nothing', async () => {
    api.replies.set(CHECKOUT, checkout('monthly', '6.99'));
    const r = await cli(['plus', '--json']);
    expect(r.code).toBe(Exit.ok);
    expect(JSON.parse(r.stdout)).toEqual({
      url: CHECKOUT_URL,
      expires_at: '2026-10-14T18:00:00.000Z',
      plan: 'plus',
      price: { amount: '6.99', currency: 'USD', interval: 'monthly' },
    });
    expect(sent().interval).toBe(BillingInterval.MONTHLY);
    // A generated idempotency key when none is given.
    expect(sent().idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(opened)).toBe(false);
  });

  it('--yearly asks for the yearly price, with the idempotency key given', async () => {
    api.replies.set(CHECKOUT, checkout('yearly', '59.00'));
    const r = await cli(['--idempotency-key', 'plus-try-1', 'plus', '--yearly', '--json']);
    expect(r.code).toBe(Exit.ok);
    expect(sent().interval).toBe(BillingInterval.YEARLY);
    expect(sent().idempotencyKey).toBe('plus-try-1');
    expect(JSON.parse(r.stdout).price).toEqual({ amount: '59.00', currency: 'USD', interval: 'yearly' });
  });

  it('shows a person the plan, the price from the API, the renewal and the link; without a terminal it opens nothing', async () => {
    api.replies.set(CHECKOUT, checkout('monthly', '6.99'));
    const r = await cli(['plus']);
    expect(r.code).toBe(Exit.ok);
    expect(r.stdout).toContain('yaaa Plus, monthly');
    expect(r.stdout).toContain('$6.99/month');
    expect(r.stdout).toContain('Renews automatically; cancel any time with `yaaa plus manage`');
    expect(r.stdout).toContain(CHECKOUT_URL);
    expect(r.stdout).not.toContain('Opened');
    expect(existsSync(opened)).toBe(false);
  });

  it('takes the price from the response, never its own', async () => {
    api.replies.set(CHECKOUT, checkout('yearly', '64.00'));
    const r = await cli(['plus', '--yearly']);
    expect(r.stdout).toContain('$64/year');
    expect(r.stdout).not.toContain('$59');
  });

  it('already Plus: exit 5, pointing to yaaa plus manage', async () => {
    api.replies.set(CHECKOUT, {
      error: { code: 9, reason: ErrorDetail_Reason.CONFLICT, message: 'This account already has yaaa Plus.', metadata: { reason: 'already_plus', plan: 'plus' } },
    });
    const rich = await cli(['plus']);
    expect(rich.code).toBe(Exit.conflict);
    expect(rich.stderr).toContain('already has yaaa Plus');
    expect(rich.stderr).toContain('`yaaa plus manage`');
    const json = await cli(['plus', '--json']);
    expect(json.code).toBe(Exit.conflict);
    expect(JSON.parse(json.stdout)).toMatchObject({ error: { reason: 'CONFLICT', metadata: { reason: 'already_plus' } }, exit_code: Exit.conflict });
  });

  it("billing off: exit 2, yaaa Plus isn't available yet", async () => {
    api.replies.set(CHECKOUT, {
      error: { code: 3, reason: ErrorDetail_Reason.INVALID_ARGUMENT, message: 'not yet', metadata: { feature: 'plus', status: 'coming_soon' } },
    });
    const r = await cli(['plus']);
    expect(r.code).toBe(Exit.usage);
    expect(r.stderr).toContain("yaaa Plus isn't available yet");
    const json = await cli(['plus', '--json']);
    expect(JSON.parse(json.stdout)).toMatchObject({ error: { metadata: { feature: 'plus', status: 'coming_soon' } }, exit_code: Exit.usage });
  });
});

describe('yaaa plus manage', () => {
  it('--json returns the portal link and opens nothing; rich prints it without a terminal', async () => {
    api.replies.set(PORTAL, ok(CreateBillingPortalResponseSchema, { url: PORTAL_URL }));
    const json = await cli(['plus', 'manage', '--json']);
    expect(json.code).toBe(Exit.ok);
    expect(JSON.parse(json.stdout)).toEqual({ url: PORTAL_URL });
    const rich = await cli(['plus', 'manage']);
    expect(rich.stdout).toContain(PORTAL_URL);
    expect(existsSync(opened)).toBe(false);
  });

  it('never subscribed: exit 6, pointing to yaaa plus', async () => {
    api.replies.set(PORTAL, {
      error: { code: 5, reason: ErrorDetail_Reason.NOT_FOUND, message: 'never had Plus', metadata: { reason: 'no_subscription' } },
    });
    const r = await cli(['plus', 'manage']);
    expect(r.code).toBe(Exit.notFound);
    expect(r.stderr).toContain("You don't have yaaa Plus yet: `yaaa plus`");
  });
});

describe('yaaa plus status', () => {
  it('--json gives the plan, the subscription and plan_usage as proto JSON', async () => {
    api.replies.set(GET_ACCOUNT, account('plus', { status: 'active', cancelAtPeriodEnd: true }));
    const r = await cli(['plus', 'status', '--json']);
    expect(r.code).toBe(Exit.ok);
    expect(JSON.parse(r.stdout)).toMatchObject({
      plan: 'plus',
      plus: { status: 'active', interval: 'monthly', renews_at: '2026-11-13T12:00:00Z', cancel_at_period_end: true },
      plan_usage: { plan: 'plus', price_watches: { used: 3, limit: 50 }, price_check_minutes: 15 },
    });
  });

  it('shows a free account its usage, and how to get Plus', async () => {
    api.replies.set(GET_ACCOUNT, account('free'));
    const r = await cli(['plus', 'status']);
    expect(r.stdout).toContain('3 of 5');
    expect(r.stdout).toContain('none');
    expect(r.stdout).toContain('`yaaa plus`');
  });

  it('shows a cancelled subscription ending, not renewing', async () => {
    api.replies.set(GET_ACCOUNT, account('plus', { status: 'active', cancelAtPeriodEnd: true }));
    const r = await cli(['plus', 'status']);
    expect(r.stdout).toMatch(/active · monthly · ends Nov 13, 2026/);
    expect(r.stdout).toContain('`yaaa plus manage`');
  });
});

describe('yaaa whoami', () => {
  it('shows the Plus subscription when there is one', async () => {
    api.replies.set(GET_ACCOUNT, account('plus', { status: 'active' }));
    const r = await cli(['whoami']);
    expect(r.code).toBe(Exit.ok);
    expect(r.stdout).toMatch(/plus\s+active · monthly · renews Nov 13, 2026/);
  });

  it('has no Plus line without one', async () => {
    api.replies.set(GET_ACCOUNT, account('free'));
    const r = await cli(['whoami']);
    expect(r.stdout).not.toMatch(/│ plus /);
  });
});

describe('the rules agents follow for yaaa Plus', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const buyer = read('../../skills/yaaa-buyer/SKILL.md');
  const advisor = read('../../skills/yaaa-advisor/SKILL.md');
  // agent.md is part of the site, which the public mirror (yaaa-io/yaaa) doesn't include: there, only the skills are
  // checked.
  const guidePath = fileURLToPath(new URL('../../../../site/public/agent.md', import.meta.url));
  const guides = existsSync(guidePath) ? [readFileSync(guidePath, 'utf8')] : [];

  it('say to suggest it only at a plan limit or when asked, with its price and renewal, and never to open or pay', () => {
    for (const text of [buyer, ...guides]) {
      expect(text).toContain('`PLAN_LIMIT`');
      expect(text).toMatch(/renews automatically until (they|the person) cancel/);
      expect(text).toContain('$6.99 a month or $59 a year');
      expect(text).toMatch(/Never open,? (it, )?fill/);
      expect(text).toContain('`yaaa plus manage');
    }
  });

  it('list yaaa plus and yaaa plus manage among the commands run only when asked', () => {
    for (const text of [buyer, advisor, ...guides]) expect(text).toContain('`yaaa plus` or `yaaa plus manage`, or ');
  });
});
