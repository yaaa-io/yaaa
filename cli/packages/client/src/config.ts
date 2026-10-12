import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync, renameSync, openSync, closeSync, statSync, unlinkSync, fsyncSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError, Exit } from './errors.js';

/** Where yaaa keeps its config and credentials: $YAAA_HOME, else $XDG_CONFIG_HOME/yaaa, else ~/.config/yaaa. */
export function yaaaHome(): string {
  if (process.env.YAAA_HOME) return process.env.YAAA_HOME;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'yaaa');
}

export interface Profile {
  api_url: string;
}

export const DEFAULT_PROFILES: Record<string, Profile> = {
  default: { api_url: 'https://api.yaaa.io' },
  local: { api_url: 'http://localhost:7080' },
};

export interface Credentials {
  account_id: string;
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
  /**
   * The API these were issued by (an origin, see apiOrigin). Tokens are only ever sent there. Credentials saved before
   * this field existed belong to their profile's API, and get it written in the first time they're used.
   */
  api_url?: string;
}

/** An API URL as an origin, for comparing: scheme, host and port, lower case, no path or trailing slash. */
export function apiOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.trim().replace(/\/+$/, '').toLowerCase();
  }
}

interface Stored {
  profiles?: Record<string, Partial<Profile>>;
  credentials?: Record<string, Credentials>;
  state?: Record<string, Record<string, string>>;
  /** Values for this device rather than a profile: the version that last ran, update checks, skill folders. */
  device?: Record<string, string>;
}

