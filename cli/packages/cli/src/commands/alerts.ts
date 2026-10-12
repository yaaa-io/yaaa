import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { toJson } from '@bufbuild/protobuf';
import { Command } from 'commander';
import notifier from 'node-notifier';
import { AlertSchema, CliError, EventSchema, Exit, isWsl, ListEventsResponseSchema, toYaaaError, type Alert, type Clients } from '@yaaa/client';
import { ops } from '@yaaa/tools';
import { run, type GlobalOpts } from '../context.js';
import { c, fmtTime } from '../output.js';
import { fetchImage, imagePreference, sized } from '../images.js';
import { openable } from '../open.js';
import { clean, cleanLines } from '../sanitize.js';
import { assetsDir } from '../paths.js';

const g = (cmd: Command) => cmd.optsWithGlobals() as GlobalOpts & Record<string, unknown>;

/** In WSL, notifications can't reach the Windows desktop (and most WSL installs don't run systemd). */
export const WSL_NOTIFY =
  "Desktop notifications don't reach Windows from WSL. Get alerts by email (`yaaa notify email <address>`), in Discord (`yaaa notify discord <webhook-url>`), or on the web desk (`yaaa desk`).";

export function alertsTable(as: Alert[]): string {
  if (as.length === 0) return c.dim('No new alerts.');
  return as
    .map(
      (a) =>
        `${c.warn('●')} ${c.bold(clean(a.title))} ${c.dim(fmtTime(a.createdAt))}\n  ${cleanLines(a.body).replaceAll('\n', '\n  ')}${a.confirmUrl ? `\n  ${c.key(clean(a.confirmUrl))}` : ''}`,
    )
    .join('\n\n');
}

/** New alerts since the cursor this device last saw, then moves the cursor. */
async function newAlerts(clients: Clients, cursor: string): Promise<{ alerts: Alert[]; cursor: string }> {
  const r = await ops.listAlerts(clients, { after: cursor });
  return { alerts: r.message.alerts, cursor: r.message.cursor || cursor };
}

const label = 'io.yaaa.notify';

/** The yaaa mark, shipped in the package (assets/yaaa.png). */
const logo = join(assetsDir, 'yaaa.png');

/**
 * Shows a native notification with the yaaa logo: `icon` is the app icon on Windows and Linux; on macOS
 * `contentImage` shows the logo beside the text (macOS always uses the sending app's own icon in the corner).
 * Alerts go through showAlert, which shows the product's image there instead when it has one.
 */
function show(title: string, message: string, url?: string): void {
  post({ title, message, icon: logo, contentImage: logo, url }, () => undefined);
}

/**
 * notify-send's arguments for a notification: options first, then `--`, so a title or body that starts with `-` is
 * shown as text rather than read as an option.
 */
export function notifySendArgs(title: string, message: string, icon: string): string[] {
  return ['--app-name=yaaa', `--icon=${icon}`, '--expire-time=10000', '--', title, message];
}

/**
 * Posts a desktop notification. Title and body are cleaned of control characters first, and a click opens `url` only
 * when it's https (see openable). On Linux this runs notify-send directly with `--` before the text (node-notifier
 * builds a shell command with the text ahead of its options); elsewhere it's node-notifier. `done` runs once the
 * notification is posted (or, when it waits for a click, once it's clicked or times out).
 */
function post(n: { title: string; message: string; icon: string; contentImage: string; url?: string }, done: () => void): void {
  const title = clean(n.title);
  const message = clean(n.message) || ' ';
  const url = openable(n.url) ? n.url : undefined;
  if (process.platform === 'linux' && !isWsl()) {
    execFile('notify-send', notifySendArgs(title, message, n.icon), { timeout: 10_000 }, () => done());
    return;
  }
  notifier.notify({ title, message, icon: n.icon, contentImage: n.contentImage, open: url, wait: Boolean(url) }, () => done());
}

/**
 * An alert's product image as a temporary file for a macOS notification thumbnail, with a cleanup that deletes it.
 * Fetched when the alert fires (with fetchImage's limits) and removed once the notification is done with it, so no
 * image is kept (Shopify's catalog terms). macOS only: Linux and Windows notifications show just an icon. Any failure
 * means no thumbnail.
 */
