/**
 * Derive a write, show exactly what it does, and stop.
 *
 * The first of the three steps an automated caller is required to take —
 * `preview` → `approve` → `execute`. Nothing is authorized here, nothing is
 * built, and no key is loaded: this command runs to completion on a machine
 * with no `SUI_PRIVATE_KEY` at all.
 *
 * What it produces is a *plan*, written to the approval ledger. The plan holds
 * the exact intent the policy gate will authorize and the exact request the
 * backend will be asked to build, so the order a person reads here is the order
 * `execute` submits — not a re-derivation of it a minute later at a different
 * price. See `src/agent/approvals.ts` for why that distinction is the whole
 * point of the file.
 *
 * ## Nothing is defaulted
 *
 * `--slippage` has no default on this path, and an opening action must state
 * `--collateral` and exactly one of `--leverage` / `--size`. That is deliberate
 * and it is the code half of the rule in `SKILL.md`: an agent that does not
 * know the size, the leverage or the slippage has to stop and ask, and the only
 * way to make that true is to leave it nothing to fall back on. The direct
 * commands (`pnpm run open-long`) keep their human-friendly defaults.
 */
import { initAgent, note, parseArgs, run, setOutcome, show, demand, asNumber } from "../lib/cli.ts";
import { previewOf, type TradePlan } from "../../src/agent/plan.ts";
import { requestApproval } from "../../src/agent/approvals.ts";
import { UsageError } from "../../src/errors.ts";
import type { WaterXAgent } from "../../src/agent/agent.ts";

const ACTIONS = [
  "open-long",
  "open-short",
  "place-order",
  "close-position",
  "reduce-position",
  "increase-position",
  "add-margin",
  "remove-margin",
  "cancel-order",
  "create-account",
  "deposit",
  "withdraw",
  "add-delegate",
  "remove-delegate",
] as const;

const args = parseArgs(
  {
    action: { desc: `One of: ${ACTIONS.join(", ")}`, required: true },
    ticker: { desc: "Market, e.g. BTC or BTCUSD" },
    collateral: { desc: "Collateral in display USD" },
    leverage: { desc: "Leverage multiplier — or pass --size" },
    size: { desc: "Base-asset size, e.g. 0.15 — overrides --leverage" },
    slippage: { desc: "Slippage bound in percent. Required; there is no default here" },
    tp: { desc: "Take-profit trigger price in USD" },
    sl: { desc: "Stop-loss trigger price in USD" },
    triggerPrice: { desc: "Trigger price for a resting order" },
    stop: { desc: "Make the resting order a stop rather than a limit", flag: true },
    reduceOnly: { desc: "The resting order may only reduce exposure", flag: true },
    side: { desc: "long | short (place-order)" },
    positionId: { desc: "Position id" },
    orderId: { desc: "Order id" },
    percent: { desc: "Percent of the position to close (reduce-position)" },
    amount: { desc: "Amount in display units (margin, deposit, withdraw)" },
    assetType: { desc: "Backing-asset Move type (deposit, withdraw)" },
    toAddress: { desc: "Recipient (withdraw)" },
    name: { desc: "Account display name (create-account)" },
    referralCode: { desc: "Referral code (create-account)" },
    delegate: { desc: "Delegate address (add-delegate, remove-delegate)" },
    perpPermissions: { desc: "Perp permission bitmask (add-delegate)" },
    predictPermissions: { desc: "Predict permission bitmask (add-delegate)" },
    stakingPermissions: { desc: "Staking permission bitmask (add-delegate)" },
  },
  "preview",
);

await run(async () => {
  const agent = initAgent();
  const action = (args.action ?? "").trim();
  const plan = await planFor(agent, action);
  const preview = previewOf(plan);

  const request = requestApproval({
    action: plan.action,
    network: agent.config.network,
    apiUrl: agent.config.apiUrl,
    ...(agent.config.accountId === undefined ? {} : { accountId: agent.config.accountId }),
    plan,
    preview,
  });

  const approveCommand = `pnpm run approve -- --id ${request.id} --approver <who> --json`;
  const executeCommand = `pnpm run execute -- --id ${request.id} --json`;

  render(preview, agent, request.expiresAt);

  show({
    approvalId: request.id,
    action: plan.action,
    network: agent.config.network,
    executionPolicy: agent.config.executionPolicy,
    expiresAt: new Date(request.expiresAt).toISOString(),
    intentFingerprint: request.fingerprint,
    preview,
    // The exact intent the gate will authorize. Included so a reviewer can see
    // the raw values the chain receives, not only the display rendering of them.
    intent: plan.intent,
    approveCommand,
    executeCommand,
    // Nothing here has been authorized. `preview` never constructs the policy
    // gate — that needs the signer's address — so an out-of-scope order still
    // previews cleanly and is refused at `execute`.
    authorized: false,
  }, { rendered: true });

  setOutcome({
    status: "needs-approval",
    message:
      `${plan.action} previewed as ${request.id}; a person must approve it before it can be sent`,
    submitted: false,
    retryable: false,
    reconcileRequired: false,
    awaitingApproval: true,
    nextCommand: approveCommand,
  });
});

