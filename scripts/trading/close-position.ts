/**
 * Close a position entirely.
 * Usage: npx tsx scripts/trading/close-position.ts --base BTC --position-id 0
 */
import { initSigner, requireAccountId, parseArgs, fmtTx } from "../lib/init.ts";
import { closePosition } from "../../src/agent/index.ts";
import type { BaseAsset } from "../../src/agent/index.ts";

const signer = initSigner();
const accountId = requireAccountId();
const args = parseArgs(
  {
    base: { required: true, desc: "Market: BTC, ETH, SOL, SUI, etc." },
    positionId: { required: true, desc: "Position ID to close" },
  },
  "scripts/trading/close-position.ts",
);

console.log(`Closing position #${args.positionId} on ${args.base}...`);

const result = await closePosition(signer, {
  accountId,
  positionId: Number(args.positionId),
  base: args.base as BaseAsset,
});

console.log(`Position closed: ${fmtTx(result.digest)}`);
