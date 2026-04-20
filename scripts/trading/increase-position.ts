/**
 * Increase an existing position's size.
 * Usage: npx tsx scripts/trading/increase-position.ts --base BTC --position-id 0 --collateral 5 [--leverage 5]
 */
import { initSigner, requireAccountId, parseArgs, usdcToRaw, fmtTx } from "../lib/init.ts";
import { increasePosition } from "../../src/agent/index.ts";
import type { BaseAsset } from "../../src/agent/index.ts";

const signer = initSigner();
const accountId = requireAccountId();
const args = parseArgs(
  {
    base: { required: true, desc: "Market: BTC, ETH, SOL, SUI, etc." },
    positionId: { required: true, desc: "Position ID to increase" },
    collateral: { required: true, desc: "Additional collateral in USDC" },
    leverage: { desc: "Leverage multiplier" },
  },
  "scripts/trading/increase-position.ts",
);

console.log(`Increasing position #${args.positionId} on ${args.base} by ${args.collateral} USDC...`);

const result = await increasePosition(signer, {
  accountId,
  positionId: Number(args.positionId),
  base: args.base as BaseAsset,
  collateralAmount: usdcToRaw(args.collateral),
  leverage: args.leverage ? Number(args.leverage) : undefined,
});

console.log(`Position increased: ${fmtTx(result.digest)}`);
