/** Attach take-profit and/or stop-loss to an open position. */
import { confirmed, initAgent, parseArgs, reportTx, run } from "../lib/cli.ts";

const args = parseArgs(
  {
    ticker: { desc: "Market, e.g. BTC", required: true },
    positionId: { desc: "Position id", required: true },
    tp: { desc: "Take-profit trigger price in USD" },
    sl: { desc: "Stop-loss trigger price in USD" },
    size: { desc: "Base-asset size (defaults to the whole position)" },
    yes: { desc: "Confirm this write", flag: true },
    policy: { desc: "Narrow the execution policy for this invocation" },
  },
  "place-tpsl",
);

await run(async () => {
  const agent = initAgent();
  const result = await agent.placeTpSl({
    ticker: args.ticker ?? "",
    positionId: Number(args.positionId),
    ...(args.tp !== undefined ? { takeProfitPrice: args.tp } : {}),
    ...(args.sl !== undefined ? { stopLossPrice: args.sl } : {}),
    ...(args.size !== undefined ? { size: args.size } : {}),
    confirm: confirmed(),
  });
  reportTx(agent, "place-tpsl", result);
});
