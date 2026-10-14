import { Command, Option } from 'commander';
import { VERSION } from '@yaaa/client';
import { accountCommands } from './commands/account.js';
import { alertCommands } from './commands/alerts.js';
import { devCommands, showDevCommands } from './commands/dev.js';
import { mcpCommand } from './commands/mcp.js';
import { plusCommands } from './commands/plus.js';
import { shopCommands } from './commands/shop.js';
import { updateCommand } from './commands/update.js';

/**
 * Every command and option, without running anything. main.ts parses the command line with it; the docs' command
 * reference (scripts/reference.mjs) is generated from it, so the two can't drift apart.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('yaaa')
    .description('yaaa (Yet Another AI Agent) by NxisAI: buy from online stores at retail, in your name. Every purchase ends with a confirm link.')
    .version(VERSION, '--version')
    .option('--json', 'print the exact API response as JSON (for agents)')
    .option('--pretty', 'with --json, indent it for reading')
    // Developer options, like `yaaa dev`: they always work, but help lists them only for the local profile or YAAA_DEV=1,
    // so buyers and their agents don't point yaaa at another API by mistake.
    .addOption(new Option('--profile <name>', 'default, dev, or local (also YAAA_PROFILE)').hideHelp(!showDevCommands()))
    .addOption(new Option('--api-url <url>', 'override the API URL (also YAAA_API_URL)').hideHelp(!showDevCommands()))
    .option('--idempotency-key <key>', 'reuse the same key when retrying a command that changes state')
    .addHelpText('after', '\nDocs: https://yaaa.io/docs/ · every command: https://yaaa.io/docs/reference/')
    .showHelpAfterError()
    .exitOverride();

  accountCommands(program);
  plusCommands(program);
  shopCommands(program);
  alertCommands(program);
  mcpCommand(program);
  updateCommand(program);
  devCommands(program);
  return program;
}
