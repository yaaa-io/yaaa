<p align="center"><a href="https://yaaa.io"><img src="https://raw.githubusercontent.com/yaaa-io/yaaa/main/assets/banner.png" alt="YAAA: your shopping agent, in your terminal" width="100%"></a></p>

<p align="center">
  <a href="https://yaaa.io"><b>yaaa.io</b></a> ·
  <a href="https://yaaa.io/docs/">Docs</a> ·
  <a href="https://yaaa.io/docs/reference/">Command reference</a> ·
  <a href="https://yaaa.io/docs/plans/">Plans</a> ·
  <a href="https://discord.gg/RzukGnVBRA">Discord</a> ·
  <a href="https://github.com/yaaa-io/yaaa">GitHub</a>
</p>

# yaaa

YAAA (Yet Another AI Agent), by [NxisAI](https://nxis.ai), lets the AI agent in your terminal buy from online stores at retail, in your name: right now, when a price drops, when something new fits a search, or on a schedule. Every purchase ends with a confirm link that opens the store's own checkout, where you pay the store directly. yaaa never touches your card.

yaaa is in beta, for US-based Shopify stores that support agent checkout (UCP).

## Install

With Node.js 22.12 or newer, on macOS or Linux (on Windows, inside WSL):

```sh
npm install -g @yaaa-io/cli
yaaa init        # an anonymous account (no sign-up), and the skills for your agents
```

Update with `npm install -g @yaaa-io/cli@latest`. Nothing runs when the package installs: `yaaa init` is a step you run.

Other ways to install, each with the same release:

```sh
curl -fsSL https://yaaa.io/install | sh   # brings its own Node.js
brew install yaaa-io/tap/yaaa             # Homebrew, on macOS and Linux
```

## Use it from your agent

`yaaa init` installs two skills into each terminal agent it finds (Claude Code, Hermes, and others): **yaaa-buyer** buys, watches prices and restocks, and **yaaa-advisor** recommends and compares. Then just ask, for example:

> find me trail running shoes under $120 and get a quote on the best one

> watch the Allbirds Tree Runners in size 10 and tell me if they drop below $90

Agents that prefer tool calls can use the same operations over MCP: `yaaa mcp`. Every command also takes `--json` for agents and scripts.

## Commands

<!-- commands -->

Every option, with examples: [yaaa.io/docs/reference](https://yaaa.io/docs/reference/), or `yaaa <command> --help`.

## Where this package comes from

Each version is built from the tagged commit in [yaaa-io/yaaa](https://github.com/yaaa-io/yaaa) and published by its publish workflow with [npm provenance](https://docs.npmjs.com/generating-provenance-statements): the version's page on npmjs.com links to that commit and workflow run. Check your install with `npm audit signatures`.

## Privacy

yaaa sends your searches, quotes, watches and account to api.yaaa.io, checks yaaa.io for updates, and collects no telemetry or analytics. The [GitHub README](https://github.com/yaaa-io/yaaa#what-yaaa-sends-and-where) has the details; see also the [Privacy Policy](https://yaaa.io/privacy/) and [Terms](https://yaaa.io/terms/).

## Help and security

Questions and bugs: [Discord](https://discord.gg/RzukGnVBRA) or [GitHub issues](https://github.com/yaaa-io/yaaa/issues). Report vulnerabilities privately through [GitHub](https://github.com/yaaa-io/yaaa/security/advisories/new), not in public issues.

## License

Apache-2.0. See LICENSE and NOTICE.
