import { describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { ErrorDetailSchema, ErrorDetail_Reason, Exit, toYaaaError, CliError } from '@yaaa/client';
import { money, productRef } from '@yaaa/tools';
import { parseDuration } from '../src/commands/dev.js';

describe('productRef', () => {
  it('reads ids, URLs, bare domains with paths, and words', () => {
    expect(productRef('prd_7Kq2mX9aZZ')).toEqual({ case: 'productId', value: 'prd_7Kq2mX9aZZ' });
    expect(productRef('https://odastudio.co/products/tote-vol-3')).toEqual({ case: 'url', value: 'https://odastudio.co/products/tote-vol-3' });
    expect(productRef('odastudio.co/products/tote')).toEqual({ case: 'url', value: 'odastudio.co/products/tote' });
    expect(productRef('oda tote vol. 3')).toEqual({ case: 'query', value: 'oda tote vol. 3' });
  });
  it('rejects empty input as bad usage', () => {
    expect(() => productRef('  ')).toThrow(CliError);
  });
});

describe('money', () => {
  it('accepts plain and dollar amounts', () => {
    expect(money('110', 'max')?.amount).toBe('110');
    expect(money('$249.99', 'max')?.amount).toBe('249.99');
    expect(money(undefined, 'max')).toBeUndefined();
  });
  it('rejects sub-cent and non-numeric amounts', () => {
    expect(() => money('1.234', 'max')).toThrow(/isn't an amount/);
    expect(() => money('cheap', 'max')).toThrow(CliError);
  });
});

describe('parseDuration', () => {
  it('parses compound durations', () => {
    expect(parseDuration('15m')).toBe(900);
    expect(parseDuration('1d12h')).toBe(129600);
    expect(() => parseDuration('soon')).toThrow(CliError);
    expect(() => parseDuration('5x')).toThrow(CliError);
  });
});

describe('exit codes', () => {
  const withDetail = (reason: ErrorDetail_Reason, code = Code.FailedPrecondition) =>
    new ConnectError('server message', code, undefined, [{ desc: ErrorDetailSchema, value: create(ErrorDetailSchema, { reason, message: 'detail message', metadata: { limit: 'monthly' } }) }]);

  it('maps typed error details to the fixed exit codes', () => {
    expect(toYaaaError(withDetail(ErrorDetail_Reason.LIMIT_EXCEEDED))).toEqual({ reason: 'LIMIT_EXCEEDED', message: 'detail message', metadata: { limit: 'monthly' }, exit: Exit.limits });
    expect(toYaaaError(withDetail(ErrorDetail_Reason.STORE_UNSUPPORTED)).exit).toBe(Exit.conflict);
    expect(toYaaaError(withDetail(ErrorDetail_Reason.NOT_FOUND, Code.NotFound)).exit).toBe(Exit.notFound);
    expect(toYaaaError(withDetail(ErrorDetail_Reason.UNAVAILABLE, Code.Unavailable)).exit).toBe(Exit.retryable);
    expect(toYaaaError(withDetail(ErrorDetail_Reason.UNAUTHENTICATED, Code.Unauthenticated)).exit).toBe(Exit.auth);
  });

  it('falls back to the gRPC code without a detail', () => {
    expect(toYaaaError(new ConnectError('nope', Code.InvalidArgument)).exit).toBe(Exit.usage);
    expect(toYaaaError(new ConnectError('connect ECONNREFUSED 127.0.0.1:7080', Code.Unavailable)).exit).toBe(Exit.retryable);
  });

  it("keeps a CLI error's exit code when Connect wraps it (no account: exit 3, not a network error)", () => {
    const wrapped = ConnectError.from(new CliError('This device has no yaaa account yet.', Exit.auth, 'UNAUTHENTICATED'));
    expect(toYaaaError(wrapped)).toMatchObject({ reason: 'UNAUTHENTICATED', exit: Exit.auth });
  });

  it('keeps CLI errors and unexpected errors distinct', () => {
    expect(toYaaaError(new CliError('bad flag')).exit).toBe(Exit.usage);
    expect(toYaaaError(new Error('kaboom')).exit).toBe(Exit.unexpected);
  });
});

describe('product images', () => {
  const tty = { isTTY: true } as NodeJS.WriteStream;
  const pipe = { isTTY: false } as NodeJS.WriteStream;

  it('are off for --json, piped output, and YAAA_IMAGES=0; forced on with YAAA_IMAGES=1', async () => {
    const { imagesEnabled } = await import('../src/images.js');
    const before = process.env.YAAA_IMAGES;
    try {
      process.env.YAAA_IMAGES = '1';
      expect(imagesEnabled(true, tty)).toBe(false);
      expect(imagesEnabled(false, pipe)).toBe(false);
      expect(imagesEnabled(false, tty)).toBe(true);
      process.env.YAAA_IMAGES = '0';
      expect(imagesEnabled(false, tty)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.YAAA_IMAGES;
      else process.env.YAAA_IMAGES = before;
    }
  });

  it('follow `yaaa config images`, with YAAA_IMAGES overriding it and never on non-terminal output', async () => {
    const { imagesEnabled, setImagePreference } = await import('../src/images.js');
    const before = process.env.YAAA_IMAGES;
    try {
      delete process.env.YAAA_IMAGES;
      setImagePreference('on');
      expect(imagesEnabled(false, tty)).toBe(true);
      expect(imagesEnabled(false, pipe)).toBe(false);
      expect(imagesEnabled(true, tty)).toBe(false);
      setImagePreference('off');
      expect(imagesEnabled(false, tty)).toBe(false);
      process.env.YAAA_IMAGES = '1';
      expect(imagesEnabled(false, tty)).toBe(true);
      setImagePreference('nonsense'); // unknown values fall back to auto
      process.env.YAAA_IMAGES = '0';
      expect(imagesEnabled(false, tty)).toBe(false);
    } finally {
      setImagePreference('auto');
      if (before === undefined) delete process.env.YAAA_IMAGES;
      else process.env.YAAA_IMAGES = before;
    }
  });

  it('ask Shopify’s CDN for a small rendition and leave other URLs alone', async () => {
    const { sized } = await import('../src/images.js');
    expect(sized('https://cdn.shopify.com/s/files/1/x/tree.png?v=3', 400)).toBe('https://cdn.shopify.com/s/files/1/x/tree.png?v=3&width=400');
    expect(sized('https://www.allbirds.com/cdn/shop/files/tree.png', 200)).toBe('https://www.allbirds.com/cdn/shop/files/tree.png?width=200');
    expect(sized('https://example.com/tree.png', 200)).toBe('https://example.com/tree.png');
    expect(sized('not a url', 200)).toBe('not a url');
  });

  it('build Kitty and iTerm2 codes as strings: base64 PNG, sized in cells, Kitty leaving the cursor in place', async () => {
    const { kittyCodes, iterm2Codes } = await import('../src/images.js');
    const png = Buffer.alloc(5000, 7);
    const k = kittyCodes(png, 10, 4);
    expect(k.startsWith('\x1b_Ga=T,f=100,q=2,C=1,c=10,r=4,m=1;')).toBe(true);
    expect(k.split('\x1b_G').length - 1).toBe(Math.ceil(png.toString('base64').length / 4096));
    expect(k).not.toMatch(/\d+,\d+,\d+/); // base64, not comma-separated bytes
    const i = iterm2Codes(png, 10, 4);
    expect(i).toBe(`\x1b]1337;File=inline=1;size=5000;width=10;height=4;preserveAspectRatio=1:${png.toString('base64')}\x07`);
  });

  it('pick the protocol by terminal', async () => {
    const { protocol } = await import('../src/images.js');
    expect(protocol({ TERM_PROGRAM: 'iTerm.app' })).toBe('iterm2');
    expect(protocol({ TERM_PROGRAM: 'vscode' })).toBe('iterm2');
    expect(protocol({ TERM_PROGRAM: 'ghostty' })).toBe('kitty');
    expect(protocol({ TERM_PROGRAM: 'WarpTerminal' })).toBe('kitty');
    expect(protocol({ KITTY_WINDOW_ID: '1' })).toBe('kitty');
  });

  it('render nothing, without fetching, when images are off or there is no URL', async () => {
    const { productImage } = await import('../src/images.js');
    expect(await productImage('https://cdn.shopify.com/x.png', true)).toBe('');
    expect(await productImage(undefined, false)).toBe('');
  });
});

describe('shopping preferences', () => {
  it('set sizes, budgets, brands and ships-to, and unset them', async () => {
    const { setPref, unsetPref } = await import('../src/prefs.js');
    let p = setPref({}, 'size.shoes', '10');
    p = setPref(p, 'budget.shoes', '$150');
    p = setPref(p, 'prefer-brands', 'Allbirds, Veja ,');
    p = setPref(p, 'ships-to', 'us');
    expect(p).toEqual({ sizes: { shoes: '10' }, budgets: { shoes: '150' }, prefer_brands: ['Allbirds', 'Veja'], ships_to: 'US' });
    p = unsetPref(unsetPref(p, 'size.shoes'), 'budget.shoes');
    expect(p).toEqual({ prefer_brands: ['Allbirds', 'Veja'], ships_to: 'US' });
  });
  it('reject unknown keys and bad values', async () => {
    const { setPref } = await import('../src/prefs.js');
    expect(() => setPref({}, 'colour', 'blue')).toThrow(/Unknown preference/);
    expect(() => setPref({}, 'budget.shoes', 'cheap')).toThrow(/isn't an amount/);
    expect(() => setPref({}, 'ships-to', 'USA')).toThrow(/country code/);
    expect(() => setPref({}, 'size.', '10')).toThrow(/name a category/);
  });
});

describe('search filters', () => {
  it('ratings are 0 to 5', async () => {
    const { rating } = await import('@yaaa/tools');
    expect(rating(undefined)).toBe(0);
    expect(rating('4.5')).toBe(4.5);
    expect(() => rating('6')).toThrow(CliError);
    expect(() => rating('good')).toThrow(CliError);
  });
});

describe('yaaa login', () => {
  it('lands the desk link on adding a passkey, keeping the token in the fragment', async () => {
    const { passkeyLink } = await import('../src/commands/account.js');
    expect(passkeyLink('https://api.yaaa.io/desk/login#abc-_123')).toBe('https://api.yaaa.io/desk/login?next=passkey#abc-_123');
    expect(passkeyLink('http://localhost:7080/desk/login?x=1#t')).toBe('http://localhost:7080/desk/login?x=1&next=passkey#t');
  });
});

describe('yaaa dev in --help', () => {
  it('shows only for the local profile or YAAA_DEV=1', async () => {
    const { showDevCommands } = await import('../src/commands/dev.js');
    expect(showDevCommands(['node', 'yaaa', '--help'], {})).toBe(false);
    expect(showDevCommands(['node', 'yaaa', '--profile', 'local', '--help'], {})).toBe(true);
    expect(showDevCommands(['node', 'yaaa', '--profile=local'], {})).toBe(true);
    expect(showDevCommands(['node', 'yaaa', '--profile', 'work'], {})).toBe(false);
    expect(showDevCommands(['node', 'yaaa'], { YAAA_PROFILE: 'local' })).toBe(true);
    expect(showDevCommands(['node', 'yaaa', '--profile', 'default'], { YAAA_PROFILE: 'local' })).toBe(false);
    expect(showDevCommands(['node', 'yaaa'], { YAAA_DEV: '1' })).toBe(true);
  });
});

describe('filter watches', () => {
  // Stand-in clients that record which RPC ran and what it was sent.
  const recorder = () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const rpc = (name: string) => async (req: Record<string, unknown>) => {
      calls.push([name, req]);
      return {};
    };
    const watches = {
      cancelPriceWatch: rpc('cancelPriceWatch'),
      cancelFilterWatch: rpc('cancelFilterWatch'),
      createFilterWatch: rpc('createFilterWatch'),
    };
    return { calls, clients: { watches } as never };
  };

  it('cancel routes by id: fwt_ to filter watches, anything else to price watches', async () => {
    const { ops } = await import('@yaaa/tools');
    const { calls, clients } = recorder();
    await ops.cancelWatch(clients, { watchId: 'fwt_abc' });
    await ops.cancelWatch(clients, { watchId: 'wch_abc' });
    expect(calls.map((c) => c[0])).toEqual(['cancelFilterWatch', 'cancelPriceWatch']);
  });

  it('create sends the filters, and refuses empty words and bad dates before calling', async () => {
    const { ops } = await import('@yaaa/tools');
    const { calls, clients } = recorder();
    await ops.createFilterWatch(clients, { query: ' trail shoes ', max: '120', minRating: 4, inStock: true, until: '2026-12-01' });
    const req = calls[0][1];
    expect(req.query).toBe('trail shoes');
    expect((req.maxPrice as { amount: string }).amount).toBe('120');
    expect(req.minRating).toBe(4);
    expect(req.inStock).toBe(true);
    expect(req.until).toBeDefined();
    await expect(ops.createFilterWatch(clients, { query: '  ' })).rejects.toBeInstanceOf(CliError);
    await expect(ops.createFilterWatch(clients, { query: 'x', until: 'soon' })).rejects.toBeInstanceOf(CliError);
    expect(calls.length).toBe(1);
  });
});

describe('search attributes and paging', () => {
  it('sends size, color, gender, condition, reviews and the cursor; refuses a bad review count before calling', async () => {
    const { ops } = await import('@yaaa/tools');
    const calls: Array<Record<string, unknown>> = [];
    const clients = { products: { searchProducts: async (r: Record<string, unknown>) => (calls.push(r), {}) } } as never;
    await ops.searchProducts(clients, { query: 'trail shoes', size: '10', color: 'black', gender: 'women', condition: 'new', minReviews: 25, cursor: 'abc' });
    expect(calls[0]).toMatchObject({ size: '10', color: 'black', gender: 'women', condition: 'new', minReviews: 25, cursor: 'abc' });
    await expect(ops.searchProducts(clients, { query: 'x', minReviews: -1 })).rejects.toBeInstanceOf(CliError);
    expect(calls.length).toBe(1);
  });
});
