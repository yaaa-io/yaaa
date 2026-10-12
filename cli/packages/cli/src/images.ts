import { Jimp, JimpMime } from 'jimp';
import supportsTerminalGraphics from 'supports-terminal-graphics';

/**
 * Product images in the terminal, for terminals with a graphics protocol: Kitty's (Kitty, Ghostty, Warp, WezTerm) or
 * iTerm2's (iTerm2, WezTerm, VS Code with terminal.integrated.enableImages). Others show no image rather than a
 * block-character preview. YAAA_IMAGES=0 turns images off; YAAA_IMAGES=1 forces them where detection misses.
 *
 * The escape codes are built here and returned as strings, never written straight to the terminal, so they land
 * exactly where the layout puts them. Shopify's catalog terms allow product images only beside that product's
 * listing, rendered in real time and never cached: each image is fetched when shown, held in memory, and never
 * written to disk.
 */
export type ImagePreference = 'auto' | 'on' | 'off';
export const IMAGE_PREFERENCES: ImagePreference[] = ['auto', 'on', 'off'];

let preference: ImagePreference = 'auto';

/** This profile's `yaaa config images` setting; the CLI sets it once per command. */
export function setImagePreference(p: string | undefined): void {
  preference = IMAGE_PREFERENCES.includes(p as ImagePreference) ? (p as ImagePreference) : 'auto';
}

/** The preference in force: YAAA_IMAGES (0 or 1) overrides `yaaa config images`. */
export function imagePreference(): ImagePreference {
  if (process.env.YAAA_IMAGES === '0') return 'off';
  if (process.env.YAAA_IMAGES === '1') return 'on';
  return preference;
}

/** Whether this terminal reports a graphics protocol yaaa can use. */
export function terminalSupportsImages(): boolean {
  return supportsTerminalGraphics.stdout.kitty || supportsTerminalGraphics.stdout.iterm2;
}

/**
 * Images only ever go to a real terminal, never to --json or captured output (an agent's context), whatever the
 * preference says; then `on` forces them, `off` hides them, and `auto` asks the terminal.
 */
export function imagesEnabled(json: boolean, stream: NodeJS.WriteStream = process.stdout): boolean {
  if (json || !stream.isTTY) return false;
  const p = imagePreference();
  return p === 'on' || (p === 'auto' && terminalSupportsImages());
}

type Protocol = 'kitty' | 'iterm2';

/** Which protocol to speak. iTerm2 and VS Code also accept some Kitty codes but render their own protocol reliably. */
export function protocol(env: NodeJS.ProcessEnv = process.env): Protocol {
  const program = (env.TERM_PROGRAM ?? '').toLowerCase();
  if (program === 'iterm.app' || program === 'vscode' || (env.LC_TERMINAL ?? '').toLowerCase() === 'iterm2') return 'iterm2';
  if (supportsTerminalGraphics.stdout.kitty || env.KITTY_WINDOW_ID || program === 'ghostty' || program === 'warpterminal')
    return 'kitty';
  return 'iterm2';
}

/** Asks the image CDN for a small rendition where it supports that (Shopify's does), so less is downloaded. */
export function sized(url: string, px: number): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'cdn.shopify.com' || u.pathname.includes('/cdn/shop/')) u.searchParams.set('width', String(px));
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Whether yaaa fetches an image from this URL: https only, from Shopify's image CDN (cdn.shopify.com and its
 * shopifycdn hosts) or a Shopify store's own /cdn/shop/ path, never an IP address or a name on this machine. Catalog
 * images come from these; anything else is left out rather than fetched.
 */
export function imageUrlAllowed(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'cdn.shopify.com' || host.endsWith('.shopifycdn.com') || host.endsWith('.shopifycdn.net')) return true;
  const local = host === 'localhost' || host.endsWith('.localhost') || host.startsWith('[') || /^[\d.]+$/.test(host) || !host.includes('.');
  return !local && u.pathname.startsWith('/cdn/shop/');
}

/** The most an image download may be. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The largest image, on either side, that yaaa decodes. */
export const MAX_IMAGE_SIDE = 4096;

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

/** An image's format and size in pixels, read from its header without decoding it; undefined when it's not one. */
export function imageHeader(b: Uint8Array): { format: ImageFormat; width: number; height: number } | undefined {
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
  const u24le = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  const u32be = (i: number) => b[i]! * 0x1000000 + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR')
    return { format: 'png', width: u32be(16), height: u32be(20) };
  if (b.length >= 10 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return { format: 'gif', width: u16le(6), height: u16le(8) };
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8 ') return { format: 'webp', width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
      return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { format: 'webp', width: u24le(24) + 1, height: u24le(27) + 1 };
    return undefined;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the JPEG segments to the first start-of-frame, which holds the size.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        i += 2;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { format: 'jpeg', width: u16be(i + 7), height: u16be(i + 5) };
      i += 2 + u16be(i + 2);
    }
  }
  return undefined;
}

/**
 * An image's bytes, fetched within limits: an allowed URL (imageUrlAllowed) at every redirect, at most MAX_IMAGE_BYTES
 * read (the download stops there), and a PNG, JPEG, GIF or WebP no larger than MAX_IMAGE_SIDE on either side by its
 * header, so nothing oversized is ever decoded. Undefined for anything else; never throws.
 */
