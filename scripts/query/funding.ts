/**
 * Fetch funding rate info and history.
 * Usage: npx tsx scripts/query/funding.ts --symbol BTC [--history] [--limit 10]
 */
import { initApiClient, parseArgs } from "../lib/init.ts";

const api = initApiClient();
const args = parseArgs(
  {
    symbol: { required: true, desc: "Market symbol" },
    history: { flag: true, desc: "Show funding history instead of current" },
    limit: { default: "10", desc: "History entries (with --history)" },
  },
  "scripts/query/funding.ts",
);

if (args.history === "true") {
  const records = await api.getFundingHistory(args.symbol, Number(args.limit));
  console.log(`\n=== ${args.symbol} Funding History (${records.length}) ===\n`);
  for (const r of records) {
    const time = new Date(r.timestamp).toISOString().replace("T", " ").slice(0, 19);
    console.log(
      `  ${time}  rate=${(r.fundingRate * 100).toFixed(6)}%  ann=${(r.annualizedRate * 100).toFixed(2)}%`,
    );
  }
} else {
  const info = await api.getFundingInfo(args.symbol);
  console.log(`\n=== ${args.symbol} Funding Info ===\n`);
  console.log(`  Current Rate:    ${(info.currentRate * 100).toFixed(6)}%`);
  console.log(`  Annualized:      ${(info.annualizedRate * 100).toFixed(2)}%`);
  console.log(`  Interval:        ${info.interval}`);
  console.log(`  Next Settlement: ${new Date(info.nextFundingTime).toISOString()}`);
}
