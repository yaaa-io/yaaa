import { describe, expect, it } from 'vitest';
import { compareVersions, installation, releasesUrl, updateHint } from '../src/installation.js';

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
    const npm = installation({}, '/usr/local/lib/node_modules/@yaaa/cli/dist/main.js');
    const src = installation({}, '/Users/r/nxis/yaaa/cli/packages/cli/dist/main.js');
    expect([brew.kind, npm.kind, src.kind]).toEqual(['homebrew', 'npm', 'source']);
    expect(updateHint(brew)).toBe('brew upgrade yaaa');
    expect(updateHint(npm)).toMatch(/npm install -g/);
    expect(releasesUrl(src, { YAAA_INSTALL_URL: 'https://t.ngrok.app' })).toBe('https://t.ngrok.app');
  });
});
