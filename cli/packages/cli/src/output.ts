import { timestampDate, type Timestamp } from '@bufbuild/protobuf/wkt';
import { toJson } from '@bufbuild/protobuf';
import { ProductSchema, type Money } from '@yaaa/client';
import { toYaaaError, type YaaaError } from '@yaaa/client';
import { asJson, type Result } from '@yaaa/tools';
import { installation, updateHint } from './installation.js';
import { clean, cleanLines } from './sanitize.js';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  ok: wrap('32'),
  warn: wrap('33'),
  hot: wrap('35'),
  key: wrap('36'),
  err: wrap('31'),
};

export const fmtMoney = (m?: Money): string =>
  m && m.amount ? (m.currencyCode === 'USD' || !m.currencyCode ? `$${clean(m.amount)}` : `${clean(m.amount)} ${clean(m.currencyCode)}`) : '—';

export function fmtTime(t?: Timestamp): string {
  if (!t) return '—';
  const d = timestampDate(t);
  const now = Date.now();
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function fmtDate(t?: Timestamp): string {
  if (!t) return '—';
  return timestampDate(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - visible(s).length));

/** A titled box of label/value rows. */
export function box(title: string, rows: Array<[string, string]>): string {
  const lw = Math.max(...rows.map(([l]) => l.length));
  const lines = rows.map(([l, v]) => `${c.dim(pad(l, lw))}  ${v}`);
  const w = Math.max(visible(title).length + 2, ...lines.map((l) => visible(l).length));
  const top = `┌─ ${c.bold(title)} ${'─'.repeat(Math.max(0, w - visible(title).length - 1))}┐`;
  return [top, ...lines.map((l) => `│ ${pad(l, w)} │`), `└${'─'.repeat(w + 2)}┘`].join('\n');
}

export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return c.dim('(none)');
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => visible(r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((cell, i) => pad(cell, widths[i]!)).join('  ').trimEnd();
  return [c.dim(line(headers)), ...rows.map(line)].join('\n');
}

/** An error as agents read it: reason, message, metadata, and alternatives as proto3 JSON. */
export function errorJson(err: YaaaError): Record<string, unknown> {
  return {
    reason: err.reason,
    message: err.message,
    metadata: err.metadata,
    ...(err.alternatives?.length ? { alternatives: err.alternatives.map((p) => toJson(ProductSchema, p, { useProtoFieldName: true })) } : {}),
  };
}

export interface Out {
  json: boolean;
  /** Prints a result: its proto3 JSON with --json, else the rich view. */
  result(r: Result, rich: () => string): void;
  /** Prints a plain JSON object with --json, else the rich view. */
  data(obj: unknown, rich: () => string): void;
  /** People-only notes; suppressed with --json. */
  note(s: string): void;
  fail(e: unknown): never;
}

export function output(json: boolean): Out {
  const write = (s: string) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
  return {
    json,
    result(r, rich) {
      write(json ? JSON.stringify(asJson(r)) : rich());
    },
    data(obj, rich) {
      write(json ? JSON.stringify(obj) : rich());
    },
    note(s) {
      if (!json) process.stderr.write(s + '\n');
    },
    fail(e): never {
      const err: YaaaError = toYaaaError(e);
      if (json) write(JSON.stringify({ error: errorJson(err), exit_code: err.exit }));
      else {
        process.stderr.write(`${c.err('✗')} ${cleanLines(err.message)}\n`);
        if (err.reason === 'CLIENT_OUTDATED') process.stderr.write(`Update with: ${c.key(updateHint(installation()))}\n`);
        if (err.alternatives?.length) {
          process.stderr.write(`\n${c.bold('yaaa can buy these instead:')}\n`);
          process.stderr.write(
            table(
              ['PRODUCT', 'TITLE', 'STORE', 'PRICE'],
              err.alternatives.map((p) => [c.key(clean(p.productId)), clean(p.title), clean(p.store?.name), fmtMoney(p.price)]),
            ) + '\n',
          );
        }
        if (process.env.YAAA_DEBUG && e instanceof Error && e.stack) process.stderr.write(c.dim(e.stack) + '\n');
      }
      process.exit(err.exit);
    },
  };
}
