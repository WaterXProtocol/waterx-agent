/**
 * Claim accrued rewards from the reward distributor.
 * Usage: npx tsx scripts/wlp/claim-rewards.ts
 */
import { initSigner, fmtTx } from "../lib/init.ts";
import { claimRewards } from "../../src/agent/index.ts";

const signer = initSigner();

console.log("Claiming rewards...");

const result = await claimRewards(signer);

console.log(`Rewards claimed: ${fmtTx(result.digest)}`);
