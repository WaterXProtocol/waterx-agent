/** Close a position in full, bounded by `--slippage`. */
import { asNumber, confirmed, initAgent, parseArgs, reportTx, run } from "../lib/cli.ts";

const args = parseArgs(
  {
    ticker: { desc: "Market, e.g. BTC", required: true },
    positionId: { desc: "Position id (see `positions`)", required: true },
    slippage: { desc: "Slippage bound in percent", default: "0.5" },
    yes: { desc: "Confirm this write", flag: true },
    policy: { desc: "Narrow the execution policy for this invocation" },
  },
  "close-position",
);

await run(async () => {
  const agent = initAgent();
  const result = await agent.closePosition({
    ticker: args.ticker ?? "",
    positionId: Number(args.positionId),
    slippagePercent: asNumber(args.slippage) ?? 0.5,
    confirm: confirmed(),
  });
  reportTx(agent, "close-position", result);
});
