---
name: waterx-agent
description: Trade WaterX perpetuals on Sui from the command line — read market and account state, preview a write, have a person approve it, execute it, and reconcile a submission whose result nobody saw. Use when asked to check WaterX markets, positions, orders or account balances; to open, close, reduce or increase a perpetual position; to place, amend or cancel an order; to set up a WaterX wallet, account, delegate or risk limits; or to find out whether a WaterX transaction went through. Requires a checkout of the waterx-agent repository.
---

# WaterX agent

A TypeScript agent for the [WaterX](https://waterx.io) perpetual protocol on
Sui. It holds a keypair, asks the WaterX backend to build each transaction,
verifies the bytes against what was authorized, signs, and submits.

Every command below is real and lives in `package.json`. Run them from the
repository root.

## How to call it

```bash
node bin/waterx.mjs <command> [options] --json
```

From the repository root. `--json` makes the command write **exactly one JSON
document to stdout and nothing else**; human-readable output goes to stderr,
where it is safe to ignore or to show the user.

Use `bin/waterx.mjs`, not `pnpm run`. The package manager writes its own banner
to stdout, which breaks the one-document guarantee — `pnpm --silent run
<command> -- --json` also works, but it depends on a flag that is easy to omit
and impossible to notice missing.

## Guiding a person: start every turn here

```bash
node bin/waterx.mjs next --json
```

One read that answers "where am I, and what should I offer?" — and answers it
in the order the states have to be resolved, so you cannot offer a trade to
someone who has a transaction in flight. Relay `headline`, offer `suggestions`,
and **ask for anything in `needsFromUser` instead of choosing it**.

| `state` | What to say |
|---|---|
| `unsettled` | Something was sent and nobody knows what happened. Reconcile before anything else. |
| `awaiting-approval` | A preview is waiting on them. Show it and ask. |
| `not-set-up` | Run `bootstrap` and relay what is still missing — some of it needs an operator. |
| `read-only` | Nothing can be signed. On mainnet that is the default and changing it is their decision. |
| `no-collateral` | Set up, but nothing to commit. Gas is not collateral; this one needs an operator. |
| `ready` | Ask what they want to do, and for the numbers. |

## The loop you must follow

**read → preview → approve → execute**, and **reconcile** if anything is
unclear.

```bash
# 0. set up — one command. Signs nothing; says what is still missing and who
#    can supply it. Run this first on any checkout you have not used before.
node bin/waterx.mjs bootstrap --json

# 1. read — no key needed, nothing is signed
node bin/waterx.mjs next --json         # where am I, what should I offer?
node bin/waterx.mjs balance --json      # freeMargin is what a new order may commit
node bin/waterx.mjs positions --json

# 2. preview — derives the exact order and stops. Nothing is authorized or built.
node bin/waterx.mjs preview --action open-long --ticker SUI \
    --collateral 10 --leverage 2 --slippage 0.5 --json
#    → status "needs-approval", exit 9, and an approvalId

# 3. approve — a PERSON does this, after seeing the preview
node bin/waterx.mjs approve --id apr_… --approver "<their name>" --json

# 4. execute — submits the approved plan unchanged
node bin/waterx.mjs execute --id apr_… --json

# 5. reconcile — only if execute returned status "ambiguous"
node bin/waterx.mjs reconcile --id sub_… --json
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
3. **Never open a position on mainnet on your own initiative.** Mainnet
   defaults to `read-only`, and it stays that way unless a person has
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
   `node bin/waterx.mjs approvals --json` reports any submission nobody settled.
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

Size against **`freeMargin`** from `node bin/waterx.mjs balance --json`, never
against `totalEquity`: equity includes collateral already committed to open
positions and resting orders, and sizing from it is how an account tries to
commit money it does not have.

## Things that will surprise you

- **An order is a request, not a fill.** A write returns when the request is on
  chain; a keeper fills it afterwards. `positions` may be empty while `orders`
  shows the request. Say "submitted", not "filled", until you have checked.
- **Collateral is not gas.** `fund-sui` gets testnet gas. Trading collateral is
  a backing asset the wallet must already hold; on testnet the credit faucet is
  whitelist-gated, so a fresh wallet needs an operator.
- **Some actions refuse under default settings, by design.** Their argument
  layouts have never been confirmed against that deployment, and the verifier
  will not read positions nobody measured. On testnet that is `burnWlp`,
  `cancelWlpBurn` and `claimWlpRewards`; on mainnet it is also `cancelOrder` and
  `updateOrder`. `doctor` names them for the network you are on. This is
  expected and is not a fault to work around.
- **Mainnet needs setup that testnet does not** — a policy someone typed, and
  package exceptions `doctor` prints. Run `node bin/waterx.mjs doctor --json`
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
  interface is `node bin/waterx.mjs <command> --json`; no MCP server, no HTTP
  service, and no wrapper is required.
- **Anything else** — `AGENT_INSTRUCTIONS.md` is plain Markdown with no
  runtime-specific syntax. It is the file to paste.

No install step is needed to *try* it: point any agent with a shell at a
checkout and tell it to read `SKILL.md`. Installing only saves that sentence.

## The prompt to hand someone

Paste this into Claude Code, Codex, or anything else with a shell:

> Clone `git@github.com:Bucket-Protocol/waterx-agent.git`, run `pnpm install`,
> read `SKILL.md`, then run `node bin/waterx.mjs bootstrap --json` and tell me
> what is still missing before I can trade on testnet.

That gets to a set-up checkout and an exact list of what remains — which, on a
fresh wallet, is testnet collateral, and no agent can arrange that (see below).
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
