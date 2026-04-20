/**
 * Remove collateral (margin) from an existing position.
 * Usage: npx tsx scripts/trading/remove-collateral.ts --base BTC --position-id 0 --amount 2
 */
import { initSigner, requireAccountId, parseArgs, usdcToRaw, fmtTx } from "../lib/init.ts";
import { removeCollateral } from "../../src/agent/index.ts";
import type { BaseAsset } from "../../src/agent/index.ts";

const signer = initSigner();
const accountId = requireAccountId();
const args = parseArgs(
  {
    base: { required: true, desc: "Market: BTC, ETH, SOL, SUI, etc." },
    positionId: { required: true, desc: "Position ID" },
    amount: { required: true, desc: "Collateral to remove in USDC" },
  },
  "scripts/trading/remove-collateral.ts",
);

console.log(`Removing ${args.amount} USDC collateral from position #${args.positionId}...`);

const result = await removeCollateral(signer, {
  accountId,
  positionId: Number(args.positionId),
  base: args.base as BaseAsset,
  amount: usdcToRaw(args.amount),
});

console.log(`Collateral removed: ${fmtTx(result.digest)}`);
