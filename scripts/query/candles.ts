/**
 * Fetch candlestick data for a market.
 * Usage: npx tsx scripts/query/candles.ts --symbol BTC --tf 1h [--limit 20]
 */
import { initApiClient, parseArgs } from "../lib/init.ts";
import type { CandleTimeframe } from "../../src/agent/index.ts";

const api = initApiClient();
const args = parseArgs(
  {
    symbol: { required: true, desc: "Market symbol: BTC, ETH, SOL, SUI, etc." },
    tf: { required: true, desc: "Timeframe: 1m, 5m, 15m, 1h, 4h, 1d" },
    limit: { default: "20", desc: "Number of candles (max 1500)" },
  },
  "scripts/query/candles.ts",
);

const candles = await api.getCandles(args.symbol, {
  tf: args.tf as CandleTimeframe,
  limit: Number(args.limit),
});

console.log(`\n=== ${args.symbol} ${args.tf} Candles (${candles.length}) ===\n`);

const show = candles.slice(-10);
for (const c of show) {
  const time = new Date(c.time * 1000).toISOString().replace("T", " ").slice(0, 19);
  console.log(
    `  ${time}  O=${c.open}  H=${c.high}  L=${c.low}  C=${c.close}  V=${c.volume.toFixed(2)}`,
  );
}
if (candles.length > 10) {
  console.log(`  ... (showing last 10 of ${candles.length})`);
}
