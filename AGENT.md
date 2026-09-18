# WaterX Agent — command reference

The agent asks the WaterX backend to build each transaction, signs the bytes
locally, and submits them. It never composes a PTB itself. See
[README](README.md) for why, and [docs/integration.md](docs/integration.md) for
the programmatic surface.

## Before anything else

```bash
pnpm install
pnpm run doctor        # preflight — signs nothing, safe on any network
```

`doctor` verifies the backend's network matches yours, reports the deployment's
package versions and market list, and fails on a stale `WATERX_ACCOUNT_ID`. Run
it first, and whenever a command fails in a way that does not name its own fix.

## Writes need confirmation

`WATERX_EXECUTION_POLICY` gates every write routed through
`TxExecutor.execute()`. Not every signature this package can produce:
`SignerProvider` is a public export and signs opaque bytes without consulting
the gate.

| Policy | CLI behaviour |
|---|---|
| `read-only` | writes refuse |
| `interactive` (testnet default) | writes need `--yes` |
| `delegated-auto` | writes proceed unattended, inside `WATERX_POLICY_SCOPE_FILE` — delegate wallets only |

Mainnet defaults to `read-only`. Every write example below carries `--yes`.
`--policy <mode>` narrows one invocation and can never widen.

By default the key is read from `SUI_PRIVATE_KEY` into this process. Set
`WATERX_SIGNER_COMMAND` (plus `WATERX_AGENT_WALLET`) and it moves into a child
process instead — required in practice for `delegated-auto`, which `doctor`
warns about otherwise. `pnpm run doctor` reports which provider is in use.

## Setup

| Command | What it does |
|---|---|
| `pnpm run doctor` | Preflight against the live deployment |
| `pnpm run generate-wallet` | Generate or load the wallet, saving the key to `.env` |
| `pnpm run fund-sui` | Testnet **gas** from the public Sui faucet |
| `pnpm run create-account -- --name my-agent --yes` | Create a trading account |
| `pnpm run accounts` | List accounts — copy the id into `WATERX_ACCOUNT_ID` |
| `pnpm run deposit -- --amount 50 --yes` | Mint wxUSD credit against a backing asset |
| `pnpm run withdraw -- --amount 25 --yes` | Withdraw to a backing stablecoin (owner-only) |

Collateral is a backing asset the wallet already holds — mock USDC or mock
USDsui on testnet (`pnpm run info` lists them). `fund-sui` covers **gas only**;
the credit faucet is whitelist-gated, so a fresh wallet needs an operator to
whitelist it or send it funds.

**An order is a request, not a fill.** A write returns when the request is on
chain; the keeper's `match_orders` sweep fills it — measured between ~2 and ~7
minutes on testnet, for identical orders. Check
`pnpm run positions` — an unfilled market order shows in `pnpm run orders` with
`triggerPrice: 0`. `pnpm run trades` reads an indexer view that can be days
stale; it is not evidence about your order.

## Trading

| Command | Notes |
|---|---|
| `pnpm run open-long -- --ticker BTC --collateral 10 --leverage 5 --yes` | Add `--tp` / `--sl` to bracket it |
| `pnpm run open-short -- --ticker ETH --collateral 10 --leverage 3 --yes` | |
| `pnpm run close-position -- --ticker BTC --position-id 0 --yes` | |
| `pnpm run reduce-position -- --ticker BTC --position-id 0 --percent 50 --yes` | Or `--size` in base-asset units |
| `pnpm run increase-position -- --ticker BTC --position-id 0 --collateral 5 --leverage 5 --yes` | |
| `pnpm run margin -- --ticker BTC --position-id 0 --amount 5 --yes` | `--remove` to withdraw margin |

`--slippage` (percent, default `0.5`) bounds every market-priced action. The
bound is derived from the live oracle price and refuses to compute from a stale
one.

## Orders

