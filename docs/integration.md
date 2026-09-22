# Integration guide

How to drive the WaterX perpetual protocol from an automated process, and why
this agent is shaped the way it is.

## The flow

Every write is three steps:

```
  shape the request      →   backend builds the PTB   →   sign and submit
  (display units)            (POST /order/market)         (TxExecutor)
  src/agent/agent.ts         src/api/tx.ts                src/chain/executor.ts
```

The backend returns base64 transaction bytes and never a signature. Nothing in
this repo composes a PTB — with one exception worth knowing about, because it is
the difference between "we never touch it" and "we never decide what it does":
on the **self-pay** path the backend returns transaction *kind* bytes, and
`TxExecutor` rebuilds them into a complete transaction, adding the sender and
letting its own fullnode client select gas. The commands are still entirely the
backend's; the envelope around them is not. The sponsored path signs the bytes
exactly as they arrive.

### Why not compose the PTB here

The previous design used the SDK's builders directly. It stopped working, and
the way it stopped is the argument for the current shape.

A perp PTB carries oracle legs. Which legs are required is a property of the
*deployment*, not of the call: a rule that is weighted on chain must be fed, and
`remove_outliers` aborts the transaction with `EMissingPriceSource` when a
client omits it. That set moved twice in three months — testnet retired
`PythRule` in favour of the enclave-backed `WaterxRule`, and mainnet weighted,
then partially unweighted, its Lazer leg. On top of that, package ids and the
account registry moved (the registry left `waterx_perp` for its own
`waterx_account` package), and the version gates were realigned to the source
`PACKAGE_VERSION`.

A pinned client with compiled-in ids and a fixed oracle plan cannot track any of
that, and each divergence surfaces as an on-chain abort whose code describes the
symptom. The backend already does this composition — `core/perp-ptb-composer.ts`
for the leg threading, `core/oracle-update-cache.service.ts` for the refreshes —
against the deployment it is itself booted on, and it is exercised by production
traffic continuously. Delegating to it removes the drift surface rather than
managing it.

What the agent keeps is what a backend cannot hold for it: the private key, the
decision to sign, and the conversion between how a caller thinks about money and
how the chain represents it.

## Units

Three scales, not interchangeable, all crossing the wire as decimal **strings**
because a `u128` does not survive `JSON.parse`.

| Quantity | Scale | Width | Example |
|---|---|---|---|
| Collateral | 6 dp | `u64` | `8` USD → `"8000000"` |
| Price | 1e9 | `u128` | `$65,000` → `"65000000000000"` |
| Size | 1e9 | `u128` | `0.15` BTC → `"150000000"` |
| `acceptablePrice` | 1e9 | **`u64`** | the one 1e9 field the contract keeps narrow |

`src/units.ts` owns every conversion, and **refuses** input carrying more
precision than the scale can hold rather than rounding it:

```typescript
toRawCollateral("10.5")       // "10500000"
toRawCollateral("1.0000001")  // throws — 7 dp into a 6 dp scale
```

There is no safe default for which digit to drop, and a silently truncated
amount is a wrong trade that looks like a right one. Round deliberately at the
call site if you need to.

Slippage bounds are directional, and the direction is easy to invert:

```typescript
acceptablePriceFor(spot, "buy", 0.5)   // spot × 1.005 — a buy may pay up to
acceptablePriceFor(spot, "sell", 0.5)  // spot × 0.995 — a sell may accept down to
```

A bound computed on the wrong side can never bind, which reads as working.

## Execution policy

Two objects, deliberately not one. `PolicyGate.authorize()` decides and issues a
**permit**; `TxExecutor.execute()` spends one per signature and refuses a permit
it did not issue or that has already been spent. The gate is consulted *before*
the transaction is built, so a refused action costs no request; the permit is
what makes "every write routed through `TxExecutor.execute()` was authorized" a
property of the code rather than a habit of its callers. Not "every signature
this package produces": `SignerProvider` is a public export, so a caller can
sign opaque bytes without going near the gate.

