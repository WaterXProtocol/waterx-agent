/**
 * Stake WLP tokens in the reward distributor.
 * Usage: npx tsx scripts/wlp/stake.ts --stake-coin <objectId>
 */
import { initSigner, parseArgs, fmtTx } from "../lib/init.ts";
import { stakeRewards } from "../../src/agent/index.ts";

const signer = initSigner();
const args = parseArgs(
  {
    stakeCoin: { required: true, desc: "Object ID of the WLP coin to stake" },
  },
  "scripts/wlp/stake.ts",
);

console.log(`Staking WLP coin ${args.stakeCoin}...`);

const result = await stakeRewards(signer, {
  stakeCoin: args.stakeCoin,
});

console.log(`Staked: ${fmtTx(result.digest)}`);
