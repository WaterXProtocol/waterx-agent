/**
 * Funding-rate history for a market.
 *
 * The *live* rate is a field on the ticker (`npm run ticker`); there is no
 * separate funding-info route.
 */
import { asNumber, initAgent, parseArgs, run, show } from "../lib/cli.ts";

const args = parseArgs(
  {
    ticker: { desc: "Market, e.g. BTC", required: true },
    limit: { desc: "Number of intervals", default: "48" },
  },
  "funding",
);

await run(async () => {
  const agent = initAgent();
  const ticker = await agent.markets.resolveTicker(args.ticker ?? "");
  show(await agent.read.fundingHistory(ticker, asNumber(args.limit)));
});
