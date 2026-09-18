# Instructions for an automated caller

This is the contract between an LLM agent and the WaterX agent CLI. It is the
long form of [SKILL.md](SKILL.md); everything here is enforced by the code, not
only asked for.

Read it once, then work from the JSON envelopes.

---

## 0. Finding these instructions again

```bash
npx waterx skill              # prints SKILL.md
npx waterx skill --json       # the paths, for reading the files directly
```

Where the documents live depends on the package manager — npm puts them under
`node_modules/waterx-agent/`, pnpm behind a symlink into `.pnpm/`, a checkout at
the root — so ask rather than guessing a path.

## 1. How to call anything

```bash
npx waterx <command> [options] --json
```

From a project that installed the package; `node bin/waterx.mjs <command> …
--json` from a checkout. Identical otherwise.

- `--json` — exactly one JSON document on stdout and nothing else, for the whole
  life of the process. Everything human-readable goes to stderr.
- `npx waterx` — or `bin/waterx.mjs` in a checkout — rather than `pnpm run`:
  the package manager writes a banner to stdout, which is the first thing your
  parser would see. `pnpm --silent run <command> -- --json` is equivalent, and
  one forgotten word away from an unparseable response.

If stdout does not parse as JSON, you called it another way. Do not try to
repair the output; fix the call.

Every `nextCommand` in an envelope is already spelled this way and is meant to
be run verbatim.

## 2. The envelope

```json
{
  "ok": false,
  "status": "needs-approval",
  "command": "preview",
  "network": "testnet",
  "at": "2026-09-10T09:26:09.748Z",
  "message": "openLong previewed as apr_477f…; a person must approve it",
  "submitted": false,
  "retryable": false,
  "reconcileRequired": false,
  "awaitingApproval": true,
  "nextCommand": "pnpm run approve -- --id apr_477f… --approver <who> --json",
  "data": { … }
}
```

Branch on the booleans. Never on `message` — it is for a human reading a log
and it is free to change.

| Field | Question it answers |
|---|---|
| `ok` | Did it do what it was asked? |
| `status` | Which kind of ending this is (table below) |
| `submitted` | Did transaction bytes leave the process? |
| `retryable` | Is running the same command again safe **and** potentially useful? |
| `reconcileRequired` | Must you settle an in-flight submission before doing anything else? |
| `awaitingApproval` | Is this waiting on a person? |
| `nextCommand` | The exact command to run next, when there is one |

## 3. Statuses and exit codes

| Status | Exit | What it means | What to do |
|---|---|---|---|
| `ok` | 0 | It worked | Continue |
| `usage` | 2 | The arguments are wrong | Fix the arguments. Ask the user if the missing thing is a number only they know |
| `config` | 3 | The environment is wrong — no account, no key, an unreadable scope file | Stop. Report it. Do not try a different call |
| `auth` | 4 | A key or authority problem | Stop. Report it |
| `policy` | 5 | The execution policy or delegation scope refused it. **Nothing was built** | Report the reason. Do not work around it |
| `rejected` | 6 | The venue, the verifier or the chain refused it. **It did not happen** | Report it. Retrying identical bytes fails identically |
| `unavailable` | 7 | Transient — unreachable backend, sponsorship down | Wait and retry the same command |
| `ambiguous` | 8 | It may or may not have been submitted | **Reconcile. Never retry.** See §6 |
| `needs-approval` | 9 | A person has not approved it | Show the preview and ask |

Exit code `1` is deliberately unused: Node exits `1` when a process dies of an
unhandled throw, so `1` means "this crashed", never "this decided".

## 4. The required sequence

### read

Reads need no key and sign nothing. Run them freely.

**Start every turn with `next`.** It is the only command that answers "where am
I and what should I offer?", and it answers in the order the states must be
resolved — so an agent that follows it cannot offer a trade to someone with a
transaction in flight. `suggestions[].needsFromUser` names the values you must
ask for rather than choose.

```bash
npx waterx next --json
```

```bash
npx waterx doctor --json      # is anything blocking reads or writes?
npx waterx balance --json     # freeMargin is what a new order may commit
npx waterx positions --json
npx waterx ticker --ticker BTC --json
```

Check `writeReady` **before** previewing a write. A preview on a process with
no account fails with `config`, which is correct but is a worse first thing for
a user to see than the list of what is missing.

`doctor` reports `readReady` and `writeReady` separately. `readReady: false`
means the deployment is unreachable and nothing else will work. `writeReady:
false` names exactly what is missing — a key, an account id, a policy — in
`data.checks`.

### preview

```bash
npx waterx preview --action open-long --ticker SUI \
  --collateral 10 --leverage 2 --slippage 0.5 --json
```

Derives the order and stops. It loads no key, authorizes nothing and builds
nothing. It returns `status: "needs-approval"`, an `approvalId`, and the full
plan — including the exact `intent` the policy gate will later authorize.

