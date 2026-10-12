import { createInterface } from 'node:readline';
import type { Out } from './output.js';

/**
 * Whether a person is at this terminal: stdin and stdout are a TTY and the output isn't --json. Secrets that let
 * someone into the account (a recovery key, a desk link) are only shown then, never to an agent reading the output.
 */
export const interactive = (json: boolean): boolean => !json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

/**
 * What a command that shows a secret prints without a terminal: no secret, and what the person should run themselves.
 * Exit 0, so an agent reads the message rather than retrying.
 */
export function needsTerminal(out: Out, command: string, message: string): void {
  out.data({ needs_terminal: true, command, message }, () => message);
}

/** Asks a question on the terminal without echoing the answer (for a recovery key). */
export async function askHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  let muted = false;
  // readline echoes typed characters through this; mute it once the question is shown.
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
    if (!muted) process.stderr.write(s);
  };
  try {
    process.stderr.write(question);
    muted = true;
    return await new Promise<string>((resolve) => rl.question('', resolve));
  } finally {
    muted = false;
    process.stderr.write('\n');
    rl.close();
  }
}

/** All of stdin, as text (for `--restore -`). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(typeof c === 'string' ? Buffer.from(c) : (c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}
