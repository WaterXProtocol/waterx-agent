/**
 * Show open orders. Use --base for a specific market, or omit for all markets.
 * Usage: npx tsx scripts/query/orders.ts [--base BTC]
 */
import { initSigner, requireAccountId, parseArgs, fmtPrice } from "../lib/init.ts";
import { getOrders, getAllOrders } from "../../src/agent/index.ts";
import type { BaseAsset } from "../../src/agent/index.ts";

const signer = initSigner();
const accountId = requireAccountId();
const args = parseArgs(
  {
    base: { desc: "Market filter (omit for all markets)" },
  },
  "scripts/query/orders.ts",
);

const orders = args.base
  ? await getOrders(signer, accountId, args.base as BaseAsset)
  : await getAllOrders(signer, accountId);

if (orders.length === 0) {
  console.log(args.base ? `No open orders on ${args.base}.` : "No open orders.");
} else {
  console.log(`=== Orders (${orders.length}) ===\n`);
  for (const o of orders) {
    console.log(`  #${o.orderId} ${o.isLong ? "LONG" : "SHORT"} trigger=${fmtPrice(o.triggerPrice)}`);
  }
}
