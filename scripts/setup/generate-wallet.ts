/**
 * Generate a new SUI wallet and save to .env.
 * Usage: npx tsx scripts/setup/generate-wallet.ts
 */
import dotenv from "dotenv";
dotenv.config();

import { getOrCreateWallet } from "../../src/agent/index.ts";

const { address, secretKey, isNew } = getOrCreateWallet();

if (isNew) {
  console.log("Generated new wallet:");
} else {
  console.log("Loaded existing wallet:");
}
console.log(`  Address:    ${address}`);
console.log(`  Secret key: ${secretKey.slice(0, 20)}...`);
