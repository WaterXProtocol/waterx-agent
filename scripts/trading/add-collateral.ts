/**
 * Add collateral (margin) to an existing position.
 * Usage: npx tsx scripts/trading/add-collateral.ts --base BTC --position-id 0 --amount 5
 */
import { initSigner, requireAccountId, parseArgs, usdcToRaw, fmtTx } from "../lib/init.ts";
import { addCollateral } from "../../src/agent/index.ts";
import type { BaseAsset } from "../../src/agent/index.ts";

const signer = initSigner();
const accountId = requireAccountId();
const args = parseArgs(
  {
    base: { required: true, desc: "Market: BTC, ETH, SOL, SUI, etc." },
    positionId: { required: true, desc: "Position ID" },
    amount: { required: true, desc: "Collateral to add in USDC" },
  },
  "scripts/trading/add-collateral.ts",
);

console.log(`Adding ${args.amount} USDC collateral to position #${args.positionId}...`);

const result = await addCollateral(signer, {
  accountId,
  positionId: Number(args.positionId),
  base: args.base as BaseAsset,
  collateralAmount: usdcToRaw(args.amount),
});

console.log(`Collateral added: ${fmtTx(result.digest)}`);