| Command | Notes |
|---|---|
| `pnpm run place-order -- --ticker BTC --collateral 10 --leverage 5 --trigger-price 60000 --yes` | Long limit; add `--short`, `--stop`, `--reduce-only` |
| `pnpm run place-tpsl -- --ticker BTC --position-id 0 --tp 90000 --sl 70000 --yes` | Attach to an open position |
| `pnpm run update-order -- --ticker BTC --order-id 0 --trigger-price 61000 --size 0.01 --yes` | Re-price and re-size |
| `pnpm run cancel-order -- --ticker BTC --order-id 0 --yes` | |

**A crossing limit is refused before the request is sent** — a long above market
or a short below it would fill immediately, and the contract aborts it
(`ECrossingLimitOrder`). Send a market order when that is what you meant. A
limit exactly at market is allowed.

## WLP

```bash
pnpm run wlp -- --action mint --amount 100 --yes
pnpm run wlp -- --action burn --amount 50 --yes          # queued for settlement
pnpm run wlp -- --action cancel-burn --request-id 3 --yes
pnpm run wlp -- --action claim --yes
```

Minting stakes in the same step and burning redeems from the staked balance;
there is no separate stake/unstake action.

## Delegates

The handshake, from the agent's side — it never grants, and `--wait` is the only
thing here that writes:

```bash
pnpm run onboard                            # the link to hand the account owner
pnpm run onboard -- --wait 300              # …then wait for the grant and adopt the account
pnpm run onboard -- --link                  # the URL alone, for pasting or piping
pnpm run onboard -- --qr                    # the link as a scannable code, for an owner elsewhere
pnpm run onboard -- --open                  # open the page in a browser ON THIS MACHINE
pnpm run onboard -- --details               # what the grant asks for, and where to revoke
pnpm run discover -- --wait 300             # the same search, without adopting
```

From the owner's side, with their own key:

```bash
pnpm run add-delegate -- --delegate 0x… --yes           # defaults to PERM_ALL_TRADING
pnpm run remove-delegate -- --delegate 0x… --yes
pnpm run remove-delegate -- --all --yes                 # every delegate, all accounts
pnpm run delegates
```

Four independent masks — perp, predict, staking, WLP. None of them grants a
funds-out path: a delegate can trade the account and cannot withdraw from it.

## Long-running use

| Command | What it does |
|---|---|
| `pnpm run queue -- --kind open --ticker SUI --collateral 10 --leverage 2` | Queue a market order. Signs nothing. |
| `pnpm run queue -- --kind limit --ticker SUI --collateral 10 --leverage 2 --trigger-price 0.7` | Queue a resting limit order (add `--stop` for a stop). |
| `… --after 300 --expires-in 3600` | Defer it 5 minutes. An expiry is required with `--after`. |

Intent kinds: `open` · `limit` · `close` · `cancel` · `reduce` · `increase` ·
`add-margin` · `remove-margin` · `wlp-mint` · `wlp-burn` · `wlp-cancel-burn` ·
`wlp-claim`. `--help` lists the arguments each one needs.

What a job waits for depends on what it leaves behind: `open`/`limit` wait for
the order's terminal status, `close`/`cancel` for the thing they named to be
gone, and everything else finishes when the transaction lands — a
keeper-executed reduce fills under the keeper's digest, so "the request is on
chain" is all this can honestly attest.
| `pnpm run runner` | Drive queued intents until stopped. Needs `delegated-auto`. |
| `pnpm run runner -- --once` | One pass, then exit. |
| `pnpm run jobs [-- --verbose]` | What the runner believes, and why. Read-only; safe while it runs. |

Pass a `key` when the same condition can fire repeatedly — `enqueue(intent,
{ key, cooldownMs })` returns `undefined` instead of queuing a duplicate. It
guards the *decision*; checking whether you already hold the position guards the
*world*, and both are needed.

For keeping it alive across reboots see `examples/deploy/` (launchd, systemd).
Restarting is safe: anything ambiguous is reconciled before new work goes out.

The runner submits each intent **at most once**, across crashes: it records the
transaction digest before sending, and on restart resolves anything ambiguous
against the chain before submitting anything new. A job it cannot resolve ends
as `unresolved` and waits for a person rather than being retried.

## Reads

