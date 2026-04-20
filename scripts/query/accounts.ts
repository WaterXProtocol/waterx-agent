/**
 * List all WaterX accounts owned by the wallet.
 * Usage: npx tsx scripts/query/accounts.ts
 */
import { initSigner } from "../lib/init.ts";
import { getAccounts } from "../../src/agent/index.ts";

const signer = initSigner();

const accounts = await getAccounts(signer);

if (accounts.length === 0) {
  console.log("No WaterX accounts found. Run `npm run create-account` first.");
} else {
  console.log(`Found ${accounts.length} account(s):\n`);
  for (const acc of accounts) {
    console.log(`  Address: ${acc.accountObjectAddress}`);
    console.log(`  Name:    ${acc.name ?? "(unnamed)"}`);
    console.log("");
  }
}
