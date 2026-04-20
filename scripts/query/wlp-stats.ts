/**
 * Fetch WLP pool summary, utilization, and volume.
 * Usage: npx tsx scripts/query/wlp-stats.ts [--user 0x...]
 */
import { initApiClient, initSigner, parseArgs } from "../lib/init.ts";

const api = initApiClient();
const args = parseArgs(
  {
    user: { desc: "Wallet address (defaults to signer address)" },
  },
  "scripts/query/wlp-stats.ts",
);

const user = args.user || initSigner().address;

const [utilization, volume, staked, rewards] = await Promise.all([
  api.getUtilization(),
  api.getTotalVolume(),
  api.getStakedBalance(user).catch(() => null),
  api.getStakedRewards(user).catch(() => null),
]);

console.log("\n=== WLP Stats ===\n");
console.log(`  Utilization:   ${(utilization.utilizationBps / 100).toFixed(2)}%`);
console.log(`  Total Volume:  $${volume.totalVolume.toLocaleString()}`);
if (staked) {
  console.log(`  Staked WLP:    ${staked.stakedAmount}`);
}
if (rewards) {
  console.log(`  Claimable:     ${rewards.claimableRewardAmount}`);
  console.log(`  Cumulative:    ${rewards.cumulativeRewardAmount}`);
}
