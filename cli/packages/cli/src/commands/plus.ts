import { Command } from 'commander';
import { toJson } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import {
  BillingInterval,
  CliError,
  Exit,
  PlanUsageSchema,
  PlusSubscriptionSchema,
  toYaaaError,
  type CreatePlusCheckoutResponse,
} from '@yaaa/client';
import { key } from '@yaaa/tools';
import { run, type GlobalOpts } from '../context.js';
import { box, c, fmtTime } from '../output.js';
import { openUrl } from '../open.js';
import { clean } from '../sanitize.js';
import { interactive } from '../terminal.js';
import { planLine, planName, planRows, plusLine, plusPriceLine } from '../views.js';

const g = (cmd: Command) => cmd.optsWithGlobals() as GlobalOpts & Record<string, unknown>;

/** Said when billing isn't switched on at the API (metadata feature=plus, status=coming_soon): exit 2, "not live yet". */
export const PLUS_NOT_AVAILABLE = "yaaa Plus isn't available yet. The free plan keeps working as it does.";
export const ALREADY_PLUS =
  'This account already has yaaa Plus. To switch between monthly and yearly, update the card, see invoices, or cancel: `yaaa plus manage`';
export const NO_SUBSCRIPTION = "You don't have yaaa Plus yet: `yaaa plus` starts it.";

/**
 * The API's billing refusals in the CLI's words, with the commands that help. Reason and metadata stay as the API sent
 * them, so `--json` callers can branch on `metadata.reason`.
 */
export function plusError(e: unknown): unknown {
  const err = toYaaaError(e);
  if (err.metadata.feature === 'plus' && err.metadata.status === 'coming_soon') return new CliError(PLUS_NOT_AVAILABLE, Exit.usage, err.reason, err.metadata);
  if (err.metadata.reason === 'already_plus') return new CliError(ALREADY_PLUS, Exit.conflict, err.reason, err.metadata);
  if (err.metadata.reason === 'no_subscription') return new CliError(NO_SUBSCRIPTION, Exit.notFound, err.reason, err.metadata);
  return e;
}

/**
 * Whether to open a billing link in the browser: only for a person at a terminal who didn't pass --no-open. Never with
 * --json or without a terminal, where an agent is reading: it hands the link to the person instead.
 */
export const shouldOpen = (open: unknown, json: boolean): boolean => open !== false && interactive(json);

/** What `yaaa plus --json` prints: the link for the person, and what it costs. */
export function checkoutJson(r: CreatePlusCheckoutResponse) {
  return {
    url: r.url,
    expires_at: r.expiresAt ? timestampDate(r.expiresAt).toISOString() : undefined,
    plan: r.plan,
    price: {
      amount: r.price?.amount?.amount ?? '',
      currency: r.price?.amount?.currencyCode ?? '',
      interval: r.price?.interval ?? '',
    },
  };
}

/** The checkout, as a person sees it. The price comes from the API's response, never from here. */
export function checkoutView(r: CreatePlusCheckoutResponse, opened: boolean): string {
  const interval = r.price?.interval === 'yearly' ? 'yearly' : r.price?.interval === 'monthly' ? 'monthly' : clean(r.price?.interval);
  return [
    ...(opened ? [`${c.ok('✓')} Opened Stripe Checkout in your browser.`] : []),
    box('yaaa Plus', [
      ['plan', [planName(r.plan || 'plus'), interval].filter(Boolean).join(', ')],
      ['price', `${c.bold(plusPriceLine(r.price))} ${c.dim('+ sales tax where it applies')}`],
      ['renewal', 'Renews automatically; cancel any time with `yaaa plus manage`'],
      ['link expires', fmtTime(r.expiresAt)],
    ]),
    // Outside the box: Stripe's links are long, and a terminal copies them whole only on a line of their own.
    opened ? c.dim('If the browser didn’t open, use this link to pay:') : 'Open this link to pay:',
    c.key(clean(r.url)),
    c.dim('You pay on Stripe’s page (Apple Pay, Google Pay, Link, or a card); yaaa never sees your card.'),
    c.dim('Plus starts a few seconds after you pay: `yaaa plus status`.'),
  ].join('\n');
}

export function plusCommands(program: Command): void {
  const plus = program
    .command('plus')
    .description('Start yaaa Plus: more watches and restocks, faster checks, longer watches. Opens Stripe Checkout, where you pay; it renews until you cancel')
    .option('--yearly', 'pay yearly instead of monthly')
    .option('--no-open', 'only print the link')
    .action(async (_o, cmd: Command) => {
      const o = g(cmd);
      await run(o, async ({ clients, out, idempotencyKey }) => {
        const r = await clients.billing
          .createPlusCheckout({
            idempotencyKey: key(idempotencyKey),
            interval: o.yearly ? BillingInterval.YEARLY : BillingInterval.MONTHLY,
          })
          .catch((e: unknown) => {
            throw plusError(e);
          });
        // The link is the person's to open: they pay, and agree to the renewal, there. An agent gets it with --json to
        // hand over word for word; it's opened only for a person at a terminal.
        const opened = shouldOpen(o.open, out.json) && openUrl(r.url);
        out.data(checkoutJson(r), () => checkoutView(r, opened));
      });
    });

  plus
    .command('manage')
    .description('Manage yaaa Plus in Stripe’s billing portal: switch monthly or yearly, update the card, see invoices, or cancel')
    .option('--no-open', 'only print the link')
    .action(async (_o, cmd: Command) => {
      const o = g(cmd);
      await run(o, async ({ clients, out }) => {
        const r = await clients.billing.createBillingPortal({}).catch((e: unknown) => {
          throw plusError(e);
        });
        const opened = shouldOpen(o.open, out.json) && openUrl(r.url);
        out.data({ url: r.url }, () =>
          [
            opened ? `${c.ok('✓')} Opened the billing portal in your browser.\n${c.dim('If it didn’t open: ')}${c.key(clean(r.url))}` : `Open this link to manage yaaa Plus:\n${c.key(clean(r.url))}`,
            c.dim('Cancelling keeps Plus until the end of the period you paid for. Open the link soon: it works once, for a short time.'),
          ].join('\n'),
        );
      });
    });

  plus
    .command('status')
    .description('Your plan, your yaaa Plus subscription, and what’s in use')
    .action(async (_o, cmd: Command) => {
      await run(g(cmd), async ({ clients, out }) => {
        const a = (await clients.auth.getAccount({})).account;
        const json = {
          plan: a?.plan ?? '',
          ...(a?.plus ? { plus: toJson(PlusSubscriptionSchema, a.plus, { useProtoFieldName: true }) } : {}),
          ...(a?.planUsage ? { plan_usage: toJson(PlanUsageSchema, a.planUsage, { useProtoFieldName: true }) } : {}),
        };
        out.data(json, () => {
          const p = a?.plus;
          const rows: Array<[string, string]> = [
            ['plan', planLine(a?.planUsage) || planName(a?.plan ?? '')],
            ['subscription', p ? plusLine(p) : c.dim('none')],
            ...planRows(a?.planUsage),
          ];
          const live = a?.plan === 'plus';
          const next = live
            ? c.dim(p?.cancelAtPeriodEnd ? 'Cancelled: Plus lasts until the end date above. Changed your mind? `yaaa plus manage`' : 'Change or cancel: `yaaa plus manage`')
            : c.dim('yaaa Plus raises these limits and checks watches more often: `yaaa plus`');
          return [box('yaaa plan', rows), next].join('\n');
        });
      });
    });
}
