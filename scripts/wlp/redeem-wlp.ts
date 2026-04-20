/**
 * Request to redeem WLP tokens for collateral.
 * Usage: npx tsx scripts/wlp/redeem-wlp.ts --lp-coin <objectId> [--collateral USDC]
 */
import { initSigner, parseArgs, fmtTx } from "../lib/init.ts";
import { redeemWlp } from "../../src/agent/index.ts";
import type { CollateralAsset } from "../../src/agent/index.ts";

const signer = initSigner();
const args = parseArgs(
  {
    lpCoin: { required: true, desc: "Object ID of the WLP coin to redeem" },
    collateral: { default: "USDC", desc: "Collateral to receive: USDC or USDSUI" },
  },
  "scripts/wlp/redeem-wlp.ts",
);

console.log(`Redeeming WLP coin ${args.lpCoin}...`);

const result = await redeemWlp(signer, {
  lpCoin: args.lpCoin,
  collateral: args.collateral as CollateralAsset,
});

console.log(`Redeem requested: ${fmtTx(result.digest)}`);