async function thumbnail(url: string | undefined): Promise<{ path?: string; cleanup: () => void }> {
  const none = { cleanup: () => undefined };
  if (!url || process.platform !== 'darwin' || imagePreference() === 'off') return none;
  try {
    const image = await fetchImage(sized(url, 200));
    if (!image) return none;
    const dir = mkdtempSync(join(tmpdir(), 'yaaa-alert-'));
    const path = join(dir, `product.${image.format === 'jpeg' ? 'jpg' : image.format}`);
    writeFileSync(path, image.bytes, { mode: 0o600 });
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch {
    return none;
  }
}

/** A notification for one alert, with the product thumbnail when there is one; the image file is gone afterwards. */
async function showAlert(a: Alert): Promise<void> {
  const thumb = await thumbnail(a.imageUrl || undefined);
  post(
    { title: `yaaa · ${clean(a.title)}`, message: clean(a.body).slice(0, 200), icon: logo, contentImage: thumb.path ?? logo, url: a.confirmUrl || undefined },
    () => thumb.cleanup(),
  );
}

/** Text for a launchd plist's <string>: XML's special characters escaped. */
export const plistString = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** The launchd plist that runs `argv` at login, logging to `logs`. */
export function launchdPlist(argv: string[], logs: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${plistString(label)}</string>
  <key>ProgramArguments</key><array>${argv.map((a) => `<string>${plistString(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${plistString(logs)}</string>
  <key>StandardErrorPath</key><string>${plistString(logs)}</string>
</dict></plist>
`;
}

/**
 * One ExecStart argument for a systemd unit: double-quoted with C-style escapes, and `%` and `$` doubled so systemd
 * takes them literally rather than as a specifier or a variable.
 */
export const systemdArg = (a: string): string => JSON.stringify(a).replace(/[%$]/g, (ch) => ch + ch);

/** The systemd user unit that runs `argv` at login. */
export function systemdUnit(argv: string[]): string {
  return `[Unit]\nDescription=yaaa desktop notifications\n\n[Service]\nExecStart=${argv.map(systemdArg).join(' ')}\nRestart=always\n\n[Install]\nWantedBy=default.target\n`;
}

/** Restarts the background notifier, if installed, so it runs the version just installed. Returns whether it did. */
export function restartNotifier(): boolean {
  try {
    if (process.platform === 'darwin') {
      const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
      if (!existsSync(plist)) return false;
      execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 0}/${label}`], { stdio: 'ignore' });
      return true;
    }
    if (process.platform === 'linux') {
      if (!existsSync(join(homedir(), '.config', 'systemd', 'user', 'yaaa-notify.service'))) return false;
      execFileSync('systemctl', ['--user', 'restart', 'yaaa-notify.service'], { stdio: 'ignore' });
      return true;
    }
  } catch {
    // It picks up the new version at the next login instead.
  }
  return false;
}

function notifierCommand(profile: string): string[] {
  // Installed by the yaaa installer, the launcher sets YAAA_LAUNCHER to its own stable path, so the background job keeps
  // working after an upgrade replaces the versioned Node and CLI it ran.
  const launcher = process.env.YAAA_LAUNCHER;
  if (launcher) return [launcher, '--profile', profile, 'notify', 'run'];
  return [process.execPath, process.argv[1] ?? 'yaaa', '--profile', profile, 'notify', 'run'];
}

export function alertCommands(program: Command): void {
  program
    .command('alerts')
    .description('New alerts (watch hits, filter watch matches, restock runs, skipped runs) since you last looked')
    .option('--all', 'everything still open, not just new ones')
    .option('--peek', 'don’t mark them seen')
    .action(async (_o, cmd: Command) => {
      const o = g(cmd);
      await run(o, async ({ clients, store, profile, out }) => {
        const cursor = o.all ? '' : (store.get(profile, 'alerts_cursor') ?? '');
        const r = await newAlerts(clients, cursor);
        if (!o.peek) store.set(profile, 'alerts_cursor', r.cursor);
        out.data(
          { alerts: r.alerts.map((a) => toJson(AlertSchema, a, { useProtoFieldName: true })), cursor: r.cursor },
          () => alertsTable(r.alerts),
        );
      });
    });

  program
    .command('events')
    .description('Your event stream: purchase.updated, watch.triggered, watch.matched, restock.run, restock.skipped')
    .option('--after-seq <seq>', 'only events after this sequence number', '0')
    .option('--follow', 'keep streaming as events happen (JSON lines with --json)')
    .action(async (_o, cmd: Command) => {
      const o = g(cmd);
      await run(o, async ({ clients, out }) => {
        const after = BigInt(String(o.afterSeq));
        const show = (e: { seq: bigint; type: string; createdAt?: Parameters<typeof fmtTime>[0] }) =>
          `${c.dim(String(e.seq).padStart(5))} ${c.key(clean(e.type).padEnd(18))} ${c.dim(fmtTime(e.createdAt))}`;
        if (!o.follow) {
          const r = await clients.events.listEvents({ afterSeq: after, limit: 100 });
          out.result({ schema: ListEventsResponseSchema, message: r }, () => (r.events.length ? r.events.map(show).join('\n') : c.dim('No events.')));
          return;
        }
        let seq = after;
        for (;;) {
          try {
            for await (const m of clients.events.subscribe({ afterSeq: seq, types: [] })) {
              if (!m.event) continue;
              seq = m.event.seq;
              process.stdout.write((out.json ? JSON.stringify(toJson(EventSchema, m.event, { useProtoFieldName: true })) : show(m.event)) + '\n');
            }
          } catch (e) {
            out.note(c.dim(`stream ended (${e instanceof Error ? e.message : e}); reconnecting after seq ${seq}`));
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      });
    });

  const notify = program.command('notify').description('Desktop notifications for watches and restocks');

  notify
    .command('run')
    .description('Run the notifier in the foreground (what the background service runs)')
    .option('--interval <seconds>', 'how often to check', '60')
    .action(async (_o, cmd: Command) => {
      const o = g(cmd);
      await run(o, async ({ clients, store, profile, out }) => {
        let cursor = store.get(profile, 'notify_cursor') ?? '';
        if (!cursor) {
          // First run: start from now, so old alerts don't all pop up at once.
          const all = await ops.listAlerts(clients, { after: '' });
          cursor = all.message.cursor;
          store.set(profile, 'notify_cursor', cursor);
        }
        out.note(c.dim(`notifier running for profile ${profile}; checking every ${o.interval}s`));
        for (;;) {
          try {
            const r = await newAlerts(clients, cursor);
            for (const a of r.alerts) {
              await showAlert(a);
              out.note(`${fmtTime(a.createdAt)} ${clean(a.title)}`);
            }
            cursor = r.cursor;
            store.set(profile, 'notify_cursor', cursor);
          } catch (e) {
            out.note(c.dim(`check failed: ${e instanceof Error ? e.message : e}`));
          }
          await new Promise((res) => setTimeout(res, Number(o.interval) * 1000));
        }
      });
    });

  notify
    .command('test')
    .description('Show a test notification')
    .action(async (_o, cmd: Command) => {
      await run(g(cmd), async ({ out, apiUrl }) => {
        if (isWsl()) throw new CliError(WSL_NOTIFY, Exit.conflict, 'CONFLICT');
        show('yaaa · test', 'Desktop notifications work. Click to open yaaa.io.', apiUrl);
        out.data({ sent: true }, () => `${c.ok('✓')} Sent a test notification.`);
      });
    });

  notify
    .command('install')
    .description('Run the notifier in the background at login (launchd on macOS, a systemd user unit on Linux)')
    .action(async (_o, cmd: Command) => {
      await run(g(cmd), async ({ profile, out }) => {
        if (isWsl()) throw new CliError(WSL_NOTIFY, Exit.conflict, 'CONFLICT');
        const argv = notifierCommand(profile);
        if (process.platform === 'darwin') {
          const dir = join(homedir(), 'Library', 'LaunchAgents');
          const plist = join(dir, `${label}.plist`);
          mkdirSync(dir, { recursive: true });
          const logs = join(homedir(), 'Library', 'Logs', 'yaaa-notify.log');
          writeFileSync(plist, launchdPlist(argv, logs));
          try {
            execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' });
          } catch {
            /* not loaded yet */
          }
          execFileSync('launchctl', ['load', plist]);
          out.data({ installed: true, path: plist }, () => `${c.ok('✓')} Desktop notifications on. ${c.dim(`(${plist})`)}`);
        } else if (process.platform === 'linux') {
          const dir = join(homedir(), '.config', 'systemd', 'user');
          const unit = join(dir, 'yaaa-notify.service');
          mkdirSync(dir, { recursive: true });
          writeFileSync(unit, systemdUnit(argv));
          execFileSync('systemctl', ['--user', 'daemon-reload']);
          execFileSync('systemctl', ['--user', 'enable', '--now', 'yaaa-notify.service']);
          out.data({ installed: true, path: unit }, () => `${c.ok('✓')} Desktop notifications on. ${c.dim(`(${unit})`)}`);
        } else {
          throw new CliError('Background notifications on Windows are coming soon. For now run `yaaa notify run` in a terminal.', Exit.usage);
        }
      });
    });

  notify
    .command('status')
    .description('Where alerts reach you: desktop notifications on this device, email, and Discord')
    .action(async (_o, cmd: Command) => {
      await run(g(cmd), async ({ clients, out }) => {
        const wsl = isWsl();
        const path = wsl
          ? undefined
          : process.platform === 'darwin'
            ? join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
            : join(homedir(), '.config', 'systemd', 'user', 'yaaa-notify.service');
        const installed = path !== undefined && existsSync(path);
        // Email and Discord are on the account, so they need the API; without an account (or offline) the desktop
        // notifier is still reported, and `channels_error` says why the rest isn't.
        let ch: { email: string; pendingEmail: string; discord: string } = { email: '', pendingEmail: '', discord: '' };
        let channelsError: string | undefined;
        try {
          ch = await clients.account.getAlertChannels({});
        } catch (e) {
          channelsError = toYaaaError(e).message;
        }
        // `installed` and `path` are the desktop notifier, as before; `any` is whether alerts reach the buyer outside
        // their agent and the desk at all, which agents check before asking how they'd like to hear.
        const any = installed || Boolean(ch.email) || Boolean(ch.discord);
        out.data(
          {
            installed,
            ...(path ? { path } : {}),
            ...(wsl ? { supported: false, reason: WSL_NOTIFY } : {}),
            email: ch.email || null,
            pending_email: ch.pendingEmail || null,
            discord: ch.discord || null,
            any,
            ...(channelsError ? { channels_error: channelsError } : {}),
          },
          () =>
            channelsError
              ? [
                  `desktop  ${wsl ? c.warn('not available in WSL') : installed ? `${c.ok('on')} ${c.dim(path!)}` : `${c.dim('off')} · yaaa notify install`}`,
                  `email, discord  ${c.warn(`unknown: ${clean(channelsError)}`)}`,
                ].join('\n')
              : [
              `desktop  ${wsl ? c.warn('not available in WSL') : installed ? `${c.ok('on')} ${c.dim(path!)}` : `${c.dim('off')} · yaaa notify install`}`,
              `email    ${ch.email ? `${c.ok('on')} ${clean(ch.email)}` : c.dim('off')}${ch.pendingEmail ? c.warn(` · waiting for you to confirm ${clean(ch.pendingEmail)} (check its inbox)`) : ch.email ? '' : c.dim(' · yaaa notify email <address>')}`,
                  `discord  ${ch.discord ? `${c.ok('on')} ${c.dim(clean(ch.discord))}` : `${c.dim('off')} · yaaa notify discord <webhook-url>`}`,
                ].join('\n'),
        );
      });
    });

  notify
    .command('uninstall')
    .description('Turn off background desktop notifications')
    .action(async (_o, cmd: Command) => {
      await run(g(cmd), async ({ out }) => {
        if (process.platform === 'darwin') {
          const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
          try {
            execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' });
          } catch {
            /* already unloaded */
          }
          rmSync(plist, { force: true });
        } else if (process.platform === 'linux') {
          try {
            execFileSync('systemctl', ['--user', 'disable', '--now', 'yaaa-notify.service'], { stdio: 'ignore' });
          } catch {
            /* already off */
          }
          rmSync(join(homedir(), '.config', 'systemd', 'user', 'yaaa-notify.service'), { force: true });
        }
        out.data({ installed: false }, () => `${c.ok('✓')} Desktop notifications off.`);
      });
    });

  notify
    .command('email [address]')
    .description('Email alerts as a fallback channel: an address (confirmed by a link sent there), or "off"')
    .action(async (address: string | undefined, _o, cmd: Command) => {
      await run(g(cmd), async ({ clients, out, idempotencyKey }) => {
        if (!address) throw new CliError('Usage: yaaa notify email <address> | off');
        const email = address === 'off' ? '' : address;
        const r = await clients.account.setAlertEmail({ idempotencyKey: idempotencyKey ?? crypto.randomUUID(), email });
        out.data({ email: email || null, status: r.status }, () => {
          if (r.status === 'confirmation_sent')
            return `${c.ok('✓')} Sent a confirmation link to ${email}. Email alerts go there once you click it ${c.dim('(it works for 24 hours; check spam if it isn’t there)')}.`;
          if (r.status === 'already_on') return `${c.ok('✓')} Email alerts already go to ${email}.`;
          return `${c.ok('✓')} Email alerts off.`;
        });
      });
    });

  notify
    .command('discord [webhook-url]')
    .description('Post alerts to a Discord channel: its webhook URL, or "off"')
    .addHelpText(
      'after',
      '\nIn Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.\n' +
        'Use a private channel: anyone who can see it can open your confirm links.',
    )
    .action(async (url: string | undefined, _o, cmd: Command) => {
      await run(g(cmd), async ({ clients, out, idempotencyKey }) => {
        if (!url) throw new CliError('Usage: yaaa notify discord <webhook-url> | off');
        const webhookUrl = url === 'off' ? '' : url;
        const res = await clients.account.setAlertDiscord({ idempotencyKey: idempotencyKey ?? crypto.randomUUID(), webhookUrl });
        out.data({ discord: res.webhook || null }, () =>
          res.webhook
            ? `${c.ok('✓')} Alerts post to your Discord channel. yaaa sent a welcome message there.\n` +
              c.dim('  Keep the channel private: anyone who can see it can open your confirm links.')
            : `${c.ok('✓')} Discord alerts off.`,
        );
      });
    });
}

