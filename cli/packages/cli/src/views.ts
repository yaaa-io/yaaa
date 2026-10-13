import {
  PurchaseStatus,
  RestockStatus,
  StoreLevel,
  FilterWatchStatus,
  WatchStatus,
  type FilterMatch,
  type FilterWatch,
  type PlanUsage,
  type PlusPrice,
  type PlusSubscription,
  type PriceHistory,
  type PriceWatch,
  type Product,
  type Purchase,
  type Restock,
  type StatusItem,
} from '@yaaa/client';
import { box, c, fmtDate, fmtMoney, fmtTime, table } from './output.js';
import { clean } from './sanitize.js';

export const levelLabel = (l: StoreLevel): string =>
  l === StoreLevel.CHECKOUT ? c.ok('checkout') : l === StoreLevel.CATALOG ? c.warn('catalog only') : c.dim('unsupported');

/** "4.6 ★ (69,657)", or '' when the catalog has no rating. */
export const fmtRating = (p: Product): string =>
  p.rating && p.rating.count > 0n ? `${p.rating.value.toFixed(1)} ★ ${c.dim(`(${p.rating.count.toLocaleString('en-US')})`)}` : '';

/** "allbirds.com", plus "+2 stores" when others sell the same product. */
const storeCell = (p: Product): string =>
  `${clean(p.store?.domain)}${p.otherStores.length > 0 ? c.dim(` +${p.otherStores.length} store${p.otherStores.length > 1 ? 's' : ''}`) : ''}`;

export function productsTable(ps: Product[]): string {
  return table(
    ['PRODUCT', 'TITLE', 'STORE', 'PRICE', 'RATING', 'STOCK'],
    ps.map((p) => [
      c.key(clean(p.productId)),
      clean(p.title),
      storeCell(p),
      fmtMoney(p.price),
      fmtRating(p) || c.dim('–'),
      p.available ? c.ok('in stock') : c.dim('sold out'),
    ]),
  );
}

/** A search result's three lines beside its thumbnail: title, where and how much, and its id. */
export function productCard(p: Product, width = (process.stdout.columns || 100) - 14): string[] {
  const fit = (s: string) => (s.length > width ? `${s.slice(0, Math.max(width - 1, 1))}…` : s);
  return [
    c.bold(fit(clean(p.title))),
    [storeCell(p), fmtMoney(p.price), fmtRating(p), p.available ? c.ok('in stock') : c.dim('sold out')]
      .filter(Boolean)
      .join(c.dim(' · ')),
    c.key(clean(p.productId)),
  ];
}

