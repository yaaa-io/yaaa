import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The CLI package's names: the workspace's and the installer's (@yaaa/cli), and npm's (@yaaa-io/cli, #184). */
const NAMES = new Set(['@yaaa/cli', '@yaaa-io/cli']);

/**
 * The CLI package's root folder, where `skills/` and `assets/` live. Found by walking up to its package.json, so it's
 * the same whether this runs from the workspace (`dist/commands/...`), from the one-file bundle the installer ships, or
 * from the npm package.
 */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (NAMES.has((JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name ?? '')) return dir;
      } catch {
        // Not ours; keep looking.
      }
    }
    const up = dirname(dir);
    if (up === dir) throw new Error('yaaa: can’t find its install folder (no yaaa package.json above it)');
    dir = up;
  }
}

export const root = packageRoot();
export const skillsDir = join(root, 'skills');
export const assetsDir = join(root, 'assets');
