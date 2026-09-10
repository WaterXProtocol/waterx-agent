# waterx-agent

A trading agent for [WaterX](https://waterx.app) perpetual futures on Sui.

## Why backend-first

The agent never composes a programmable transaction block itself. It asks the
WaterX backend to **build** each transaction, then — before signing — **verifies
the returned bytes locally** against a policy: which Move calls are allowed, which
objects each command may name, how much collateral and leverage a scope permits,
and that a deposit's coin can be consumed by nothing but the deposit itself. Only
then does it sign the bytes locally and submit them.

The backend can build; it cannot make the agent sign something it did not intend.
That verification layer (`src/chain/verify.ts`) is the security boundary this
package exists for — a malicious or buggy build response is the threat model.

## Quick start

```bash
pnpm install
pnpm run doctor        # preflight — signs nothing, safe on any network
```

`doctor` checks that the backend's network matches yours, reports the deployment's
package versions and market list, and fails on a stale `WATERX_ACCOUNT_ID`. Run it
first, and whenever a command fails in a way that doesn't name its own fix.

## Layout

- **`src/`** — the library: API client (`src/api`), on-chain verify + execute
  (`src/chain`), the durable job runner (`src/runner`), policy scopes
  (`src/policy.ts`), and unit conversion (`src/units.ts`).
- **`scripts/`** — a CLI over the library: `setup/`, `trading/`, `orders/`,
  `query/`, `runner/`. Each is `pnpm run <name>` (see `package.json`).
- **`AGENT.md`** — the full command reference.
- **`docs/integration.md`** — the programmatic surface for embedding the agent.
- **`examples/`** — a keypair signer, a strategy sketch, and deploy units.

## Running unattended

`pnpm run runner` drives queued jobs to terminal states durably: it reconciles
each job against the chain (`landed` / `aborted` / never-landed) before advancing,
so a timed-out read or an aborted Move call never records a trade that didn't take
effect. Scopes and per-order limits are enforced before signing.

Writes need explicit confirmation; reads never sign. See **AGENT.md** for the
per-command details and the environment variables each expects.
