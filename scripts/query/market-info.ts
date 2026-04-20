/**
 * Show market summary for a specific base asset.
 * Usage: npx tsx scripts/query/market-info.ts --base BTC
 */
import { initSigner, parseArgs } from "../lib/init.ts";
import { getMarketInfo } from "../../src/agent/index.ts";
import type { BaseAsset } from "../../src/agent/index.ts";

const signer = initSigner();
const args = parseArgs(
  {
    base: { required: true, desc: "Market: BTC, ETH, SOL, SUI, etc." },
  },
  "scripts/query/market-info.ts",
);

const info = await getMarketInfo(signer, args.base as BaseAsset);

console.log(`=== ${args.base} Market Info ===\n`);
console.log(JSON.stringify(info, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
