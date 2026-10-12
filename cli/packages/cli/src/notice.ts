import { VERSION, type ConfigStore } from '@yaaa/client';
import { c } from './output.js';
import { compareVersions, installation, latestVersion, releasesUrl, updateHint } from './installation.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Whether this run may check for and mention a new version: only for a person at a terminal. Never with --json,
 * piped output (agents), in CI, for the MCP server or the background notifier, for `yaaa update` itself, or with
 * YAAA_NO_UPDATE_CHECK=1.
 */
export function noticeAllowed(argv: string[], env: NodeJS.ProcessEnv, stderrIsTTY: boolean): boolean {
  if (!stderrIsTTY || env.YAAA_NO_UPDATE_CHECK === '1' || env.CI) return false;
  if (argv.includes('--json') || argv.includes('--version') || argv.includes('--help') || argv.includes('-h')) return false;
  const words = argv.slice(2).filter((a) => !a.startsWith('-'));
  if (['mcp', 'update'].includes(words[0] ?? '')) return false;
  if (words[0] === 'notify' && words[1] === 'run') return false;
  return true;
}

export interface NoticeState {
  checkedAt?: number;
  latest?: string;
  notifiedAt?: number;
}

/** Whether to fetch releases/latest now: at most once a day. */
export const checkDue = (s: NoticeState, now: number) => !s.checkedAt || now - s.checkedAt >= DAY;

/** The version to mention, if it's newer and nothing was said in the last day. */
export function versionToMention(s: NoticeState, current: string, now: number): string | undefined {
  if (!s.latest || compareVersions(s.latest, current) <= 0) return undefined;
  if (s.notifiedAt && now - s.notifiedAt < DAY) return undefined;
  return s.latest;
}

const num = (v: string | undefined) => (v ? Number(v) || undefined : undefined);

/**
 * Starts the check when a run begins and returns a function to call when it ends, which prints the notice (to
 * stderr) if there is one. The end waits at most `graceMs` for a slow network, then gives up without a word.
 */
export function startUpdateNotice(store: ConfigStore, now = Date.now(), graceMs = 400): () => Promise<void> {
  const state: NoticeState = {
    checkedAt: num(store.deviceGet('update_checked_at')),
    latest: store.deviceGet('update_latest'),
    notifiedAt: num(store.deviceGet('update_notified_at')),
  };
  const inst = installation();
  const check: Promise<void> = checkDue(state, now)
    ? latestVersion(releasesUrl(inst), 3000)
        .then((latest) => {
          state.latest = latest;
          state.checkedAt = now;
          store.deviceSet('update_latest', latest);
          store.deviceSet('update_checked_at', String(now));
        })
        .catch(() => undefined) // Offline or a slow CDN: try again next run.
    : Promise.resolve();
  return async () => {
    try {
      await Promise.race([check, new Promise((r) => setTimeout(r, graceMs).unref())]);
      const v = versionToMention(state, VERSION, Date.now());
      if (!v) return;
      store.deviceSet('update_notified_at', String(Date.now()));
      process.stderr.write(`\n${c.dim(`yaaa ${v} is available (you have ${VERSION}). Update with:`)} ${c.key(updateHint(inst))}\n`);
    } catch {
      // A notice must never break a command.
    }
  };
}