/** Breaks text into lines of at most `width` characters, at spaces. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return line ? [...lines, line] : lines;
}

export function productView(p: Product): string {
  const width = Math.min((process.stdout.columns || 100) - 16, 72);
  const rows: Array<[string, string]> = [
    ['id', c.key(clean(p.productId))],
    ['store', `${clean(p.store?.name)} · ${clean(p.store?.domain)} · ${levelLabel(p.store?.level ?? StoreLevel.UNSPECIFIED)}`],
    ['url', clean(p.url)],
    ...(fmtRating(p) ? [['rating', fmtRating(p)] as [string, string]] : []),
    ...wrap(clean(p.description), width).map((l, i): [string, string] => [i === 0 ? 'about' : '', c.dim(l)]),
    ...p.features.map((f, i): [string, string] => [i === 0 ? 'features' : '', `• ${clean(f)}`]),
    ...p.variants.map((v): [string, string] => [
      clean(v.title),
      `${fmtMoney(v.price)} ${v.available ? c.ok('in stock') : c.dim('sold out')} ${c.dim(clean(v.variantId))}`,
    ]),
    ...p.otherStores.map((o, i): [string, string] => [
      i === 0 ? 'also at' : '',
      `${clean(o.store?.domain)} · ${fmtMoney(o.price)} · ${o.available ? c.ok('in stock') : c.dim('sold out')} ${c.dim(clean(o.productId))}`,
    ]),
  ];
  return box(clean(p.title), rows);
}

const STAGES = ['quoted', 'checkout ready', 'confirmed', 'shipped', 'delivered'];
function progress(s: PurchaseStatus): string {
  const at =
    s === PurchaseStatus.AWAITING_CONFIRMATION ? 1 : s === PurchaseStatus.CONFIRMED ? 2 : s === PurchaseStatus.SHIPPED ? 3 : s === PurchaseStatus.DELIVERED ? 4 : -1;
  if (at < 0) return s === PurchaseStatus.EXPIRED ? c.dim('□ link expired') : c.dim('□ cancelled');
  return STAGES.map((name, i) => (i < at ? c.ok(`■ ${name}`) : i === at ? c.warn(`▣ ${c.bold(name)}`) : c.dim(`□ ${name}`))).join(c.dim(' ── '));
}

export const purchaseStatusWord = (s: PurchaseStatus): string =>
  ({
    [PurchaseStatus.AWAITING_CONFIRMATION]: 'awaiting confirmation',
    [PurchaseStatus.CONFIRMED]: 'confirmed',
    [PurchaseStatus.SHIPPED]: 'shipped',
    [PurchaseStatus.DELIVERED]: 'delivered',
    [PurchaseStatus.CANCELLED]: 'cancelled',
    [PurchaseStatus.EXPIRED]: 'expired',
    [PurchaseStatus.UNSPECIFIED]: 'unknown',
  })[s];

export function purchaseView(p: Purchase): string {
  const q = p.quote;
  const rows: Array<[string, string]> = [
    ['item', `${clean(p.product?.title)} · ${clean(p.variant?.title)}${q && q.quantity > 1 ? ` × ${q.quantity}` : ''} · ${fmtMoney(q?.item)}`],
    ...(q?.estimated
      ? ([
          ['tax', c.dim("shown at the store's checkout")],
          ['shipping', c.dim("shown at the store's checkout")],
          ['total', `${c.bold(fmtMoney(q?.total))} ${c.dim('+ tax and shipping')}`],
        ] as Array<[string, string]>)
      : ([
          ['tax', fmtMoney(q?.tax)],
          ['shipping', fmtMoney(q?.shipping)],
          ['total', c.bold(fmtMoney(q?.total))],
        ] as Array<[string, string]>)),
  ];
  if (q?.max) rows.push(['your max', `${fmtMoney(q.max)} ${c.ok('✓')}`]);
  if (p.status === PurchaseStatus.AWAITING_CONFIRMATION) {
    rows.push(['pay with', `the store's own checkout (${clean(p.product?.store?.name) || 'store'})`]);
    rows.push(['confirm', `${c.key(clean(p.confirmUrl))} ${c.dim(`· until ${fmtTime(p.confirmExpiresAt)}`)}`]);
    if (q?.estimated)
      rows.push(['note', c.warn("the store's checkout is busy for agents; the link opens your cart there instead")]);
  }
  if (p.orderNumber) rows.push(['order', `#${clean(p.orderNumber)}`]);
  if (p.trackingNumber) rows.push(['tracking', `${clean(p.carrier)} ${clean(p.trackingNumber)}`]);
  rows.push(['id', c.dim(clean(p.purchaseId))]);
  return `${progress(p.status)}\n${box(`${purchaseStatusWord(p.status)} · ${clean(p.product?.store?.domain)}`, rows)}`;
}

const watchWord = (s: WatchStatus) =>
  ({
    [WatchStatus.ACTIVE]: 'watching',
    [WatchStatus.TRIGGERED]: c.warn('confirm link sent'),
    [WatchStatus.COMPLETED]: c.ok('done'),
    [WatchStatus.CANCELLED]: c.dim('cancelled'),
    [WatchStatus.ENDED]: c.dim('ended'),
    [WatchStatus.UNSPECIFIED]: '',
  })[s];

const VERDICT: Record<string, (s: string) => string> = {
  great: (s) => c.ok(s),
  good: (s) => c.ok(s),
  typical: (s) => s,
  high: (s) => c.warn(s),
};

/** "90-day low $104.00 · usual $129.00 · great", or how long yaaa has watched when that's too short to judge. */
export function historyLine(h?: PriceHistory): string | undefined {
  if (!h || h.days === 0) return undefined;
  if (h.verdict === 'not_enough_data') return c.dim(`watched ${h.days} day${h.days === 1 ? '' : 's'}: not enough to judge yet`);
  const verdict = (VERDICT[h.verdict] ?? clean)(h.verdict);
  return `90-day low ${fmtMoney(h.low90)} · usual ${fmtMoney(h.usual)} · ${verdict} ${c.dim(`(${h.days} days)`)}`;
}

