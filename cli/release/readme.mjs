/**
 * The npm package's README: release/npm/README.md, with `<!-- commands -->` replaced by a table of every command, from
 * the CLI's own definitions (the same as yaaa.io/docs/reference), so each version lists exactly its own commands.
 * Run `pnpm build` first.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pkgDir } from './app.mjs';

const MARKER = '<!-- commands -->';

/** Top-level commands by section, in reading order. A command not listed here lands in "More", so none is lost. */
const SECTIONS = [
  ['Get started', ['init', 'doctor', 'update']],
  ['Shop', ['products', 'buy', 'status', 'cancel']],
  ['Watch prices and restocks', ['watch', 'restock']],
  ['Alerts and notifications', ['alerts', 'events', 'notify']],
  ['Your account', ['whoami', 'login', 'recovery-key', 'desk', 'shop', 'plus', 'logout', 'config']],
  ['For agents', ['mcp']],
];

/** A cell's text: one line, with pipes escaped. */
const cell = (s) => s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

/** Every command under `c`, itself included when it does something of its own or has nothing under it. */
function rows(c) {
  const out = [];
  if (c.commands.length === 0 || c.description) out.push(`| \`${cell(c.usage.replace(/ \[(options|command)\]/g, ''))}\` | ${cell(c.description)} |`);
  for (const s of c.commands) out.push(...rows(s));
  return out;
}

/** The commands as Markdown: a heading and a table per section. */
export async function commandsMarkdown() {
  // What a buyer sees: without the developer settings that make help list `yaaa dev`, `--profile` and `--api-url`.
  const saved = { dev: process.env.YAAA_DEV, profile: process.env.YAAA_PROFILE, argv: process.argv };
  delete process.env.YAAA_DEV;
  delete process.env.YAAA_PROFILE;
  process.argv = process.argv.slice(0, 2);
  try {
    const { buildProgram } = await import(pathToFileURL(join(pkgDir, 'dist/program.js')).href);
    const { reference } = await import(pathToFileURL(join(pkgDir, 'dist/reference.js')).href);
    const top = reference(buildProgram()).commands;
    const byName = new Map(top.map((c) => [c.name.replace(/^yaaa /, ''), c]));
    const listed = new Set(SECTIONS.flatMap(([, names]) => names));
    const sections = [...SECTIONS, ['More', [...byName.keys()].filter((n) => !listed.has(n))]];
    const md = [];
    for (const [title, names] of sections) {
      const cmds = names.map((n) => byName.get(n)).filter(Boolean);
      if (cmds.length === 0) continue;
      md.push(`### ${title}`, '', '| Command | What it does |', '| --- | --- |', ...cmds.flatMap(rows), '');
    }
    return md.join('\n').trimEnd();
  } finally {
    if (saved.dev !== undefined) process.env.YAAA_DEV = saved.dev;
    if (saved.profile !== undefined) process.env.YAAA_PROFILE = saved.profile;
    process.argv = saved.argv;
  }
}

/** The README for the npm package. */
export async function npmReadme(template = join(dirname(fileURLToPath(import.meta.url)), 'npm/README.md')) {
  const text = readFileSync(template, 'utf8');
  if (!text.includes(MARKER)) throw new Error(`${template} has no ${MARKER} marker for the command table`);
  return text.replace(MARKER, await commandsMarkdown());
}
