# yaaa

YAAA (Yet Another AI Agent), by [NxisAI](https://nxis.ai), lets the AI agent in your terminal buy from online stores at retail, in your name: right now, when a price drops, when something new fits a search, or on a schedule. Every purchase ends with a confirm link that opens the store's own checkout, where you pay the store directly. yaaa never touches your card.

yaaa is in beta, for US-based Shopify stores that support agent checkout (UCP). Docs: [yaaa.io/docs](https://yaaa.io/docs/).

## Install

With Node.js 22.12 or newer, on macOS or Linux (on Windows, inside WSL):

```sh
npm install -g @yaaa-io/cli
yaaa init        # an anonymous account (no sign-up), and the skills for your agents
```

Update with `npm install -g @yaaa-io/cli@latest`. Nothing runs when the package installs; `yaaa init` is a step you run.

Without Node, use the installer, which brings its own: `curl -fsSL https://yaaa.io/install | sh`.

Then ask your agent, for example Claude Code: "find me trail running shoes under $120 and get a quote on the best one". [Getting started](https://yaaa.io/docs/) covers the rest, and the [command reference](https://yaaa.io/docs/reference/) lists every command.

## Where this package comes from

Each version is built and published from the tagged commit in [yaaa-io/yaaa](https://github.com/yaaa-io/yaaa) by its publish workflow, with [npm provenance](https://docs.npmjs.com/generating-provenance-statements): the version's page on npmjs.com links to that commit and workflow run. Check your install with `npm audit signatures`.

## Security

Report vulnerabilities privately through [GitHub](https://github.com/yaaa-io/yaaa/security/advisories/new), not in public issues. See [SECURITY.md](https://github.com/yaaa-io/yaaa/blob/main/SECURITY.md).

## License

Apache-2.0. See LICENSE and NOTICE.
