/** Recent trades on a market. */
import { asNumber, initAgent, parseArgs, run, show } from "../lib/cli.ts";

const args = parseArgs(
  {
    ticker: { desc: "Market, e.g. BTC", required: true },
    limit: { desc: "Number of trades", default: "50" },
  },
  "trades",
);

await run(async () => {
  const agent = initAgent();
  const ticker = await agent.markets.resolveTicker(args.ticker ?? "");
  show(await agent.read.trades(ticker, asNumber(args.limit)));
});
