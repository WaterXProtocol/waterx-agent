/** Add an intent to the runner's queue. Writes to the store; signs nothing. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Inbox } from "../../src/runner/inbox.ts";
import type { Intent } from "../../src/runner/types.ts";
import { asNumber, initAgent, parseArgs, run } from "../lib/cli.ts";

const args = parseArgs(
  {
    kind: {
      desc: "open | limit | close | cancel | reduce | increase | add-margin | remove-margin | wlp-mint | wlp-burn | wlp-cancel-burn | wlp-claim",
      required: true,
    },
    ticker: { desc: "Market, e.g. BTC (not needed for wlp-*)" },
    short: { desc: "Open a short (default long)", flag: true },
    collateral: { desc: "Collateral in display USD (open)" },
    leverage: { desc: "Leverage multiplier (open)" },
    tp: { desc: "Take-profit trigger price (open, limit)" },
    sl: { desc: "Stop-loss trigger price (open, limit)" },
    triggerPrice: { desc: "Trigger price in USD (limit)" },
    stop: { desc: "Stop order rather than limit (limit)", flag: true },
    positionId: { desc: "Position id (close, reduce, increase, *-margin)" },
    percent: { desc: "Percent of the position to close (reduce)" },
    amount: { desc: "Amount in display units (*-margin, wlp-mint, wlp-burn)" },
    size: { desc: "Base-asset size (open, limit, reduce)" },
    requestId: { desc: "Redeem request id (wlp-cancel-burn)" },
    orderId: { desc: "Order id (cancel)" },
    slippage: { desc: "Slippage bound in percent", default: "0.5" },
    key: { desc: "Name the decision, so a repeat of it is suppressed" },
    cooldown: { desc: "Seconds after this key last finished before it may recur (needs --key)" },
    after: { desc: "Defer for this many seconds before submitting" },
    expiresIn: { desc: "Seconds until the intent must no longer be started (required with --after)" },
    store: { desc: "Path to the job store (the inbox sits beside it)", default: ".waterx/jobs.json" },
  },
  "runner-submit",
);

const WLP_KINDS = new Set(["wlp-mint", "wlp-burn", "wlp-cancel-burn", "wlp-claim"]);

await run(async () => {
  const agent = initAgent();
  // WLP acts on the pool, not on a market, so a ticker there would be noise
  // that resolveTicker would reject.
  const ticker = WLP_KINDS.has(args.kind ?? "")
    ? ""
    : await agent.markets.resolveTicker(requireTicker());
  const intent = buildIntent(ticker);

  // Written to the inbox, not the store: the runner holds the store's writer
  // lock for as long as it is up, and queueing work must not require stopping
  // it. The runner drains this on its next pass.
  const at = Date.now();
  const after = asNumber(args.after);
  const expiresIn = asNumber(args.expiresIn);
  // A cooldown with nothing to hang it on was accepted and then dropped at the
  // runner, so the caller believed a limit was in place that never existed.
  const cooldownSeconds = args.cooldown === undefined ? undefined : Number(args.cooldown);
  if (
    cooldownSeconds !== undefined &&
    (!Number.isFinite(cooldownSeconds) || cooldownSeconds <= 0)
  ) {
    throw new Error(
      `--cooldown ${String(args.cooldown)} is not a duration. Zero, negative and non-numeric ` +
        `cooldowns compare false against every elapsed time, so they would be accepted and hold ` +
        `nothing. Omit --cooldown if you want no hold.`,
    );
  }
  if (args.cooldown !== undefined && args.key === undefined) {
    throw new Error(
      "--cooldown needs --key. A cooldown is a property of a named decision; without one " +
        "there is nothing for it to apply to, and it would be silently ignored.",
    );
  }
  if (after !== undefined && expiresIn === undefined) {
    throw new Error(
      "A deferred intent needs --expires-in. Without one it fires whenever the runner next " +
        "comes up, however long that is, on whatever the market has become.",
    );
  }

  const inbox = new Inbox(inboxDir(args.store ?? ".waterx/jobs.json"));
  const id = inbox.submit({
    intent,
    ...(after !== undefined ? { notBefore: at + after * 1000 } : {}),
    ...(expiresIn !== undefined ? { expiresAt: at + expiresIn * 1000 } : {}),
    ...(args.key !== undefined ? { key: args.key } : {}),
    ...(cooldownSeconds !== undefined ? { cooldownMs: cooldownSeconds * 1000 } : {}),
  });

  console.log(`\nqueued ${id}`);
  if (after !== undefined) {
    console.log(`not before ${new Date(at + after * 1000).toISOString()}`);
    console.log(`expires    ${new Date(at + (expiresIn ?? 0) * 1000).toISOString()}`);
  }
  console.log(`The runner picks it up on its next pass (\`pnpm run runner\`).`);
});

/** The inbox sits beside the store it feeds. */
function inboxDir(storePath: string): string {
  return `${storePath.replace(/\.json$/, "")}.inbox`;
}