export async function fetchImage(
  url: string,
  timeoutMs = 3000,
): Promise<{ bytes: Uint8Array; format: ImageFormat; width: number; height: number } | undefined> {
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response | undefined;
    // Follows up to three redirects by hand, so each hop is checked against the allowlist too.
    for (let hops = 0, next = url; hops <= 3; hops++) {
      if (!imageUrlAllowed(next)) return undefined;
      res = await fetch(next, { signal, redirect: 'manual' });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      await res.body?.cancel().catch(() => undefined);
      next = new URL(location, next).toString();
      res = undefined;
    }
    if (!res || !res.ok || !res.body) return undefined;
    if (Number(res.headers.get('content-length') ?? '0') > MAX_IMAGE_BYTES) {
      await res.body.cancel().catch(() => undefined);
      return undefined;
    }
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.byteLength;
    }
    const head = imageHeader(bytes);
    if (!head || head.width < 1 || head.height < 1 || head.width > MAX_IMAGE_SIDE || head.height > MAX_IMAGE_SIDE) return undefined;
    return { bytes, ...head };
  } catch {
    return undefined;
  }
}

// A terminal cell is about twice as tall as it is wide, so a slot of c columns by r rows is about c : 2r in shape.
const PX_PER_COLUMN = 20;
const PX_PER_ROW = 40;

/**
 * The image fitted into a slot `columns` wide and `rows` tall, centred on a transparent PNG of the slot's shape, so
 * terminals that stretch an image to its cell box don't distort it.
 */
async function fitted(bytes: Uint8Array, columns: number, rows: number): Promise<Buffer> {
  const w = columns * PX_PER_COLUMN;
  const h = rows * PX_PER_ROW;
  const img = await Jimp.read(Buffer.from(bytes));
  img.scaleToFit({ w, h });
  const canvas = new Jimp({ width: w, height: h, color: 0x00000000 });
  canvas.composite(img, Math.round((w - img.width) / 2), Math.round((h - img.height) / 2));
  return canvas.getBuffer(JimpMime.png);
}

/** Kitty graphics: PNG, base64 in 4 KB chunks; C=1 leaves the cursor where it was. */
export function kittyCodes(png: Buffer, columns: number, rows: number): string {
  const data = png.toString('base64');
  const chunks = data.match(/.{1,4096}/g) ?? [];
  return chunks
    .map((chunk, i) => {
      const more = i < chunks.length - 1 ? 1 : 0;
      const head = i === 0 ? `a=T,f=100,q=2,C=1,c=${columns},r=${rows},` : '';
      return `\x1b_G${head}m=${more};${chunk}\x1b\\`;
    })
    .join('');
}

/** iTerm2 inline image, sized in cells. */
export function iterm2Codes(png: Buffer, columns: number, rows: number): string {
  return `\x1b]1337;File=inline=1;size=${png.length};width=${columns};height=${rows};preserveAspectRatio=1:${png.toString('base64')}\x07`;
}

/**
 * The image as terminal escape codes filling a slot `columns` wide and `rows` tall, or '' when it can't be shown:
 * images off, no URL, a URL or image fetchImage refuses, a slow or failed download (3 seconds at most), or an image
 * that can't be decoded. Never throws.
 */
export async function productImage(url: string | undefined, json: boolean, columns = 24, rows = 8): Promise<string> {
  if (!url || !imagesEnabled(json)) return '';
  try {
    const image = await fetchImage(sized(url, columns * PX_PER_COLUMN * 2));
    if (!image) return '';
    const png = await fitted(image.bytes, columns, rows);
    return protocol() === 'kitty' ? kittyCodes(png, columns, rows) : iterm2Codes(png, columns, rows);
  } catch {
    return '';
  }
}

/** Runs `f` over `items` with at most `limit` at a time, keeping their order. */
async function mapLimit<T, R>(items: T[], limit: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await f(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const CARD_W = 10; // thumbnail columns
const CARD_H = 4; // thumbnail rows: three detail lines and a gap

/**
 * Cards: each item's thumbnail in a fixed slot on the left (left blank when it has no image), its lines to the
 * right. The slot's rows are reserved first, and the cursor is saved before the image and restored after it, so the
 * text lands beside the image whatever a terminal does with the cursor while drawing.
 */
export async function cards(items: Array<{ imageUrl?: string; lines: string[] }>, json: boolean): Promise<string> {
  const images = await mapLimit(items, 4, (it) => productImage(it.imageUrl, json, CARD_W, CARD_H));
  const indent = `\x1b[${CARD_W + 2}C`;
  return items
    .map((it, i) => {
      const reserve = '\n'.repeat(CARD_H) + `\x1b[${CARD_H}A`;
      const image = images[i] ? `\r\x1b7${images[i]}\x1b8` : '';
      const rows = Array.from({ length: CARD_H }, (_, r) => `\r${indent}${it.lines[r] ?? ''}`).join('\n');
      return reserve + image + rows;
    })
    .join('\n');
}

/**
 * A product image on its own `rows` lines, with the cursor left on the line below it, for views that print a box
 * under the image. Fetch failures give ''.
 */
export async function imageBlock(url: string | undefined, json: boolean, columns = 24, rows = 8): Promise<string> {
  const img = await productImage(url, json, columns, rows);
  if (!img) return '';
  return '\n'.repeat(rows) + `\x1b[${rows}A\r\x1b7${img}\x1b8` + `\x1b[${rows}B\r`;
}