export function watchView(w: PriceWatch): string {
  const rows: Array<[string, string]> = [
    ['now', fmtMoney(w.currentPrice)],
    ['buy at', `${fmtMoney(w.target)} or less, in stock`],
    ['checks', `every ${w.checkIntervalMinutes} minutes`],
    ...(historyLine(w.priceHistory) ? [['history', historyLine(w.priceHistory)!] as [string, string]] : []),
    ['ends', fmtDate(w.endsAt)],
    ['when it hits', w.product?.store?.level === StoreLevel.CHECKOUT ? 'you get a confirm link' : 'you get a link to the product page'],
  ];
  if (w.confirmUrl) rows.push(['confirm', c.key(clean(w.confirmUrl))]);
  return `${c.ok('✓')} ${watchWord(w.status)} ${c.bold(clean(w.watchId))} ${c.dim(`${clean(w.product?.title)}${w.variant ? ` · ${clean(w.variant.title)}` : ''} · ${clean(w.product?.store?.name)}`)}\n${box('price watch', rows)}`;
}

export function watchesTable(ws: PriceWatch[]): string {
  return table(
    ['WATCH', 'PRODUCT', 'NOW', 'TARGET', '90-DAY LOW', 'STATUS'],
    ws.map((w) => [
      c.key(clean(w.watchId)),
      `${clean(w.product?.title)}${w.variant ? ` · ${clean(w.variant.title)}` : ''}`,
      fmtMoney(w.currentPrice),
      fmtMoney(w.target),
      w.priceHistory && w.priceHistory.verdict !== 'not_enough_data' ? fmtMoney(w.priceHistory.low90) : c.dim('–'),
      watchWord(w.status),
    ]),
  );
}

const filterWord = (s: FilterWatchStatus) =>
  s === FilterWatchStatus.ACTIVE ? 'watching' : s === FilterWatchStatus.ENDED ? c.dim('ended') : c.dim('cancelled');

/** Why a match is in the list: its price now, and what it was when it was first seen if that's different. */
const matchPrice = (m: FilterMatch) => {
  const now = fmtMoney(m.lastPrice);
  const was = m.firstPrice && m.lastPrice && m.firstPrice.amount !== m.lastPrice.amount ? ` ${c.dim(`(was ${fmtMoney(m.firstPrice)})`)}` : '';
  const h = m.priceHistory;
  const verdict = h && h.verdict !== 'not_enough_data' ? ` · ${(VERDICT[h.verdict] ?? clean)(h.verdict)}` : '';
  return `${now}${was}${verdict}`;
};

export function filterMatchesTable(ms: FilterMatch[]): string {
  if (ms.length === 0) return c.dim('Nothing matches yet. yaaa will tell you when something does.');
  return table(
    ['PRODUCT', 'TITLE', 'STORE', 'PRICE', 'RATING', 'STOCK'],
    ms.map((m) => {
      const p = m.product;
      return [
        c.key(clean(p?.productId)),
        clean(p?.title),
        p ? storeCell(p) : '',
        matchPrice(m),
        (p && fmtRating(p)) || c.dim('–'),
        p?.available ? c.ok('in stock') : c.dim('sold out'),
      ];
    }),
  );
}

