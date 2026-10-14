import { Code, ConnectError, createClient, type Client, type Interceptor } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { DescService } from '@bufbuild/protobuf';
import { AccountService } from './gen/yaaa/v1/account_pb.js';
import { AuthService } from './gen/yaaa/v1/auth_pb.js';
import { BillingService } from './gen/yaaa/v1/billing_pb.js';
import { DevService } from './gen/yaaa/v1/dev_pb.js';
import { EventService } from './gen/yaaa/v1/event_pb.js';
import { HealthService } from './gen/yaaa/v1/health_pb.js';
import { ProductService } from './gen/yaaa/v1/product_pb.js';
import { PurchaseService } from './gen/yaaa/v1/purchase_pb.js';
import { RestockService } from './gen/yaaa/v1/restock_pb.js';
import { WatchService } from './gen/yaaa/v1/watch_pb.js';
import { CliError, Exit } from './errors.js';
import { apiOrigin, type Credentials, type ConfigStore } from './config.js';
import { platformName } from './platform.js';

export const VERSION = '0.1.11';

export interface Clients {
  apiUrl: string;
  health: Client<typeof HealthService>;
  auth: Client<typeof AuthService>;
  products: Client<typeof ProductService>;
  purchases: Client<typeof PurchaseService>;
  watches: Client<typeof WatchService>;
  restocks: Client<typeof RestockService>;
  account: Client<typeof AccountService>;
  billing: Client<typeof BillingService>;
  events: Client<typeof EventService>;
  dev: Client<typeof DevService>;
  /** A valid access token, refreshing it first if it's about to expire. */
  accessToken(): Promise<string>;
}

/** Calls that work without an account. */
const anonymous = new Set(['Check', 'CreateAccount', 'RestoreAccount', 'StartPasskeySignIn', 'PollPasskeySignIn', 'Refresh', 'Logout', 'GetClock', 'AdvanceClock', 'Reset', 'SetFakeProduct', 'CompleteFakeCheckout']);

/**
 * The profile's credentials, only when they belong to `apiUrl`. Credentials from another API are never sent there:
 * a local session must not reach production, and production tokens must not go to whatever --api-url names.
 * Undefined when the profile has none; throws (exit 3) when they belong to another API, or when nothing says which API
 * they belong to. Credentials saved before yaaa recorded their API get it written in from their profile.
 */
export function credentialsFor(store: ConfigStore, profile: string, apiUrl: string): Credentials | undefined {
  const creds = store.credentials(profile);
  if (!creds) return undefined;
  const home = store.signedInTo(profile);
  if (home === undefined) throw unknownApi(profile, apiUrl, Exit.auth, 'UNAUTHENTICATED');
  if (home !== apiOrigin(apiUrl)) throw wrongApi(store, profile, home, apiUrl, Exit.auth, 'UNAUTHENTICATED');
  if (!creds.api_url) {
    store.stampApi(profile, creds.refresh_token, home);
    return { ...creds, api_url: home };
  }
  return creds;
}

/** The error for credentials that don't say which API they're from, on a profile that doesn't name one either. */
export function unknownApi(profile: string, apiUrl: string, exit: number, reason: string): CliError {
  return new CliError(
    `Profile '${profile}' has a sign-in that doesn't say which API it's from, so yaaa won't send it to ${apiOrigin(apiUrl)} or anywhere else. ` +
      `Sign this profile in again: \`yaaa --profile ${profile} logout\` (it only forgets the sign-in on this device), then \`yaaa --profile ${profile} --api-url ${apiOrigin(apiUrl)} init --restore\` or \`init --passkey\`.`,
    exit,
    reason,
  );
}

/** The error for a profile signed in to another API, with the --profile that fits when there is one. */
export function wrongApi(store: ConfigStore, profile: string, home: string, apiUrl: string, exit: number, reason: string): CliError {
  const fits = store.profilesFor(apiUrl).filter((p) => p !== profile);
  const fix = fits.length
    ? `Use \`--profile ${fits[0]}\` for ${apiOrigin(apiUrl)}`
    : `Use another profile for it (\`yaaa --profile <name> --api-url ${apiOrigin(apiUrl)} init\`)`;
  return new CliError(
    `Profile '${profile}' is signed in to ${home}, not ${apiOrigin(apiUrl)}, so yaaa won't send its sign-in there. ${fix}, or leave out --api-url and YAAA_API_URL.`,
    exit,
    reason,
  );
}

