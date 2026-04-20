/**
 * Place a limit or stop order.
 * Usage: npx tsx scripts/orders/place-order.ts --base BTC --long --collateral 10 --leverage 5 --trigger-price 60000 [--stop]
 */
import { initSigner, requireAccountId, parseArgs, usdcToRaw, fmtTx } from "../lib/init.ts";
import { placeOrder } from "../../src/agent/index.ts";
import type { BaseAsset } from "../../src/agent/index.ts";

const signer = initSigner();
const accountId = requireAccountId();
const args = parseArgs(
  {
    base: { required: true, desc: "Market: BTC, ETH, SOL, SUI, etc." },
    long: { flag: true, desc: "Long direction" },
    short: { flag: true, desc: "Short direction" },
    collateral: { required: true, desc: "Collateral amount in USDC" },
    leverage: { default: "1", desc: "Leverage multiplier" },
    triggerPrice: { required: true, desc: "Trigger price in USD" },
    stop: { flag: true, desc: "Make it a stop order (default: limit)" },
  },
  "scripts/orders/place-order.ts",
);

const isLong = args.long === "true" || args.short !== "true";
const isStop = args.stop === "true";
const orderType = isStop ? "STOP" : "LIMIT";
const direction = isLong ? "LONG" : "SHORT";

console.log(`Placing ${orderType} ${direction} on ${args.base} @ $${args.triggerPrice}...`);

const result = await placeOrder(signer, {
  accountId,
  base: args.base as BaseAsset,
  isLong,
  collateralAmount: usdcToRaw(args.collateral),
  leverage: Number(args.leverage),
  triggerPrice: Number(args.triggerPrice),
  isStopOrder: isStop,
});

console.log(`Order placed: ${fmtTx(result.digest)}`);
