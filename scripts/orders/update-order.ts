/**
 * Re-price and re-size a resting order.
 *
 * The order's current trigger and book are read from the live order — the
 * contract locates it by those, so a stale guess is not found rather than
 * corrected.
 */
import { confirmed, initAgent, parseArgs, reportTx, run } from "../lib/cli.ts";

const args = parseArgs(
  {
    ticker: { desc: "Market, e.g. BTC", required: true },
    orderId: { desc: "Order id (see `npm run orders`)", required: true },
    triggerPrice: { desc: "New trigger price in USD", required: true },
    size: { desc: "New base-asset size", required: true },
    yes: { desc: "Confirm this write", flag: true },
    policy: { desc: "Narrow the execution policy for this invocation" },
  },
  "update-order",
);

await run(async () => {
  const agent = initAgent();
  const result = await agent.updateOrder({
    ticker: args.ticker ?? "",
    orderId: Number(args.orderId),
    newTriggerPrice: args.triggerPrice ?? "0",
    newSize: args.size ?? "0",
    confirm: confirmed(),
  });
  reportTx(agent, "update-order", result);
});
