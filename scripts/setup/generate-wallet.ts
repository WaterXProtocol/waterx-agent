/** Generate (or load) the agent's Ed25519 wallet, persisting the key to .env. */
import dotenv from "dotenv";
dotenv.config();

import { getOrCreateWallet } from "../../src/chain/wallet.ts";
import { run } from "../lib/cli.ts";

await run(async () => {
  const wallet = getOrCreateWallet();
  console.log(wallet.isNew ? "Generated a new wallet:" : "Loaded the existing wallet:");
  console.log(`  address: ${wallet.address}`);
  if (wallet.isNew) console.log("  secret key saved to .env as SUI_PRIVATE_KEY");
  await Promise.resolve();
});
