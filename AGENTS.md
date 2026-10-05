# waterx-agent

A TypeScript CLI (`bin/waterx.mjs`) and library for trading WaterX perpetuals on Sui. It asks the
WaterX backend to build each transaction, verifies the bytes against what was authorized
(`src/chain/verify.ts`), signs locally and submits (`src/chain/executor.ts`). `README.md` explains
why the backend owns transaction composition; `docs/integration.md` is the programmatic surface.
This file is for agents changing the code. An agent asked to use the CLI (read markets, trade)
follows `SKILL.md` instead.

Both Claude Code (v2.1.281+) and Codex read this file. Do not add a CLAUDE.md anywhere in the
repo: Claude Code ignores every AGENTS.md at or below a directory that has one.

## Scope

The request, or the plan the user approved, sets the scope. When the user describes a problem,
asks a question, or asks for an assessment, the deliverable is your findings: report and stop,
and do not apply a fix until asked. Keep changes to what the task needs; a nearby bug, a
cleanup or a doc the task did not call for goes in the summary as a suggestion. Before any
state-changing command outside the working tree (a command that signs, `git push`), check that
the evidence supports that specific action.

## The three root prompt files are shipped product copy

`SKILL.md`, `AGENT_INSTRUCTIONS.md` and `AGENT.md` are listed in `package.json#files` and are
the prompt an LLM operating this CLI reads; `README.md` ships too. They are not instructions
for working on this repo, and they stay at the root, under these names: `scripts/agent/skill.ts`
resolves them by name from the package root, and installs point users at those paths.

- `SKILL.md` is the short form (with skill frontmatter), `AGENT_INSTRUCTIONS.md` the long form
  (it says so in its opening), `AGENT.md` the command reference. A change to a rule, command,
  flag, status or exit code in one has to be made in the others in the same change. The rule
  lists (`SKILL.md` "Rules you must not break", `AGENT_INSTRUCTIONS.md` §5) say the same things
  in different shapes (§5 numbers the `--yes` ban that `SKILL.md` states just above its list);
  keep them saying the same things.
- Edit them as prompt text: each prohibition names the flag or action and gives its reason.
  Agents operating the CLI obey a direct instruction and do not infer one from prose
  (`test/scripts.test.ts`, "switches an agent must not reach for").
- Tests hold the shipped docs to the code, so rewording can fail `pnpm test`.
  `test/scripts.test.ts`: every `npx waterx <cmd>`, `node bin/waterx.mjs <cmd>` and
  `pnpm run <cmd>` named in README.md, the three files, this AGENTS.md and `.env.example` must be a
  `package.json` script; every `limits --write` bash example must name each flag
  `scripts/agent/limits.ts` refuses to run without; `SKILL.md` must forbid `--no-open` and
  `policy --set` in fixed wording (and `onboard --help` must say an agent must not pass
  `--no-open`); the text before `## Start here` in `SKILL.md` must say mainnet, real money and
  read-only. `test/verify.test.ts`: the table between the `FREE-ARGUMENTS` markers in README.md
  must equal the `free` bindings in `src/chain/verify.ts`, so changing a binding means updating
  that table.
- `node bin/waterx.mjs skill` (`npx waterx skill` from an install) prints `SKILL.md` as a user
  agent sees it; `--which instructions|reference` prints the other two.

## Build, test, verify

pnpm (version pinned by `packageManager` in `package.json`), Node 22.

```bash
pnpm install --frozen-lockfile
pnpm test                   # tsc --noEmit, then vitest run
pnpm run smoke              # every read command, started for real: needs network + a configured account
pnpm run check-corpus       # does src/chain/abi-corpus.json still describe the deployment? needs network
pnpm run pack:check         # pack, install into a scratch project, run it: after touching `files`, deps or path resolution
bash scripts/agent-hooks/check-harness.sh   # agent-harness lint (AGENTS.md, .codex/config.toml, knowledge hub)
```

A change is done when `pnpm test` passes; run `smoke` too when a command's output or envelope
changed. `.github/workflows/ci.yml` runs on pull requests, pushes to main, daily and on
dispatch. It fails on: typecheck and test (ubuntu and windows), the harness lint, and a stale
corpus in `check-corpus` (mainnet and testnet). It only warns on `smoke` and on `check-corpus`
exit 7 (config unreachable). The `corpus` job asks the live deployment on every run, so a red
`corpus` on a change that did not touch the corpus means the deployment moved, not that the
change broke it. `check-read-api` and `check-verifier` (`scripts/dev/`) are manual checks
against the live backend, not CI.

Report only what a tool result from this session backs: if tests fail, say so with the output;
if a step was skipped or a check could not run, say that, and say what is unverified.

## Repo-wide gotchas

- **The default network is mainnet**, where a signed transaction spends real money. Do not run
  a command that can sign (`execute`, the trading, order, WLP and setup-write commands, `runner`)
  to test a change; `READS` in `scripts/dev/smoke.ts` lists commands that cannot. The suite is
  hermetic: `test/setup.ts` clears `WATERX_*`, `SUI_PRIVATE_KEY`, `SUI_NETWORK` and
  `SUI_GRPC_URL`, does not load `.env`, and pins `WATERX_NETWORK=testnet`, so tests state their
  own config.
- **stdout is a contract**: every command prints exactly one JSON document under `--json`.
  `pnpm run <cmd>` adds its own banner, so run commands as `node bin/waterx.mjs <cmd>` or
  `pnpm --silent run <cmd>`, and send human-readable lines through `note` in
  `scripts/lib/cli.ts` (stderr under `--json`). Statuses and exit codes live in
  `src/cli/contract.ts`.
- **CI runs on Windows.** Filesystem code (renames, fsync, paths) must work there; directory
  fsync goes through `src/durability.ts`, and the comment on the `check` job in `ci.yml` records
  the bug that made this a requirement.
- **Every `package.json` script is a consumer command.** `bin/waterx.mjs` takes its command
  table from `scripts`, minus the maintainer tools in its `INTERNAL` set, which it refuses by
  name (so run `smoke`, `check-corpus` and the like with `pnpm run`). A new maintainer script
  goes into `INTERNAL`, or `waterx <name>` will run it for anyone who installed the package.
- **After bumping `@waterx/sdk`**, run `pnpm run generate-abi`: `test/abi.test.ts` fails when the
  committed `src/chain/abi.generated.ts` came from a different SDK version.
  `pnpm run capture-corpus` re-records one network's layouts into the committed
  `src/chain/abi-corpus.json` from real accounts (it signs nothing; its header lists the
  inputs); run it only when asked, since every positional check in the verifier reads it.
- Comments explain why: the code carries long docblocks giving the failure each guard exists
  for. Keep that reasoning when editing, and write new guards the same way. Breaking changes go
  under `## Unreleased` in `CHANGELOG.md`.

## Lessons

`docs/knowledge-hub/` is the lesson store, one lesson per file (format in its README). Scan its
`title` lines before starting in an unfamiliar area, and add a lesson at the end of a task when
something cost real time that the next session would otherwise rediscover.
