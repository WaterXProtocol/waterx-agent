/**
 * Request gas from the public Sui testnet faucet.
 *
 * Gas only. Trading collateral comes from `npm run deposit` against a backing
 * asset — on testnet the credit faucet is whitelist-gated, so a fresh wallet
 * cannot mint its own (see the deposit script).
 */
import dotenv from "dotenv";
dotenv.config();

import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";

import { loadConfig } from "../../src/config.ts";
import { loadWallet } from "../../src/chain/wallet.ts";
import { run } from "../lib/cli.ts";

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
      console.log(`Requested testnet SUI for ${address}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rateLimited = message.includes("429") || message.toLowerCase().includes("rate");
      if (!rateLimited || attempt === 2) throw error;
      const waitMs = 5000 * 2 ** attempt;
      console.log(`Rate-limited; retrying in ${String(waitMs / 1000)}s…`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
});
