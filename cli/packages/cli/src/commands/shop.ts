import { Command } from 'commander';
import { CancelPurchaseResponseSchema, CliError, type Limits } from '@yaaa/client';
import { asJson, ops, key } from '@yaaa/tools';
import { run, type GlobalOpts } from '../context.js';
import { readPrefs, setPref, unsetPref, writePrefs } from '../prefs.js';
import {
  cards,
  IMAGE_PREFERENCES,
  imageBlock,
  imagePreference,
  imagesEnabled,
  protocol,
  setImagePreference,
  terminalSupportsImages,
  type ImagePreference,
} from '../images.js';
import { box, c, fmtMoney } from '../output.js';
import {
  prefsView,
  productCard,
  productView,
  productsTable,
  purchaseView,
  restockView,
  restocksTable,
  statusTable,
  filterMatchesTable,
  filterWatchView,
  filterWatchesTable,
  watchView,
  watchesTable,
} from '../views.js';

const g = (cmd: Command) => cmd.optsWithGlobals() as GlobalOpts & Record<string, unknown>;
const int = (v: string) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new CliError(`'${v}' isn't a whole number.`);
  return n;
};

const limitsView = (l?: Limits) =>
  box('your limits', [
    ['per purchase', fmtMoney(l?.perPurchase)],
    ['monthly', fmtMoney(l?.monthly)],
    ['used this month', fmtMoney(l?.monthlyUsed)],
  ]);

