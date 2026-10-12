/**
 * The public keys that sign yaaa releases: each is an Ed25519 key, as base64 of its SPKI DER (what release/keygen.mjs
 * prints). `yaaa update` and the installer (release/build.mjs writes these into it) trust a release whose manifest is
 * signed by any key here.
 *
 * To rotate: add the new key here, ship a release signed with the old key, then sign with the new key and remove the old
 * one in a later release.
 *
 * The placeholder is never trusted: release/build.mjs refuses to build a release for publishing that would ship only
 * the placeholder, and `yaaa update` ignores it. Tests use it as a stand-in.
 */
export const RELEASE_KEY_PLACEHOLDER = 'PLACEHOLDER-run-make-release-key-and-paste-the-public-key-here';

export const RELEASE_KEYS: readonly string[] = [
  // release-2026, added 2026-10-10.
  'MCowBQYDK2VwAyEAgA4THzr8xX27jhLUIrln9RFkMiZaR6MNuvhPl4OuAnU=',
];
