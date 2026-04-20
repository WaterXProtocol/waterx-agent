/**
 * Fetch coin prices from CoinGecko (proxied via backend).
 * Usage: npx tsx scripts/query/prices.ts --coins bitcoin,ethereum,sui
 */
import { initApiClient, parseArgs } from "../lib/init.ts";

const api = initApiClient();
const args = parseArgs(
  {
    coins: { required: true, desc: "CoinGecko IDs (comma-separated)" },
  },
  "scripts/query/prices.ts",
);

const prices = await api.getCoinPrices(args.coins);

console.log("\n=== Coin Prices ===\n");
for (const [id, data] of Object.entries(prices)) {
  const change =
    data.usd_24h_change !== undefined
      ? ` (${data.usd_24h_change >= 0 ? "+" : ""}${data.usd_24h_change.toFixed(2)}%)`
      : "";
  console.log(`  ${id}: $${data.usd.toLocaleString()}${change}`);
}
