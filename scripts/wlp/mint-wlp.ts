/**
 * Mint WLP tokens by depositing collateral into the liquidity pool.
 * Usage: npx tsx scripts/wlp/mint-wlp.ts --deposit-coin <objectId> [--collateral USDC]
 */
import { initSigner, parseArgs, fmtTx } from "../lib/init.ts";
import { mintWlp } from "../../src/agent/index.ts";
import type { CollateralAsset } from "../../src/agent/index.ts";

const signer = initSigner();
const args = parseArgs(
  {
    depositCoin: { required: true, desc: "Object ID of the coin to deposit" },
    collateral: { default: "USDC", desc: "Collateral type: USDC or USDSUI" },
  },
  "scripts/wlp/mint-wlp.ts",
);

console.log(`Minting WLP with coin ${args.depositCoin}...`);

const result = await mintWlp(signer, {
  depositCoin: args.depositCoin,
  collateral: args.collateral as CollateralAsset,
});

console.log(`WLP minted: ${fmtTx(result.digest)}`);