/** How long a lock may be held before another process takes it over (its holder crashed). */
const STALE_LOCK_MS = 60_000;
/** How long to wait for another yaaa process to finish with the file. */
const LOCK_WAIT_MS = 45_000;

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One JSON file, mode 0600. Tokens live here until the OS keychain backend lands.
 *
 * Several yaaa processes share it (the notifier, an agent's commands, update checks), so every change is a locked
 * read-modify-write: a lock file next to it, then a temporary file renamed over the old one, so a crash can't leave
 * half a file. A file that doesn't parse is never written back: yaaa stops and says how to fix it, rather than
 * replacing it with an empty one and losing the account.
 */
export class ConfigStore {
  private readonly file: string;
  private readonly lockFile: string;
  /** Set while this process holds the lock (possibly across an await), so nested changes don't wait on themselves. */
  private held = 0;

  constructor(readonly dir: string = yaaaHome()) {
    this.file = join(dir, 'config.json');
    this.lockFile = join(dir, 'config.lock');
  }

  /** The file's contents. Throws (exit 1) when it exists but isn't valid JSON. */
  private read(): Stored {
    if (!existsSync(this.file)) return {};
    const text = readFileSync(this.file, 'utf8');
    try {
      const v = JSON.parse(text) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Stored;
    } catch {
      // Reported below.
    }
    throw new CliError(
      `yaaa's config file ${this.file} isn't valid JSON, so yaaa won't read or change it (it holds this device's sign-in). ` +
        `Fix it by hand, or move it aside and run \`yaaa init --restore\` or \`yaaa init --passkey\` to sign in again.`,
      Exit.unexpected,
      'CONFIG_UNREADABLE',
    );
  }

  /** Writes the whole file: a temporary file in the same folder (0600), flushed, then renamed over the old one. */
  private write(s: Stored): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = join(this.dir, `.config.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      const fd = openSync(tmp, 'w', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(s, null, 2) + '\n');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  /** Takes the lock file once, or returns false when another process has it (taking over a stale one). */
  private tryLock(): boolean {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      closeSync(openSync(this.lockFile, 'wx', 0o600));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(this.lockFile).mtimeMs > STALE_LOCK_MS) unlinkSync(this.lockFile);
      } catch {
        // Released (or taken over) meanwhile: try again.
      }
      return false;
    }
  }

  private lockTimeout(): CliError {
    return new CliError(
      `Another yaaa process has been changing ${this.file} for too long. Try again; if no other yaaa is running, delete ${this.lockFile}.`,
      Exit.retryable,
      'UNAVAILABLE',
    );
  }

  private unlock(): void {
    rmSync(this.lockFile, { force: true });
  }

  /** Runs `fn` holding the lock (synchronously). */
  private locked<T>(fn: () => T): T {
    if (this.held > 0) return fn();
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (!this.tryLock()) {
      if (Date.now() > deadline) throw this.lockTimeout();
      sleepSync(20 + Math.random() * 30);
    }
    this.held++;
    try {
      return fn();
    } finally {
      this.held--;
      this.unlock();
    }
  }

  /**
   * Runs `fn` holding the lock across its awaits: a token refresh, so two processes never present the same refresh
   * token. `fn` should read what it needs again once it has the lock.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.held > 0) return fn();
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (!this.tryLock()) {
      if (Date.now() > deadline) throw this.lockTimeout();
      await sleep(20 + Math.random() * 30);
    }
    this.held++;
    try {
      return await fn();
    } finally {
      this.held--;
      this.unlock();
    }
  }

  /** A locked read-modify-write. */
  private update(change: (s: Stored) => void): void {
    this.locked(() => {
      const s = this.read();
      change(s);
      this.write(s);
    });
  }

  profile(name: string): Profile {
    const stored = this.read().profiles?.[name];
    const base = DEFAULT_PROFILES[name];
    const url = stored?.api_url ?? base?.api_url;
    if (!url) throw new Error(`unknown profile '${name}'. Known: ${Object.keys(DEFAULT_PROFILES).join(', ')}`);
    return { api_url: url };
  }

  credentials(profile: string): Credentials | undefined {
    return this.read().credentials?.[profile];
  }

  /**
   * Which API a profile's credentials belong to: the one they were saved with, or (for credentials saved before
   * yaaa recorded it) the profile's API. Undefined when the profile has no credentials, or when they don't say and the
   * profile names no API (an unnamed profile used with --api-url by an older yaaa): then nothing knows where they
   * belong, and they aren't sent anywhere.
   */
  signedInTo(profile: string): string | undefined {
    const c = this.credentials(profile);
    if (!c) return undefined;
    if (c.api_url) return apiOrigin(c.api_url);
    try {
      return apiOrigin(this.profile(profile).api_url);
    } catch {
      return undefined;
    }
  }

  /** Profiles whose API is this one, for suggesting the right --profile. */
  profilesFor(apiUrl: string): string[] {
    const named = new Set([...Object.keys(DEFAULT_PROFILES), ...Object.keys(this.read().profiles ?? {})]);
    return [...named].filter((n) => apiOrigin(this.profile(n).api_url) === apiOrigin(apiUrl));
  }

  saveCredentials(profile: string, c: Credentials): void {
    this.update((s) => {
      s.credentials = { ...(s.credentials ?? {}), [profile]: c };
    });
  }

  /**
   * Writes the API into credentials saved before yaaa recorded it, once it's known from the profile, so they keep
   * belonging there whatever the profile says later. Only when the stored credentials are still the same ones.
   */
  stampApi(profile: string, refreshToken: string, apiUrl: string): void {
    this.update((s) => {
      const c = s.credentials?.[profile];
      if (c && !c.api_url && c.refresh_token === refreshToken) c.api_url = apiOrigin(apiUrl);
    });
  }

  clearCredentials(profile: string): void {
    this.update((s) => {
      if (s.credentials) delete s.credentials[profile];
    });
  }

  /** Small per-profile values, like the alerts cursor. */
  get(profile: string, key: string): string | undefined {
    return this.read().state?.[profile]?.[key];
  }

  set(profile: string, key: string, value: string): void {
    this.update((s) => {
      s.state = { ...(s.state ?? {}), [profile]: { ...(s.state?.[profile] ?? {}), [key]: value } };
    });
  }

  /** A value for this device, whatever the profile. */
  deviceGet(key: string): string | undefined {
    return this.read().device?.[key];
  }

  deviceSet(key: string, value: string): void {
    this.update((s) => {
      s.device = { ...(s.device ?? {}), [key]: value };
    });
  }

  reset(): void {
    this.locked(() => rmSync(this.file, { force: true }));
  }
}
