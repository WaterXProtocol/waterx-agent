/** Candlestick history for a market. */
import { UsageError } from "../../src/errors.ts";
import { asNumber, initAgent, parseArgs, run, show } from "../lib/cli.ts";
import { CANDLE_TIMEFRAMES, type CandleTimeframe } from "../../src/api/types.ts";

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
      tf: timeframe(),
      limit: asNumber(args.limit) ?? 50,
    }),
  );
});

/** The timeframe, refused by name rather than cast into the union. */
function timeframe(): CandleTimeframe {
  const value = args.tf ?? "1h";
  if (!(CANDLE_TIMEFRAMES as readonly string[]).includes(value)) {
    throw new UsageError(
      `--tf "${value}" is not a timeframe. One of: ${CANDLE_TIMEFRAMES.join(", ")}.`,
    );
  }
  return value as CandleTimeframe;
}