/**
 * Connect clients over gRPC (HTTP/2) for one profile. Adds the bearer token, refreshes it when it's close to
 * expiring, and retries once after a refresh if the server says the token is no good.
 */
export function connect(opts: { apiUrl: string; profile: string; store: ConfigStore; timeoutMs?: number }): Clients {
  const { apiUrl, profile, store } = opts;
  let refreshing: Promise<Credentials> | undefined;

  /**
   * A fresh access token, replacing `stale` (the one that expired or was refused). Holds the config lock while it
   * refreshes, and reads the credentials again once it has it: if another yaaa process refreshed meanwhile, its new
   * token is used instead of presenting the same refresh token twice (which the API takes for a copied token).
   */
  const refresh = async (stale: Credentials): Promise<Credentials> => {
    refreshing ??= store
      .withLock(async () => {
        const current = credentialsFor(store, profile, apiUrl);
        if (!current) throw new CliError('This device has no yaaa account yet. Run `yaaa init` (no sign-up needed).', Exit.auth, 'UNAUTHENTICATED');
        if (current.access_token !== stale.access_token && fresh(current)) return current;
        const r = await bare.auth.refresh({ refreshToken: current.refresh_token });
        const next: Credentials = {
          account_id: current.account_id,
          access_token: r.accessToken,
          refresh_token: r.refreshToken,
          access_expires_at: r.accessTokenExpiresAt ? timestampDate(r.accessTokenExpiresAt).toISOString() : '',
          api_url: apiOrigin(apiUrl),
        };
        store.saveCredentials(profile, next);
        return next;
      })
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  };

  /** Whether an access token has more than a minute left. */
  const fresh = (c: Credentials) => {
    const expires = Date.parse(c.access_expires_at);
    return Number.isFinite(expires) && expires - Date.now() >= 60_000;
  };

  const accessToken = async (): Promise<string> => {
    let creds = credentialsFor(store, profile, apiUrl);
    if (!creds) {
      throw new CliError('This device has no yaaa account yet. Run `yaaa init` (no sign-up needed).', Exit.auth, 'UNAUTHENTICATED');
    }
    if (!fresh(creds)) creds = await refresh(creds);
    return creds.access_token;
  };

  const auth: Interceptor = (next) => async (req) => {
    if (anonymous.has(req.method.name)) return next(req);
    const sent = await accessToken();
    req.header.set('authorization', `Bearer ${sent}`);
    try {
      return await next(req);
    } catch (e) {
      // The API refused the token (its session ended, or it predates session ids): refresh once and retry.
      if (e instanceof ConnectError && e.code === Code.Unauthenticated) {
        const creds = credentialsFor(store, profile, apiUrl);
        if (creds) {
          // A stream can't be replayed; refreshing still means its reconnect gets a token that works.
          if (req.stream) {
            await refresh({ ...creds, access_token: sent }).catch(() => undefined);
            throw e;
          }
          const next_ = await refresh({ ...creds, access_token: sent });
          req.header.set('authorization', `Bearer ${next_.access_token}`);
          return next(req);
        }
      }
      throw e;
    }
  };

  const userAgent: Interceptor = (next) => (req) => {
    // The platform (linux-wsl for WSL) shows in the load balancer's logs: how many people use yaaa where.
    req.header.set('user-agent', `yaaa-cli/${VERSION} node/${process.versions.node} (${platformName()}; ${process.arch})`);
    // The API refuses CLIs older than its MIN_CLI_VERSION by this header, telling them to update.
    req.header.set('yaaa-client', `cli/${VERSION}`);
    return next(req);
  };

  const make = (interceptors: Interceptor[]) => {
    const transport = createGrpcTransport({
      baseUrl: apiUrl,
      interceptors,
      defaultTimeoutMs: opts.timeoutMs ?? 30_000,
    });
    const c = <T extends DescService>(s: T) => createClient(s, transport);
    return {
      health: c(HealthService),
      auth: c(AuthService),
      products: c(ProductService),
      purchases: c(PurchaseService),
      watches: c(WatchService),
      restocks: c(RestockService),
      account: c(AccountService),
      billing: c(BillingService),
      events: c(EventService),
      dev: c(DevService),
    };
  };

  const bare = make([userAgent]);
  return { apiUrl, accessToken, ...make([userAgent, auth]) };
}