| Command | Returns |
|---|---|
| `pnpm run info` | Network, collateral, backing assets, market list |
| `pnpm run markets` | Every market and which are tradeable |
| `pnpm run ticker [-- --ticker BTC]` | Price, 24h stats, OI, funding |
| `pnpm run positions` | Open positions with PnL and liquidation estimates |
| `pnpm run orders` | Resting orders with TP/SL legs nested |
| `pnpm run accounts` / `pnpm run delegates` | Account and delegate state |
| `pnpm run candles -- --ticker BTC --tf 1h --limit 50` | Candlestick history |
| `pnpm run trades -- --ticker BTC` | Recent trades |
| `pnpm run funding -- --ticker BTC` | Funding history (live rate is on `ticker`) |
| `pnpm run history [-- --category order]` | Trade / order history |
| `pnpm run funds` | Deposit and withdrawal history (keyed on the wallet) |
| `pnpm run pnl` | PnL summary and equity curve |
| `pnpm run wlp-info` | Pool overview, APY, this account's stake |
| `pnpm run market-data` | Coin prices, trending, fear & greed |
| `pnpm run referral` | Codes, referrer, stats |

## Reading position output

- `estLiqPrice: 0` = **cannot estimate**, never "no liquidation risk".
- `maintenanceMarginRatio: 0` = unknown. There is no fallback value on purpose.
- `priceStale: true` = `spotPrice` is not live, and every field derived from it
  is stale too.

## Amounts

Everything on the CLI is in display units.

- Collateral and margin: USD — `--collateral 10` is 10 USD.
- Prices: USD — `--trigger-price 65000` is $65,000.
- Size: base-asset units — `--size 0.15` is 0.15 BTC.
- Leverage: a multiplier — `--leverage 5` is 5×.

Scaling to the chain's `u64`/`u128` integers happens once, in `src/units.ts`,
which refuses precision it cannot represent rather than rounding it away.

## Markets

Read them from the deployment (`pnpm run markets`) rather than assuming a list.
There are 30 on testnet today — crypto, tokenized equities, FX, metals and
energy — and the set changes.

## Exit codes

Stable, and the same for every command. An automated caller can branch on these
without reading a message; `--json` carries the same answer as fields on the
envelope. See [AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md) for the full
contract.

| Code | Status | Meaning |
|---|---|---|
| `0` | `ok` | It did what it was asked |
| `2` | `usage` | The arguments are wrong. Fix them; do not retry as-is |
| `3` | `config` | The environment is wrong — no account, no key, an unreadable scope file |
| `4` | `auth` | A key or authority problem |
| `5` | `policy` | The execution policy or delegation scope refused it. Nothing was built |
| `6` | `rejected` | The venue, the verifier or the chain refused it. It did **not** happen |
| `7` | `unavailable` | Transient. Retrying is safe |
| `8` | `ambiguous` | It may or may not have been submitted. **Reconcile; never retry** |
| `9` | `needs-approval` | A person has not approved it yet |

`1` is deliberately unused: Node exits `1` when a process dies of an unhandled
throw, so `1` means "this crashed", never "this decided".

## The approval path

The commands an automated caller uses. A person is in the middle of it by
construction — `execute` submits a plan `approve` recorded someone agreeing to,
unchanged.

| Command | What it does |
|---|---|
| `pnpm run preview -- --action <action> … --json` | Derives the write exactly. Loads no key, authorizes nothing, builds nothing. Exits `9` |
| `pnpm run approve -- --id apr_… --approver <name>` | Records a person's decision. `--reject --reason …` records a refusal |
| `pnpm run execute -- --id apr_…` | Submits the approved plan unchanged. One approval, one transaction |
| `pnpm run reconcile -- --id sub_… \| --all` | Asks the chain whether a submission landed |
| `pnpm run approvals` | Previewed plans, who approved them, and anything unsettled |
| `pnpm run limits` | The policy and risk ceilings in force. `--write policy.json …` creates a scope |

`preview` has **no defaults** for `--collateral`, `--leverage` / `--size` or
`--slippage`. That is deliberate: an agent that does not know how large a trade
should be must ask, and the only way to make that true is to leave it nothing to
fall back on. The direct commands below keep their human-friendly defaults.