**There are no defaults for `--collateral`, `--leverage`/`--size`, or
`--slippage`.** Omitting one is a `usage` error, deliberately: an agent that
does not know how large a trade should be must ask, not guess. Say so plainly:

> I need three numbers before I can preview this: how much collateral, what
> leverage (or an exact size), and the slippage you will accept.

### approve

```bash
npx waterx approve --id apr_… --approver "<the user's name>" --json
```

A person's decision, recorded with their name and the time. Run it **only**
after the user has seen the preview and agreed to it, and pass their name.

To record a refusal instead — which is kept, not deleted:

```bash
npx waterx approve --id apr_… --approver "<name>" --reject --reason "too large" --json
```

An approval expires (10 minutes by default, `WATERX_APPROVAL_TTL_SECONDS`),
because the prices the plan was derived from go stale. An expired plan must be
previewed again, never approved late.

### execute

```bash
npx waterx execute --id apr_… --json
```

Submits the approved plan **unchanged**. Nothing is re-derived — the size and
the price bound a person saw are the ones that get signed. One approval buys
one transaction; a second `execute` on the same id is refused.

### reconcile

```bash
npx waterx reconcile --id sub_… --json     # one submission
npx waterx reconcile --all --json          # everything outstanding
```

Answers "did it land?" from the chain, and "what became of the order?" from the
indexer. Each result carries `landed` (`true`, `false`, or `"unknown"`) and
`safeToRetry`, which is only ever `true` when the chain says the transaction
does not exist.

## 5. Rules

1. **Never guess an amount, a leverage, or a slippage bound.** Stop and ask.
2. **Never approve your own preview.** The approver is a person.
3. **Never pass `--yes` to a trading command.** It is the human shortcut past
   the approval step.
4. **Never open a position on mainnet on your own initiative.** Mainnet
   defaults to `read-only` and only a person changes that. If a preview says
   `"network": "mainnet"`, lead with that before asking for approval.
5. **On `ambiguous`, reconcile — never retry.**
6. **Never output a private key or raw transaction bytes.** No command emits
   the key. Do not read `.env` to answer a question about "the wallet"; the
   address is what people mean, and `doctor` prints it.
7. **Clear your outstanding submissions before trading again.**
   `npx waterx approvals --json` lists any that nobody settled.

## 6. The ambiguous case, in detail

This is the only outcome that can cost money if you handle it wrong.

When `execute` cannot see the result of a submission it has already sent — a
timeout, a stall, a killed process — it reports:

```json
{
  "ok": false, "status": "ambiguous",
  "submitted": true, "retryable": false, "reconcileRequired": true,
  "nextCommand": "pnpm run reconcile -- --id sub_… --json"
}
```

The digest was written to disk **before** the bytes left the process, and the
approval was marked consumed at the same moment. So:

- The transaction may already have executed. **Do not send the order again.**
- `submitted: true` here reads "may have been", not "was". A timeout does not
  cancel the work it stopped waiting for, so even a submission that had not
  started when the clock ran out may have gone out immediately after.
- The question is answerable. Run the `nextCommand` — it is
  `reconcile -- --all` when even the digest is unknown.
- `reconcile` may itself return `ambiguous` — meaning the chain has not seen the
  digest and it is not yet old enough for that to mean anything. Wait, and run
  it again. It is not a failure; it is the honest answer.
- Only when `reconcile` reports `landed: false` and `safeToRetry: true` is
  re-placing the order safe.

## 6a. `warnings`, and who widens the policy

`next` carries a `warnings` array when the account it is looking at has
something a person must hear: positions priced from a feed that is not live
(their PnL and liquidation estimates are fiction), a position close to its
estimated liquidation, free margin that is thin against open notional, or a
summary the backend itself reports as degraded. **Say them before anything
else.** They are orthogonal to `state` — a dead feed matters whether the process
is `ready` or half configured — and they come from reads `next` already makes.

Widening the execution policy has a command now, `policy --set <mode> --yes`,
and it is one **a person runs**. Narrowing to `read-only` needs no confirmation;
widening needs `--yes`, and an agent adding `--yes` on its own initiative is the
same mistake as approving its own preview.

## 7. Setting up wallet, account, delegation and risk limits

One command does everything that can be done without a person, and returns the
rest as structured work:

```bash
npx waterx bootstrap --json
```

It generates a wallet if there is none, asks the testnet faucet for gas only if
the wallet actually needs some, finds or records the account id in `.env`, and
reports free margin. It signs **nothing** unless you add
`--create-account --yes`, and even then only account creation, which moves no
funds. It never deposits — that commits money, and money is a decision.

Read `data.remaining`. Each entry is `{ what, why, who, command }`, and `who` is
the field that matters:

