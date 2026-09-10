/** Candlestick history for a market. */
import { asNumber, initAgent, parseArgs, run, show } from "../lib/cli.ts";
import type { CandleTimeframe } from "../../src/api/types.ts";

const args = parseArgs(
  {
    ticker: { desc: "Market, e.g. BTC", required: true },
    tf: { desc: "Timeframe: 1m 5m 15m 1h 4h 1d", default: "1h" },
    limit: { desc: "Number of bars", default: "50" },
  },
  "candles",
);

await run(async () => {
  const agent = initAgent();
  const ticker = await agent.markets.resolveTicker(args.ticker ?? "");
  show(
    await agent.read.candles(ticker, {
      tf: (args.tf ?? "1h") as CandleTimeframe,
      limit: asNumber(args.limit) ?? 50,
    }),
  );
});
