import { CliError, type ConfigStore } from '@yaaa/client';

/**
 * Shopping preferences the yaaa-advisor skill recommends from: sizes and budgets per category, brands to prefer or
 * avoid, and where things ship. Kept in this device's profile (`yaaa config prefs`); syncing across devices is #11.
 */
export interface Prefs {
  sizes?: Record<string, string>;
  budgets?: Record<string, string>;
  prefer_brands?: string[];
  avoid_brands?: string[];
  ships_to?: string;
}

const KEY = 'prefs';

export function readPrefs(store: ConfigStore, profile: string): Prefs {
  try {
    return JSON.parse(store.get(profile, KEY) ?? '{}') as Prefs;
  } catch {
    return {};
  }
}

export function writePrefs(store: ConfigStore, profile: string, prefs: Prefs): void {
  store.set(profile, KEY, JSON.stringify(prefs));
}

const usage =
  'Keys: size.<category> (size.shoes 10), budget.<category> (budget.shoes 150), prefer-brands, avoid-brands ' +
  '(comma-separated), ships-to (a 2-letter country code).';

const category = (key: string, prefix: string): string => {
  const c = key.slice(prefix.length).trim().toLowerCase();
  if (!/^[a-z][a-z0-9 -]{0,30}$/.test(c)) throw new CliError(`'${key}': name a category, like ${prefix}shoes. ${usage}`);
  return c;
};

const brands = (value: string): string[] =>
  value
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);

/** Returns the preferences with `key` set to `value`. */
export function setPref(prefs: Prefs, key: string, value: string): Prefs {
  const v = value.trim();
  if (!v) throw new CliError(`Give a value for '${key}', or use \`yaaa config prefs unset ${key}\`.`);
  if (key.startsWith('size.')) return { ...prefs, sizes: { ...prefs.sizes, [category(key, 'size.')]: v } };
  if (key.startsWith('budget.')) {
    const amount = v.replace(/^\$/, '');
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) throw new CliError(`'${value}' isn't an amount. Use a number like 150.`);
    return { ...prefs, budgets: { ...prefs.budgets, [category(key, 'budget.')]: amount } };
  }
  if (key === 'prefer-brands') return { ...prefs, prefer_brands: brands(v) };
  if (key === 'avoid-brands') return { ...prefs, avoid_brands: brands(v) };
  if (key === 'ships-to') {
    if (!/^[A-Za-z]{2}$/.test(v)) throw new CliError(`'${value}' isn't a country code. Use 2 letters, like US.`);
    return { ...prefs, ships_to: v.toUpperCase() };
  }
  throw new CliError(`Unknown preference '${key}'. ${usage}`);
}

/** Returns the preferences without `key`. */
export function unsetPref(prefs: Prefs, key: string): Prefs {
  const next: Prefs = { ...prefs, sizes: { ...prefs.sizes }, budgets: { ...prefs.budgets } };
  if (key.startsWith('size.')) delete next.sizes![category(key, 'size.')];
  else if (key.startsWith('budget.')) delete next.budgets![category(key, 'budget.')];
  else if (key === 'prefer-brands') delete next.prefer_brands;
  else if (key === 'avoid-brands') delete next.avoid_brands;
  else if (key === 'ships-to') delete next.ships_to;
  else throw new CliError(`Unknown preference '${key}'. ${usage}`);
  if (Object.keys(next.sizes!).length === 0) delete next.sizes;
  if (Object.keys(next.budgets!).length === 0) delete next.budgets;
  return next;
}
