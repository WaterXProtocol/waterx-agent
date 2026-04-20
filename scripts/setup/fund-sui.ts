/**
 * Request testnet SUI from the faucet.
 * Usage: npx tsx scripts/setup/fund-sui.ts
 */
import { initSigner } from "../lib/init.ts";
import { requestTestnetSui, getSuiBalance } from "../../src/agent/index.ts";
import { fmtSui } from "../lib/init.ts";

const signer = initSigner();

console.log(`Requesting testnet SUI for ${signer.address}...`);
await requestTestnetSui(signer.address);

// Wait for faucet tx to settle
await new Promise((r) => setTimeout(r, 3000));

const balance = await getSuiBalance(signer);
console.log(`Done. SUI balance: ${fmtSui(balance)}`);
