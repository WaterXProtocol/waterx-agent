/**
 * A strategy on top of the runner.
 *
 * The runner does not decide anything — it makes decisions survive. This file
 * is the other half: it watches the market, decides, and hands the decision
 * over as an intent. Keeping the two apart is what lets the strategy be
 * rewritten, crash, or be replaced without any risk to money already in flight.
 *
 * The rule the split enforces: **decide at most once per condition, then let
 * the runner own the outcome.** A strategy that submitted directly would have
 * to answer "did my last order go through?" itself, and answering that wrong is
 * how a dip gets bought twice.
 *
 * Two guards below look redundant and are not:
 *
 *  - the **key** stops the same decision being taken twice while it is in play
 *    or too soon after it settled. It is about the *decision*.
 *  - the **position check** stops a decision being taken when the world is
 *    already how it was meant to become. It is about the *world*.
 *
 * A key cannot see that a position exists; a position check cannot see that an
 * order is in flight but unfilled. Both are needed.
 *
 * There is also, deliberately, **no state in this process**. The job store
 * survives a crash and these variables do not, so everything is derived from
 * chain and backend reads each pass. A strategy that remembered things would
 * come back after a restart holding a view of the world it had no evidence for.
 *
 *   WATERX_EXECUTION_POLICY=delegated-auto \
 *   WATERX_POLICY_SCOPE_FILE=./policy.json \
 *   npx tsx examples/strategy.ts
 */
import "dotenv/config";

import {
  JobStore,
  Reconciler,
  Runner,
  WaterXAgent,
  HttpClient,
  ReadApi,
  TERMINAL_STATES,
} from "../src/index.ts";

const TICKER = "SUIUSD";
const BUY_BELOW = 0.75;
const COLLATERAL = 10;
const LEVERAGE = 2;
const TICK_MS = 30_000;

const agent = new WaterXAgent();
const store = new JobStore(".waterx/jobs.json");
store.open();

const runner = new Runner({
  agent,
  store,
  reconciler: new Reconciler(
    agent.config,
    new ReadApi(new HttpClient({ baseUrl: agent.config.apiUrl })),
  ),
});
runner.assertCanRunUnattended();

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => (stopping = true));
}

try {
  while (!stopping) {
    // Always drive first. Work already in flight outranks work being
    // considered — and a decision taken while an earlier one is unresolved is
    // a decision taken on an unknown position.
    await runner.tick();

    if (runner.pending().length > 0) {
      console.log(`holding off — ${String(runner.pending().length)} job(s) in flight`);
    } else {
      await decide();
    }

    for (let waited = 0; waited < TICK_MS && !stopping; waited += 500) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
} finally {
  store.close();
}

async function decide(): Promise<void> {
  const spot = await agent.markets.spotPrice(TICKER);
  const positions = await agent.positions();
  const holding = positions.some((p) => p.ticker === TICKER);

  if (holding || spot >= BUY_BELOW) {
    console.log(`no action  spot=${spot.toFixed(4)} holding=${String(holding)}`);
    return;
  }

  // Idempotence is the strategy's job, not the runner's. The runner guarantees
  // an intent is submitted at most once; it cannot know that two intents are
  // the *same idea*. Here the position check above is that guard — a condition
  // that stays true for several ticks must not queue several orders.
  console.log(`buying     spot=${spot.toFixed(4)} < ${String(BUY_BELOW)}`);
  const entry = runner.enqueue(
    {
      kind: "open",
      ticker: TICKER,
      side: "long",
      collateral: COLLATERAL,
      leverage: LEVERAGE,
      slippagePercent: 0.5,
      // The scope file bounds size, leverage and slippage independently, so a
      // strategy bug cannot exceed what an operator wrote down.
    },
    // The condition stays true for as long as the price does. Without the key
    // this would queue an order every pass; with it, the same decision is taken
    // once and not retaken for an hour after it settles.
    { key: `${TICKER}-dip-entry`, cooldownMs: 60 * 60_000 },
  );
  if (entry === undefined) return;

  // "…and in five minutes, ladder a limit order underneath it." A deferred
  // intent survives a restart — the delay is measured from this decision, not
  // from whenever the process next comes up — and must carry an expiry, so an
  // outage cannot resurrect it into a market that has moved on.
  const now = Date.now();
  runner.enqueue(
    {
      kind: "limit",
      ticker: TICKER,
      side: "long",
      collateral: COLLATERAL,
      leverage: LEVERAGE,
      triggerPrice: (spot * 0.95).toFixed(4),
    },
    {
      notBefore: now + 5 * 60_000,
      expiresAt: now + 60 * 60_000,
      // Its own key: the ladder belongs to this entry, and pairing it with the
      // entry's key would let one suppress the other.
      key: `${TICKER}-dip-ladder`,
      cooldownMs: 60 * 60_000,
    },
  );
}

/** Terminal states are re-exported so a caller can report without re-deriving the set. */
void TERMINAL_STATES;
