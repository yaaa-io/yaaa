import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The CLI package's root folder, where `skills/` and `assets/` live. Found by walking up to its package.json, so it's
 * the same whether this runs from the workspace (`dist/commands/...`) or from the one-file bundle the installer ships.
 */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === '@yaaa/cli') return dir;
      } catch {
        // Not ours; keep looking.
      }
    }
    const up = dirname(dir);
    if (up === dir) throw new Error('yaaa: can’t find its install folder (no @yaaa/cli package.json above it)');
    dir = up;
  }
}

export const root = packageRoot();
export const skillsDir = join(root, 'skills');
export const assetsDir = join(root, 'assets');