export function filterWatchView(w: FilterWatch, matches: FilterMatch[], created = false): string {
  const rows: Array<[string, string]> = [
    ['watching for', clean(w.description)],
    ['checks', `every ${Math.round(w.checkIntervalMinutes / 60)} hours`],
    ['ends', fmtDate(w.endsAt)],
    ['alerts', 'new matches, 5% or $5 cheaper, back in stock'],
  ];
  const head = `${c.ok('✓')} ${created ? 'watching' : filterWord(w.status)} ${c.bold(clean(w.watchId))} ${c.dim(clean(w.description))}`;
  const found = created ? `${c.bold('Matching today')} ${c.dim('(these alert again only if they get cheaper)')}` : c.bold('Matches');
  return `${head}\n${box('filter watch', rows)}\n\n${found}\n${filterMatchesTable(matches)}`;
}

export function filterWatchesTable(ws: FilterWatch[]): string {
  return table(
    ['WATCH', 'SEARCH', 'MATCHES', 'BEST', 'ENDS', 'STATUS'],
    ws.map((w) => [c.key(clean(w.watchId)), w.description, String(w.matchCount), fmtMoney(w.bestPrice), fmtDate(w.endsAt), filterWord(w.status)]),
  );
}

const cadenceWord = (r: Restock) =>
  r.cadence?.kind.case === 'monthlyDay' ? `day ${r.cadence.kind.value} of every month` : r.cadence?.kind.case === 'everyDays' ? `every ${r.cadence.kind.value} days` : '';

export function restockView(r: Restock): string {
  const rows: Array<[string, string]> = [
    ['schedule', cadenceWord(r)],
    ['next run', r.status === RestockStatus.PAUSED ? c.dim('paused') : `${fmtDate(r.nextRunAt)}${r.skipNext ? c.warn(' (skipping)') : ''} · quoted ${fmtDate(r.nextQuoteAt)}`],
    ['max', `${fmtMoney(r.max)} per run`],
    ['now', fmtMoney(r.variant?.price ?? r.product?.price)],
    ['each run', 'you get a confirm link; over max or out of stock is skipped'],
  ];
  return `${c.ok('✓')} restock ${c.bold(clean(r.restockId))} ${c.dim(`${clean(r.product?.title)} · ${clean(r.variant?.title)} × ${r.quantity} · ${clean(r.product?.store?.name)}`)}\n${box('restock', rows)}`;
}

export function restocksTable(rs: Restock[]): string {
  return table(
    ['RESTOCK', 'PRODUCT', 'SCHEDULE', 'NEXT RUN', 'MAX', 'STATUS'],
    rs.map((r) => [
      c.key(clean(r.restockId)),
      clean(r.product?.title),
      cadenceWord(r),
      r.status === RestockStatus.PAUSED ? c.dim('paused') : `${fmtDate(r.nextRunAt)}${r.skipNext ? ' (skip)' : ''}`,
      fmtMoney(r.max),
      r.status === RestockStatus.ACTIVE ? c.ok('active') : r.status === RestockStatus.PAUSED ? c.warn('paused') : c.dim('cancelled'),
    ]),
  );
}

export function statusTable(items: StatusItem[]): string {
  if (items.length === 0) return c.dim('Nothing in flight. Try `yaaa buy`, `yaaa watch price`, `yaaa watch search`, or `yaaa restock`.');
  const t = table(
    ['ID', 'ITEM', 'TYPE', 'STATUS'],
    items.map((i) => [c.key(clean(i.id)), clean(i.title), clean(i.kind.replace('_', ' ')), i.needsAttention ? c.warn(clean(i.summary)) : clean(i.summary)]),
  );
  const links = items.filter((i) => i.confirmUrl).map((i) => `${c.warn('→')} confirm ${clean(i.title)}: ${c.key(clean(i.confirmUrl))}`);
  return links.length ? `${t}\n\n${links.join('\n')}` : t;
}

