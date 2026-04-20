/**
 * Print full account summary (wallet + account balances, orders).
 * Usage: npx tsx scripts/query/summary.ts
 */
import { initSigner, requireAccountId } from "../lib/init.ts";
import { printAccountSummary } from "../../src/agent/index.ts";

const signer = initSigner();
const accountId = requireAccountId();

await printAccountSummary(signer, accountId);
