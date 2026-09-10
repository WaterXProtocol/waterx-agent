/**
 * Place a resting limit or stop order.
 *
 * A crossing limit — a long above market, a short below it — is rejected before
 * the request is sent; the contract aborts it as `ECrossingLimitOrder`.
 */
import { confirmed, initAgent, parseArgs, reportTx, run } from "../lib/cli.ts";

const args = parseArgs(
  {
    ticker: { desc: "Market, e.g. BTC", required: true },
    short: { desc: "Place a short (default is long)", flag: true },
    collateral: { desc: "Collateral in display USD", required: true },
    leverage: { desc: "Leverage multiplier (or pass --size)" },
    size: { desc: "Base-asset size — overrides --leverage" },
    triggerPrice: { desc: "Trigger price in USD", required: true },
    stop: { desc: "Stop order rather than limit", flag: true },
    reduceOnly: { desc: "Reduce-only", flag: true },
    linkedPositionId: { desc: "Attach to an existing position" },
    tp: { desc: "Take-profit trigger price" },
    sl: { desc: "Stop-loss trigger price" },
    yes: { desc: "Confirm this write", flag: true },
    policy: { desc: "Narrow the execution policy for this invocation" },
  },
  "place-order",
);

await run(async () => {
  const agent = initAgent();
  const result = await agent.placeLimitOrder({
    ticker: args.ticker ?? "",
    isLong: args.short !== "true",
    collateral: args.collateral ?? "0",
    ...(args.leverage !== undefined ? { leverage: Number(args.leverage) } : {}),
    ...(args.size !== undefined ? { size: args.size } : {}),
    triggerPrice: args.triggerPrice ?? "0",
    ...(args.stop === "true" ? { isStopOrder: true } : {}),
    ...(args.reduceOnly === "true" ? { reduceOnly: true } : {}),
    ...(args.linkedPositionId !== undefined
      ? { linkedPositionId: Number(args.linkedPositionId) }
      : {}),
    ...(args.tp !== undefined ? { takeProfitPrice: args.tp } : {}),
    ...(args.sl !== undefined ? { stopLossPrice: args.sl } : {}),
    confirm: confirmed(),
  });
  reportTx(agent, "place-order", result);
});
