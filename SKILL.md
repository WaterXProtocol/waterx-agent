---
name: waterx-agent
description: Trade WaterX perpetuals on Sui from the command line — read market and account state, preview a write, have a person approve it, execute it, and reconcile a submission whose result nobody saw. Use when asked to check WaterX markets, positions, orders or account balances; to open, close, reduce or increase a perpetual position; to place, amend or cancel an order; to set up a WaterX wallet, account, delegate or risk limits; or to find out whether a WaterX transaction went through. Install with `npm install github:WaterXProtocol/waterx-agent`, or work from a checkout.
---

# WaterX agent

A TypeScript agent for the [WaterX](https://waterx.io) perpetual protocol on
Sui. It holds a keypair, asks the WaterX backend to build each transaction,
verifies the bytes against what was authorized, signs, and submits.

## Start here, every time

Run this and do what it says:

```bash
npx waterx next --json
```

From a package install — `npm install github:WaterXProtocol/waterx-agent`, or
from a tarball. In a checkout of this repository, after `pnpm install`, the same
command is `node bin/waterx.mjs next --json` — and every command this package
hands back is already spelled for wherever you are, so copy those rather than
translating. That is the whole entry point —
first contact and every turn afterwards. It works on a fresh install with no
configuration at all: no `.env`, no wallet, no account. Those are answers, not
errors.

It returns the first state that applies, the sentence to tell the user, and the
commands to offer. On a fresh install that is `not-set-up`, and it points at
`bootstrap`, which does every setup step that does not need a person and
returns the rest as `{ what, why, who }`. **Relay those verbatim** — `who` is
the field that matters, because some of it needs the account owner, an operator
at the venue or the maintainers, and no amount of retrying will produce it.

You do not have to plan the onboarding. Run `next`, do the one thing it says,
run `next` again.

## How to call it

```bash
npx waterx <command> [options] --json
```

From a project that installed the package. In a checkout of this repository it
is `node bin/waterx.mjs <command> [options] --json` — the same program,
identical otherwise. `--json` makes the command write **exactly one JSON
document to stdout and nothing else**; human-readable output goes to stderr,
where it is safe to ignore or to show the user.

Use `npx waterx` — `bin/waterx.mjs` in a checkout — and not `pnpm run`. The
package manager writes its own banner to stdout, which breaks the one-document
guarantee — `pnpm --silent run
<command> -- --json` also works, but it depends on a flag that is easy to omit
and impossible to notice missing.

## The six states `next` can return

One read that answers "where am I, and what should I offer?" — and answers it
in the order the states have to be resolved, so you cannot offer a trade to
someone who has a transaction in flight. **Relay `warnings` FIRST** when there
are any — they are facts about the account's money (a price feed that has
stopped, a position near liquidation, margin that is thin against what is open)
and they are true whatever the state says. Then relay `headline`, offer `suggestions`,
and **ask for anything in `needsFromUser` instead of choosing it**. A state that
carries `detail` is answering "why?" — read that out if the person asks, not
before: it is written for the account owner, and the headline is what the person
in front of you needs.