| `who` | What it means |
|---|---|
| `"you"` | Run the command. |
| `"the account owner"` | Only the owner can do it — their grant. Give them the link `onboard` prints; nobody at the venue can grant it for them. `onboard --wait <s>` then picks the grant up on its own. |
| `"an operator"` | Stop and ask a human at the venue — testnet collateral, for one. |
| `"the maintainers"` | Nothing anyone at this terminal can fix — an argument layout nobody has captured. Report it. Do not set `WATERX_ALLOW_UNCONFIRMED_ABI` on your own initiative: accepting an unconfirmed layout is a person's decision. |

Relay those verbatim rather than paraphrasing — the reasons are specific and the
paraphrase usually loses them.

```json
{
  "what": "trading collateral",
  "why": "gas is not collateral, and testnet's credit faucet is whitelist-gated — there is no self-service route",
  "who": "an operator"
}
```

**The agent is normally a delegate.** The owner keeps their account and their
funds; this wallet gets permission to trade it and nothing else. A delegate
needs **no SUI** — the backend sponsors its transactions — no account of its
own, and no collateral of its own, and it cannot withdraw. So the answer to
"what does the agent need?" is usually "the owner's grant, and nothing else".

**Never read "nothing is configured" as "nothing was granted."** The grant is
keyed on the agent's wallet, so it is findable before any account id exists —
`next` and `onboard` ask the delegate index before they report a state that
depends on it. If the owner granted it earlier, you get `granted-not-adopted`
and an `adopt` command: run that, and do not hand them the authorize link a
second time.

**`onboard` opens the authorize page itself**, once per link, and prints the
link first either way. It does not open where nobody is watching:
`WATERX_NO_BROWSER=1` or `CI` turns it off, and `--open` opens it again.

**Do not pass `--no-open`.** An install passed it on its own initiative, with
the reasoning that a mainnet authorization page should not auto-launch without
the person choosing to click. That is a real concern, and it is not yours to
settle: the switch belongs to whoever installed this, they have one
(`WATERX_NO_BROWSER=1`), and they asked for the page to open. Suppressing it to
spare somebody a window they did not ask you to spare them leaves them with a
link to paste and no idea the tool would have opened it.

Say the code exists too — `onboard --qr` — because which of the two helps
depends on where the person is sitting, and only they know that.

Getting that grant is one command:

```bash
npx waterx onboard --wait 300 --json
```

It prints the link to hand the owner, then polls until the grant lands and
adopts the account that made it — `WATERX_ACCOUNT_ID`, plus a line in the
adoption ledger. The console's own completion screen tells the owner "you can go
back to the terminal, the agent will pick this up within a few seconds", and
this is the command that makes that true. Do not wait for the user to announce
that they signed; the chain says so. Between several grants it stops at
`needs-approval` rather than choosing whose money to trade.
Never tell a user to send money to the agent's wallet unless they have
deliberately chosen the owner path with `bootstrap --create-account --yes`.

**Gas is not collateral.** Gas pays for transactions and the faucet gives it
out. Collateral is a backing asset the wallet must already hold — mock USDC or
mock USDsui on testnet — and there is no self-service route to it. A wallet can
have plenty of gas and be unable to trade at all. This is the step that
surprises people; say it plainly rather than retrying `deposit`.

**Risk limits.** `npx waterx limits --json` reports the execution
policy and the ceilings in force. To write a scope file for unattended
(`delegated-auto`) trading:

```bash
npx waterx limits --write policy.json \
  --accounts 0x… --markets BTCUSD,ETHUSD --sides long \
  --max-collateral-per-order 50 --max-cumulative-collateral 200 \
  --max-leverage 5 --max-slippage-percent 1 \
  --not-after 2026-12-31T00:00:00Z --json
```

Every ceiling is mandatory. An optional ceiling is one somebody forgets, and a
forgotten ceiling under an auto-approving policy is an unbounded one.
`delegated-auto` also requires a **delegate** key, not the owner's: a delegate
cannot withdraw or grant authority on chain, which is the whole reason
unattended trading is a bounded risk.

## 8. What the guarantees actually are

Be accurate about this if a user asks.

- The policy gate authorizes an intent, issues a permit, binds it to the
  transaction bytes, and the executor spends exactly one permit per signature.
  The transaction is then decoded and checked against the intent it is
  presented for, immediately before the signature.
- That makes an unauthorized or mis-described signature impossible **by
  mistake**. It does not contain an attacker who already has code execution in
  the process — `SignerProvider` is reachable directly, and signs opaque bytes.
- The approval ledger is the same kind of guarantee. It cannot stop a
  compromised process from writing its own approval line; what it does is make
  approval a separate, timestamped, named act, and guarantee that the plan a
  person read is the plan that gets signed.
- An order is a request, not a fill. Say "submitted" until you have checked
  `positions`.
