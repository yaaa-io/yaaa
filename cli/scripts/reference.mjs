// The command reference, as JSON, from the CLI's own command definitions. yaaa.io/docs renders it.
//   node scripts/reference.mjs                     print it
//   node scripts/reference.mjs --out <file>        write it
//   node scripts/reference.mjs --out <file> --check  fail if <file> is out of date (CI)
// Run `pnpm build` first.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outAt = process.argv.indexOf('--out');
const out = outAt > 0 && process.argv[outAt + 1] ? resolve(process.argv[outAt + 1]) : undefined;
const check = process.argv.includes('--check');
if (check && !out) {
  console.error('--check needs --out <file>, the reference to compare with.');
  process.exit(2);
}

// What a buyer sees: without the developer settings that make help list `yaaa dev`, `--profile` and `--api-url`.
delete process.env.YAAA_DEV;
delete process.env.YAAA_PROFILE;
process.argv = process.argv.slice(0, 2);

const { buildProgram } = await import('../packages/cli/dist/program.js');
const { reference } = await import('../packages/cli/dist/reference.js');

// No version number: the reference changes when commands do, not on every release.
const json = JSON.stringify({ program: reference(buildProgram()) }, null, 2) + '\n';

if (check) {
  let current = '';
  try {
    current = readFileSync(out, 'utf8');
  } catch {}
  if (current !== json) {
    console.error(`${out} is out of date. Run: node scripts/reference.mjs --out ${out}`);
    process.exit(1);
  }
  console.log('cli-reference.json is up to date');
} else if (out) {
  writeFileSync(out, json);
  console.log(`wrote ${out}`);
} else {
  process.stdout.write(json);
}