**The backend is trusted to compose freely inside the deployment's own
packages.** Every object, type and producer *of the operation itself* is checked
against an intent formed locally, and no other action's entrypoint may ride
along. Its arguments are checked too — but not all of them: fourteen are
declared unconstrained, and two of those are the minimum-output floors on a WLP
mint and a native withdrawal, which the backend picks and nothing here bounds.
[The README lists every one.](../README.md#the-backend-is-the-trust-boundary-for-auxiliary-composition)
The auxiliary calls *around* the operation are bounded only by which packages
and shared objects the deployment publishes; their arguments, multiplicity,
ordering and effects on shared state are not checked at all.

Prices are the consequence to plan around: the oracle legs write into shared
state and the trading call reads it from there, with no argument in the PTB
joining them, and the acceptable-price bound is derived from a spot reading
taken from the same backend — so it does not cover a consistently misreported
price. See [the README](../README.md#the-backend-is-the-trust-boundary-for-auxiliary-composition)
for the full statement and what would close it.

**Both run inside the agent process.** `TxExecutor.execute()` calls the gate, the
permit check and the transaction check, so code already executing here can skip
all three and sign directly. They defend against bugs, against a wrong or
hostile backend response, and against a compromise that reaches only the API
layer — not against an attacker with execution alongside the signer.

Moving the key out does not answer that either, and this paragraph used to
suggest it did while the section below said the opposite. An external key stops
the key being *taken*; it does not stop a compromised process asking for a
signature, because the signer applies no policy of its own. What limits what
such a signature can DO is the delegate's on-chain
permission mask has to be narrow — and that mask is capability bits with no
amount limit, which is what the scope file is standing in for.

```typescript
// WATERX_EXECUTION_POLICY=read-only
await agent.openLong({ ... });                  // ExecutionPolicyError, no request sent

// WATERX_EXECUTION_POLICY=interactive  (default on testnet)
await agent.openLong({ ... });                  // ExecutionPolicyError — no `confirm`
await agent.openLong({ ..., confirm: true });   // signs

// WATERX_EXECUTION_POLICY=delegated-auto + WATERX_POLICY_SCOPE_FILE=./policy.json
await agent.openLong({ ... });                  // signs, if the scope allows it
```

### Where the key is

The policy decides *whether* to sign. `SignerProvider` decides *where the key
is*, and the two are independent on purpose — a scope that bounds an unattended
agent is worth much less if the same process can also read the key it is being
bounded around.

**Moving the key out is key custody isolation and nothing more.**
`SIGNER_PROTOCOL` carries opaque bytes: the child parses no transaction, knows
no intent, and applies no policy. A process that has been taken over cannot
extract the key, and can still ask the child to sign whatever it likes by
calling `SignerProvider` directly. It bounds what an attacker walks away with,
not what they can do while they are there. See
[the README](../README.md#signer-boundary) for what closing that would take.

```typescript
import { WaterXAgent, ExternalCommandSigner } from "waterx-agent";

// Default: the key is loaded from SUI_PRIVATE_KEY into this process.
const local = new WaterXAgent();

// The key lives in a child process; this one only ever sees signatures.
const remote = new WaterXAgent({
  signer: new ExternalCommandSigner({
    command: ["waterx-predict-keystore", "sign"],
    agentWallet: "0x…",
  }),
});
```

The wire is `SIGNER_PROTOCOL` v1 — one JSON line in, one signature out:

```jsonc
// stdin
{ "version": 1, "type": "TRANSACTION", "agentWallet": "0x…", "transactionBytesBase64": "…" }
// stdout, and nothing else
{ "signature": "…" }
```

Three details are load-bearing:

- **The address is stated, not derived.** Deriving it would need the key. A
  conforming signer refuses a request for an address it does not hold and names
  the one it does, so a misconfiguration fails at the child instead of producing
  a signature for the wrong account.
- **The bytes must be complete.** On the unsponsored perp path the backend
  returns transaction *kind* bytes; the sender and gas coins are chosen here,
  before anything reaches a signer. A signer cannot tell a kind from a whole
  transaction, so skipping that step would be asking a key holder to sign
  something that cannot execute.
- **One request, one child.** Nothing is reused between signatures. The
  ssh-agent-shaped providers this talks to already hold the key in *their*
  resident process, which is the one that should own that risk.

Every way a child can fail becomes a named refusal — non-zero exit, non-JSON
output, JSON without a signature, no answer within the timeout, a command that
cannot be run — and the child's stderr is surfaced as a diagnostic rather than
returned to a caller who might archive it.

### The scope

`delegated-auto` without a scope is a configuration error, not a blank cheque.
Every ceiling that applies to an allowed action is mandatory, and an incomplete
scope is refused at load:

```jsonc
{
  "accounts": ["0x…"],
  "markets": ["BTCUSD"],
  "sides": ["long"],
  "maxCollateralPerOrder": 50,
  "maxOpenCollateral": 150,
  "maxCumulativeCollateral": 200,
  "maxLeverage": 5,
  "maxSlippagePercent": 1,
  "notAfter": "2026-12-31T00:00:00Z"
}
```

The strictness is not stylistic. **On chain, a perp delegate's permissions are
capability bits, not amounts** — `PERM_OPEN_POSITION` says the delegate may open
a position and nothing about its size — and nothing on the perp side enforces a
per-order or per-hour ceiling server-side. This file is therefore the only
amount limit a delegate has, and an optional ceiling in it would be an unbounded
one.

Actions that *reduce* exposure — close, reduce, add margin, cancel — are never
metered. A risk limit that could trap a position open would be worse than none.
Only exposure-increasing actions accrue against `maxCumulativeCollateral`, and a
refused order does not accrue at all.

`maxOpenCollateral` bounds concurrent exposure — open positions plus unfilled
orders — and recovers when a position closes; `maxCumulativeCollateral` is a
lifetime budget that only decays, persisted across restarts in
`.waterx/spend.jsonl` (`WATERX_SPEND_FILE`). `PolicyGate` does no I/O, so the
concurrent measurement is supplied by the caller as
`AuthorizeOptions.openCollateral` — `Agent.submit` measures it with
`openCollateralOf(positions, unsettled, maxCollateralPerOrder)` — and an
exposure-increasing write that arrives without one is refused.

`authorizeAndBuild` commits the amount before calling `build()`, and releases
it — appending the reversal to the ledger — if the build throws, since no bytes
existed and nothing was sent. Nothing after a successful build is released.

`--policy` narrows one invocation and can never widen: `--policy read-only` on an
unattended machine is a safety belt, `--policy delegated-auto` on an interactive
one is an error. Widening is a change to the configuration, made deliberately
and in one place.

## Sponsored vs self-paid

`TxResponse` is discriminated on `sponsored`, and the two branches submit
differently:

- **`sponsored: true`** — Enoki has reserved a digest and is the gas owner.
  Sign the bytes, then `POST /sponsor/execute` with `{ digest, signature }`.
  Submitting these bytes to a fullnode fails for gas.
- **`sponsored: false`** — sign and submit directly over gRPC.

`TxExecutor` narrows this once. One case is worth naming: a **delegate** wallet
holds no gas, so an unsponsored build while delegated cannot succeed. The
backend normally returns `6003 SponsorshipRequiredForDelegate` when it cannot
sponsor; if an unsponsored build reaches the executor anyway, it refuses with
that explanation rather than letting the fullnode report a gas failure.

## The delegate model

A delegate carries **three** bitmasks, not four: perp (`account_data::WaterXPerp`),
predict, and staking. Perp and WLP are the same mask — `trading::assert_protocol_perm`
and `lp_pool::assert_wxa_protocol_perm` both read that one slot, with the trading
bits and `PERM_MINT_WLP` / `PERM_REDEEM_WLP` living on it together. Granting perp
authority grants nothing on predict or staking.

The `request::TradingRequest<CREDIT>` slot you may see in older code and in the
`@waterx/sdk` generated doc comments is superseded; nothing reads it as a
permission. A delegate holding authority only there looks permissioned and aborts
`EUnauthorized` on chain — `GET /account/delegate` reports that as `stale`.

```typescript
import { PERM_ALL_TRADING, PERM_OPEN_POSITION, PERM_CLOSE_POSITION } from "waterx-agent";

await agent.addDelegate({
  delegate: "0x…",
  perpPermissions: PERM_OPEN_POSITION | PERM_CLOSE_POSITION,
  confirm: true,
});
```

**No mask opens a funds-out path.** After the delegate-phishing hardening, every
funds-out entry point is owner-only, and the backend refuses a delegate-signed
request at the edge with `2018 DelegateSenderNotAllowed` — verified against a
live account for `withdraw`, `deposit` and `addDelegate` (so a delegate cannot
grant itself anything either). An unregistered address gets `2022`. That is what
makes `delegated-auto` on a delegate wallet a bounded risk.

### The mask the API shows is not the one the chain enforces

`GET /account/delegate` returns the mask stored under
`request::TradingRequest<CREDIT>`. `trading::assert_protocol_perm` reads
`account_data::WaterXPerp` — a different key, and since the contract moved
trading auth onto it, the one that decides. `buildAddDelegate` writes
`perpPermissions` into **both** scopes, so a delegate added through the current
backend works.

A delegate added before that dual write does not, and fails in the least
informative way available: the backend's own pre-check reads the legacy mask,
sees full permissions, and passes; the chain then aborts `EUnauthorized`, which
reaches the client as a generic `6002 Transaction would fail on-chain`. Observed
on a live testnet account whose delegate reads
`OPEN_POSITION CLOSE_POSITION … WITHDRAW_COLLATERAL` and cannot place an order.

`pnpm run doctor` warns about this whenever a delegate key is loaded, because
nothing in the API response reveals it. If a delegate fails this way, re-add it.

Running as a delegate:

```bash
SUI_PRIVATE_KEY=<delegate key>
WATERX_OWNER_ADDRESS=<owner address>   # sender stays the owner; this wallet signs
```

`withdraw`, `addDelegate` and `removeDelegate` refuse up front in this mode
rather than building a transaction the chain will reject.

## Guards that need live state

Two checks run against live market data before a request is sent, because the
on-chain failure is not self-explaining.

**Crossing limits.** A long limit above market, or a short below it, would fill
immediately; the contract aborts it as `ECrossingLimitOrder` at placement *and*
at re-price (so re-pricing a resting order across market is closed too). The
agent refuses first and names market orders as the intended path. The comparison
is strict — a limit exactly at market is legal on chain and allowed here. Stop
orders and reduce-only legs are exempt: triggering through price is their job.

**Stale prices.** `MarketRegistry.spotPrice` refuses a ticker marked `stale`
rather than sizing an order from it. Everything derived from spot — the order
size, the slippage bound — inherits that staleness, and a bound derived from a
stale price does not bind.

## Errors

Three kinds, distinguishable by class:

| Class | Meaning |
|---|---|
| `ExecutionPolicyError` | The policy forbade this write. No signature was produced. |
| `WaterXApiError` | The backend rejected the request. Carries `code` from `ErrorCode`. |
| `TxExecutionError` | Submitted, and the chain rejected it. Carries the digest when there is one. |

```typescript
import { ErrorCode, WaterXApiError } from "waterx-agent";

try {
  await agent.openLong({ ticker: "BTC", collateral: 10, leverage: 5, confirm: true });
} catch (error) {
  if (error instanceof WaterXApiError) {
    if (error.code === ErrorCode.InsufficientAccountBalance) { /* deposit first */ }
    if (error.retryable) { /* 5xx, or 6003 sponsorship down — try again shortly */ }
  }
}
```

`retryable` is `true` for 5xx and for `6003 SponsorshipRequiredForDelegate`,
which is explicitly transient. A 4xx will not become a 2xx by asking again, and
the HTTP client only retries GETs — a build POST reserves a sponsorship digest,
so a blind retry on an ambiguous timeout leaves a second reservation dangling.

## Account lifecycle

```typescript
await agent.createAccount({ name: "my-agent", confirm: true });
// The indexer assigns the id; read it back rather than parsing events.
const [account] = await agent.accounts();
```

Then set `WATERX_ACCOUNT_ID`. `pnpm run doctor` fails loudly if that id is not
owned by the loaded wallet on the current deployment — the exact failure that
made the previous version of this agent look broken for no visible reason.

## Deposits

Deposit **mints wxUSD credit** against a registered backing asset. It is not a
transfer of a fixed collateral coin, so it names a Move type:

```typescript
const info = await agent.read.info();
await agent.deposit({
  assetType: info.backingAssets[0].coinType,
  amount: 50,
  confirm: true,
});
```

`GET /info` is the authoritative list of what a deployment accepts, alongside
its market list. Prefer it to anything compiled into a client.

> **Testnet funding.** The credit faucet (`testnet_faucet::faucet_mint`) is
> whitelist-gated by an admin capability, so a freshly generated wallet cannot
> mint its own test collateral. Gas comes from the public Sui faucet
> (`pnpm run fund-sui`); collateral needs an operator to whitelist the address or
> to send it. There is no self-service path, and this agent does not pretend
> there is one.

## WLP

Minting stakes in the same step, and burning redeems from the staked balance —
there is no separate stake/unstake action. A burn is queued and settled by the
withdrawal queue; `cancel-burn` withdraws a pending request.

```typescript
await agent.mintWlp({ amount: 100, confirm: true });
await agent.burnWlp({ amount: 50, confirm: true });    // queued
await agent.claimWlpRewards({ confirm: true });
```

The backend pre-checks both burn preconditions — pool utilization above the cap,
and a requested amount exceeding the staked balance — so those surface as
`WaterXApiError` rather than as an on-chain abort.

## Reading positions

Two fields carry sentinel values that a naive consumer will misread:

- `estLiqPrice === 0` means **"cannot estimate"** — the market's maintenance
  margin ratio is unknown or the position has no size. It never means "no
  liquidation risk". Gate on `> 0` and render nothing otherwise.
- `maintenanceMarginRatio === 0` means unknown, for the same reason. There is no
  flat fallback on purpose: real values span ~0.01 on crypto to ~0.05 on
  tokenized stocks, and substituting a middle number understates risk by more
  than 3× on the high end.
- `priceStale === true` means `spotPrice` is not a live oracle read, and
  everything derived from it — `estPnl`, `estLiqPrice`, `size` — inherits that.

## Keeping up with the backend

`src/api/types.ts` mirrors backend wire types by hand; each block names the file
it mirrors. The backend publishes no client package, so this is a maintained
copy, and `pnpm run doctor` is the check that the copy still matches reality.

When the backend changes:

1. `pnpm run doctor` — network, package versions, market list, account.
2. `pnpm run info` — collateral and backing assets.
3. Diff `apps/waterx/src/**/*-tx.dto.ts` against `src/api/types.ts`.
