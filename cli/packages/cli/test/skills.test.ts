import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '@yaaa/client';
import { skillsDir } from '../src/paths.js';
import { refreshSkills, rememberSkillsDir, syncSkillsOnUpgrade } from '../src/skills.js';

describe('skills follow the CLI', () => {
  let home: string;
  let oldHome: string | undefined;
  let store: ConfigStore;
  const claude = () => join(home, '.claude', 'skills');
  const bundled = (s: string) => readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'yaaa-skills-'));
    oldHome = process.env.HOME;
    process.env.HOME = home;
    store = new ConfigStore(join(home, '.config', 'yaaa'));
  });
  afterEach(() => {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('updates agents that have yaaa skills, adds the missing ones, and leaves other agents alone', () => {
    mkdirSync(join(claude(), 'yaaa-buyer'), { recursive: true });
    writeFileSync(join(claude(), 'yaaa-buyer', 'SKILL.md'), 'old instructions');
    mkdirSync(join(home, '.hermes', 'skills'), { recursive: true });

    expect(refreshSkills(store).map((c) => c.agent)).toEqual(['Claude Code']);
    expect(readFileSync(join(claude(), 'yaaa-buyer', 'SKILL.md'), 'utf8')).toBe(bundled('yaaa-buyer'));
    expect(readFileSync(join(claude(), 'yaaa-advisor', 'SKILL.md'), 'utf8')).toBe(bundled('yaaa-advisor'));
    expect(existsSync(join(home, '.hermes', 'skills', 'yaaa-buyer'))).toBe(false);
    expect(refreshSkills(store)).toEqual([]); // already current
  });

  it('reaches folders given to `yaaa init --skills-dir`', () => {
    const custom = join(home, 'my-skills');
    mkdirSync(join(custom, 'yaaa-buyer'), { recursive: true });
    writeFileSync(join(custom, 'yaaa-buyer', 'SKILL.md'), 'old');
    rememberSkillsDir(store, custom);
    rememberSkillsDir(store, custom);
    expect(refreshSkills(store)).toEqual([{ agent: custom, dir: custom }]);
  });

  it('refreshes once per version', () => {
    mkdirSync(join(claude(), 'yaaa-buyer'), { recursive: true });
    writeFileSync(join(claude(), 'yaaa-buyer', 'SKILL.md'), 'old');
    syncSkillsOnUpgrade(store, true, '9.9.9');
    expect(readFileSync(join(claude(), 'yaaa-buyer', 'SKILL.md'), 'utf8')).toBe(bundled('yaaa-buyer'));
    writeFileSync(join(claude(), 'yaaa-buyer', 'SKILL.md'), 'edited by hand');
    syncSkillsOnUpgrade(store, true, '9.9.9'); // same version: leaves it
    expect(readFileSync(join(claude(), 'yaaa-buyer', 'SKILL.md'), 'utf8')).toBe('edited by hand');
    expect(store.deviceGet('skills_version')).toBe('9.9.9');
  });
});
