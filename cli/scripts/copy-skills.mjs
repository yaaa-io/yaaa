// Copies packages/skills/*/SKILL.md into packages/cli/skills so the published CLI carries them.
import { cpSync, rmSync, chmodSync } from 'node:fs';
const from = new URL('../packages/skills/', import.meta.url);
const to = new URL('../packages/cli/skills/', import.meta.url);
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true, filter: (src) => !src.endsWith('package.json') });
chmodSync(new URL('../packages/cli/dist/main.js', import.meta.url), 0o755);
