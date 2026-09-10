/** Cancel a resting order. */
import { confirmed, initAgent, parseArgs, reportTx, run } from "../lib/cli.ts";

const args = parseArgs(
  {
    ticker: { desc: "Market, e.g. BTC", required: true },
    orderId: { desc: "Order id", required: true },
    yes: { desc: "Confirm this write", flag: true },
    policy: { desc: "Narrow the execution policy for this invocation" },
  },
  "cancel-order",
);

await run(async () => {
  const agent = initAgent();
  const result = await agent.cancelOrder({
    ticker: args.ticker ?? "",
    orderId: Number(args.orderId),
    confirm: confirmed(),
  });
  reportTx(agent, "cancel-order", result);
});
