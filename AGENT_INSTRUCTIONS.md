# Instructions for an automated caller

This is the contract between an LLM agent and the WaterX agent CLI. It is the
long form of [SKILL.md](SKILL.md); everything here is enforced by the code, not
only asked for.

Read it once, then work from the JSON envelopes.

---

## 1. How to call anything

```bash
pnpm --silent run <command> -- --json
```

- `--silent` — suppresses the package manager banner, which is written to
  stdout and would otherwise be the first thing your JSON parser sees.
- `--json` — exactly one JSON document on stdout and nothing else, for the whole
  life of the process. Everything human-readable goes to stderr.
- `--` — separates the package-manager's arguments from the command's.

If stdout does not parse as JSON, you called it without one of those. Do not
try to repair the output; fix the call.

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

```bash
pnpm --silent run doctor --json      # is anything blocking reads or writes?
pnpm --silent run positions --json
pnpm --silent run ticker -- --ticker BTC --json
```

`doctor` reports `readReady` and `writeReady` separately. `readReady: false`
means the deployment is unreachable and nothing else will work. `writeReady:
false` names exactly what is missing — a key, an account id, a policy — in
`data.checks`.

### preview

```bash
pnpm --silent run preview -- --action open-long --ticker SUI \
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
pnpm --silent run approve -- --id apr_… --approver "<the user's name>" --json
```

A person's decision, recorded with their name and the time. Run it **only**
after the user has seen the preview and agreed to it, and pass their name.

To record a refusal instead — which is kept, not deleted:

```bash
pnpm --silent run approve -- --id apr_… --approver "<name>" --reject --reason "too large" --json
```

An approval expires (10 minutes by default, `WATERX_APPROVAL_TTL_SECONDS`),
because the prices the plan was derived from go stale. An expired plan must be
previewed again, never approved late.

### execute

```bash
pnpm --silent run execute -- --id apr_… --json
```

Submits the approved plan **unchanged**. Nothing is re-derived — the size and
the price bound a person saw are the ones that get signed. One approval buys
one transaction; a second `execute` on the same id is refused.

### reconcile

```bash
pnpm --silent run reconcile -- --id sub_… --json     # one submission
pnpm --silent run reconcile -- --all --json          # everything outstanding
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
   `pnpm --silent run approvals --json` lists any that nobody settled.

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

## 7. Setting up wallet, account, delegation and risk limits

These are a person's job, but you may be asked to walk someone through them.

```bash
pnpm install
cp .env.example .env

pnpm --silent run generate-wallet --json   # writes SUI_PRIVATE_KEY to .env
pnpm --silent run fund-sui --json          # testnet GAS only — not collateral
pnpm --silent run doctor --json
pnpm --silent run create-account -- --name my-agent --yes --json
pnpm --silent run accounts --json          # put the id in WATERX_ACCOUNT_ID
pnpm --silent run deposit -- --amount 100 --yes --json
```

Collateral is a backing asset the wallet already holds (mock USDC or mock
USDsui on testnet — `pnpm --silent run info --json` lists them). On testnet the
credit faucet is whitelist-gated, so a fresh wallet needs an operator to
whitelist it or to send it funds. `fund-sui` covers gas and nothing else.

**Risk limits.** `pnpm --silent run limits --json` reports the execution policy
and the ceilings in force. To write a scope file for unattended
(`delegated-auto`) trading:

```bash
pnpm --silent run limits -- --write policy.json \
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