export function shopCommands(program: Command): void {
  const products = program.command('products').description('Find products at stores that sell to agents');
  products
    .command('search <query...>')
    .description('Search by name, brand, or keywords, with optional filters')
    .option('--store <domain>', 'only this store (leave out to search every store)')
    .option('--limit <n>', 'how many results, up to 50', int, 10)
    .option('--min <usd>', 'lowest price')
    .option('--max <usd>', 'highest price')
    .option('--min-rating <stars>', 'only products rated at least this, 0 to 5')
    .option('--in-stock', 'only products in stock')
    .option('--ships-to <country>', '2-letter country code (default: your prefs, else US)')
    .option('--cheapest', 'cheapest first, and the cheapest store first')
    .option('--size <size>', 'a size, like 10 or M')
    .option('--color <color>', 'a color, like black')
    .option('--gender <who>', 'women, men, or unisex')
    .option('--condition <c>', 'new or secondhand')
    .option('--min-reviews <n>', 'only products with at least this many reviews', int)
    .option('--cursor <c>', 'the next page of a search (printed after the results)')
    .action(async (words: string[], _o, cmd: Command) => {
      const o = g(cmd);
      await run(o, async ({ clients, out, store, profile }) => {
        const r = await ops.searchProducts(clients, {
          query: words.join(' '),
          store: o.store as string | undefined,
          limit: o.limit as number,
          min: o.min as string | undefined,
          max: o.max as string | undefined,
          minRating: o.minRating as number | undefined,
          inStock: Boolean(o.inStock),
          shipsTo: (o.shipsTo as string | undefined) ?? readPrefs(store, profile).ships_to,
          cheapest: Boolean(o.cheapest),
          size: o.size as string | undefined,
          color: o.color as string | undefined,
          gender: o.gender as string | undefined,
          condition: o.condition as string | undefined,
          minReviews: o.minReviews as number | undefined,
          cursor: o.cursor as string | undefined,
        });
        const ps = r.message.products;
        if (r.message.nextCursor) out.note(c.dim(`More results: add --cursor ${r.message.nextCursor}`));
        // Terminals that show images get cards: a thumbnail with the product's details beside it.
        if (ps.length > 0 && imagesEnabled(out.json)) {
          const shown = await cards(ps.map((p) => ({ imageUrl: p.imageUrl, lines: productCard(p) })), out.json);
          out.result(r, () => shown);
        } else out.result(r, () => productsTable(ps));
      });
    });
  products
    .command('similar <product...>')
    .description('Products like this one (id, product page URL, or search words): alternatives, or something cheaper')
    .option('--limit <n>', 'how many results', int, 5)
    .option('--max <usd>', 'highest price')
    .option('--min-rating <stars>', 'only products rated at least this, 0 to 5')
    .action(async (words: string[], _o, cmd: Command) => {
      const o = g(cmd);
      await run(o, async ({ clients, out }) => {
        const r = await ops.similarProducts(clients, {
          product: words.join(' '),
          limit: o.limit as number,
          max: o.max as string | undefined,
          minRating: o.minRating as number | undefined,
        });
        const ps = r.message.products;
        if (ps.length > 0 && imagesEnabled(out.json)) {
          const shown = await cards(ps.map((p) => ({ imageUrl: p.imageUrl, lines: productCard(p) })), out.json);
          out.result(r, () => shown);
        } else out.result(r, () => (ps.length > 0 ? productsTable(ps) : c.dim('No similar products found.')));
      });
    });
  products
    .command('get <product>')
    .description('One product by id (prd_...), product page URL, or search words, with price and stock per variant')
    .action(async (product: string, _o, cmd: Command) => {
      await run(g(cmd), async ({ clients, out }) => {
        const r = await ops.getProduct(clients, { product });
        const img = await imageBlock(r.message.product?.imageUrl, out.json);
        out.result(r, () => (r.message.product ? img + productView(r.message.product) : ''));
      });
    });

  program
    .command('buy <product...>')
    .description('Quote the total with tax and shipping, and get a confirm link that opens the store’s checkout')
    .option('--variant <variant>', 'variant id or name, like "black" or "10.5"')
    .option('--qty <n>', 'quantity', int, 1)
    .option('--max <usd>', 'refuse if the total is higher')
    .action(async (words: string[], _o, cmd: Command) => {
      const o = g(cmd);
      await run(o, async ({ clients, out, idempotencyKey }) => {
        const r = await ops.buyNow(clients, {
          product: words.join(' '),
          variant: o.variant as string | undefined,
          quantity: o.qty as number,
          max: o.max as string | undefined,
          idempotencyKey,
        });
        const img = await imageBlock(r.message.purchase?.product?.imageUrl, out.json);
        out.result(r, () => (r.message.purchase ? img + purchaseView(r.message.purchase) : ''));
      });
    });

  program
    .command('status [id]')
    .description('Everything in flight, or one purchase by id')
    .action(async (id: string | undefined, _o, cmd: Command) => {
      await run(g(cmd), async ({ clients, out }) => {
        if (id) {
          const r = await ops.getPurchase(clients, { purchaseId: id });
          const img = await imageBlock(r.message.purchase?.product?.imageUrl, out.json);
          out.result(r, () => (r.message.purchase ? img + purchaseView(r.message.purchase) : ''));
        } else {
          const r = await ops.status(clients);
          out.result(r, () => statusTable(r.message.items));
        }
      });
    });

  program
    .command('cancel <purchase_id>')
    .description('Withdraw a confirm link that hasn’t been used')
    .action(async (id: string, _o, cmd: Command) => {
      await run(g(cmd), async ({ clients, out, idempotencyKey }) => {
        const m = await clients.purchases.cancelPurchase({ idempotencyKey: key(idempotencyKey), purchaseId: id });
        out.result({ schema: CancelPurchaseResponseSchema, message: m }, () => (m.purchase ? purchaseView(m.purchase) : ''));
      });
    });

  const config = program.command('config').description('Settings for this account');
  config
    .command('limits')
    .description('Show or set what your agent may spend. It asks before going over.')
    .option('--per-purchase <usd>', 'most a single purchase may total')
    .option('--monthly <usd>', 'most all purchases may total in a month')
    .action(async (_o, cmd: Command) => {
      const o = g(cmd);
      await run(o, async ({ clients, out, idempotencyKey }) => {
        if (o.perPurchase === undefined && o.monthly === undefined) {
          const r = await ops.getLimits(clients);
          out.result(r, () => limitsView(r.message.limits));
        } else {
          const r = await ops.setLimits(clients, { perPurchase: o.perPurchase as string | undefined, monthly: o.monthly as string | undefined, idempotencyKey });
          out.result(r, () => `${c.ok('✓')} Limits updated\n${limitsView(r.message.limits)}`);
        }
      });
    });

  const prefs = config
    .command('prefs')
    .description('Your shopping preferences on this device: sizes, budgets, brands, and where things ship')
    .addHelpText(
      'after',
      '\nExamples:\n  yaaa config prefs set size.shoes 10\n  yaaa config prefs set budget.shoes 150\n' +
        '  yaaa config prefs set prefer-brands "Allbirds, Veja"\n  yaaa config prefs set ships-to US\n' +
        '  yaaa config prefs unset size.shoes\n\nThe yaaa-advisor skill recommends from these. They stay on this device.',
    )
    .action(async (_o, cmd: Command) => {
      await run(g(cmd), async ({ store, profile, out }) => {
        const p = readPrefs(store, profile);
        out.data(p, () => prefsView(p));
      });
    });
  prefs
    .command('set <key> <value...>')
    .description('Set one preference, like size.shoes 10 or prefer-brands "Allbirds, Veja"')
    .action(async (k: string, value: string[], _o, cmd: Command) => {
      await run(g(cmd), async ({ store, profile, out }) => {
        const p = setPref(readPrefs(store, profile), k, value.join(' '));
        writePrefs(store, profile, p);
        out.data(p, () => `${c.ok('✓')} Saved ${k}\n${prefsView(p)}`);
      });
    });
  prefs
    .command('unset <key>')
    .description('Remove one preference')
    .action(async (k: string, _o, cmd: Command) => {
      await run(g(cmd), async ({ store, profile, out }) => {
        const p = unsetPref(readPrefs(store, profile), k);
        writePrefs(store, profile, p);
        out.data(p, () => `${c.ok('✓')} Removed ${k}\n${prefsView(p)}`);
      });
    });
  prefs
    .command('clear')
    .description('Remove all preferences on this device')
    .action(async (_o, cmd: Command) => {
      await run(g(cmd), async ({ store, profile, out }) => {
        writePrefs(store, profile, {});
        out.data({}, () => `${c.ok('✓')} Preferences cleared.`);
      });
    });

  config
    .command('images [setting]')
    .description('Product images in this terminal: auto (when the terminal supports them), on, or off')
    .addHelpText(
      'after',
      '\nauto shows images in terminals with a graphics protocol (iTerm2, WezTerm, Kitty, Ghostty, Warp).\n' +
        'on also shows them where that isn\'t detected (VS Code, with terminal.integrated.enableImages).\n' +
        'off hides them, including macOS notification thumbnails. YAAA_IMAGES=0 or 1 overrides this.\n' +
        'Images never appear in --json or piped output.',
    )
    .action(async (setting: string | undefined, _o, cmd: Command) => {
      await run(g(cmd), async ({ store, profile, out }) => {
        if (setting !== undefined) {
          if (!IMAGE_PREFERENCES.includes(setting as ImagePreference))
            throw new CliError('Usage: yaaa config images auto | on | off');
          store.set(profile, 'images', setting);
          setImagePreference(setting);
        }
        const p = imagePreference();
        const overridden = process.env.YAAA_IMAGES === '0' || process.env.YAAA_IMAGES === '1';
        const detected = terminalSupportsImages();
        out.data({ images: store.get(profile, 'images') ?? 'auto', effective: p, terminal_supports_images: detected }, () =>
          [
            `${setting !== undefined ? `${c.ok('✓')} ` : ''}Images: ${c.bold(store.get(profile, 'images') ?? 'auto')}` +
              (overridden ? c.dim(` (YAAA_IMAGES=${process.env.YAAA_IMAGES} overrides it: ${p})`) : ''),
            c.dim(
              detected
                ? `This terminal supports images (${protocol() === 'kitty' ? 'Kitty' : 'iTerm2'} protocol).`
                : p === 'on'
                  ? 'This terminal doesn\'t report image support; images are on anyway.'
                  : 'This terminal doesn\'t report image support; use `on` if it has it (VS Code with images enabled).',
            ),
          ].join('\n'),
        );
      });
    });

  const watch = program
    .command('watch')
    .description('Price watches (a confirm link when a product hits your price) and filter watches (alerts for new matches to a search)');
  watch
    .command('price <product...>')
    .description('Watch a product (checked hourly for up to 30 days; every 15 minutes, up to 90 days, with yaaa Plus)')
    .requiredOption('--below <usd>', 'alert at or below this price, in stock')
    .option('--variant <variant>', 'only this variant')
    .option('--until <date>', 'stop watching after this date (YYYY-MM-DD)')
    .action(async (words: string[], _o, cmd: Command) => {
      const o = g(cmd);
      await run(o, async ({ clients, out, idempotencyKey }) => {
        const r = await ops.createPriceWatch(clients, {
          product: words.join(' '),
          below: o.below as string,
          variant: o.variant as string | undefined,
          until: o.until as string | undefined,
          idempotencyKey,
        });
        out.result(r, () => (r.message.watch ? watchView(r.message.watch) : ''));
      });
    });
  watch
    .command('search <query...>')
    .description('Watch a search across stores (checked every 12 hours for up to 30 days; every 3 hours, up to 90 days, with yaaa Plus): alerts for new matches, price drops, restocks')
    .option('--store <domain>', 'only this store (leave out to watch every store)')
    .option('--min <usd>', 'lowest price')
    .option('--max <usd>', 'highest price')
    .option('--min-rating <stars>', 'only products rated at least this, 0 to 5')
    .option('--in-stock', 'only products in stock')
    .option('--ships-to <country>', '2-letter country code (default: your prefs, else US)')
    .option('--until <date>', 'stop watching after this date (YYYY-MM-DD)')
    .option('--size <size>', 'a size, like 10 or M')
    .option('--color <color>', 'a color, like black')
    .option('--gender <who>', 'women, men, or unisex')
    .option('--condition <c>', 'new or secondhand')
    .option('--min-reviews <n>', 'only products with at least this many reviews', int)
    .action(async (words: string[], _o, cmd: Command) => {
      const o = g(cmd);
      await run(o, async ({ clients, out, store, profile, idempotencyKey }) => {
        const r = await ops.createFilterWatch(clients, {
          size: o.size as string | undefined,
          color: o.color as string | undefined,
          gender: o.gender as string | undefined,
          condition: o.condition as string | undefined,
          minReviews: o.minReviews as number | undefined,
          query: words.join(' '),
          store: o.store as string | undefined,
          min: o.min as string | undefined,
          max: o.max as string | undefined,
          minRating: o.minRating as number | undefined,
          inStock: Boolean(o.inStock),
          shipsTo: (o.shipsTo as string | undefined) ?? readPrefs(store, profile).ships_to,
          until: o.until as string | undefined,
          idempotencyKey,
        });
        out.result(r, () => (r.message.watch ? filterWatchView(r.message.watch, r.message.matches, true) : ''));
      });
    });
  watch
    .command('matches <watch_id>')
    .description("What a filter watch has found (and you haven't dismissed), cheapest first")
    .action(async (id: string, _o, cmd: Command) => {
      await run(g(cmd), async ({ clients, out }) => {
        const r = await ops.filterWatchMatches(clients, { watchId: id });
        out.result(r, () => (r.message.watch ? filterWatchView(r.message.watch, r.message.matches) : filterMatchesTable(r.message.matches)));
      });
    });
  watch
    .command('dismiss <watch_id> <product_id>')
    .description("Hide a product from a filter watch's matches; it won't alert again")
    .action(async (id: string, productId: string, _o, cmd: Command) => {
      await run(g(cmd), async ({ clients, out, idempotencyKey }) => {
        const r = await ops.dismissFilterMatch(clients, { watchId: id, productId, idempotencyKey });
        out.result(r, () => `${c.ok('✓')} Dismissed ${productId} from ${id}`);
      });
    });
  watch
    .command('list')
    .description('Your price watches and filter watches')
    .option('--all', 'include finished and cancelled watches')
    .action(async (_o, cmd: Command) => {
      const o = g(cmd);
      await run(o, async ({ clients, out }) => {
        const [prices, filters] = await Promise.all([
          ops.listPriceWatches(clients, { all: Boolean(o.all) }),
          ops.listFilterWatches(clients, { all: Boolean(o.all) }),
        ]);
        const pw = prices.message.watches;
        const fw = filters.message.watches;
        out.data(
          { watches: (asJson(prices) as { watches?: unknown[] }).watches ?? [], filter_watches: (asJson(filters) as { watches?: unknown[] }).watches ?? [] },
          () => {
            if (pw.length === 0 && fw.length === 0) return c.dim('No watches. Start one with yaaa watch price or yaaa watch search.');
            const parts: string[] = [];
            if (pw.length > 0) parts.push(`${c.bold('Price watches')}\n${watchesTable(pw)}`);
            if (fw.length > 0) parts.push(`${c.bold('Filter watches')}\n${filterWatchesTable(fw)}`);
            return parts.join('\n\n');
          },
        );
      });
    });
  watch
    .command('cancel <watch_id>')
    .description('Stop a price watch (wch_...) or a filter watch (fwt_...)')
    .action(async (id: string, _o, cmd: Command) => {
      await run(g(cmd), async ({ clients, out, idempotencyKey }) => {
        const r = await ops.cancelWatch(clients, { watchId: id, idempotencyKey });
        out.result(r, () => `${c.ok('✓')} Stopped ${id}`);
      });
    });

  program
    .command('restock')
    .description('Reorder on a schedule: each run is quoted a day early and sends a confirm link')
    .argument('[product...]', 'product id, URL, or words; or one of: list, pause, resume, skip, cancel')
    .option('--every <days>', 'every N days, like 14d')
    .option('--monthly <day>', 'on this day of every month (1 to 28)', int)
    .option('--qty <n>', 'quantity per run', int, 1)
    .option('--max <usd>', 'skip a run whose total is higher')
    .option('--variant <variant>', 'variant id or name')
    .option('--all', 'with `list`: include cancelled restocks')
    .action(async (args: string[], _o, cmd: Command) => {
      const o = g(cmd);
      await run(o, async ({ clients, out, idempotencyKey }) => {
        const [first, ...rest] = args;
        if (!first) throw new CliError('Usage: yaaa restock <product> --monthly <day> | --every <n>d --max <usd>, or yaaa restock list');
        if (first === 'list') {
          const r = await ops.listRestocks(clients, { all: Boolean(o.all) });
          out.result(r, () => restocksTable(r.message.restocks));
          return;
        }
        if (['pause', 'resume', 'skip', 'cancel'].includes(first)) {
          const id = rest[0];
          if (!id) throw new CliError(`Usage: yaaa restock ${first} <rst_id>`);
          const r = await ops.manageRestock(clients, { action: first as 'pause' | 'resume' | 'skip' | 'cancel', restockId: id, idempotencyKey });
          out.result(r, () => (r.message.restock ? restockView(r.message.restock) : ''));
          return;
        }
        const every = o.every === undefined ? undefined : int(String(o.every).replace(/d$/i, ''));
        if (o.max === undefined) throw new CliError('A restock needs --max, the most a run may cost.');
        const r = await ops.createRestock(clients, {
          product: args.join(' '),
          max: String(o.max),
          everyDays: every,
          monthlyDay: o.monthly as number | undefined,
          variant: o.variant as string | undefined,
          quantity: o.qty as number,
          idempotencyKey,
        });
        out.result(r, () => (r.message.restock ? restockView(r.message.restock) : ''));
      });
    });
}
