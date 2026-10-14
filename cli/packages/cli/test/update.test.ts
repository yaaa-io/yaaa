import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { compareVersions, installation, releasesUrl, updateHint, yaaaOnPath } from '../src/installation.js';

describe('compareVersions', () => {
  it('orders releases and pre-releases', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('v1.0.0', '1.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.1')).toBeLessThan(0);
  });
});

describe('installation', () => {
  it('reads the installer launcher, with the install folder from the path for older launchers', () => {
    const env = { YAAA_LAUNCHER: '/home/a/.local/bin/yaaa', YAAA_INSTALL_DIR: '/home/a/.yaaa', YAAA_INSTALL_URL: 'https://x.ngrok.app/' };
    const i = installation(env, '/nope/versions/0.1.0/app/dist/yaaa.mjs');
    expect(i).toEqual({ kind: 'installer', dir: '/home/a/.yaaa', bin: '/home/a/.local/bin/yaaa', url: 'https://x.ngrok.app' });
    expect(releasesUrl(i, {})).toBe('https://x.ngrok.app');
    expect(installation({ YAAA_LAUNCHER: '/b/yaaa' }, '/opt/y/versions/0.1.0/app/dist/yaaa.mjs')).toMatchObject({ kind: 'installer', dir: '/opt/y', url: 'https://yaaa.io' });
  });
  it('tells Homebrew, npm and a source checkout apart, each with its own way to update', () => {
    const brew = installation({}, '/opt/homebrew/Cellar/yaaa/0.1.0/libexec/dist/main.js');
    const npm = installation({}, '/usr/local/lib/node_modules/@yaaa-io/cli/dist/yaaa.mjs');
    const src = installation({}, '/Users/r/nxis/yaaa/cli/packages/cli/dist/main.js');
    expect([brew.kind, npm.kind, src.kind]).toEqual(['homebrew', 'npm', 'source']);
    expect(updateHint(brew)).toBe('brew upgrade yaaa');
    expect(updateHint(npm)).toBe('npm install -g @yaaa-io/cli@latest');
    expect(releasesUrl(src, { YAAA_INSTALL_URL: 'https://t.ngrok.app' })).toBe('https://t.ngrok.app');
  });
  it('knows npx runs from its cache, not an install', () => {
    expect(installation({}, '/Users/r/.npm/_npx/1a2b/node_modules/@yaaa-io/cli/dist/yaaa.mjs')).toEqual({ kind: 'npm', npx: true });
    expect(installation({}, '/usr/local/lib/node_modules/@yaaa-io/cli/dist/yaaa.mjs')).toEqual({ kind: 'npm', npx: false });
  });
  it("takes Homebrew's word for it, before the launcher the formula also sets", () => {
    const env = { YAAA_INSTALLED_BY: 'homebrew', YAAA_LAUNCHER: '/opt/homebrew/opt/yaaa/bin/yaaa' };
    expect(installation(env, '/opt/homebrew/Cellar/yaaa/0.1.11/libexec/app/dist/yaaa.mjs')).toEqual({ kind: 'homebrew' });
    expect(installation(env, '/home/linuxbrew/.linuxbrew/Cellar/yaaa/0.1.11/libexec/app/dist/yaaa.mjs')).toEqual({ kind: 'homebrew' });
  });
});

describe('yaaaOnPath', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'yaaa-path-'));
  const exe = (d: string) => {
    const f = join(d, 'yaaa');
    writeFileSync(f, '#!/bin/sh\n');
    chmodSync(f, 0o755);
    return f;
  };
  it('lists each yaaa once, in PATH order, by what it resolves to', () => {
    const [a, b, c, empty] = [dir(), dir(), dir(), dir()];
    const first = exe(a);
    exe(b);
    symlinkSync(first, join(c, 'yaaa'));
    const found = yaaaOnPath({ PATH: [empty, a, b, c, ''].join(delimiter) });
    expect(found.map((f) => f.path)).toEqual([join(a, 'yaaa'), join(b, 'yaaa')]);
  });
  it("skips files that aren't executable", () => {
    const d = dir();
    writeFileSync(join(d, 'yaaa'), 'not a program');
    expect(yaaaOnPath({ PATH: d })).toEqual([]);
  });
});
