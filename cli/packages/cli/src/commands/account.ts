import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openUrl } from '../open.js';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { Command } from 'commander';
import {
  apiOrigin,
  isWsl,
  platformName,
  CheckResponse_Status,
  CliError,
  type Clients,
  type Credentials,
  CreateDeskLinkResponseSchema,
  Exit,
  GetAccountResponseSchema,
  PollShopLinkResponse_Status,
  toYaaaError,
  unknownApi,
  VERSION,
  wrongApi,
} from '@yaaa/client';
import { run, type GlobalOpts } from '../context.js';
import { box, c } from '../output.js';
import { planLine, planRows, plusLine } from '../views.js';
import { askHidden, interactive, needsTerminal, readStdin } from '../terminal.js';
import { clean } from '../sanitize.js';
import { key } from '@yaaa/tools';

import { SKILLS, detectAgents, installSkills, rememberSkillsDir, skillsCurrent } from '../skills.js';
import { compareVersions, installation, NPM_PACKAGE, updateHint, yaaaOnPath, type Installation } from '../installation.js';
export { skillsDir } from '../paths.js';
export { detectAgents };

/** A desk link that lands on the add-a-passkey step. The token stays in the fragment, after the query. */
export function passkeyLink(deskUrl: string): string {
  const [base, token] = deskUrl.split('#', 2);
  return `${base}${base!.includes('?') ? '&' : '?'}next=passkey${token === undefined ? '' : `#${token}`}`;
}

/** Opens a URL in the default browser. Returns false when it couldn't. */
const g = (cmd: Command) => cmd.optsWithGlobals() as GlobalOpts & Record<string, unknown>;

/** A new recovery key, shown once. */
function recoveryKeyView(k: string): string {
  return box('recovery key · shown once', [
    ['key', c.bold(k)],
    ['', 'Save it in your password manager. With it, `yaaa init --restore`'],
    ['', 'gets this account back on any device. yaaa can’t show it again.'],
  ]);
}

/** Said instead of showing a recovery key when no person is at the terminal (an agent ran the command). */
const RECOVERY_KEY_IN_TERMINAL =
  'A recovery key is only shown in a terminal, to the person whose account it is. Ask them to run `yaaa recovery-key` themselves, in their own terminal, and save the key in their password manager.';

/** Said by `init` when this device's saved sign-in is refused: how to get that account back, or start a new one. */
export function signInStopped(accountId: string): string {
  return (
    `This device's sign-in to account ${accountId} no longer works: it was signed out, or the account no longer exists. ` +
    'To get that account back, run `yaaa logout`, then `yaaa init --restore` (with your recovery key) or `yaaa init --passkey`. ' +
    'To start a new account instead, run `yaaa logout`, then `yaaa init`.'
  );
}

/** The recovery key from `--restore`: its value, stdin for `-` or when piped, or a prompt on a terminal. */
async function restoreKey(value: unknown): Promise<string> {
  if (typeof value === 'string' && value !== '-') return value;
  if (value === true && process.stdin.isTTY) return askHidden('Recovery key: ');
  return (await readStdin()).trim();
}

/**
 * Signs this terminal into an existing account with a passkey: the person opens the device page, checks the code, and
 * approves with a passkey while this polls. Progress goes to stderr so --json output stays one object.
 */
async function passkeySignIn(clients: Clients, deviceName: string, json: boolean): Promise<Credentials> {
  const s = await clients.auth.startPasskeySignIn({ deviceName });
  if (json) process.stderr.write(JSON.stringify({ verification_url: s.verificationUrl, user_code: s.userCode }) + '\n');
  else
    process.stderr.write(
      `Open ${c.key(clean(s.verificationUrl))}
on a device with your yaaa passkey, enter the code ${c.bold(clean(s.userCode))}, and approve. Waiting…
`,
    );
  const deadline = s.expiresAt ? timestampDate(s.expiresAt).getTime() : Date.now() + 600_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.max(1, s.intervalSeconds) * 1000));
    const p = await clients.auth.pollPasskeySignIn({ deviceCode: s.deviceCode });
    if (p.status === 'approved')
      return {
        account_id: p.account?.accountId ?? '',
        access_token: p.accessToken,
        refresh_token: p.refreshToken,
        access_expires_at: p.accessTokenExpiresAt ? timestampDate(p.accessTokenExpiresAt).toISOString() : '',
      };
    if (p.status === 'denied') throw new CliError('Signing in was cancelled on the device page.', Exit.conflict, 'CONFLICT');
    if (p.status === 'expired') break;
  }
  throw new CliError('The code expired. Run `yaaa init --passkey` again.', Exit.conflict, 'CONFLICT');
}

