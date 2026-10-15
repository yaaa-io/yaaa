# AGENTS.md

Instructions for AI coding agents working in this repository: the yaaa command-line tool, its agent skills, and the API contract. People should start with [README.md](README.md).

If you're an agent that wants to *use* yaaa to shop for someone, this is the wrong file: read https://yaaa.io/agent.md.

## Before you change anything

- **This repo is a read-only mirror.** It's updated from yaaa's private repository with each release, and changes made here are overwritten. Pull requests from outside the yaaa-io organization are closed automatically ([CONTRIBUTING.md](CONTRIBUTING.md)). To suggest a fix, write it up as an issue, including the diff if you have one.
- **Security issues go to [SECURITY.md](SECURITY.md)**, never to a public issue.
- The yaaa service itself (api.yaaa.io) isn't here. `proto/` is its contract.

## Layout

| Path | What it is |
| --- | --- |
| `proto/yaaa/v1` | The API contract (protobuf, served over gRPC/Connect). The client is generated from it. |
| `cli/packages/client` | The API client: `src/connect.ts` (transport, `VERSION`), `src/config.ts` (credentials on disk), `src/errors.ts` (`Exit` codes). Generated code lands in `src/gen/`; don't edit it. |
| `cli/packages/tools` | The operations as data (name, description, input schema, run). Both the commands and the MCP server (`yaaa mcp`) use them. |
| `cli/packages/cli` | The `yaaa` command: `src/program.ts` (the command tree), `src/commands/` (account, alerts, plus, shop, update, mcp), `src/views.ts` (rich output), `src/output.ts`. Tests in `test/`. |
| `cli/packages/skills` | The agent skills `yaaa-buyer` and `yaaa-advisor` (`SKILL.md`), copied into the package at build. |
| `cli/release` | Distribution builds: the installer and signed tarballs (`build.mjs`), the npm package (`npm.mjs`), the Homebrew formula (`formula.mjs`). |
| `.github/workflows` | `ci.yml` (checks on every push and pull request), `publish.yml` (npm and Homebrew on release tags). |

## Build and test

Needs Node.js 22.12 or newer and pnpm 10. Everything runs from `cli/`:

```sh
cd cli
pnpm install --frozen-lockfile
pnpm build          # buf generate from ../proto, then tsc, then copy the skills in
pnpm typecheck
pnpm test           # vitest
pnpm lint:proto     # buf lint
node packages/cli/dist/main.js --help
```

`pnpm build` runs `buf generate` first, so a fresh checkout won't typecheck until it has run once. CI also builds the installer with a throwaway signing key and installs from it, and builds, packs and installs the npm package. The steps are in `.github/workflows/ci.yml`; run them locally the same way if you touch `cli/release`.

Run a dev build against the API with `node packages/cli/dist/main.js <command>`. It reads and writes your real `~/.config/yaaa`, so set `YAAA_HOME` to a scratch folder for experiments, and `YAAA_NO_UPDATE_CHECK=1` to skip the update check.

## Conventions

- **Two outputs for every command.** People get rich output; `--json` prints the API's response as stable JSON (compact; `--pretty` indents it). Agents depend on `--json` field names and on the exit codes in `cli/packages/client/src/errors.ts` (0 ok, 1 unexpected, 2 usage, 3 auth, 4 limits, 5 conflict, 6 not found, 10 retryable). Treat both as public API: don't rename or repurpose them.
- **Commands and MCP tools stay in step.** An operation is defined once in `packages/tools` and used by both. The docs' command reference is generated from the command tree (`scripts/reference.mjs`), so help text and descriptions are user-facing copy.
- **Plain, specific wording** in help text and messages: say what happens and what to do next. Errors say how to fix the problem.
- TypeScript, ES modules, strict mode. Match the surrounding code's style and comment density; comments explain why, not what.
- Keep the version in `packages/cli/package.json` and `VERSION` in `packages/client/src/connect.ts` equal. The release build refuses a mismatch.

## Safety rules (these are tested)

- **Store text is untrusted.** Product titles, descriptions, store names and alert bodies come from stores. Pass them through `clean()` (`src/sanitize.ts`) before any rich output prints them; it strips terminal escape sequences, control characters and bidi controls. Only open `https:` links (`src/open.ts`). Never build a command, path or URL to fetch from store text.
- **Secrets are for the person, never an agent.** Recovery keys and desk sign-in links are shown only when a person is at the terminal (`interactive()` in `src/terminal.ts`). Otherwise the command returns `needs_terminal` with what the person should run. Keys are read with a hidden prompt or from stdin, never from arguments in examples. Don't log, print or test with real keys or tokens.
- **Purchases always end at a confirm link** that a person opens to pay in the store's own checkout. Nothing in the CLI completes a checkout or handles card details.
- **Credentials go only to the configured API.** `src/connect.ts` refuses to send them anywhere else; keep it that way.
- **Releases are signed.** `yaaa update` and the installer only accept a manifest signed by a key pinned in `packages/cli/src/release-keys.ts`, and only over https. Don't add a way around that, even for tests: use the `--dev-key` build.

## The skills

`packages/skills/*/SKILL.md` are instructions that agents follow when they use yaaa, so wording changes change behaviour. Keep the rules in them: confirm the product, variant and price before buying or watching; stay within the person's limits; hand over confirm links word for word; never run account or security commands unless the person asked.
