/** Add or remove margin on an open position (`--remove` to withdraw). */
import { confirmed, initAgent, parseArgs, reportTx, run } from "../lib/cli.ts";

const args = parseArgs(
  {
    ticker: { desc: "Market, e.g. BTC", required: true },
    positionId: { desc: "Position id", required: true },
    amount: { desc: "Margin amount in display USD", required: true },
    remove: { desc: "Withdraw margin instead of adding it", flag: true },
    yes: { desc: "Confirm this write", flag: true },
    policy: { desc: "Narrow the execution policy for this invocation" },
  },
  "margin",
);

await run(async () => {
  const agent = initAgent();
  const params = {
    ticker: args.ticker ?? "",
    positionId: Number(args.positionId),
    amount: args.amount ?? "0",
    confirm: confirmed(),
  };
  const removing = args.remove === "true";
  const result = removing ? await agent.removeMargin(params) : await agent.addMargin(params);
  reportTx(agent, removing ? "remove-margin" : "add-margin", result);
});
