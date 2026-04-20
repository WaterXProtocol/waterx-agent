/**
 * Create a WaterX trading account (or find existing).
 * Usage: npx tsx scripts/setup/create-account.ts
 */
import { initSigner } from "../lib/init.ts";
import { getOrCreateAccount } from "../../src/agent/index.ts";

const signer = initSigner();

console.log("Looking for existing WaterX account...");
const { accountId, isNew } = await getOrCreateAccount(signer);

if (isNew) {
  console.log(`Created new account: ${accountId}`);
} else {
  console.log(`Found existing account: ${accountId}`);
}
console.log("Account ID saved to .env (WATERX_ACCOUNT_ID).");
