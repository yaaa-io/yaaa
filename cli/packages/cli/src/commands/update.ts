import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Command } from 'commander';
import { CliError, Exit, VERSION } from '@yaaa/client';
import { run, type GlobalOpts } from '../context.js';
import { c } from '../output.js';
import { compareVersions, installation, latestVersion, releasesUrl, updateHint } from '../installation.js';
import { installRelease, ReleaseError } from '../release.js';
import { restartNotifier } from './alerts.js';

const g = (cmd: Command) => cmd.optsWithGlobals() as GlobalOpts & Record<string, unknown>;

export function updateCommand(program: Command): void {
  program
    .command('update')
    .description('Update yaaa to the latest version (or --to <version>); refreshes the skills and the notifier too')
    .option('--check', 'only say whether a newer version is out')
    .option('--to <version>', 'install this version instead, newer or older')
    .action(async (_o, cmd: Command) => {
      const o = g(cmd);
      const wanted = o.to === undefined ? undefined : String(o.to);
      await run(o, async ({ out }) => {
        const inst = installation();
        let url: string;
        try {
          url = releasesUrl(inst);
        } catch (e) {
          throw new CliError((e as Error).message, Exit.usage, 'INVALID_ARGUMENT');
        }
        const latest = wanted ?? (await latestVersion(url).catch((e: Error) => {
          throw new CliError(`Couldn't check for a new version: ${e.message}`, Exit.retryable, 'UNAVAILABLE');
        }));
        const newer = compareVersions(latest, VERSION) > 0;

        if (o.check || inst.kind !== 'installer') {
          const how = updateHint(inst);
          out.data({ current: VERSION, latest, update_available: newer, how }, () =>
            newer
              ? `yaaa ${c.bold(latest)} is out (you have ${VERSION}). Update with: ${c.key(how)}`
              : `${c.ok('✓')} yaaa ${VERSION} is the latest.`,
          );
          return;
        }
        if (!wanted && !newer) {
          out.data({ current: VERSION, latest, updated: false }, () => `${c.ok('✓')} yaaa ${VERSION} is the latest.`);
          return;
        }

        // Download, check the signature and checksum, and unpack here, rather than running a downloaded script. The
        // `current` link switches in one step and this version stays, so the running yaaa is undisturbed.
        try {
          await installRelease({
            url,
            version: latest,
            dir: inst.dir,
            bin: inst.bin,
            keep: [VERSION],
            // People see the progress; with --json it goes to stderr, keeping stdout to one JSON object.
            log: (s) => (out.json ? process.stderr : process.stdout).write(s + '\n'),
          });
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          // A release that fails its checks isn't something to retry into; a failed download is.
          const bad = e instanceof ReleaseError && !e.retryable;
          throw new CliError(`The update to ${latest} didn't finish (${why}); yaaa ${VERSION} is still installed.`, bad ? Exit.unexpected : Exit.retryable, bad ? 'UNVERIFIED_RELEASE' : 'UNAVAILABLE');
        }

        // Its first run refreshes the agents' skills (and says so on a terminal).
        const now = execFileSync(inst.bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
        if (now !== latest) throw new CliError(`Installed ${latest}, but yaaa now reports ${now}. Run \`curl -fsSL ${url}/install | sh\` to repair it.`, Exit.unexpected, 'UNEXPECTED');
        const notifier = restartNotifier();
        out.data({ previous: VERSION, current: now, updated: true, notifier_restarted: notifier }, () =>
          [
            `${c.ok('✓')} Updated yaaa ${VERSION} → ${c.bold(now)}`,
            ...(notifier ? [`${c.ok('✓')} Restarted desktop notifications`] : []),
            c.dim(`The previous version stays in ${join(inst.dir, 'versions', VERSION)}; \`yaaa update --to ${VERSION}\` goes back.`),
          ].join('\n'),
        );
      });
    });
}
