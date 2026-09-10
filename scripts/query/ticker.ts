/** Live ticker(s): price, 24h stats, open interest, funding. */
import { initAgent, parseArgs, run, show } from "../lib/cli.ts";

const args = parseArgs({ ticker: { desc: "Market, e.g. BTC (omit for all)" } }, "ticker");

await run(async () => {
  const agent = initAgent();
  if (args.ticker === undefined) {
    show(await agent.read.tickers());
    return;
  }
  const ticker = await agent.markets.resolveTicker(args.ticker);
  show(await agent.read.ticker(ticker));
});
