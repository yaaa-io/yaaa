import { Command } from 'commander';
import { create } from '@bufbuild/protobuf';
import { DurationSchema, timestampDate } from '@bufbuild/protobuf/wkt';
import { CliError } from '@yaaa/client';
import { run, type GlobalOpts } from '../context.js';
import { c } from '../output.js';

const g = (cmd: Command) => cmd.optsWithGlobals() as GlobalOpts & Record<string, unknown>;

/** "15m", "36h", "2d", "1d12h" -> seconds. */
export function parseDuration(s: string): number {
  const re = /(\d+)\s*([dhms])/gi;
  let total = 0;
  let matched = '';
  for (const m of s.matchAll(re)) {
    const n = Number(m[1]);
    total += n * { d: 86400, h: 3600, m: 60, s: 1 }[m[2]!.toLowerCase() as 'd' | 'h' | 'm' | 's'];
    matched += m[0];
  }
  if (!total || matched.replace(/\s/g, '') !== s.replace(/\s/g, '')) throw new CliError(`'${s}' isn't a duration. Use something like 15m, 36h, or 2d.`);
  return total;
}

/**
 * Whether `yaaa --help` lists `dev`, `--profile` and `--api-url`: only for the local profile or with YAAA_DEV=1. It's hidden from buyers and their
 * agents, not locked: the commands still run when typed, and the API refuses them unless ENVIRONMENT=local.
 */
export function showDevCommands(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.YAAA_DEV === '1') return true;
  const i = argv.indexOf('--profile');
  const profile = argv.find((a) => a.startsWith('--profile='))?.slice('--profile='.length) ?? (i >= 0 ? argv[i + 1] : env.YAAA_PROFILE);
  return profile === 'local';
}

/** Local-only helpers. The API refuses them unless it runs with ENVIRONMENT=local. */
export function devCommands(program: Command): void {
  const dev = program
    .command('dev', { hidden: !showDevCommands() })
    .description('Local development helpers (only against a local API)');

  dev
    .command('clock [advance] [by]')
    .description('Show the API’s clock, or move it forward and run every task that came due: `yaaa dev clock advance 1d`')
    .action(async (action: string | undefined, by: string | undefined, _o, cmd: Command) => {
      await run(g(cmd), async ({ clients, out }) => {
        if (!action) {
          const r = await clients.dev.getClock({});
          const now = r.now ? timestampDate(r.now).toISOString() : '';
          out.data({ now, offset_seconds: Number(r.offset?.seconds ?? 0n) }, () => `${now} ${c.dim(`(offset ${Number(r.offset?.seconds ?? 0n)}s)`)}`);
          return;
        }
        if (action !== 'advance' || !by) throw new CliError('Usage: yaaa dev clock advance <duration>, like 15m or 1d');
        const r = await clients.dev.advanceClock({ by: create(DurationSchema, { seconds: BigInt(parseDuration(by)) }) });
        const now = r.now ? timestampDate(r.now).toISOString() : '';
        out.data({ now, ran: r.ran }, () => [`${c.ok('✓')} clock is now ${now}`, ...r.ran.map((t) => `  ${c.dim('ran')} ${t}`)].join('\n'));
      });
    });

  dev
    .command('reset')
    .description('Empty the local database and reset fake-store and the clock')
    .action(async (_o, cmd: Command) => {
      await run(g(cmd), async ({ clients, store, profile, out }) => {
        await clients.dev.reset({});
        store.clearCredentials(profile);
        store.set(profile, 'alerts_cursor', '');
        store.set(profile, 'notify_cursor', '');
        out.data({ reset: true }, () => `${c.ok('✓')} Reset. Run \`yaaa init\` to make a new account.`);
      });
    });

  dev
    .command('price <handle> [price]')
    .description('Change a fake-store product: `yaaa dev price ferro-65 248 --variant brass`')
    .option('--variant <title>', 'only this variant')
    .option('--in-stock', 'mark it in stock')
    .option('--out-of-stock', 'mark it sold out')
    .action(async (handle: string, price: string | undefined, _o, cmd: Command) => {
      const o = g(cmd);
      await run(o, async ({ clients, out }) => {
        const setAvailable = Boolean(o.inStock || o.outOfStock);
        await clients.dev.setFakeProduct({
          handle,
          variantTitle: (o.variant as string | undefined) ?? '',
          price: price ?? '',
          available: Boolean(o.inStock),
          setAvailable,
        });
        out.data({ handle, price: price ?? null, available: setAvailable ? Boolean(o.inStock) : null }, () => `${c.ok('✓')} fake-store ${handle} updated`);
      });
    });

  dev
    .command('complete <purchase_id>')
    .description('Pay a confirm link’s checkout as if the buyer did, in fake-store')
    .action(async (id: string, _o, cmd: Command) => {
      await run(g(cmd), async ({ clients, out }) => {
        const r = await clients.dev.completeFakeCheckout({ purchaseId: id });
        out.data({ purchase_id: id, order_number: r.orderNumber }, () => `${c.ok('✓')} order ${r.orderNumber} placed`);
      });
    });
}
