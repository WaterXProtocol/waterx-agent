/**
 * Fetch WLP APY and total fee stats.
 * Usage: npx tsx scripts/query/wlp-apy.ts [--period 7d]
 */
import { initApiClient, parseArgs } from "../lib/init.ts";
import type { WlpPeriod } from "../../src/agent/index.ts";

const api = initApiClient();
const args = parseArgs(
  {
    period: { default: "7d", desc: "Period: 1d, 7d, 30d, all" },
  },
  "scripts/query/wlp-apy.ts",
);

const [apy, fees] = await Promise.all([
  api.getWlpApy(args.period as WlpPeriod),
  api.getTotalFees(),
]);

console.log(`\n=== WLP APY (${args.period}) ===\n`);
console.log(`  Fee APY:       ${(apy.feeApy * 100).toFixed(2)}%`);
console.log(`  Incentive APY: ${(apy.incentiveApy * 100).toFixed(2)}%`);
console.log(`\n=== WLP Total Fees ===\n`);
console.log(`  Total:       $${fees.totalFees.toLocaleString()}`);
console.log(`  Trading:     $${fees.breakdown.tradingFee.toLocaleString()}`);
console.log(`  Borrow:      $${fees.breakdown.borrowFee.toLocaleString()}`);
console.log(`  Funding:     $${fees.breakdown.fundingFee.toLocaleString()}`);
console.log(`  Liquidation: $${fees.breakdown.liquidationFee.toLocaleString()}`);
