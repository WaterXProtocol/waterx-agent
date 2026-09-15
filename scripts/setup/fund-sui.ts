/**
 * Request gas from the public Sui testnet faucet.
 *
 * Gas only. Trading collateral comes from `pnpm run deposit` against a backing
 * asset — on testnet the credit faucet is whitelist-gated, so a fresh wallet
 * cannot mint its own (see the deposit script).
 */
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";

import { loadConfig } from "../../src/config.ts";
import { loadWallet } from "../../src/chain/wallet.ts";
import { note, run, show } from "../lib/cli.ts";

await run(async () => {
  const config = loadConfig();
  if (config.network !== "testnet") {
    throw new Error(`There is no faucet on ${config.network}; fund the wallet yourself.`);
  }
  const { address } = loadWallet();

  // The faucet rate-limits per address; back off rather than failing the run.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await requestSuiFromFaucetV2({ host: getFaucetHost("testnet"), recipient: address });
      note(`Requested testnet SUI for ${address}`);
      // Gas only, and saying so here is the point: the next thing a new user
      // reaches for is collateral, which this faucet does not provide.
      show({ address, funded: "gas", note: "collateral is separate — see `deposit`" });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rateLimited = message.includes("429") || message.toLowerCase().includes("rate");
      if (!rateLimited || attempt === 2) throw error;
      const waitMs = 5000 * 2 ** attempt;
      note(`Rate-limited; retrying in ${String(waitMs / 1000)}s…`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
});