function buildIntent(ticker: string): Intent {
  const slippagePercent = asNumber(args.slippage) ?? 0.5;
  switch (args.kind) {
    case "open":
      if (args.collateral === undefined) throw new Error("open needs --collateral.");
      return {
        kind: "open",
        ticker,
        side: args.short === "true" ? "short" : "long",
        collateral: args.collateral,
        ...(args.leverage !== undefined ? { leverage: Number(args.leverage) } : {}),
        ...(args.tp !== undefined ? { takeProfitPrice: args.tp } : {}),
        ...(args.sl !== undefined ? { stopLossPrice: args.sl } : {}),
        slippagePercent,
      };
    case "limit":
      if (args.collateral === undefined) throw new Error("limit needs --collateral.");
      if (args.triggerPrice === undefined) throw new Error("limit needs --trigger-price.");
      return {
        kind: "limit",
        ticker,
        side: args.short === "true" ? "short" : "long",
        collateral: args.collateral,
        triggerPrice: args.triggerPrice,
        ...(args.leverage !== undefined ? { leverage: Number(args.leverage) } : {}),
        ...(args.stop === "true" ? { isStopOrder: true } : {}),
        ...(args.tp !== undefined ? { takeProfitPrice: args.tp } : {}),
        ...(args.sl !== undefined ? { stopLossPrice: args.sl } : {}),
      };
    case "close":
      if (args.positionId === undefined) throw new Error("close needs --position-id.");
      return { kind: "close", ticker, positionId: Number(args.positionId), slippagePercent };
    case "cancel":
      if (args.orderId === undefined) throw new Error("cancel needs --order-id.");
      return { kind: "cancel", ticker, orderId: Number(args.orderId) };
    case "reduce":
      if (args.size === undefined && args.percent === undefined) {
        throw new Error("reduce needs --size or --percent.");
      }
      return {
        kind: "reduce",
        ticker,
        positionId: requirePositionId(),
        ...(args.size !== undefined ? { size: args.size } : {}),
        ...(args.percent !== undefined ? { percent: Number(args.percent) } : {}),
        slippagePercent,
      };
    case "increase":
      if (args.collateral === undefined) throw new Error("increase needs --collateral.");
      return {
        kind: "increase",
        ticker,
        positionId: requirePositionId(),
        collateral: args.collateral,
        ...(args.leverage !== undefined ? { leverage: Number(args.leverage) } : {}),
        ...(args.size !== undefined ? { size: args.size } : {}),
        slippagePercent,
      };
    case "add-margin":
    case "remove-margin":
      return {
        kind: args.kind === "add-margin" ? "add-margin" : "remove-margin",
        ticker,
        positionId: requirePositionId(),
        amount: requireAmount(),
      };
    case "wlp-mint":
      return { kind: "wlp-mint", amount: requireAmount() };
    case "wlp-burn":
      return { kind: "wlp-burn", amount: requireAmount() };
    case "wlp-cancel-burn":
      if (args.requestId === undefined) throw new Error("wlp-cancel-burn needs --request-id.");
      return { kind: "wlp-cancel-burn", requestId: args.requestId };
    case "wlp-claim":
      return { kind: "wlp-claim" };
    default:
      throw new Error(
        `Unknown kind "${String(args.kind)}". Run with --help for the list.`,
      );
  }
}

function requireTicker(): string {
  if (args.ticker === undefined) throw new Error(`${String(args.kind)} needs --ticker.`);
  return args.ticker;
}

function requirePositionId(): number {
  if (args.positionId === undefined) throw new Error(`${String(args.kind)} needs --position-id.`);
  return Number(args.positionId);
}

function requireAmount(): string {
  if (args.amount === undefined) throw new Error(`${String(args.kind)} needs --amount.`);
  return args.amount;
}
