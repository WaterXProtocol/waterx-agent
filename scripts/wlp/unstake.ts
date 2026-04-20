/**
 * Unstake tokens from the reward distributor.
 * Usage: npx tsx scripts/wlp/unstake.ts --amount 1000000
 */
import { initSigner, parseArgs, fmtTx } from "../lib/init.ts";
import { unstakeRewards } from "../../src/agent/index.ts";

const signer = initSigner();
const args = parseArgs(
  {
    amount: { required: true, desc: "Amount to unstake in raw units" },
  },
  "scripts/wlp/unstake.ts",
);

console.log(`Unstaking ${args.amount}...`);

const result = await unstakeRewards(signer, {
  withdrawalAmount: BigInt(args.amount),
});

console.log(`Unstaked: ${fmtTx(result.digest)}`);
