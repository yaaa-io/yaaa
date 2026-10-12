#!/usr/bin/env node
import { CommanderError } from 'commander';
import { ConfigStore, Exit } from '@yaaa/client';
import { buildProgram } from './program.js';
import { syncSkillsOnUpgrade } from './skills.js';
import { noticeAllowed, startUpdateNotice } from './notice.js';

const program = buildProgram();

// The first run of a new version refreshes the agents' skills, however yaaa was updated. Quiet for agents.
const store = new ConfigStore();
syncSkillsOnUpgrade(store, process.argv.includes('--json') || !process.stderr.isTTY);
// At most once a day, and only for a person at a terminal: say when a newer yaaa is out.
// An unreadable config file is reported by the command itself (see context), not here.
let notice: (() => Promise<void>) | undefined;
try {
  notice = noticeAllowed(process.argv, process.env, Boolean(process.stderr.isTTY)) ? startUpdateNotice(store) : undefined;
} catch {
  notice = undefined;
}

try {
  await program.parseAsync(process.argv);
  await notice?.();
} catch (e) {
  if (e instanceof CommanderError) {
    // --help and --version exit 0; every other parse error is bad usage.
    process.exit(e.exitCode === 0 ? Exit.ok : Exit.usage);
  }
  throw e;
}