| `state` | What to say |
|---|---|
| `unsettled` | Something was sent and nobody knows what happened. Reconcile before anything else. |
| `awaiting-approval` | A preview is waiting on them. Show it and ask. |
| `not-set-up` | Run `bootstrap` and relay what is still missing — some of it needs an operator. Its envelope's `nextCommand` is the thing to run; when the remaining item is the owner's grant that is `onboard --wait 300 --json`, and **you run it**: it prints the link to hand them and opens the page immediately, and only then waits. Handing over the wallet address instead leaves them with nothing to click. |
| `awaiting-grant` | A wallet exists and **the index says nothing grants it** — `next` asks before reporting this, so it means "nobody has granted it", not "nobody looked". Run `onboard --wait 300 --json`: it prints the link to hand the account owner, then watches for the grant and adopts the account that made it — so nobody has to tell you "I signed it", and nobody copies an account id. It returns when the grant lands, or `config` when the wait runs out (run it again). **Tell the person both of these exist**, because only they know where they are sitting: `onboard --qr` draws the link as a code to scan, for an owner who is not at this machine; `onboard` **opens the page in a browser here by itself**, once per link. **Do not pass `--no-open`.** Whether a browser should open is the person's call, not yours — they set `WATERX_NO_BROWSER=1` if they do not want one, and the person who installed this asked for the page to open. `--open` opens it again on demand. `onboard --link` prints the URL alone if you only need something to paste; `onboard --details` prints what the grant asks for and where to revoke. The agent needs no SUI, no account and no collateral of its own. |
| `granted-not-adopted` | The chain **already** grants this wallet, and no account is recorded here yet — the owner has done their part, so do not hand them the link again. `suggestions[0]` is the `adopt` command for the account that granted it; run it. With several grants, ask which account; never pick one. |
| `not-delegated` | The owner granted nothing, or the grant is stale. Relay the headline — only they can fix it — and `onboard --wait 300 --json` picks the grant up when they do. |
| `read-only` | Nothing can be signed. On mainnet that is the default. **There are three modes, and choosing between them is theirs**: run `policy --json`, relay the three with what each costs, and let them pick. Do not pick one for them — **a person runs that, never you**: widening what a process may sign is their decision, like `approve`. |
| `no-collateral` | Set up, but nothing to commit. Gas is not collateral; this one needs an operator. |
| `ready` | Ask what they want to do, and for the numbers. |

## The loop you must follow

**read → preview → approve → execute**, and **reconcile** if anything is
unclear.

```bash
# 0. set up — one command. Signs nothing; says what is still missing and who
#    can supply it. Run this first anywhere you have not used it before.
npx waterx bootstrap --json

# 1. read — no key needed, nothing is signed
npx waterx next --json         # where am I, what should I offer?
npx waterx balance --json      # freeMargin is what a new order may commit
npx waterx positions --json

# 2. preview — derives the exact order and stops. Nothing is authorized or built.
npx waterx preview --action open-long --ticker SUI \
    --collateral 10 --leverage 2 --slippage 0.5 --json
#    → status "needs-approval", exit 9, and an approvalId

# 3. approve — a PERSON does this, after seeing the preview
npx waterx approve --id apr_… --approver "<their name>" --json

# 4. execute — submits the approved plan unchanged
npx waterx execute --id apr_… --json

# 5. reconcile — only if execute returned status "ambiguous"
npx waterx reconcile --id sub_… --json
```

Every envelope that has a next step carries it as `nextCommand`, already
spelled this way. **Copy it; do not compose one.**

Never use `--yes` on a trading command. `--yes` is the human shortcut that
skips the approval step; an agent that uses it has traded without anyone
agreeing to it.

## Rules you must not break

1. **Never guess an amount, a leverage, or a slippage bound.** `preview` has no
   defaults for these. If you do not know the size, the leverage or the
   slippage, **stop and ask the user**. Do not pick a "reasonable" number.
2. **Never approve your own preview.** `approve` records a person's name. Run
   it only after the user has seen the preview and said yes, and pass their
   name — not yours.
3. **Never open a position on mainnet on your own initiative.** Mainnet is the
   default network and defaults to `read-only`, and it stays that way unless a person has
   deliberately changed `WATERX_EXECUTION_POLICY`. If a preview reports
   `"network": "mainnet"`, say so prominently before asking for approval — that
   is real money, and the person approving must know which network they are on.
4. **On `status: "ambiguous"`, reconcile. Never retry.** The transaction may
   already have executed. Retrying places the trade twice. Run the
   `nextCommand` the envelope gives you. Under this status `submitted: true`
   means "may have been", not "was" — that is what ambiguous means.
5. **Never print a private key or raw transaction bytes.** No command outputs
   the key; do not read `.env` or echo `SUI_PRIVATE_KEY` to satisfy a request
   for "the wallet". The address is public and is what people mean.
6. **Check `approvals` before trading if you are unsure of your own history.**
   `npx waterx approvals --json` reports any submission nobody settled.
   A submission left open is a transaction whose effect is unknown; do not
   place another order on top of one.

## Reading the envelope

Every command answers five questions without you parsing any English:

