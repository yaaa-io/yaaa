# yaaa-io/homebrew-tap

Homebrew formulae for [yaaa](https://yaaa.io), your shopping agent in your terminal.

```sh
brew install yaaa-io/tap/yaaa
yaaa init        # an anonymous account (no sign-up), and the skills for your agents
```

Update with `brew upgrade yaaa`.

The formula installs the same signed release as `curl -fsSL https://yaaa.io/install | sh`: yaaa with the Node.js it runs on, for macOS and Linux (arm64 and x64). Each release's formula is written by `cli/release/formula.mjs` in [yaaa-io/yaaa](https://github.com/yaaa-io/yaaa) from that release's signed manifest, and committed here by its publish workflow. Don't edit `Formula/yaaa.rb` by hand: the next release replaces it.

Issues and security reports go to [yaaa-io/yaaa](https://github.com/yaaa-io/yaaa) (security reports privately, through [GitHub](https://github.com/yaaa-io/yaaa/security/advisories/new)).
