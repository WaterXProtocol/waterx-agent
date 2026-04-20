/**
 * Decrease an existing position's size.
 * Usage: npx tsx scripts/trading/decrease-position.ts --base BTC --position-id 0 --size 1000000000
 */
import { initSigner, requireAccountId, parseArgs, fmtTx } from "../lib/init.ts";
import { decreasePosition } from "../../src/agent/index.ts";
import type { BaseAsset } from "../../src/agent/index.ts";

const signer = initSigner();
const accountId = requireAccountId();
const args = parseArgs(
  {
    base: { required: true, desc: "Market: BTC, ETH, SOL, SUI, etc." },
    positionId: { required: true, desc: "Position ID to decrease" },
    size: { required: true, desc: "Amount to reduce in 1e9-scaled units" },
  },
  "scripts/trading/decrease-position.ts",
);

console.log(`Decreasing position #${args.positionId} on ${args.base} by ${args.size}...`);

const result = await decreasePosition(signer, {
  accountId,
  positionId: Number(args.positionId),
  base: args.base as BaseAsset,
  size: BigInt(args.size),
});

console.log(`Position decreased: ${fmtTx(result.digest)}`);
