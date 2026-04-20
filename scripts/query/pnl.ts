/**
 * Fetch PnL summary for the current account.
 * Usage: npx tsx scripts/query/pnl.ts
 */
import { initApiClient, requireAccountId } from "../lib/init.ts";

const api = initApiClient();
const accountId = requireAccountId();

const pnl = await api.getPnlSummary(accountId);

console.log("\n=== PnL Summary ===\n");
console.log(`  Today:     $${pnl.today.toFixed(2)}`);
console.log(`  7 Day:     $${pnl.sevenDay.toFixed(2)}`);
console.log(`  30 Day:    $${pnl.thirtyDay.toFixed(2)}`);
console.log(`  All Time:  $${pnl.total.toFixed(2)}`);
