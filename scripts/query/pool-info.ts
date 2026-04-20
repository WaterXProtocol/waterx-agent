/**
 * Show WLP liquidity pool summary.
 * Usage: npx tsx scripts/query/pool-info.ts
 */
import { initSigner } from "../lib/init.ts";
import { getPoolInfo } from "../../src/agent/index.ts";

const signer = initSigner();

const pool = await getPoolInfo(signer);

console.log("=== WLP Pool Info ===\n");
console.log(JSON.stringify(pool, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
