# WaterX Agent

A TypeScript agent for the [WaterX](https://waterx.io) perpetual protocol on Sui.
No browser wallet: it holds a keypair, asks the WaterX backend to build each
transaction, signs the bytes, and submits them.

## Why the backend builds the transaction

A perp PTB has to refresh the right oracle rules for the deployment it targets,
dedup those refreshes per ticker, and respect the per-position reentrancy lock.
Which rules are live changes — testnet retired `PythRule` for the enclave-backed
`WaterxRule`, mainnet re-weighted its Lazer leg — and when a client omits a leg
that is weighted on chain, the transaction aborts with `EMissingPriceSource`
rather than failing a type check.

That composition already exists in the backend, is exercised by production
traffic, and moves with each deployment. A second copy in this repo would be a
second thing to keep in step, and it would fail silently. So this agent shapes
requests and owns the signature; the backend owns PTB composition. (One
exception, because it matters for what "owns" means: on the self-pay path the
backend returns transaction *kind* bytes and this repo rebuilds them, adding a
sender and letting its own client select gas. The commands are the backend's;
the envelope is not.)

Concretely, that leaves three things here:

| Concern | Where |
|---|---|
| Display units → the raw integer strings the DTOs demand | `src/units.ts` |
| The path every write in this package signs through, and the policy gating it | `src/chain/executor.ts` |
| Request shaping and the guards that need live market state | `src/agent/` |

`@waterx/sdk` is a dependency for its permission and order-type constants — the
on-chain source of truth for those bitmasks — not for transaction building.

## Install

Three ways in. The commands are identical afterwards, and the ones this package
*hands back* are spelled for wherever they were printed — `npx waterx …` from an
install, `node bin/waterx.mjs …` from a checkout — so they run verbatim.

**From the repository URL.** Nothing to host; npm clones, builds and packs.

```bash
npm install github:WaterXProtocol/waterx-agent
npx waterx next --json
```

The build happens at install time via the `prepare` script, which means this
route depends on lifecycle scripts being allowed. Two things to know:

- **npm** runs it, with a `npm warn allow-scripts` notice on npm ≥ 11. If a
  policy blocks it, the package installs with no `dist/` — an install that looks
  fine and has no build in it.
- **pnpm refuses outright**: `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. It wants
  the package named in `onlyBuiltDependencies` first. Nothing is silently
  broken — the install fails — but `pnpm add github:…` does not work as typed.

Use a tarball wherever either of those bites.

**From a tarball.** Already built, so nothing runs at install time.

```bash
npm install https://github.com/WaterXProtocol/waterx-agent/releases/download/v0.1.0/waterx-agent-0.1.0.tgz
npx waterx next --json
```

Produce one with `pnpm run build && npm pack` and attach it to a GitHub release.
This is the option to hand to anyone whose environment blocks install scripts.

**A checkout**, to work on it:

```bash
git clone git@github.com:WaterXProtocol/waterx-agent.git
cd waterx-agent && pnpm install
node bin/waterx.mjs next --json
```

Runs straight from TypeScript through `tsx`, with no build step between an edit
and a run — the shim prefers sources when they are present, which they are only
in a checkout.

**Mainnet is the default network.** Testnet does not work — its gas faucet
refuses most first attempts, its collateral faucet is whitelist-gated so
retrying never produces trading funds, and its keeper has not been filling
orders. Defaulting there sent every new user down a road with three walls
across it. This is a decision about which deployment to *read*: mainnet's
execution policy still defaults to `read-only`, so writing is a separate thing
a person types. `WATERX_NETWORK=testnet` switches back.

Configuration belongs to the caller: `.env` and the `.waterx/` ledgers are read
and written in the **working directory**, never inside the package.

`pnpm run pack:check` packs the tarball, installs it into a throwaway project
and asserts what arrived — that `bin` resolves, that no `tsx` came with it, and
that the commands it emits are runnable there. None of that is visible from
inside the repository, which is why the check leaves it.

The package stays `private: true`: installable from a tarball or a git URL,
while publishing to npm remains a separate, deliberate decision.

## Driving it from an agent

**The prompt to hand someone**, for Claude Code, Codex, or anything with a
shell:

> Run `npm install github:WaterXProtocol/waterx-agent`, then
> `npx waterx next --json`, and do what it says.

`next` works on a package with no configuration at all and routes itself to
`bootstrap`, which reports what is still missing and who can supply it. The
agent does not have to plan the onboarding, and does not need to find a
document first — though `npx waterx skill` prints these instructions if it
wants them.

`bootstrap` does every setup step that does not need a person — a wallet, gas
if the wallet needs any, finding and recording the account id — and returns the
rest as structured work items saying *what*, *why*, and *who can supply it*.
Which is how an agent learns to stop and ask instead of retrying: testnet
collateral is whitelist-gated and comes back as `who: "an operator"`.

[SKILL.md](SKILL.md) is the entry point, and it installs into Claude Code,
Codex, an `AGENTS.md`, or any runtime with a shell tool — see *Installing this
skill* at the end of it. [AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md) is the
full contract: the required **read → preview → approve → execute** loop, the
stable exit codes, and what to do with the one outcome that costs money if you
handle it wrong.

Every command takes `--json` and writes exactly one JSON document to stdout —
nothing else, ever, for the life of the process. The envelope answers five
questions without any English being parsed: did it work, may I retry, did a
transaction leave, must I reconcile, and am I waiting on a person.

## Quick start

Nine steps, from a clean checkout to a trade you can account for. Every command
here exists in `package.json`; if one fails, it names the fix.

```bash
# 1. install
pnpm install
cp .env.example .env

# 2. preflight — needs no key, signs nothing, safe on any network
pnpm run doctor

# 3. a wallet
pnpm run generate-wallet    # writes SUI_PRIVATE_KEY to .env

# 4. GAS — not collateral (see below)
pnpm run fund-sui

# 5. an account
pnpm run create-account -- --name my-agent --yes
pnpm run accounts           # copy the id into WATERX_ACCOUNT_ID in .env

# 6. collateral — a backing asset the wallet already holds
pnpm run deposit -- --amount 100 --yes

# 7. preview a trade. Derives it exactly, authorizes nothing.
pnpm run preview -- --action open-long --ticker SUI \
    --collateral 10 --leverage 2 --slippage 0.5

# 8. a person approves it, then it is sent
pnpm run approve -- --id apr_… --approver "your name"
pnpm run execute -- --id apr_…

# 9. settle anything whose result you did not see
pnpm run reconcile -- --all
```

Steps 2–6 are a one-off. Steps 7–9 are the loop, and they are the whole
interface an automated caller gets — see [SKILL.md](SKILL.md) and
[AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md).

### Gas is not collateral

Two different things, and conflating them is the most common way a fresh setup
stalls.

| | What it is | How to get it |
|---|---|---|
| **Gas** | SUI, to pay for transactions | `pnpm run fund-sui` — the public testnet faucet |
| **Collateral** | A **backing asset** the wallet holds: mock USDC or mock USDsui on testnet | No self-service faucet. The credit faucet is whitelist-gated |

`pnpm run info` lists what this deployment accepts. `pnpm run deposit` mints
wxUSD credit against one of them — it is a credit mint, not a transfer, so a
wallet with gas and no backing asset can pay for a deposit it cannot make. Ask
an operator to whitelist the address, or use a wallet that already holds some.

### Reads need no key

`markets`, `ticker`, `positions`, `orders`, `info` and `doctor` all run in a
process that never loads `SUI_PRIVATE_KEY`:

```bash
env -u SUI_PRIVATE_KEY pnpm run markets      # works
```

The signer is built on the first *write*. That is what lets an operator hand an
agent read access without handing it the ability to sign, and it is why the
first command on a fresh clone does not fail with a message about wallets.

### When something is missing

`doctor` is the command to run first and whenever something looks wrong. It
reports **read readiness** and **write readiness** separately, because they
fail independently — a missing key blocks nothing you can read, and a stale
`WATERX_ACCOUNT_ID` blocks everything you can write. Each failing check names
the setting to change.

```
✓  signer             0xb142…de6c — in-process keypair (SUI_PRIVATE_KEY), owner key
✓  execution policy   interactive on testnet (https://api-testnet.waterx.app)
✓  backend            https://api-testnet.waterx.app → sui_testnet
✓  markets            30 listed — SUI, BTC, ETH, SOL, DEEP, WAL, HYPE, XRP, …
✓  collateral         USD (6 dp); backing assets: USDC, USDsui
✓  deployment config  waterx_perp=v3 waterx_account=v2 waterx_oracle=v1 waterx_rule=v4
✓  manifest           24 packages, 157 objects, read just now
!  packages           …a WLP mint will be refused before signing. Nothing in the
                      onboarding or perp trading flow reaches them.
!  abi corpus         19 entrypoints confirmed on 2026-09-10; 3 never were.
                      These actions refuse until they are: burnWlp, cancelWlpBurn,
                      claimWlpRewards — none of which is part of onboarding or
                      perp trading.
✓  account            0xa4a4…0af8 owned by 0xb142…de6c
✓  read readiness     markets, tickers, positions and orders are available
✓  write readiness    interactive on testnet — writes can be signed
```

Those two `!` lines are the current, expected state of testnet: three WLP and
staking entrypoints whose argument layouts cannot be captured without conditions
that do not exist (a pending redemption, an unstaked balance, claimable
rewards), and one reward-coin package the config document does not list. Neither
touches onboarding or perp trading. `doctor` prints the exact
`WATERX_ALLOW_UNCONFIRMED_ABI` / `WATERX_EXTRA_PACKAGES` line if you need those
paths anyway.

### Mainnet

Mainnet is live and this agent reaches it — `WATERX_NETWORK=mainnet` switches
the backend, the fullnode and the deployment document together. Reads work with
no further setup. Writes need three deliberate acts, and the default is that
none of them has happened.

1. **A policy.** Mainnet defaults to `read-only`. Writing there has to be
   something someone typed, so `WATERX_EXECUTION_POLICY=interactive` is the
   decision, not an oversight to fix.
2. **The package exceptions.** Mainnet's config document does not list three
   packages the backend reaches: the Pyth Lazer oracle, which **every order**
   calls, and the USDC and reward coin types, which appear as type arguments.
   `pnpm run doctor` prints the exact `WATERX_EXTRA_PACKAGES` line. The Lazer
   one needs the `=*` form — see `.env.example` for what each form grants and
   why that one is the ugliest.
3. **A corpus for the actions you use.** The recorded argument layouts are
   **per network**: testnet and mainnet publish different packages under the
   same names, so a capture of one describes the other as entirely changed.
   `src/chain/abi-corpus.json` holds a record per network, and a network with
   no record refuses every write rather than reading positions nobody confirmed.

As committed, mainnet has 17 of 23 entrypoints confirmed. `cancelOrder` and
`updateOrder` are not among them — capturing those needs a resting mainnet
order, which costs real money to create — so they refuse until someone captures
them or names them in `WATERX_ALLOW_UNCONFIRMED_ABI`. Everything else in the
perp and account flow is confirmed.

To check the whole path without signing anything:

```bash
WATERX_NETWORK=mainnet pnpm run doctor          # what is ready, what is not
WATERX_NETWORK=mainnet pnpm run check-verifier  # real bytes, verified, never signed
```

`check-verifier` asks the live backend for a bracket order, checks that the
correct one passes verification, then asks for variants that differ from what
the intent authorizes and checks that each is refused. It stops at
verification — nothing is signed and nothing is submitted.

### An order is a request, not a fill

A write returns when the request is on chain. A keeper fills it afterwards, and
on testnet that sweep is sometimes not running at all. `pnpm run orders` shows
the resting request; `pnpm run positions` shows what was actually filled. Do not
read a successful `execute` as a position.

## Trading someone else's account

**This is the normal arrangement, and the default the setup assumes.** a person keeps their own key and their own
account, and grants a **separate** wallet — the agent's — permission to trade
on it. The agent holds only the delegate key.

```bash
node bin/waterx.mjs onboard --json
```

A delegate needs **nothing**: no SUI, because the backend sponsors its
transactions; no account of its own; no collateral of its own. The owner keeps
all three. A fresh install therefore has exactly one thing outstanding — the
grant — and `bootstrap` says so rather than asking anyone to fund a wallet.

`onboard` reports where the handshake has got to and what the next move is. The
grant itself is the owner's act, made on chain from their own wallet at
`https://waterx.app/en/account`, and revocable there; this command reads it and
never makes it. An agent that could grant itself authority would not be a
delegate arrangement.

What the agent asks for is `OPEN_POSITION`, `CLOSE_POSITION`,
`INCREASE_POSITION`, `DECREASE_POSITION`, `PLACE_ORDER`, `CANCEL_ORDER` — and
never `DEPOSIT_COLLATERAL` or `WITHDRAW_COLLATERAL`. **Funds-out and authority
changes are owner-only on chain** since the delegate-phishing hardening, so a
delegate can trade the account and cannot withdraw from it or grant anyone else
access — whatever its mask says, and whatever a bug here does. That is the
entire reason `delegated-auto` is a bounded risk rather than a promise.

Two states are worth knowing about, because both look like success:

- **A stale grant** lands in the superseded `TradingRequest<CREDIT>` slot. It
  reads as fully permissioned and aborts `EUnauthorized` on every order,
  surfacing as a generic `6002`. `onboard` and `doctor` both name it.
- **A failed lookup is not a revocation.** An unreadable chain is reported as
  unconfirmed, never as "the owner took it away".

The one thing the agent cannot do for itself is find the account: the backend
answers "who may act on this account?" and has no reverse lookup, so the owner
states the account id once (`WATERX_ACCOUNT_ID`). Everything after that is
checked against the chain rather than believed.

### What mainnet cannot do yet

`cancelOrder` and `updateOrder` are unconfirmed there — capturing a layout needs
a transaction the deployment will build, and both need a resting order that does
not exist on any account this repo can reach. Everything else in the perp and
account flow is confirmed: market orders, closing, reducing, increasing, margin,
deposit, withdraw, delegates.

That gap has a consequence worth stating, because the code acts on it:
**placing a resting order is refused while its cancellation is unconfirmed.** An
order on the book whose retraction cannot be signed can only be got rid of by
letting it fill, which is strictly worse than not placing it. `placeLimitOrder`
and `placeTpSl` therefore refuse on mainnet until someone either captures
`trading::cancel_order_request` or names it deliberately in
`WATERX_ALLOW_UNCONFIRMED_ABI`.

The refusal states its evidence rather than only its verdict: six other
entrypoints in the same package and module *are* confirmed against mainnet and
all matched the SDK. That is corroboration, not proof — the SDK could describe
one function wrongly while describing its neighbours correctly — and it is the
difference between "we have never checked anything here" and "we checked six
siblings and this one needed conditions we could not create". An operator
deciding whether to accept it should decide with that in front of them.

## Execution policy

| Policy | Behaviour |
|---|---|
| `read-only` | Writes are refused before a signature exists. |
| `interactive` | A write needs explicit per-call confirmation — `--yes` on the CLI, `confirm: true` in code. |
| `delegated-auto` | Unattended signing inside a scope an operator wrote down. Delegate wallets only. |

Unset means `interactive` on testnet and `read-only` on mainnet: on mainnet a
wrong default costs real money, so writing there should be a decision someone
typed. `--policy <mode>` narrows for one invocation and can never widen —
`--policy read-only` on an unattended machine is a safety belt, the reverse is
an error.

Two independent things stand between a decision and a signature. `PolicyGate`
authorizes an intent and issues a **permit**; `TxExecutor` spends one per
signature and refuses a permit it did not issue or that has already been used, so
a write path that forgot to authorize refuses rather than quietly signs.

That holds for paths that go through `TxExecutor.execute()`, which is every one
this package exposes. It does **not** hold for a caller that reaches
`SignerProvider` directly: there is no permit check at the signer, and nothing
there to check one with. The gate makes an unauthorized signature impossible by
*mistake* — see [What none of this is](#what-none-of-this-is).

A permit is bound twice: to the **intent** at authorization, and to the
**transaction bytes** the gate itself obtained. The first stops a permit issued
for a cheap action funding an expensive one; the second stops any permit being
presented alongside bytes it did not cover.

Then, immediately before the signature, the transaction is **decoded and
checked against the intent it is presented for**. Provenance alone turned out to
be a regress: the gate was handed bytes, then a builder returning bytes, and each
time the caller still supplied the thing being vouched for. The way out is to
stop trusting the source and read the artifact.

```
openLong: the transaction calls withdrawal_queue::route_native,
account::request_withdraw, which moves funds or changes account authority.
That is not what this action was authorized to do.
```

**What this proves.** The transaction performs the operation it is presented as
and no *other action's* operation: it calls that action's defining entrypoint,
and calls no entrypoint any other action here defines. Auxiliary calls inside
the deployment's own packages are a separate matter — see [the trust
boundary](#the-backend-is-the-trust-boundary-for-auxiliary-composition). It is also sent from the address about to sign
it. That covers the case that matters most — a permit for a cheap action, which
clears every ceiling *because* it commits nothing, carrying a transaction that
opens a position or moves funds.

**Where the layouts come from.** Argument positions are read from
`@waterx/sdk`'s generated Move bindings — the same package that ships with the
deployment — and committed as `src/chain/abi.generated.ts`. `pnpm run
generate-abi` regenerates them, and a test re-runs the extraction so an SDK bump
that moves an argument fails CI rather than leaving the checks reading the old
slot. Bindings are keyed by the parameter's *name*, because positions are the
thing that moves.

Every argument the ABI declares is either bound to a field of the intent or
declared unconstrained **with a stated reason**; an argument that is neither is a
refusal. So is a call whose signature no longer matches the ABI, a type argument
that names a choice the intent did not make, and a permission grant over a
protocol slot this cannot identify.

**Where a value came from.** Some arguments are not values to compare but the
output of one specific call, and which one matters. `senderRequest` is the
authority handle: every checked call takes one, and every one takes it from
`account::request`. A handle produced elsewhere is a different authority, and
since a Move call's internals are not PTB commands, nothing else here would see
it. The same binding covers the pieces a withdrawal is assembled from — its
`extraData` **is** the route call's result, which is how the chosen route
reaches the contract at all.

What this does *not* reach is the auxiliary graph: oracle collection feeds the
protocol through shared state rather than through any argument of the defining
call, so "this price reached the right consumer" is not something these checks
establish.

**What else has to hold.** Every Move call must belong to a package the
deployment publishes, and to *that entrypoint's own* package — Sui keeps
upgraded packages callable forever, so a superseded version is refused too.
Commands are restricted to `MoveCall` and `MakeMoveVec`, and inputs to pure
values, shared objects and one funds withdrawal, which is all this deployment
ever builds. A transaction that cannot name an owned object cannot hand the
signer's coins to a call that rode along.

**Layouts are confirmed against the deployment, not just the SDK.**
`src/chain/abi-corpus.json` records, per entrypoint, the values a real
transaction carried at each position and the package it was called on. The
executor refuses to sign when a package in that record has since moved: nothing
in CI can notice a fixture going stale, so the check runs where the signature is
produced. Nineteen of twenty-three entrypoints are confirmed this way; `pnpm run
doctor` names the rest, whose layouts rest on the SDK alone. The remaining four
are WLP and staking calls that need conditions a capture cannot manufacture — a
pending redemption, an unstaked balance, claimable rewards — plus the bridged
withdrawal route this agent never takes. Nothing in the onboarding or perp
trading flow is among them, and `pnpm run check-corpus` re-asks the deployment
daily in CI.

**What it does not prove.** The derived position size, which the backend
computes from collateral and leverage — reproducing it here would be a second
implementation of the sizing rule, free to disagree with the first. Collateral,
leverage and the acceptable price are all bound, so a substituted size would have
to be wrong while its inputs were right.

### What none of this is

**These checks are not a boundary against a compromised process.** The policy
gate, the permit and the transaction check all run *inside* the agent, called by
`TxExecutor.execute()`. Code that is already executing here controls that call
site: it can skip every one of them and hand bytes straight to the signer. A
permit proves an authorization happened; it does not survive an attacker who can
issue one.

What they are worth is real but narrower:

- **bugs** — the agent building something other than what the caller asked for,
  which is the failure that actually happens;
- **a backend that returns the wrong OPERATION** — the operation a transaction
  is presented as is checked argument by argument against an intent formed
  locally before the request went out — every argument either bound to that
  intent, or listed as unconstrained with a reason — so a withdrawal cannot
  arrive dressed as an order. What this does *not* cover is everything the
  backend composes *around* that operation, the prices it will execute against,
  and the handful of arguments listed as unconstrained;
  [see below](#the-backend-is-the-trust-boundary-for-auxiliary-composition);
- **partial compromise reaching only the API layer** — a poisoned HTTP client, a
  dependency that can alter responses but not the signing path.

Two things do hold against code running here, and neither is in this repo: the
key itself, if it lives outside the process ([Signer boundary](#signer-boundary)),
and the delegate's on-chain permission mask. That mask is capability bits with
**no ceiling on size or notional**, so it bounds *what kind* of action is
possible and not *how large* — which is why the scope file below exists, and why
it is not a substitute for a narrower on-chain grant.

A third thing decides *where the key is*. See [Signer boundary](#signer-boundary).

### The backend is the trust boundary for auxiliary composition

This is a deliberate, stated limit, not an oversight — and it is worth being
exact about where it falls, because everything on one side of it is checked
closely — bar the fourteen arguments listed below as unconstrained — and
nothing on the other side is checked at all.

**Verified independently of the backend.** That the transaction performs the
operation it is presented as, and that it performs no *other* operation any
action here defines — a withdrawal cannot ride along inside an order. That every
shared object is the one the deployment names for *that role*, that every type
argument is the coin the deployment settles in, and that every value produced by
another call comes from the call — and the package — it is supposed to.

Every argument of that operation is either **bound** — to the intent, an object
role, a type or a producer, read at the position the deployed contract declares
for it — **or listed below as unconstrained, with the reason.** Those are not
the same claim, and the list is not short. It is the whole of it, checked
against the code by a test rather than written out here and left to drift:

<!-- FREE-ARGUMENTS:BEGIN — generated; `test/verify.test.ts` fails if it drifts -->

| Unconstrained argument | Why nothing here constrains it |
| --- | --- |
| `account::add_delegate.alias` | A label on the grant, carrying no authority |
| `custody_vault::mint.extraData` | An opaque routing blob the backend composes; the agent supplies none |
| `lp_pool::mint_wlp.minLpAmount` | A minimum-output bound the backend computes from live pool state; the agent names no figure for it and so has none to compare against |
| `removeAllDelegates (override) delegateAddress` | Which delegates exist is the account's state, not the intent's. The bound here is that every call is a removal — never identity, because the intent names no one. |
| `trading::cancel_order_request.orderTypeTag` | A locator the backend reads from live order state so the contract can find the order; the agent never chose it |
| `trading::cancel_order_request.triggerPrice` | A locator the backend reads from live order state so the contract can find the order; the agent never chose it |
| `trading::update_order_request.currentTriggerPrice` | A locator the backend reads from live order state so the contract can find the order; the agent never chose it |
| `trading::update_order_request.orderTypeTag` | A locator the backend reads from live order state so the contract can find the order; the agent never chose it |
| `waterx_staking::claim.request` | An authority handle, unobserved: no claim could be built to read how it is produced |
| `waterx_staking::claim.self` | The staking pool, unobserved: no claim could be built to read which object it takes |
| `withdrawal_queue::route_native.minOutput` | A floor on the amount received, computed by the backend from live bridge and pool state; the agent names no figure for it |
| `withdrawal_queue::route_wormhole.evmDestinationChain` | Unreachable: this agent only ever withdraws natively on Sui |
| `withdrawal_queue::route_wormhole.evmRecipient` | Unreachable: this agent only ever withdraws natively on Sui |
| `withdrawal_queue::route_wormhole.evmToken` | Unreachable: this agent only ever withdraws natively on Sui |

<!-- FREE-ARGUMENTS:END -->

**Two of these carry money.** `lp_pool::mint_wlp.minLpAmount` and
`withdrawal_queue::route_native.minOutput` are slippage *floors* — the least the
caller will accept. The backend picks them, the agent names no figure, so
nothing here stops either being zero and a mint or a withdrawal settling far
below what the caller expected. That is the auxiliary-composition boundary
showing up inside the operation itself, and it is the reason this list is
spelled out rather than summarized.

The rest cost nothing directly: four are locators the backend reads from live
order state, three are unreachable because this agent only withdraws natively,
two belong to `waterx_staking::claim` — refused by default anyway, its layout
never having been confirmed — one is a label carrying no authority, and one is
an address the intent deliberately does not name because *which* delegates exist
is the account's state, with removal-of-everything the bound instead.

A transaction whose OPERATION is not the one that was authorized does not get a
signature — which is a narrower statement than "does nothing it was not asked
to", and the paragraph below is why.

**Not verified — and this is wider than prices.** Inside the packages the
deployment publishes, the backend composes freely. A transaction may carry any
auxiliary call in those packages that no action claims as its own, take any
shared object the deployment document lists, and pass any arguments, types,
multiplicity or ordering to them; their effects on shared state are not modelled
at all. The price case is the consequence people will care about most — the
oracle legs write into shared state and the trading call reads it from there,
with no argument in the PTB joining them — but it is an instance, not the
boundary.

So the boundary, stated as widely as the code actually draws it: **the backend
is trusted to choose arbitrary auxiliary composition within admitted deployment
packages, over deployment-listed shared objects.** What it cannot do is reach
outside those packages, touch an object the deployment does not name, hand the
signer's own coins to anything, or alter the operation the transaction is
presented as.

**What that means concretely.** A backend that sources a wrong price produces a
transaction that passes every check here and fills at that price. The
acceptable-price bound does not save you: the agent computes it from a spot
reading taken from the same backend, so a consistently misreported price moves
the bound with it. If you need protection from that, it has to come from
somewhere other than this repo.

**What would close it.** A commitment naming the feeds a build used, signed by a
source that is not the composer, and bound to the final transaction digest and
the deployment revision — checkable here before signing. A backend signing its
own build would prove nothing, which is why this is not simply a matter of
adding a header. No such commitment exists today.

Until one does, running an agent here means accepting the deployment's backend
as the authority on price. That is the same trust every client of a
backend-composed protocol extends; the difference is that it is written down.

### Scopes, and why they are not optional here

`delegated-auto` requires `WATERX_POLICY_SCOPE_FILE` pointing at a document like
[`policy.example.json`](policy.example.json):

```jsonc
{
  "accounts": ["0x…"],            // required; "any account" is not a scope
  "markets": ["BTCUSD"],          // optional allowlist
  "sides": ["long"],              // optional
  "maxCollateralPerOrder": 50,    // required — display USD
  "maxCumulativeCollateral": 200, // required — summed over this process's life
  "maxLeverage": 5,               // required
  "maxSlippagePercent": 1,        // required
  "notAfter": "2026-12-31T00:00:00Z"  // required
}
```

Every ceiling is mandatory, and an incomplete scope is refused when it loads
rather than at the first trigger. That is stricter than it may look, for a
specific reason: **on chain a perp delegate's permissions are capability bits,
not amounts.** `PERM_OPEN_POSITION` says the delegate may open a position; it
says nothing about how large. Nothing on the perp side enforces a per-order or
per-hour ceiling server-side either. So this file is the only amount limit a
delegate has, and an optional ceiling in it would be an unbounded one.

Checks run locally, before any request, so an out-of-scope order costs nothing.
Actions that *reduce* exposure — close, reduce, add margin, cancel — are
deliberately never metered: a risk limit that trapped a position open would be
worse than none.

## Signer boundary

By default the key is read from `SUI_PRIVATE_KEY` into this process. That is the
honest default for a developer at a terminal, and the wrong one for anything
that signs while nobody is watching: an unattended process with a resident key
is one bug away from whatever that key can do.

Set `WATERX_SIGNER_COMMAND` and the key moves out. The agent writes one JSON
line to a child process and reads a signature back; it never holds key material:

```bash
WATERX_SIGNER_COMMAND='["waterx-predict-keystore","sign"]'
WATERX_AGENT_WALLET=0x…        # the address the child holds — stated, not derived
```

**What moving the key out does and does not buy.** It is key custody isolation,
and only that. `SIGNER_PROTOCOL` carries opaque bytes: the signer does not parse
the transaction, does not know what a WaterX intent is, and applies no policy of
its own. So a process that has been taken over cannot extract the key — but it
can still ask the child to sign whatever bytes it likes, by calling
`SignerProvider` directly and never going through `TxExecutor.execute()`.

Every authorization guarantee in this repo — the gate, the permit, the
transaction check — holds for code that goes through `execute()`, which is every
path this package exposes, and for no other. Closing that would mean running the
verifier and the policy **at the signer**, on the final bytes, which the current
protocol cannot express: it would have to carry the intent alongside the bytes
and the signer would have to understand WaterX semantics. That is a change to
`SIGNER_PROTOCOL`, not a setting here.

The wire is **`SIGNER_PROTOCOL` v1**, the same protocol the WaterX Predict agent
runtime speaks. It carries an address and opaque bytes and returns a signature —
nothing in it knows whether those bytes open a perp position or buy a prediction
share — so an existing provider serves this package **unmodified**. That is why
this repo copies the protocol descriptor (`src/chain/signer-protocol.ts`)
instead of merging into that workspace: the protocol is published as data
precisely so an outside implementation can speak it without depending on the
implementation.

The address is configured rather than derived, because deriving it would need
the key this arrangement exists to keep out. A conforming signer refuses a
request for an address it does not hold, naming the one it does:

```
signer: this signer holds 0xab0192d3…, not 0xb1428c76…
The signer exited with status 1; its output was not used.
```

`examples/keypair-signer.mjs` is the smallest provider that satisfies the wire —
enough to exercise the boundary, not a deployment. `pnpm run doctor` reports
which provider is in use, and warns when `delegated-auto` is signing from a key
held in this process.

Every child failure is a named refusal rather than a stray signature: a non-zero
exit, output that is not JSON, JSON with no signature, a signer that never
answers, a command that cannot be run. Timeouts default to 120s because a
conforming provider may be a person — a browser-wallet bridge blocks on a
dialog.

## Programmatic use

```typescript
import "dotenv/config";
import { WaterXAgent } from "waterx-agent";

const agent = new WaterXAgent();

// Reads need no policy.
const positions = await agent.positions();
const btc = await agent.read.ticker("BTCUSD");

// 5× long BTC with 10 USD, 0.5% slippage, bracketed.
await agent.openLong({
  ticker: "BTC",              // "BTC" and "BTCUSD" both resolve
  collateral: 10,             // display USD — scaling happens in units.ts
  leverage: 5,
  slippagePercent: 0.5,
  takeProfitPrice: 90_000,
  stopLossPrice: 70_000,
  confirm: true,
});

await agent.closePosition({ ticker: "BTC", positionId: 0, confirm: true });
```

Amounts are display units everywhere on this surface — USD for collateral and
prices, base-asset units for size. The conversion to raw `u64`/`u128` strings
happens once, in `src/units.ts`, which refuses precision it cannot represent
rather than rounding it away.

## Commands

Every command takes `--json` (one JSON document on stdout, nothing else) and
`--help`. Writes take `--yes` under the `interactive` policy — that is the
*human* shortcut; an automated caller goes through `preview` → `approve` →
`execute` instead, and never passes `--yes`.

**The agent path** — `bootstrap` · `next` · `preview` · `approve` · `execute` ·
`reconcile` · `approvals` · `limits`

`next` is where a guiding agent starts each turn: one read that says which of
six states applies, what to tell the person, and what to offer — in the order
the states have to be resolved, so a trade is never offered ahead of a
transaction still in flight. The precedence lives in `src/agent/guidance.ts`
and is tested, because it is a safety property rather than a presentation
choice.

**Setup** — `doctor` · `generate-wallet` · `fund-sui` · `create-account` ·
`deposit` · `withdraw` · `add-delegate` · `remove-delegate`

**Trading** — `open-long` · `open-short` · `close-position` · `reduce-position` ·
`increase-position` · `margin`

**Orders** — `place-order` · `place-tpsl` · `update-order` · `cancel-order`

**WLP** — `wlp -- --action mint|burn|cancel-burn|claim`

**Reads** — `balance` · `accounts` · `positions` · `orders` · `delegates` · `markets` ·
`ticker` · `candles` · `trades` · `funding` · `history` · `funds` · `pnl` ·
`wlp-info` · `info` · `market-data` · `referral`

```bash
pnpm run open-long -- --ticker BTC --collateral 10 --leverage 5 --tp 90000 --sl 70000 --yes
pnpm run place-order -- --ticker ETH --short --collateral 20 --leverage 3 --trigger-price 4200 --yes
pnpm run reduce-position -- --ticker BTC --position-id 0 --percent 50 --yes
pnpm run margin -- --ticker BTC --position-id 0 --amount 5 --yes
```

## Behaviour worth knowing before you trade

- **A crossing limit is rejected.** A long limit above market (or a short below)
  would fill immediately, and the contract aborts it as `ECrossingLimitOrder` at
  both placement and re-price. The agent refuses it first and says to send a
  market order instead. A limit exactly *at* market is allowed, on chain and here.
- **Withdrawal is owner-only.** After the delegate-phishing hardening, no
  permission mask opens a funds-out path. A delegate can trade the account and
  cannot drain it; `withdraw`, `deposit`, `add-delegate` and `remove-delegate`
  are refused at the API edge (`2018`) for a delegate-signed request.
- **Perp and WLP share ONE mask.** `account_data::WaterXPerp` carries the trading
  bits and `PERM_MINT_WLP` / `PERM_REDEEM_WLP` together — `trading::assert_protocol_perm`
  and `lp_pool::assert_wxa_protocol_perm` read the same slot. Predict and staking
  are separate masks; perp authority grants nothing on those.
- **The mask the API shows you is not the one the chain enforces for trading.**
  `GET /account/delegate` returns the legacy `request::TradingRequest<CREDIT>`
  mask, while `trading::assert_protocol_perm` reads
  `account_data::WaterXPerp`. `addDelegate` writes both today, so a delegate
  added through the current backend works — but one added earlier reads as fully
  authorised and still aborts `EUnauthorized`, surfacing as a generic
  `6002 Transaction would fail on-chain`. `pnpm run doctor` warns about this
  whenever a delegate key is loaded.
- **Deposit mints wxUSD credit** against a registered backing asset, so it names
  a Move coin type rather than transferring a fixed collateral coin. `pnpm run
  info` lists what the deployment accepts; `deposit` defaults to the first.
- **WLP mint stakes in the same step** and burn redeems from the staked balance,
  so there is no separate stake/unstake action. A burn is queued and settled by
  the withdrawal queue.
- **`estLiqPrice: 0` means "cannot estimate"**, never "no liquidation risk", and
  `priceStale: true` means every price-derived field beside it is stale too.
- **The market list is read from the deployment**, not compiled in. It has grown
  from 13 to 30 since this agent was last updated; hardcoding it is what went
  stale.
- **An order is a request, not a fill, and the gap is not bounded.** `open-long`
  returns once the request is on chain; the keeper's `match_orders` sweep fills
  it, and `match_orders` is keeper-only so nothing here can force it. Measured on
  testnet the wait ranged from ~2 to ~7 minutes for identical orders. Read
  `pnpm run positions` to see the fill — a market order sits in
  `pnpm run orders` with `triggerPrice: 0` until then. Anything long-running must
  reconcile rather than assume.
- **`/markets/:ticker/trades` can be far staler than the chain.** During
  verification it reported the last SUIUSD trade as 83 days old while orders
  were filling in under two minutes. Trust `positions` over the trades feed.

## The runner

The scripts above run once and exit. `pnpm run runner` is the long-lived form:
it drives queued intents, survives restarts, and retries — without ever
submitting the same intent twice.

```bash
pnpm run queue -- --kind open --ticker SUI --collateral 10 --leverage 2
pnpm run runner            # drives it; Ctrl-C finishes the pass in flight
pnpm run jobs -- --verbose # what it believes, and why
```

It requires `delegated-auto` and refuses to start otherwise — a runner under
`interactive` would recover, look healthy, and refuse every submission.

`delegated-auto` in turn requires a **delegate** key — established by comparing
the signer's address to the configured owner, not by the owner merely being set,
since pointing `WATERX_OWNER_ADDRESS` at your own address would otherwise satisfy
the check while leaving owner authority in an unattended process. Its safety
argument is that a delegate cannot withdraw or grant authority, and an owner key
has both. The gate refuses to construct otherwise, and refuses funds-out and delegate-management
intents under that mode regardless of which key is loaded — the on-chain
guarantee holds only while the key really is a delegate, and nothing in a scope
file can establish that.

`queue` writes to an inbox beside the store rather than to the store itself, so
work can be added while the runner is up. The store keeps one writer; adding work
does not need to be one. Each entry is removed only once its job is durably in
the ledger, and carries its inbox id so a crash in between is recognised as the
same intent rather than queued twice.

### At most once

A process can die between sending a transaction and learning what happened to
it. That window cannot be closed, only made recoverable, and the runner does it
by writing down the digest **before** the bytes leave:

```
crashed before the job was marked `submitting`  → nothing was sent
crashed after it, before the digest was written → nothing was signed; retry is safe
crashed after the digest                        → ask the chain about that digest
```

There is no fourth case, and none of them is resolved by a timer. On restart the
ambiguous jobs are reconciled **before** any new one is submitted.

Absence is treated asymmetrically, because that asymmetry is the whole safety
argument. A digest the chain *has* is conclusive at once. A digest it does not
have is conclusive only after a settle window — and a lookup that merely
*failed* is never conclusive, because reading a broken lookup as absence is what
licenses a retry of a transaction that executed.

The fill wait ends at a terminal order status or at a deadline, and the deadline
produces `unresolved` — a state that asks for a human — rather than a guess.

```
$ pnpm run jobs -- --verbose
submitted  bbbbbbbb  open long SUIUSD 10 @2x   attempts=2  DhEqCKMC…
    06:02:50Z  submitting  reconstructed crash state
    06:08:36Z  queued      the chain never saw it; retrying is safe
    06:08:45Z  submitting  attempt 2
    06:08:49Z  submitting  digest DhEqCKMCb5GnuQdD9BrkmFHDiDTJV37idVWLogxfihxz
    06:08:50Z  submitted   on chain as DhEqCKMCb5GnuQdD9BrkmFHDiDTJV37idVWLogxfihxz
```

One writer at a time is enforced with a lock file, not assumed: two runners over
one store would each believe they owned a job. A lock left by a dead process
names its pid and waits for a person — breaking it automatically is
indistinguishable from racing a live runner.

### Driving it from a strategy

The runner decides nothing. It makes decisions survive. A strategy is the other
half — it watches, decides, and hands the decision over as an intent:

```typescript
import { JobStore, Reconciler, Runner, WaterXAgent } from "waterx-agent";

const runner = new Runner({ agent, store, reconciler });
runner.assertCanRunUnattended();

while (running) {
  // Drive first. Work in flight outranks work being considered, and a decision
  // taken while an earlier one is unresolved is taken on an unknown position.
  await runner.tick();
  if (runner.pending().length === 0) await decide(runner);
  await sleep(30_000);
}
```

The split is what lets a strategy be rewritten, crash, or be replaced with no
risk to money already in flight. One thing stays the strategy's job: the runner
guarantees an intent is submitted at most once, but it cannot know that two
intents are the *same idea* — a condition that stays true for several ticks must
not queue several orders. `examples/strategy.ts` is a worked example.

### Deferred intents

"In five minutes, place a limit order" is a first-class intent:

```typescript
const now = Date.now();
runner.enqueue(
  { kind: "limit", ticker: "SUIUSD", side: "long", collateral: 10, leverage: 2,
    triggerPrice: 0.70 },
  { notBefore: now + 5 * 60_000, expiresAt: now + 60 * 60_000 },
);
```

```bash
pnpm run queue -- --kind limit --ticker SUI --collateral 10 --leverage 2 \
  --trigger-price 0.70 --after 300 --expires-in 3600
```

Two properties make this safe to leave running.

**The delay is measured from the decision, not from the last restart.** Both
instants are stored absolute, so a runner that dies and comes back at minute
four still fires at minute five — a relative countdown would start over and
"in five minutes" would quietly mean something else.

**A deferred intent must carry an expiry, and is refused without one.** The gap
between deciding and firing is exactly the window in which the reason for the
decision stops being true; an order that survives an outage and lands on a
market that has moved is a trade nobody asked for. The expiry bounds only the
*start* — a job already submitted is in flight and no expiry can undo it.

An expired job ends as `expired`, having done nothing.

### Intents, and what each one waits for

| Intent | Finishes when |
|---|---|
| `open`, `limit` | the order it created reaches a terminal status |
| `close`, `cancel` | the position or order it **named** is gone |
| `reduce`, `increase`, `add-margin`, `remove-margin`, `wlp-*` | the transaction lands |

The three rules exist because the three groups leave different traces, and
pretending otherwise reports success as failure. A cancel's digest appears in
neither history category, so waiting for an order status strands a successful
cancel until the deadline and then calls it `unresolved`. A keeper-executed
`reduce` fills under the *keeper's* digest, not ours, so the fill cannot be tied
back to the job at all — "the request is on chain" is the most this can honestly
attest, and it says exactly that.

`close` and `cancel` get a stronger rule only because the intent names the thing
that should disappear; that is what makes its absence evidence about *this* job.

### Refusals that repeating cannot fix

A retry ceiling protects against a loop, not against a wrong answer. When the
backend says `No claimable rewards`, or the agent refuses a crossing limit or a
position that is not there, the job fails **immediately** with that reason
instead of spending three attempts and reporting `gave up after 3 attempts` —
which would bury the actual cause under a retry count.

```
failed  4decfc94  refused: No claimable rewards (code 3006)
```

The classification is a small allow-list, not "anything that is not a network
error": mistaking a transient fault for a permanent one silently drops work, so
the default stays retry.

### Deciding the same thing twice

The runner submits an intent at most once. It cannot know that two intents are
the same *idea* — a condition true for ten passes produces ten distinct intents,
and all ten would be faithfully sent. A key says they are one decision:

```typescript
const job = runner.enqueue(intent, { key: "SUIUSD-dip-entry", cooldownMs: 60 * 60_000 });
if (job === undefined) return;   // already in play, or too soon
```

```bash
pnpm run queue -- --kind limit --ticker SUI --collateral 10 --leverage 2 \
  --trigger-price 0.70 --key sui-dip --cooldown 3600
```

Suppressed while a job with that key is unfinished, and for `cooldownMs` after
one settles. Two details are deliberate:

- **An `unresolved` job blocks its key regardless of the cooldown.** That job is
  an open question about money — its order may be live — and deciding again on
  top of an unknown outcome is precisely the duplicate this design exists to
  prevent. It blocks until a person settles it.
- **An `expired` job never blocks.** Nothing happened.

A key is about the *decision*. It cannot see that you already hold the position
the decision was meant to open — that check is separate, and both are needed. A
key alone lets you re-enter after the cooldown even though you are still in;
a position check alone lets you queue a second order while the first is in
flight but unfilled.

Keep no state in the strategy process. The job store survives a crash and
in-memory variables do not, so derive everything from chain and backend reads
each pass — otherwise a restart comes back holding a view of the world it has no
evidence for.

### Keeping it running

Supervision is the operating system's job, not this repo's, and building a
second one badly is worse than using the one that exists.
`examples/deploy/` has a launchd plist and a systemd unit; `cron` running
`pnpm run runner -- --once` works too, with the store's lock file preventing
overlap.

Restarting is safe by construction: the store survives, and anything ambiguous
is reconciled against the chain before a new submission goes out. Both units
send `SIGTERM` and wait, so the pass in flight finishes — abandoning one halfway
would manufacture, on every restart, exactly the ambiguity the ledger exists to
recover from.

## Layout

```
src/
├── config.ts        network, endpoints, policy mode and scope, signer wiring
├── policy.ts        the scope, the gate, and the permits it issues
├── units.ts         display ↔ raw scales (6 dp collateral, 1e9 price/size)
├── errors.ts        backend error codes worth branching on
├── doctor.ts        preflight
├── api/             http envelope · read plane · tx-build plane · wire types
├── chain/           signer providers · SIGNER_PROTOCOL · the executor
├── cli/             the outcome contract: statuses, exit codes, error mapping
├── agent/           WaterXAgent · plans · market guards · approval + submission ledgers
└── runner/          durable job store · reconciliation · the loop
```

A write is a **plan** before it is a transaction: `agent/plan.ts` holds the
intent the gate will authorize and a serializable description of the build call,
so the same value can be shown to a person, written to the approval ledger, read
back by a different process minutes later, and submitted — with the guarantee
that all four describe the same order. The preview a person reads is *derived
from* that intent rather than written beside it, so it cannot describe a
different one.

## Development

```bash
pnpm run typecheck
pnpm test
pnpm run smoke          # start every read command for real and check its envelope
pnpm run check-corpus   # is the ABI fixture still a description of the deployment?
```

`smoke` exists because the hermetic suite cannot catch a command that fails on
invocation: `balance` once shipped with a top-level initialisation error that
typechecked and passed every unit test, because nothing had ever run it. A
contract that promises "one JSON document on stdout" is a promise about a
process, and only starting the process tests it.

`check-corpus` needs the network and runs as its own CI job, daily. The suite
above does not: it is hermetic, and `test/setup.ts` clears every `WATERX_*` /
`SUI_*` variable before any file loads.

## Docs

- **[Integration guide](docs/integration.md)** — the request/sign/submit flow,
  the delegate model, error handling, and what changed from the SDK-composed
  design.
- **[SKILL.md](SKILL.md)** — the installable skill: the loop, the rules, and how
  to load it into Claude Code, Codex, an `AGENTS.md`, or any shell-tool runtime.
- **[AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md)** — the full agent contract:
  statuses, exit codes, the ambiguous case, and setting up limits.
- **[AGENT.md](AGENT.md)** — command reference for an AI agent driving the CLI.

## License

MIT