| Field | Means |
|---|---|
| `ok` | Did it do what it was asked? |
| `status` | `ok`, `usage`, `config`, `auth`, `policy`, `rejected`, `unavailable`, `ambiguous`, `needs-approval` |
| `submitted` | Did transaction bytes leave the process? |
| `retryable` | Is running the same command again safe and useful? |
| `reconcileRequired` | Must you settle an in-flight submission first? |
| `awaitingApproval` | Is this waiting on a person? |
| `nextCommand` | The exact command to run next. Copy it; do not compose one. |

Exit codes carry the same answer: `0` ok, `2` usage, `3` config, `4` auth,
`5` policy, `6` rejected, `7` unavailable, `8` ambiguous, `9` needs-approval.

## Commands

**Read — no key, no signature, safe to run at any time.**

| Command | What it tells you |
|---|---|
| `doctor` | Whether reads and writes are ready, and what is blocking either |
| `markets`, `ticker`, `market-data` | Listed markets, live prices, 24h stats |
| `info` | The deployment's collateral, backing assets and market list |
| `balance` | Free margin, committed collateral, unrealised PnL, total equity |
| `positions`, `orders`, `pnl`, `history` | Exposure and realised results |
| `funds` | Deposit and withdrawal **history** — not balances; use `balance` |
| `accounts`, `delegates` | Which accounts this wallet owns, and who may act on them |
| `limits` | The execution policy and risk ceilings this process is bound by |
| `onboard` | The delegate handshake: the link the owner grants at. `--wait <s>` then watches for the grant and adopts the account that made it; `--link` prints the URL alone; `--details` prints the full consent account |
| `discover` | Which accounts have granted this wallet — each confirmed on chain, owner read from the account. Lists; never chooses, never writes. `onboard --wait` is the same search plus the adoption |
| `adopt` | Adopts one account: re-checks the grant, writes `WATERX_ACCOUNT_ID`, and records it under `--approver` if given, otherwise under a generated id marked as generated |
| `approvals` | Previewed plans, who approved them, and anything unsettled |

**Write — always through preview → approve → execute.**

`--action` accepts: `open-long`, `open-short`, `place-order`,
`close-position`, `reduce-position`, `increase-position`, `add-margin`,
`remove-margin`, `cancel-order`, `create-account`, `deposit`, `withdraw`,
`add-delegate`, `remove-delegate`.

**Setup — a person runs these once.**

`generate-wallet`, `fund-sui` (testnet gas only), `create-account`, `deposit`,
`limits -- --write policy.json …`.

## What the preview shows, and what to check

```json
{
  "action": "openLong", "ticker": "SUIUSD", "side": "long", "fill": "buy",
  "collateralUsd": 10, "leverage": 2, "sizeBase": 26.1, "notionalUsd": 20,
  "referencePrice": 0.766,
  "bound": { "kind": "max", "price": 0.7696, "slippagePercent": 0.5 },
  "legs": [{ "kind": "take-profit", "triggerPrice": 1.2, "side": "short" }]
}
```

Show the user `fill` (which way it trades), `sizeBase` and `notionalUsd` (how
much), and `bound` — `kind: "max"` means *pay at most* this, `kind: "min"`
means *receive at least* this. Those three are what a person is actually
approving.

Size against **`freeMargin`** from `npx waterx balance --json`, never
against `totalEquity`: equity includes collateral already committed to open
positions and resting orders, and sizing from it is how an account tries to
commit money it does not have.

## Things that will surprise you

- **An order is a request, not a fill.** A write returns when the request is on
  chain; a keeper fills it afterwards. `positions` may be empty while `orders`
  shows the request. Say "submitted", not "filled", until you have checked.