function render(preview: ReturnType<typeof previewOf>, agent: WaterXAgent, expiresAt: number): void {
  note("");
  note(`  action        ${preview.action}${preview.ticker === undefined ? "" : ` ${preview.ticker}`}`);
  if (preview.fill !== undefined) {
    note(`  direction     ${preview.fill.toUpperCase()}${preview.side === undefined ? "" : ` (${preview.side})`}`);
  }
  if (preview.sizeBase !== undefined) {
    note(
      `  quantity      ${preview.sizeBase}` +
        (preview.notionalUsd === undefined ? "" : `  ≈ $${preview.notionalUsd.toFixed(2)} notional`),
    );
  }
  if (preview.collateralUsd !== undefined) note(`  collateral    $${String(preview.collateralUsd)}`);
  if (preview.leverage !== undefined) note(`  leverage      ${preview.leverage.toFixed(2)}x`);
  if (preview.referencePrice !== undefined) note(`  ref price     ${String(preview.referencePrice)}`);
  if (preview.triggerPrice !== undefined) {
    note(`  rests at      ${String(preview.triggerPrice)}${preview.isStopOrder === true ? " (stop)" : " (limit)"}`);
  }
  if (preview.bound !== undefined) {
    // The line that matters most before approving: which end is capped, and at
    // what. "max" on a buy and "min" on a sell are the same protection.
    note(
      `  price bound   ${preview.bound.kind === "max" ? "pay at most" : "receive at least"} ` +
        `${String(preview.bound.price)}` +
        (preview.bound.slippagePercent === undefined
          ? ""
          : `  (${String(preview.bound.slippagePercent)}% slippage)`),
    );
  }
  for (const leg of preview.legs ?? []) {
    note(`  ${leg.kind.padEnd(13)} ${String(leg.triggerPrice)} (${leg.side}, reduce-only)`);
  }
  if (preview.amount !== undefined) note(`  amount        ${String(preview.amount)}`);
  if (preview.assetType !== undefined) note(`  asset         ${preview.assetType}`);
  if (preview.recipient !== undefined) note(`  recipient     ${preview.recipient}`);
  if (preview.delegate !== undefined) note(`  delegate      ${preview.delegate}`);
  if (preview.positionId !== undefined) note(`  position      #${String(preview.positionId)}`);
  if (preview.orderId !== undefined) note(`  order         #${String(preview.orderId)}`);
  if (preview.note !== undefined) note(`  note          ${preview.note}`);
  note(`  network       ${agent.config.network}  (policy: ${agent.config.executionPolicy})`);
  note(`  expires       ${new Date(expiresAt).toISOString()}`);
  if (agent.config.network === "mainnet") {
    note("");
    note("  ⚠ MAINNET — this spends real money.");
  }
  if (agent.config.executionPolicy === "read-only") {
    note("");
    note("  ⚠ The execution policy is read-only, so `execute` will refuse this.");
  }
  note("");
}

/**
 * One action name → one plan.
 *
 * Every branch calls the agent's own `plan*` method, so the derivation a
 * preview shows is literally the derivation the direct commands use. There is
 * no second implementation of sizing, of the acceptable-price bound, or of the
 * bracket legs — which is the only way "the preview matches the order" can be
 * a fact rather than a hope.
 */