export function accountCommands(program: Command): void {
  program
    .command('recovery-key')
    .description('Get a recovery key for this account, shown in your terminal; --replace makes a new one (asks for the current one), and the old one stops working')
    .option('--replace', 'replace the existing key')
    .action(async (_o, cmd: Command) => {
      const o = g(cmd);
      await run(o, async ({ clients, out }) => {
        if (!interactive(out.json)) {
          needsTerminal(out, o.replace ? 'yaaa recovery-key --replace' : 'yaaa recovery-key', RECOVERY_KEY_IN_TERMINAL);
          return;
        }
        // Replacing a key needs the current one (or a passkey, on the web desk), so a copied sign-in can't swap it.
        let current = '';
        if (o.replace && (await clients.auth.getAccount({})).account?.hasRecoveryKey) {
          current = (await askHidden('Your current recovery key (press Enter if you lost it): ')).trim();
          if (!current)
            throw new CliError(
              'Without the current key, replace it on the web desk with a passkey: run `yaaa desk`, then open Security. No passkey yet? `yaaa login` adds one.',
              Exit.conflict,
              'CONFLICT',
            );
        }
        const r = await clients.auth.createRecoveryKey({ replace: Boolean(o.replace), currentRecoveryKey: current });
        out.data({ recovery_key: r.recoveryKey }, () => `${c.ok('✓')} ${o.replace ? 'Replaced' : 'Made'} the recovery key\n${recoveryKeyView(r.recoveryKey)}`);
      });
    });

  program
    .command('init')
    .description('Set up yaaa on this device: an anonymous account (no sign-up) and the skills for your agents')
    .option('--device-name <name>', 'shown on the web desk', `${userInfo().username}@${hostname()}`)
    .option('--skills-dir <path>', 'install skills here instead of each agent’s default folder')
    .option('--no-skills', 'skip installing skills')
    .option('--restore [recovery-key]', 'use your existing account on this device, with the recovery key you saved: typed at the prompt (best), `-` for stdin, or as the value')
    .option('--passkey', 'use your existing account on this device, approved with a passkey in the browser')
    .action(async (_o, cmd: Command) => {
      const o = g(cmd);
      await run(o, async ({ clients, store, profile, apiUrl, out, idempotencyKey }) => {
        let created = false;
        let restored = false;
        let recoveryKey: string | undefined;
        // A profile signed in to another API keeps that sign-in; this API gets its own profile.
        let creds = store.credentials(profile);
        const home = store.signedInTo(profile);
        if (creds && home === undefined) throw unknownApi(profile, apiUrl, Exit.conflict, 'CONFLICT');
        if (home !== undefined && home !== apiOrigin(apiUrl)) throw wrongApi(store, profile, home, apiUrl, Exit.conflict, 'CONFLICT');
        if ((o.restore !== undefined || o.passkey) && creds)
          throw new CliError(
            `This device already uses account ${creds.account_id} for profile '${profile}'. Run \`yaaa logout\` first, or use another --profile.`,
            Exit.conflict,
            'CONFLICT',
          );
        if (o.restore !== undefined && o.passkey) throw new CliError('Use --restore or --passkey, not both.', Exit.usage, 'INVALID_ARGUMENT');
        if (o.passkey) {
          creds = { ...(await passkeySignIn(clients, String(o.deviceName), out.json)), api_url: apiOrigin(apiUrl) };
          store.saveCredentials(profile, creds);
          restored = true;
        } else if (o.restore !== undefined) {
          // Typed at the prompt or piped in, the key stays out of `ps` and shell history; as a value it still works.
          if (typeof o.restore === 'string' && o.restore !== '-')
            out.note(c.dim('Tip: `yaaa init --restore` on its own asks for the key, so it stays out of your shell history.'));
          const recoveryKey = await restoreKey(o.restore);
          if (!recoveryKey) throw new CliError('Give the recovery key you saved: run `yaaa init --restore` and type it, or pipe it in with `--restore -`.', Exit.usage, 'INVALID_ARGUMENT');
          const r = await clients.auth.restoreAccount({ recoveryKey, deviceName: String(o.deviceName) });
          creds = {
            account_id: r.account?.accountId ?? '',
            access_token: r.accessToken,
            refresh_token: r.refreshToken,
            access_expires_at: r.accessTokenExpiresAt ? timestampDate(r.accessTokenExpiresAt).toISOString() : '',
            api_url: apiOrigin(apiUrl),
          };
          store.saveCredentials(profile, creds);
          restored = true;
        } else if (!creds) {
          const r = await clients.auth.createAccount({ idempotencyKey: key(idempotencyKey), deviceName: String(o.deviceName) });
          creds = {
            account_id: r.account?.accountId ?? '',
            access_token: r.accessToken,
            refresh_token: r.refreshToken,
            access_expires_at: r.accessTokenExpiresAt ? timestampDate(r.accessTokenExpiresAt).toISOString() : '',
            api_url: apiOrigin(apiUrl),
          };
          store.saveCredentials(profile, creds);
          created = true;
          // Shown only to a person at a terminal. Run by an agent, the person gets it with `yaaa recovery-key` themselves.
          if (interactive(out.json))
            recoveryKey = await clients.auth.createRecoveryKey({ replace: false }).then(
              (k) => k.recoveryKey,
              () => undefined,
            );
        } else {
          // A saved sign-in can stop working (signed out from the desk, or the account removed): check it before saying
          // "Using", or every command would say to run `yaaa init` and `init` would say all is well. Only a refused sign-in
          // stops here; with the API unreachable, init still installs the skills.
          await clients.auth.getAccount({}).catch((e: unknown) => {
            if (toYaaaError(e).exit === Exit.auth) throw new CliError(signInStopped(creds!.account_id), Exit.auth, 'UNAUTHENTICATED');
          });
        }
        const skills: Array<{ agent: string; files: string[] }> = [];
        if (o.skills !== false) {
          if (o.skillsDir) {
            skills.push({ agent: 'custom', files: installSkills(String(o.skillsDir)) });
            rememberSkillsDir(store, String(o.skillsDir));
          }
          else for (const a of detectAgents().filter((a) => a.found)) skills.push({ agent: a.name, files: installSkills(a.skillsDir) });
        }
        // Without a terminal, the person makes their recovery key themselves: say so, for the agent to pass on.
        const recoveryKeyNext = created && !recoveryKey ? (interactive(out.json) ? 'Couldn’t make a recovery key now. Run `yaaa recovery-key` to get one.' : RECOVERY_KEY_IN_TERMINAL) : undefined;
        // Run once through npx, yaaa isn't installed, but the skills (and the notifier) call `yaaa`.
        const inst = installation();
        const installNext = inst.kind === 'npm' && inst.npx ? `This yaaa ran through npx, so it isn't installed, and your agents' skills run \`yaaa\`. Install it: npm install -g ${NPM_PACKAGE}` : undefined;
        out.data({ account_id: creds.account_id, created, restored, recovery_key: recoveryKey, recovery_key_next: recoveryKeyNext, install_next: installNext, profile, api_url: apiUrl, skills }, () =>
          [
            `${c.ok('✓')} ${created ? 'Created' : restored ? 'Restored' : 'Using'} yaaa account ${c.key(creds!.account_id)} ${c.dim(`(${profile} · ${apiUrl})`)}`,
            ...(recoveryKey ? [recoveryKeyView(recoveryKey)] : []),
            ...(recoveryKeyNext ? [c.warn(recoveryKeyNext)] : []),
            ...(installNext ? [c.warn(installNext)] : []),
            skills.length
              ? skills.map((s) => `${c.ok('✓')} Installed ${s.files.length} skill${s.files.length === 1 ? '' : 's'} for ${s.agent}`).join('\n')
              : isWsl()
                ? c.warn('No terminal agents found in WSL. Install your agent (Claude Code, for example) inside WSL too: an agent running on Windows can’t see or run yaaa here. Then run `yaaa init` again.')
                : c.dim('No terminal agents found. Install skills later with `yaaa init --skills-dir <path>`.'),
            c.dim(created ? 'No sign-up needed. `yaaa login` adds a passkey, so you can sign in from other devices.' : 'No sign-up needed.'),
          ].join('\n'),
        );
      });
    });

  program
    .command('login')
    .description('Add a passkey (Touch ID, Face ID, or your phone) to sign in to this account on any device')
    .option('--no-open', 'only print the link')
    .action(async (_o, cmd: Command) => {
      const o = g(cmd);
      await run(o, async ({ clients, out }) => {
        // The link signs a browser into the account, so it only goes to a person at a terminal.
        if (!interactive(out.json)) {
          needsTerminal(out, 'yaaa login', 'Adding a passkey opens a sign-in link, which is only shown in a terminal. Ask the person to run `yaaa login` themselves, in their own terminal.');
          return;
        }
        const r = await clients.auth.createDeskLink({});
        const url = passkeyLink(r.url);
        const opened = o.open !== false && openUrl(url);
        out.data({ url, expires_at: r.expiresAt ? timestampDate(r.expiresAt).toISOString() : undefined }, () =>
          [
            opened ? `${c.ok('✓')} Opened your browser to add a passkey.` : `Open this link to add a passkey:\n${c.key(clean(url))}`,
            'Choose this computer (Touch ID, Windows Hello) or your phone (scan the QR code).',
            c.dim('Then, on another device, `yaaa init --passkey` signs in to this account.'),
            ...(opened ? [c.dim(`If the browser didn’t open: ${clean(url)}`)] : []),
            c.dim('The link works once, for 10 minutes.'),
          ].join('\n'),
        );
      });
    });

  program
    .command('shop')
    .description('Your Shop account (coming soon; yaaa works without it)')
    .command('link')
    .description('Coming soon: link your Shop account. yaaa works without it.')
    .action(async (_o, cmd: Command) => {
      await run(g(cmd), async ({ clients, out, idempotencyKey }) => {
        const s = await clients.auth.startShopLink({ idempotencyKey: key(idempotencyKey) });
        if (out.json) process.stdout.write(JSON.stringify({ verification_uri: s.verificationUri, verification_uri_complete: s.verificationUriComplete, user_code: s.userCode }) + '\n');
        else {
          process.stderr.write(`Open ${c.key(clean(s.verificationUriComplete))}\nand confirm the code ${c.bold(clean(s.userCode))}. Waiting…\n`);
        }
        const deadline = s.expiresAt ? timestampDate(s.expiresAt).getTime() : Date.now() + 600_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, Math.max(1, s.intervalSeconds) * 1000));
          const p = await clients.auth.pollShopLink({ deviceCode: s.deviceCode });
          if (p.status === PollShopLinkResponse_Status.LINKED) {
            out.data({ status: 'linked', shop_email: p.account?.shopEmail }, () => `${c.ok('✓')} Linked Shop (${clean(p.account?.shopEmail)}).`);
            return;
          }
          if (p.status === PollShopLinkResponse_Status.DENIED) throw new CliError('Linking was cancelled.', Exit.conflict, 'CONFLICT');
          if (p.status === PollShopLinkResponse_Status.EXPIRED) break;
        }
        throw new CliError('The code expired. Run `yaaa shop link` again.', Exit.conflict, 'CONFLICT');
      });
    });

  program
    .command('logout')
    .description('Sign this device out of its yaaa account (forgets the account on this device)')
    .action(async (_o, cmd: Command) => {
      await run(g(cmd), async ({ clients, store, profile, apiUrl, out }) => {
        // Signs out at the API the sign-in came from; refuses rather than send its refresh token anywhere else. A sign-in
        // that doesn't say where it's from is only forgotten here.
        const home = store.signedInTo(profile);
        if (home !== undefined && home !== apiOrigin(apiUrl)) throw wrongApi(store, profile, home, apiUrl, Exit.conflict, 'CONFLICT');
        const creds = store.credentials(profile);
        if (creds && home !== undefined) await clients.auth.logout({ refreshToken: creds.refresh_token }).catch(() => undefined);
        store.clearCredentials(profile);
        out.data({ signed_out: true }, () => `${c.ok('✓')} Signed out. \`yaaa init\` sets up a new account.`);
      });
    });

  program
    .command('whoami')
    .description('This device’s yaaa account')
    .action(async (_o, cmd: Command) => {
      await run(g(cmd), async ({ clients, out, profile }) => {
        const r = await clients.auth.getAccount({});
        out.result({ schema: GetAccountResponseSchema, message: r }, () =>
          box('yaaa account', [
            ['account', c.key(clean(r.account?.accountId))],
            ['profile', profile],
            ['plan', planLine(r.account?.planUsage) || clean(r.account?.plan)],
            ...(r.account?.plus ? ([['plus', plusLine(r.account.plus)]] as Array<[string, string]>) : []),
            ...planRows(r.account?.planUsage),
            ['shop', clean(r.account?.shopEmail) || c.dim('not linked (optional)')],
          ]),
        );
      });
    });

  program
    .command('desk')
    .description('Open the web desk, signed in to this account, in your browser (a one-time link)')
    .option('--no-open', 'only print the link')
    .action(async (_o, cmd: Command) => {
      const o = g(cmd);
      await run(o, async ({ clients, out }) => {
        // The link signs a browser into the account, so it only goes to a person at a terminal.
        if (!interactive(out.json)) {
          needsTerminal(out, 'yaaa desk', 'The desk opens with a one-time sign-in link, which is only shown in a terminal. Ask the person to run `yaaa desk` themselves, in their own terminal.');
          return;
        }
        const r = await clients.auth.createDeskLink({});
        const opened = o.open !== false && openUrl(r.url);
        out.result({ schema: CreateDeskLinkResponseSchema, message: r }, () =>
          opened
            ? `${c.ok('✓')} Opened the desk in your browser.\n${c.dim('If it didn’t open: ')}${c.key(clean(r.url))}\n${c.dim('The link works once, for 10 minutes.')}`
            : `${c.key(clean(r.url))}\n${c.dim('Works once, for 10 minutes.')}`,
        );
      });
    });

  program
    .command('doctor')
    .description('Check the API, this device’s credentials, and which terminal agents are installed')
    .action(async (_o, cmd: Command) => {
      await run(g(cmd), async ({ clients, store, profile, apiUrl, out }) => {
        const started = Date.now();
        const health = await clients.health.check({}).then(
          (h) => ({ ok: h.status === CheckResponse_Status.SERVING, h }),
          (e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
        const latency = Date.now() - started;
        const creds = store.credentials(profile);
        const signedInTo = store.signedInTo(profile);
        let account: { ok: boolean; account_id?: string; signed_in_to?: string; has_recovery_key?: boolean; error?: string } = {
          ok: false,
          error: 'no account on this device; run `yaaa init`',
        };
        if (creds && signedInTo !== undefined && signedInTo !== apiOrigin(apiUrl)) {
          account = { ok: false, account_id: creds.account_id, signed_in_to: signedInTo, error: wrongApi(store, profile, signedInTo, apiUrl, Exit.auth, 'UNAUTHENTICATED').message };
        } else if (creds) {
          account = await clients.auth.getAccount({}).then(
            (a) => ({ ok: true, account_id: a.account?.accountId, signed_in_to: signedInTo, has_recovery_key: a.account?.hasRecoveryKey ?? false }),
            (e: unknown) => ({ ok: false, account_id: creds.account_id, signed_in_to: signedInTo, error: e instanceof Error ? e.message : String(e) }),
          );
        }
        const agents = detectAgents().map((a) => ({
          name: a.name,
          found: a.found,
          skill_installed: SKILLS.every((s) => existsSync(join(a.skillsDir, s, 'SKILL.md'))),
        }));
        const skillVersionOk = agents.every((a) => !a.skill_installed || sameSkill(a.name));
        // The API may require a newer CLI (MIN_CLI_VERSION); say so here, before a command is refused.
        const minCli = 'h' in health ? health.h.minCliVersion : '';
        const cliOk = !minCli || compareVersions(VERSION, minCli) >= 0;
        const platform = platformName();
        const inst = installation();
        const onPath = yaaaOnPath();
        const report = {
          version: VERSION,
          platform,
          profile,
          api_url: apiUrl,
          api: 'h' in health
            ? { ok: health.ok, latency_ms: latency, ...toPlain(health.h) }
            : { ok: false, error: health.error },
          account,
          agents,
          skills_current: skillVersionOk,
          cli: { version: VERSION, min_version: minCli || undefined, ok: cliOk },
          install: { by: installedBy(inst), on_path: onPath.map((p) => p.path) },
        };
        // In WSL, a notifier set up anyway (systemd) can't reach the Windows desktop.
        const wslNotifier = platform === 'linux-wsl' && existsSync(join(homedir(), '.config', 'systemd', 'user', 'yaaa-notify.service'));
        out.data(report, () =>
          [
            c.dim(`yaaa ${VERSION} · ${platform === 'linux-wsl' ? 'Windows (WSL)' : platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform}`),
            c.dim(`installed with ${installedBy(inst)}`),
            ...(onPath.length > 1
              ? [c.warn(`· ${onPath.length} yaaa commands on PATH; ${onPath[0]!.path} runs, not ${onPath.slice(1).map((p) => p.path).join(', ')}. Remove the one you don't use.`)]
              : []),
            ...(wslNotifier ? [c.warn("· desktop notifications don't reach Windows from WSL: use `yaaa notify email` or `yaaa notify discord`")] : []),
            `${health.ok ? c.ok('✓') : c.err('✗')} API ${apiUrl} ${'h' in health ? c.dim(`${health.h.environment} ${health.h.version} · ${latency} ms`) : c.err(health.error)}`,
            ...('h' in health ? health.h.dependencies.map((d) => `  ${d.ok ? c.ok('✓') : c.err('✗')} ${d.name} ${c.dim(`${d.latencyMs} ms`)}`) : []),
            ...(cliOk ? [] : [`${c.err('✗')} yaaa ${VERSION} is older than this API supports (${minCli} or newer). Update with: ${c.key(updateHint(installation()))}`]),
            `${account.ok ? c.ok('✓') : c.err('✗')} account ${account.account_id ?? ''} ${account.signed_in_to ? c.dim(`· signed in to ${account.signed_in_to}`) : ''} ${account.error ? c.err(account.error) : ''}`.replace(/ +/g, ' ').trimEnd(),
            ...(account.ok
              ? [account.has_recovery_key ? `${c.ok('✓')} recovery key set` : c.warn('· no recovery key: run `yaaa recovery-key` and save it')]
              : []),
            ...agents.map((a) => `${a.found ? c.ok('✓') : c.dim('·')} ${a.name}${a.found ? (a.skill_installed ? ' · yaaa skills installed (buyer, advisor)' : c.warn(' · skill missing: run `yaaa init`')) : c.dim(' not found')}`),
            ...(health.ok && cliOk && account.ok ? [] : [c.dim('Help: https://yaaa.io/docs/troubleshooting/')]),
          ].join('\n'),
        );
        if (!health.ok) process.exitCode = Exit.retryable;
        else if (!cliOk) process.exitCode = Exit.conflict;
        else if (!account.ok) process.exitCode = Exit.auth;
      });
    });
}

/** How this yaaa was installed, as doctor says it. */
function installedBy(i: Installation): string {
  switch (i.kind) {
    case 'installer':
      return 'the installer';
    case 'homebrew':
      return 'Homebrew';
    case 'npm':
      return i.npx ? 'npx' : 'npm';
    case 'source':
      return 'a source checkout';
  }
}

function toPlain(h: { status: number; version: string; environment: string; dependencies: Array<{ name: string; ok: boolean; detail: string; latencyMs: bigint }> }) {
  return {
    status: CheckResponse_Status[h.status],
    version: h.version,
    environment: h.environment,
    dependencies: h.dependencies.map((d) => ({ name: d.name, ok: d.ok, detail: d.detail, latency_ms: Number(d.latencyMs) })),
  };
}

function sameSkill(agentName: string): boolean {
  const a = detectAgents().find((x) => x.name === agentName);
  return !a || skillsCurrent(a.skillsDir);
}