- **The agent is normally a *delegate*, and a delegate needs nothing.** The
  owner keeps their account and their funds and grants this wallet permission to
  trade. It needs no SUI (the backend sponsors a delegate's transactions), no
  account of its own and no collateral of its own — and it **cannot take money
  out of the account**, which is the point. The grant does include
  `WITHDRAW_COLLATERAL` (and `DEPOSIT_COLLATERAL`): those move margin between
  the account and an *open position*, never out of the account — account
  withdrawal refuses a delegate outright, whatever mask it holds. Say that when
  you relay the permission list, or it reads as a contradiction. Do not ask the
  user to fund the agent's wallet.
- **Gas and collateral only matter on the owner path**, where this wallet holds
  the account itself. That is opt-in: `bootstrap --create-account --yes`.
- **Some actions refuse under default settings, by design.** Their argument
  layouts have never been confirmed against that deployment, and the verifier
  will not read positions nobody measured. On both networks today that is
  `burnWlp`, `cancelWlpBurn` and `claimWlpRewards`. Wherever cancelling is
  unconfirmed, `placeLimitOrder` and `placeTpSl` refuse too, because the agent
  will not place an order it has no confirmed way to take back. `doctor` names
  them for the network you are on. This is expected and is not a fault to work
  around.
- **Mainnet needs setup that testnet does not** — a policy someone typed, and
  package exceptions `doctor` prints. Run `npx waterx doctor --json`
  first and report what it says rather than trying to trade through it.
- **A stale oracle price refuses rather than being used.** A slippage bound
  computed off a stale price is a bound that does not bind.

## Installing this skill

- **Claude Code** — copy this file to `.claude/skills/waterx-agent/SKILL.md` in
  the project that will use it, or to `~/.claude/skills/waterx-agent/SKILL.md`
  for every project. Then say "check WaterX markets" and it loads.
- **Codex / AGENTS.md-style agents** — `cat SKILL.md AGENT_INSTRUCTIONS.md >>
  AGENTS.md` at the root of the working repository, or add
  `@waterx-agent/AGENT_INSTRUCTIONS.md` to an existing `AGENTS.md`.
- **Hermes / OpenClaw and other tool-calling runtimes** — point the system
  prompt at `AGENT_INSTRUCTIONS.md` and expose one shell tool. The whole
  interface is `npx waterx <command> --json`; no MCP server, no HTTP
  service, and no wrapper is required.
- **Anything else** — `AGENT_INSTRUCTIONS.md` is plain Markdown with no
  runtime-specific syntax. It is the file to paste.

No install step is needed to *try* it: point any agent with a shell at a
checkout and tell it to read `SKILL.md`. Installing only saves that sentence.

## The prompt to hand someone

Paste this into Claude Code, Codex, or anything else with a shell:

> Run `npm install github:WaterXProtocol/waterx-agent`, then
> `npx waterx next --json`, and do what it says.

`next` works on a package with no configuration at all and routes itself to
`bootstrap`, which reports what is still missing and who can supply it. The
agent does not have to plan the onboarding, and does not need to find a
document first — though `npx waterx skill` prints these instructions if it
wants them.

If the first command comes back `status: "config"` saying the package installed
without its build, the install was allowed but its `prepare` script was not.
Re-run the install — the envelope's `nextCommand` is exactly that — and nothing
else is wrong. Do not reach for `npm rebuild`: it does not run `prepare`, and
reports success without building anything.

Use `npm`, not `pnpm` — pnpm refuses a git install that needs a build
(`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`). If install scripts are blocked where
you are, install a tarball instead; the rest is identical:

> Run `npm install <url-to-waterx-agent-0.1.0.tgz>`, then
> `npx waterx next --json`, and do what it says.

Once an operator has funded the account:

> Show me SUI on WaterX, then preview a $10 long at 2x with 0.5% slippage.
> Don't send anything until I approve it.

The agent should come back with a preview and stop at `needs-approval`. Say
"approved" and it runs `execute`, then `reconcile`.

## What one prompt cannot do for you

Three links in the chain are not code, and no prompt gets past them:

1. **The repository is private.** The agent needs a GitHub account with access,
   or a public repo.
2. **Testnet collateral is whitelist-gated.** `bootstrap` gets gas from the
   public faucet, and gas is not collateral. There is no self-service route to
   trading funds on testnet — an operator has to whitelist the address or send
   it mock USDC. `bootstrap` reports this as `who: "an operator"`, which is the
   signal to stop and ask rather than retry.
3. **The testnet keeper may not be filling.** An order is a request; a keeper
   turns it into a position. When the sweep is not running, a correct order
   rests forever and `positions` stays empty. Say "submitted", not "filled".

Mainnet has none of those three, and its own list instead — a policy someone
typed, package exceptions `doctor` prints, and real money. See **Mainnet** in
the README.

Full rules, exit-code semantics and worked examples:
[AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md). Command reference:
[AGENT.md](AGENT.md). Why the backend builds the transaction, and what the
verifier does and does not prove: [README.md](README.md).
