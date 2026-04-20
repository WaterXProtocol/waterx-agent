/**
 * Fetch market tickers.
 * Usage: npx tsx scripts/query/tickers.ts [--symbol BTC]
 */
import { initApiClient, parseArgs } from "../lib/init.ts";

const api = initApiClient();
const args = parseArgs(
  {
    symbol: { desc: "Specific market symbol (omit for all)" },
  },
  "scripts/query/tickers.ts",
);

if (args.symbol) {
  const t = await api.getTicker(args.symbol);
  console.log(`\n=== ${args.symbol} Ticker ===\n`);
  console.log(`  Price:      $${t.spotPrice}`);
  console.log(`  24h Change: ${t.changePercent24h >= 0 ? "+" : ""}${t.changePercent24h.toFixed(2)}%`);
  console.log(`  High / Low: $${t.high24h} / $${t.low24h}`);
  console.log(`  Volume 24h: $${t.volume24h.toLocaleString()}`);
  console.log(`  OI Total:   ${t.openInterest.total.toFixed(2)} (L:${t.openInterest.long.toFixed(2)} S:${t.openInterest.short.toFixed(2)})`);
  console.log(`  Funding:    ${(t.funding.currentRate * 100).toFixed(4)}%`);
} else {
  const tickers = await api.getTickers();
  console.log("\n=== All Tickers ===\n");
  for (const [symbol, t] of Object.entries(tickers)) {
    const pct =
      t.changePercent24h >= 0
        ? `+${t.changePercent24h.toFixed(2)}`
        : t.changePercent24h.toFixed(2);
    console.log(
      `  ${symbol.padEnd(8)} $${String(t.spotPrice).padEnd(12)} ${pct}%  vol=$${t.volume24h.toLocaleString()}`,
    );
  }
}
