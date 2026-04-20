/**
 * Place a take-profit order linked to an existing position.
 * Usage: npx tsx scripts/orders/place-take-profit.ts --base BTC --position-id 0 --long --trigger-price 70000
 */
import { initSigner, requireAccountId, parseArgs, fmtTx } from "../lib/init.ts";
import { placeTakeProfit } from "../../src/agent/index.ts";
import type { BaseAsset } from "../../src/agent/index.ts";

const signer = initSigner();
const accountId = requireAccountId();
const args = parseArgs(
  {
    base: { required: true, desc: "Market: BTC, ETH, SOL, SUI, etc." },
    positionId: { required: true, desc: "Linked position ID" },
    long: { flag: true, desc: "Position is long" },
    short: { flag: true, desc: "Position is short" },
    triggerPrice: { required: true, desc: "TP trigger price in USD" },
    size: { desc: "TP size in 1e9 units (omit for full close)" },
    positionSize: { desc: "Current position size (required when size is omitted)" },
  },
  "scripts/orders/place-take-profit.ts",
);

const positionIsLong = args.long === "true" || args.short !== "true";

console.log(`Placing TP on position #${args.positionId} @ $${args.triggerPrice}...`);

const result = await placeTakeProfit(signer, {
  accountId,
  base: args.base as BaseAsset,
  positionIsLong,
  positionId: Number(args.positionId),
  triggerPrice: Number(args.triggerPrice),
  size: args.size ? BigInt(args.size) : undefined,
  positionSize: args.positionSize ? BigInt(args.positionSize) : undefined,
});

console.log(`Take-profit placed: ${fmtTx(result.digest)}`);
