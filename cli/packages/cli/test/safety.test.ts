import { describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { AlertSchema, ProductSchema, StoreSchema } from '@yaaa/client';
import { clean, cleanLines } from '../src/sanitize.js';
import { openable } from '../src/open.js';
import { imageHeader, imageUrlAllowed } from '../src/images.js';
import { productCard, productView, productsTable } from '../src/views.js';
import { alertsTable, launchdPlist, notifySendArgs, plistString, systemdArg, systemdUnit } from '../src/commands/alerts.js';

const ESC = '\x1b';
// Characters a terminal acts on rather than prints, outside our own colour codes.
const UNSAFE = /[\x00-\x09\x0b-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/;

describe('server text in rich output', () => {
  it('removes screen clears and cursor moves', () => {
    expect(clean(`Shoe${ESC}[2J${ESC}[H${ESC}[1;31mRED`)).toBe('ShoeRED');
  });

  it('removes OSC 8 links, keeping the visible text', () => {
    expect(clean(`${ESC}]8;;https://evil.example/${ESC}\\Click here${ESC}]8;;${ESC}\\`)).toBe('Click here');
    expect(clean(`${ESC}]8;;https://evil.example/\x07Click${ESC}]8;;\x07`)).toBe('Click');
  });

  it('removes OSC 52 clipboard writes, ended by BEL, ST, or nothing', () => {
    expect(clean(`Tote${ESC}]52;c;Y3VybCBldmlsIHwgc2g=\x07 bag`)).toBe('Tote bag');
    expect(clean(`Tote${ESC}]52;c;Y3VybA==${ESC}\\ bag`)).toBe('Tote bag');
    expect(clean(`Tote${ESC}]52;c;Y3VybA==`)).toBe('Tote');
  });

  it('removes C1 controls, the 8-bit CSI and OSC, DEL, and lone ESC', () => {
    expect(clean('a\x9b2Jb\x9d8;;x\x9cc\x7fd\x85e' + ESC)).toBe('abcde');
  });

  it('removes bidi overrides, isolates and marks', () => {
    const s = 'price ‮00.1$‬ ⁦x⁩ ‎‏؜';
    expect(clean(s)).toBe('price 00.1$ x ');
    expect(UNSAFE.test(clean(s))).toBe(false);
  });

  it('turns line breaks and tabs into spaces on one line, and keeps line breaks where text wraps', () => {
    expect(clean('a\nb\r\nc\td\re')).toBe('a b c d e');
    expect(cleanLines('a\r\nb\tc\x07\nd')).toBe('a\nb c\nd');
  });

  it('leaves ordinary text, emoji and accents alone', () => {
    expect(clean('Café Tote — 100% wool 👟')).toBe('Café Tote — 100% wool 👟');
    expect(clean(undefined)).toBe('');
  });

  const nasty = `Shoe${ESC}[2J${ESC}]8;;https://evil.example/${ESC}\\x${ESC}]8;;${ESC}\\${ESC}]52;c;ZXZpbA==\x07‮`;
  const product = create(ProductSchema, {
    productId: 'prd_1',
    title: nasty,
    description: `Soft.${ESC}[2J\nWarm.`,
    features: [nasty],
    url: `https://shop.example/p${ESC}[2J`,
    store: create(StoreSchema, { name: nasty, domain: `shop.example${ESC}]52;c;eA==\x07` }),
  });
  // Our own colour codes are fine; nothing else that a terminal acts on is.
  const stripOwn = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').replaceAll('\n', '');

  it('reach product views, tables and cards with no escape sequences or bidi controls', () => {
    for (const out of [productView(product), productsTable([product]), productCard(product, 200).join('')]) {
      expect(out).not.toContain(`${ESC}]`);
      expect(out).not.toContain(`${ESC}[2J`);
      expect(UNSAFE.test(stripOwn(out))).toBe(false);
    }
  });

  it('reach the alerts list the same way, keeping the body’s line breaks', () => {
    const alert = create(AlertSchema, { title: nasty, body: `line one${ESC}[2J\nline two`, confirmUrl: `https://yaaa.io/c/x${ESC}[2J` });
    const out = alertsTable([alert]);
    expect(UNSAFE.test(stripOwn(out))).toBe(false);
    expect(out).toContain('line one\n  line two');
  });
});

describe('opening links', () => {
  it('opens https anywhere and http only on this machine', () => {
    expect(openable('https://yaaa.io/desk#t')).toBe(true);
    expect(openable('http://localhost:7080/desk')).toBe(true);
    expect(openable('http://127.0.0.1:7080/desk')).toBe(true);
    expect(openable('http://[::1]:7080/desk')).toBe(true);
    expect(openable('http://yaaa.io/desk')).toBe(false);
    expect(openable('file:///etc/passwd')).toBe(false);
    expect(openable('javascript:alert(1)')).toBe(false);
    expect(openable('vscode://some.extension/run')).toBe(false);
    expect(openable('-a Calculator')).toBe(false);
    expect(openable(undefined)).toBe(false);
  });
});

describe('product image downloads', () => {
  it('come only over https from Shopify’s CDN or a store’s /cdn/shop/ path', () => {
    expect(imageUrlAllowed('https://cdn.shopify.com/s/files/1/x/tree.png?width=400')).toBe(true);
    expect(imageUrlAllowed('https://www.allbirds.com/cdn/shop/files/tree.png?width=200')).toBe(true);
    expect(imageUrlAllowed('http://cdn.shopify.com/s/files/1/x/tree.png')).toBe(false);
    expect(imageUrlAllowed('https://example.com/tree.png')).toBe(false);
    expect(imageUrlAllowed('https://127.0.0.1/cdn/shop/x.png')).toBe(false);
    expect(imageUrlAllowed('https://localhost/cdn/shop/x.png')).toBe(false);
    expect(imageUrlAllowed('https://[::1]/cdn/shop/x.png')).toBe(false);
    expect(imageUrlAllowed('https://cdn.shopify.com:8443/x.png')).toBe(false);
    expect(imageUrlAllowed('https://user:pw@cdn.shopify.com/x.png')).toBe(false);
    expect(imageUrlAllowed('not a url')).toBe(false);
  });

  it('are sized from the header before decoding: PNG, GIF, JPEG and WebP', () => {
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(100000, 16);
    png.writeUInt32BE(200, 20);
    expect(imageHeader(png)).toEqual({ format: 'png', width: 100000, height: 200 });

    const gif = Buffer.from('GIF89a\x40\x01\xf0\x00', 'latin1');
    expect(imageHeader(gif)).toEqual({ format: 'gif', width: 320, height: 240 });

    // SOI, an APP0 segment, then SOF0 with height 480 and width 640.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0]);
    expect(imageHeader(jpeg)).toEqual({ format: 'jpeg', width: 640, height: 480 });

    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBP', 8, 'ascii');
    webp.write('VP8X', 12, 'ascii');
    webp.writeUIntLE(4999, 24, 3);
    webp.writeUIntLE(99, 27, 3);
    expect(imageHeader(webp)).toEqual({ format: 'webp', width: 5000, height: 100 });

    expect(imageHeader(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
  });
});

describe('desktop notifications', () => {
  it('pass the text to notify-send after --, so a leading dash is text', () => {
    const args = notifySendArgs('yaaa · --help', '--icon=/etc/passwd', '/x/yaaa.png');
    expect(args.slice(args.indexOf('--'))).toEqual(['--', 'yaaa · --help', '--icon=/etc/passwd']);
    expect(args).toContain('--icon=/x/yaaa.png');
  });

  it('escape XML in the launchd plist', () => {
    expect(plistString(`a&b<c>"d'`)).toBe('a&amp;b&lt;c&gt;&quot;d&apos;');
    const plist = launchdPlist(['/Users/a&b/<yaaa>', '--profile', 'x</string><string>y'], '/tmp/log');
    expect(plist).toContain('<string>/Users/a&amp;b/&lt;yaaa&gt;</string>');
    expect(plist).toContain('<string>x&lt;/string&gt;&lt;string&gt;y</string>');
  });

  it('escape % and $ in the systemd unit', () => {
    expect(systemdArg('/home/a%h/$HOME/yaaa')).toBe('"/home/a%%h/$$HOME/yaaa"');
    expect(systemdUnit(['/bin/yaaa', '--profile', '50%$x'])).toContain('ExecStart="/bin/yaaa" "--profile" "50%%$$x"\n');
  });
});
