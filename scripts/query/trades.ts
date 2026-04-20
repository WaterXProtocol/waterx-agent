/**
 * Fetch recent trades for a market.
 * Usage: npx tsx scripts/query/trades.ts --symbol BTC [--limit 20]
 */
import { initApiClient, parseArgs } from "../lib/init.ts";

const api = initApiClient();
const args = parseArgs(
  {
    symbol: { required: true, desc: "Market symbol" },
    limit: { default: "20", desc: "Number of trades (max 200)" },
  },
  "scripts/query/trades.ts",
);

const trades = await api.getRecentTrades(args.symbol, Number(args.limit));

console.log(`\n=== ${args.symbol} Recent Trades (${trades.length}) ===\n`);
for (const t of trades) {
  const time = new Date(t.timestamp).toISOString().replace("T", " ").slice(0, 19);
  const liq = t.isLiquidation ? " [LIQ]" : "";
  console.log(
    `  ${time}  ${t.side.padEnd(5)} $${t.price}  size=${t.size.toFixed(4)} ($${t.sizeUsd.toFixed(2)})${liq}`,
  );
}
