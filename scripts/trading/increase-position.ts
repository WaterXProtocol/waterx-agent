/** Add collateral and size to an open position. */
import { asNumber, confirmed, initAgent, parseArgs, reportTx, run } from "../lib/cli.ts";

const args = parseArgs(
  {
    ticker: { desc: "Market, e.g. BTC", required: true },
    positionId: { desc: "Position id", required: true },
    collateral: { desc: "Additional collateral in display USD", required: true },
    leverage: { desc: "Leverage to size the addition at (or pass --size)" },
    size: { desc: "Base-asset size to add — overrides --leverage" },
    slippage: { desc: "Slippage bound in percent", default: "0.5" },
    yes: { desc: "Confirm this write", flag: true },
    policy: { desc: "Narrow the execution policy for this invocation" },
  },
  "increase-position",
);

await run(async () => {
  const agent = initAgent();
  const result = await agent.increasePosition({
    ticker: args.ticker ?? "",
    positionId: Number(args.positionId),
    collateral: args.collateral ?? "0",
    ...(args.leverage !== undefined ? { leverage: Number(args.leverage) } : {}),
    ...(args.size !== undefined ? { size: args.size } : {}),
    slippagePercent: asNumber(args.slippage) ?? 0.5,
    confirm: confirmed(),
  });
  reportTx(agent, "increase-position", result);
});
