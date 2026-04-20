/**
 * Cancel an existing order.
 * Usage: npx tsx scripts/orders/cancel-order.ts --base BTC --order-id 0
 */
import { initSigner, requireAccountId, parseArgs, fmtTx } from "../lib/init.ts";
import { cancelOrder } from "../../src/agent/index.ts";
import type { BaseAsset } from "../../src/agent/index.ts";

const signer = initSigner();
const accountId = requireAccountId();
const args = parseArgs(
  {
    base: { required: true, desc: "Market: BTC, ETH, SOL, SUI, etc." },
    orderId: { required: true, desc: "Order ID to cancel" },
    orderType: { default: "255", desc: "0=limit_buy, 1=limit_sell, 2=stop_buy, 3=stop_sell, 255=wildcard" },
  },
  "scripts/orders/cancel-order.ts",
);

console.log(`Cancelling order #${args.orderId} on ${args.base}...`);

const result = await cancelOrder(signer, {
  accountId,
  base: args.base as BaseAsset,
  orderId: Number(args.orderId),
  orderTypeTag: Number(args.orderType),
});

console.log(`Order cancelled: ${fmtTx(result.digest)}`);
