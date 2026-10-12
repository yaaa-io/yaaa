import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { VERSION, type ConfigStore } from '@yaaa/client';
import { skillsDir } from './paths.js';

/** The skills yaaa installs into each agent. */
export const SKILLS = ['yaaa-buyer', 'yaaa-advisor'];

/** Terminal agents yaaa knows how to install skills into, with their default skills folders. */
export function detectAgents(): Array<{ name: string; skillsDir: string; found: boolean }> {
  const h = homedir();
  const which = (bin: string) => {
    try {
      execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  return [
    { name: 'Claude Code', skillsDir: join(h, '.claude', 'skills'), found: existsSync(join(h, '.claude')) || which('claude') },
    { name: 'Hermes', skillsDir: join(h, '.hermes', 'skills'), found: existsSync(join(h, '.hermes')) || which('hermes') },
  ];
}

const bundled = (name: string) => join(skillsDir, name, 'SKILL.md');

/** Copies this version's skills into `target`. Returns the files written. */
export function installSkills(target: string): string[] {
  const installed: string[] = [];
  if (!existsSync(skillsDir)) return installed;
  for (const name of SKILLS) {
    const src = bundled(name);
    if (!existsSync(src)) continue;
    const dest = join(target, name);
    mkdirSync(dest, { recursive: true });
    copyFileSync(src, join(dest, 'SKILL.md'));
    installed.push(join(dest, 'SKILL.md'));
  }
  return installed;
}

/** Whether `target` has every skill, each matching this version's. */
export function skillsCurrent(target: string): boolean {
  try {
    return SKILLS.every((s) => readFileSync(join(target, s, 'SKILL.md'), 'utf8') === readFileSync(bundled(s), 'utf8'));
  } catch {
    return false;
  }
}

const hasAnySkill = (target: string) => SKILLS.some((s) => existsSync(join(target, s, 'SKILL.md')));

/** `yaaa init --skills-dir <path>` folders, remembered so updates reach them too. */
export function rememberSkillsDir(store: ConfigStore, dir: string): void {
  const dirs = customSkillsDirs(store);
  if (!dirs.includes(dir)) store.deviceSet('skills_dirs', JSON.stringify([...dirs, dir]));
}

function customSkillsDirs(store: ConfigStore): string[] {
  try {
    return JSON.parse(store.deviceGet('skills_dirs') ?? '[]') as string[];
  } catch {
    return [];
  }
}

/**
 * Brings yaaa's skills up to date wherever they're installed: each agent's folder that already has a yaaa skill, and
 * the folders given to `yaaa init --skills-dir`. Folders without yaaa's skills are left alone, since the user didn't
 * install them there. Returns the places that changed.
 */
export function refreshSkills(store: ConfigStore): Array<{ agent: string; dir: string }> {
  const targets = [
    ...detectAgents().map((a) => ({ agent: a.name, dir: a.skillsDir })),
    ...customSkillsDirs(store).map((dir) => ({ agent: dir, dir })),
  ];
  const changed: Array<{ agent: string; dir: string }> = [];
  for (const t of targets) {
    if (!hasAnySkill(t.dir) || skillsCurrent(t.dir)) continue;
    if (installSkills(t.dir).length) changed.push(t);
  }
  return changed;
}

/**
 * Run at start: the first time a new version runs, however it was updated (the installer, `yaaa update`, brew, npm),
 * refresh the installed skills so agents follow this version's instructions. Says so on a terminal; silent for agents
 * (--json or piped output). Never fails a command.
 */
export function syncSkillsOnUpgrade(store: ConfigStore, quiet: boolean, version: string = VERSION): void {
  try {
    if (store.deviceGet('skills_version') === version) return;
    const changed = refreshSkills(store);
    store.deviceSet('skills_version', version);
    if (changed.length && !quiet)
      process.stderr.write(`Updated yaaa's skills to ${version} for ${changed.map((c) => c.agent).join(', ')}.\n`);
  } catch {
    // A read-only home folder or a damaged skill file shouldn't stop the command; `yaaa doctor` reports skills.
  }
}
