import { connect, ConfigStore, type Clients } from '@yaaa/client';
import { output, type Out } from './output.js';
import { setImagePreference } from './images.js';

export interface GlobalOpts {
  json?: boolean;
  profile?: string;
  apiUrl?: string;
  idempotencyKey?: string;
}

export interface Ctx {
  profile: string;
  apiUrl: string;
  store: ConfigStore;
  clients: Clients;
  out: Out;
  idempotencyKey?: string;
}

/** Resolves the profile and API URL (flag, then env, then profile) and builds clients. */
export function context(g: GlobalOpts): Ctx {
  const store = new ConfigStore();
  const profile = g.profile ?? process.env.YAAA_PROFILE ?? 'default';
  const out = output(Boolean(g.json));
  let apiUrl = '';
  try {
    apiUrl = (g.apiUrl ?? process.env.YAAA_API_URL ?? store.profile(profile).api_url).replace(/\/$/, '');
    // Also where an unreadable config file is reported, before any command reads or changes it.
    setImagePreference(store.get(profile, 'images'));
  } catch (e) {
    out.fail(e);
  }
  const clients = connect({ apiUrl, profile, store });
  return { profile, apiUrl, store, clients, out, idempotencyKey: g.idempotencyKey };
}

/** Runs a command body, turning any failure into the right message and exit code. */
export async function run(g: GlobalOpts, body: (ctx: Ctx) => Promise<void>): Promise<void> {
  const ctx = context(g);
  try {
    await body(ctx);
  } catch (e) {
    ctx.out.fail(e);
  }
}
