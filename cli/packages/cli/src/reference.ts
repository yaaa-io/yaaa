import type { Command } from 'commander';

/** One command in the docs' reference: what `yaaa <path> --help` shows, as data. */
export interface RefCommand {
  /** The full command, e.g. "yaaa products search". */
  name: string;
  usage: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean; variadic: boolean }>;
  options: Array<{ flags: string; description: string }>;
  /** Help text added after the options, such as examples. */
  notes: string;
  commands: RefCommand[];
}

/**
 * The commands, arguments and options `--help` shows a buyer, from the program itself. Hidden commands and options
 * (`yaaa dev`, `--profile`, `--api-url`) stay hidden. Defaults aren't included: some depend on the machine (the
 * device name), and the descriptions already say what happens when an option is left out.
 */
export function reference(program: Command): RefCommand {
  const help = program.createHelp();
  const walk = (cmd: Command, path: string[]): RefCommand => {
    const name = [...path, cmd.name()].join(' ');
    return {
      name,
      usage: `${name} ${cmd.usage()}`.trim(),
      description: cmd.description(),
      arguments: help.visibleArguments(cmd).map((a) => ({
        name: a.name(),
        description: a.description,
        required: a.required,
        variadic: a.variadic,
      })),
      options: help
        .visibleOptions(cmd)
        .filter((o) => o.long !== '--help')
        .map((o) => ({ flags: o.flags, description: o.description })),
      notes: notes(cmd),
      commands: help
        .visibleCommands(cmd)
        .filter((c) => c.name() !== 'help')
        .map((c) => walk(c, [...path, cmd.name()])),
    };
  };
  return walk(program, []);
}

/** Text a command adds to its help (addHelpText), such as examples, at a fixed width and without colour. */
function notes(cmd: Command): string {
  let text = '';
  cmd.configureOutput({ writeOut: (s) => (text += s), getOutHelpWidth: () => 100, getOutHasColors: () => false });
  const base = cmd.helpInformation();
  cmd.outputHelp();
  return text.startsWith(base) ? text.slice(base.length).trim() : '';
}
