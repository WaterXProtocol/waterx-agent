/** Account PnL summary and equity curve. */
import { initAgent, parseArgs, run, show } from "../lib/cli.ts";

const args = parseArgs({ period: { desc: "Chart period, e.g. 1d 7d 30d" } }, "pnl");

await run(async () => {
  const agent = initAgent();
  const accountId = agent.accountId;
  show({
    summary: await agent.read.pnlSummary(accountId),
    equityHistory: await agent.read.equityHistory(accountId, args.period),
  });
});
