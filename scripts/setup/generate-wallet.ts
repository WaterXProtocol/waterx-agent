/** Generate (or load) the agent's Ed25519 wallet, persisting the key to .env. */
import { getOrCreateWallet } from "../../src/chain/wallet.ts";
import { note, run, show } from "../lib/cli.ts";

await run(async () => {
  const wallet = getOrCreateWallet();
  note(wallet.isNew ? "Generated a new wallet:" : "Loaded the existing wallet:");
  note(`  address: ${wallet.address}`);
  if (wallet.isNew) note("  secret key saved to .env as SUI_PRIVATE_KEY");
  // The address only. The secret key is never part of any output this package
  // produces — not on stdout, not in the JSON envelope, not in a log line.
  show({ address: wallet.address, isNew: wallet.isNew });
  await Promise.resolve();
});
