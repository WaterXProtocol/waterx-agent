/**
 * Fetch Fear & Greed Index.
 * Usage: npx tsx scripts/query/fear-greed.ts [--days 7]
 */
import { initApiClient, parseArgs } from "../lib/init.ts";

const api = initApiClient();
const args = parseArgs(
  {
    days: { desc: "Historical days (omit for current, max 30)" },
  },
  "scripts/query/fear-greed.ts",
);

const result = await api.getFearGreed(args.days ? Number(args.days) : undefined);

if (Array.isArray(result)) {
  console.log(`\n=== Fear & Greed Index (${result.length} days) ===\n`);
  for (const entry of result) {
    console.log(`  ${entry.timestamp}  ${entry.value} (${entry.classification})`);
  }
} else {
  console.log("\n=== Fear & Greed Index ===\n");
  console.log(`  Value:          ${result.value}`);
  console.log(`  Classification: ${result.classification}`);
  console.log(`  Timestamp:      ${result.timestamp}`);
}
