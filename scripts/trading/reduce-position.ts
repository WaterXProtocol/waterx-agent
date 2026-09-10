/** Partially close a position, by base-asset `--size` or by `--percent`. */
import { asNumber, confirmed, initAgent, parseArgs, reportTx, run } from "../lib/cli.ts";

const args = parseArgs(
  {
    ticker: { desc: "Market, e.g. BTC", required: true },
    positionId: { desc: "Position id", required: true },
    size: { desc: "Base-asset size to close" },
    percent: { desc: "Percent of the position to close (0–100)" },
    slippage: { desc: "Slippage bound in percent", default: "0.5" },
    yes: { desc: "Confirm this write", flag: true },
    policy: { desc: "Narrow the execution policy for this invocation" },
  },
  "reduce-position",
);

await run(async () => {
  const agent = initAgent();
  const result = await agent.reducePosition({
    ticker: args.ticker ?? "",
    positionId: Number(args.positionId),
    ...(args.size !== undefined ? { size: args.size } : {}),
    ...(args.percent !== undefined ? { percent: Number(args.percent) } : {}),
    slippagePercent: asNumber(args.slippage) ?? 0.5,
    confirm: confirmed(),
  });
  reportTx(agent, "reduce-position", result);
});