/** Shopping preferences, or a hint on how to set them. */
export function prefsView(p: {
  sizes?: Record<string, string>;
  budgets?: Record<string, string>;
  prefer_brands?: string[];
  avoid_brands?: string[];
  ships_to?: string;
}): string {
  const rows: Array<[string, string]> = [
    ...Object.entries(p.sizes ?? {}).map(([k, v]): [string, string] => [`size · ${k}`, v]),
    ...Object.entries(p.budgets ?? {}).map(([k, v]): [string, string] => [`budget · ${k}`, `$${v}`]),
    ...(p.prefer_brands?.length ? [['prefer', p.prefer_brands.join(', ')] as [string, string]] : []),
    ...(p.avoid_brands?.length ? [['avoid', p.avoid_brands.join(', ')] as [string, string]] : []),
    ...(p.ships_to ? [['ships to', p.ships_to] as [string, string]] : []),
  ];
  if (rows.length === 0) return c.dim('No preferences yet. Set one with `yaaa config prefs set size.shoes 10`.');
  return box('shopping preferences · this device', rows);
}

/** "free · price checks hourly, filter watches every 12 hours, watches up to 30 days" */
export function planLine(u: PlanUsage | undefined): string {
  if (!u?.plan) return '';
  const every = (m: number) => (m % 60 === 0 ? (m === 60 ? 'hourly' : `every ${m / 60} hours`) : `every ${m} minutes`);
  return `${planName(u.plan)} ${c.dim(`· price checks ${every(u.priceCheckMinutes)}, filter watches ${every(u.filterCheckMinutes)}, watches up to ${u.longestWatchDays} days`)}`;
}

export const planName = (plan: string): string => (plan === 'plus' ? 'yaaa Plus' : plan === 'new' ? 'new (first day)' : plan === 'free' ? 'free' : clean(plan));

/** What's in use of the plan's allowances: "3 of 5". */
export function planRows(u: PlanUsage | undefined): Array<[string, string]> {
  if (!u?.plan) return [];
  const of = (a: PlanUsage['priceWatches']) => (a ? `${a.used} of ${a.limit}` : '');
  return [
    ['price watches', of(u.priceWatches)],
    ['filter watches', of(u.filterWatches)],
    ['restocks', of(u.restocks)],
    ['quotes today', of(u.quotesToday)],
  ];
}

/** "$6.99/month", "$59/year": the price from the API, never written here. */
export function plusPriceLine(p: PlusPrice | undefined): string {
  if (!p) return '—';
  const m = p?.amount;
  if (!m?.amount) return '—';
  const amount = clean(m.amount).replace(/\.00$/, '');
  const money = m.currencyCode === 'USD' || !m.currencyCode ? `$${amount}` : `${amount} ${clean(m.currencyCode)}`;
  const per = p.interval === 'monthly' ? '/month' : p.interval === 'yearly' ? '/year' : p.interval ? ` ${clean(p.interval)}` : '';
  return `${money}${per}`;
}

const SUBSCRIPTION_WORD: Record<string, string> = {
  active: 'active',
  trialing: 'active (trial)',
  past_due: 'past due: a renewal payment failed and is being retried',
  canceled: 'ended',
  unpaid: 'unpaid',
  incomplete: 'payment not finished',
  incomplete_expired: 'payment not finished (expired)',
  paused: 'paused',
};

/** A yaaa Plus subscription in a line: "active · monthly · renews Nov 13, 2026". */
export function plusLine(p: PlusSubscription): string {
  const status = SUBSCRIPTION_WORD[p.status] ?? clean(p.status);
  const live = p.status === 'active' || p.status === 'trialing' || p.status === 'past_due';
  const when = !live || !p.renewsAt ? '' : p.cancelAtPeriodEnd ? `ends ${fmtDate(p.renewsAt)}` : `renews ${fmtDate(p.renewsAt)}`;
  const line = [status, clean(p.interval), when].filter(Boolean).join(' · ');
  return p.status === 'past_due' || p.cancelAtPeriodEnd ? c.warn(line) : line;
}