function planFor(agent: WaterXAgent, action: string): Promise<TradePlan> {
  switch (action) {
    case "open-long":
    case "open-short":
      return agent.planOpenPosition({
        isLong: action === "open-long",
        ticker: demand(args.ticker, "--ticker", "which market to trade"),
        collateral: demand(args.collateral, "--collateral", "how much to commit, in USD"),
        ...sizing(),
        slippagePercent: Number(
          demand(args.slippage, "--slippage", "the worst fill you will accept, in percent"),
        ),
        ...(args.tp === undefined ? {} : { takeProfitPrice: args.tp }),
        ...(args.sl === undefined ? {} : { stopLossPrice: args.sl }),
      });

    case "place-order": {
      const side = demand(args.side, "--side", "long or short");
      if (side !== "long" && side !== "short") {
        throw new UsageError(`--side must be long or short (got "${side}").`);
      }
      return agent.planPlaceLimitOrder({
        ticker: demand(args.ticker, "--ticker", "which market to trade"),
        isLong: side === "long",
        collateral: demand(args.collateral, "--collateral", "how much to commit, in USD"),
        ...sizing(),
        triggerPrice: demand(args.triggerPrice, "--trigger-price", "where the order rests"),
        isStopOrder: args.stop === "true",
        reduceOnly: args.reduceOnly === "true",
      });
    }

    case "close-position":
      return agent.planClosePosition({
        ticker: demand(args.ticker, "--ticker", "which market the position is in"),
        positionId: Number(demand(args.positionId, "--position-id", "which position to close")),
        slippagePercent: Number(
          demand(args.slippage, "--slippage", "the worst fill you will accept, in percent"),
        ),
      });

    case "reduce-position":
      if (args.size === undefined && args.percent === undefined) {
        throw new UsageError("Pass --size or --percent: how much of the position to close.");
      }
      return agent.planReducePosition({
        ticker: demand(args.ticker, "--ticker", "which market the position is in"),
        positionId: Number(demand(args.positionId, "--position-id", "which position to reduce")),
        ...(args.size === undefined ? {} : { size: args.size }),
        ...(args.percent === undefined ? {} : { percent: Number(args.percent) }),
        slippagePercent: Number(
          demand(args.slippage, "--slippage", "the worst fill you will accept, in percent"),
        ),
      });

    case "increase-position":
      return agent.planIncreasePosition({
        ticker: demand(args.ticker, "--ticker", "which market the position is in"),
        positionId: Number(demand(args.positionId, "--position-id", "which position to increase")),
        collateral: demand(args.collateral, "--collateral", "how much more to commit, in USD"),
        ...sizing(),
        slippagePercent: Number(
          demand(args.slippage, "--slippage", "the worst fill you will accept, in percent"),
        ),
      });

    case "add-margin":
      return agent.planAddMargin({
        ticker: demand(args.ticker, "--ticker", "which market the position is in"),
        positionId: Number(demand(args.positionId, "--position-id", "which position")),
        amount: demand(args.amount, "--amount", "how much margin to add"),
      });

    case "remove-margin":
      return agent.planRemoveMargin({
        ticker: demand(args.ticker, "--ticker", "which market the position is in"),
        positionId: Number(demand(args.positionId, "--position-id", "which position")),
        amount: demand(args.amount, "--amount", "how much margin to withdraw"),
      });

    case "cancel-order":
      return agent.planCancelOrder({
        ticker: demand(args.ticker, "--ticker", "which market the order is in"),
        orderId: Number(demand(args.orderId, "--order-id", "which order to cancel")),
      });

    case "create-account":
      return agent.planCreateAccount({
        name: demand(args.name, "--name", "a display name for the account, max 32 characters"),
        ...(args.referralCode === undefined ? {} : { referralCode: args.referralCode }),
      });

    case "deposit":
      return withBackingAsset(agent, (assetType) =>
        agent.planDeposit({
          assetType,
          amount: demand(args.amount, "--amount", "how much to deposit"),
        }),
      );

    case "withdraw":
      return withBackingAsset(agent, (assetType) =>
        agent.planWithdraw({
          assetType,
          amount: demand(args.amount, "--amount", "how much to withdraw"),
          ...(args.toAddress === undefined ? {} : { toAddress: args.toAddress }),
        }),
      );

    case "add-delegate":
      return agent.planAddDelegate({
        delegate: demand(args.delegate, "--delegate", "the address being granted authority"),
        ...(asNumber(args.perpPermissions) === undefined
          ? {}
          : { perpPermissions: Number(args.perpPermissions) }),
        ...(asNumber(args.predictPermissions) === undefined
          ? {}
          : { predictPermissions: Number(args.predictPermissions) }),
        ...(asNumber(args.stakingPermissions) === undefined
          ? {}
          : { stakingPermissions: Number(args.stakingPermissions) }),
      });

    case "remove-delegate":
      return agent.planRemoveDelegate({
        delegate: demand(args.delegate, "--delegate", "the address whose authority is revoked"),
      });

    default:
      throw new UsageError(`Unknown --action "${action}". One of: ${ACTIONS.join(", ")}`);
  }
}

/**
 * `--size` or `--leverage`, and never neither.
 *
 * The position cannot be sized without one of them and there is no safe guess,
 * so this refuses rather than picking. It is the single most important place
 * the "stop and ask" rule is enforced: a default here would be an agent
 * choosing a trade size on the user's behalf.
 */
function sizing(): { size: string } | { leverage: number } {
  if (args.size !== undefined) return { size: args.size };
  if (args.leverage !== undefined) return { leverage: Number(args.leverage) };
  throw new UsageError(
    "Pass --leverage or --size: the position cannot be sized without one, and there is no " +
      "default worth guessing. Ask the user which they meant.",
  );
}

/** Resolve `--asset-type`, or the deployment's first registered backing asset. */
async function withBackingAsset(
  agent: WaterXAgent,
  make: (assetType: string) => Promise<TradePlan>,
): Promise<TradePlan> {
  if (args.assetType !== undefined) return make(args.assetType);
  const info = await agent.read.info();
  const first = info.backingAssets[0];
  if (first === undefined) {
    throw new UsageError("This deployment registers no backing assets; nothing can be moved.");
  }
  note(`Using backing asset ${first.symbol} (${first.coinType})`);
  return make(first.coinType);
}
