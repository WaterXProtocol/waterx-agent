/**
 * Mint testnet mock USDC.
 * Usage: npx tsx scripts/setup/mint-usdc.ts [--amount 100]
 */
import { initSigner, parseArgs, fmtUsdc, usdcToRaw, fmtTx } from "../lib/init.ts";
import { mintTestnetUsdc, getUsdcBalance } from "../../src/agent/index.ts";

const signer = initSigner();
const args = parseArgs(
  {
    amount: { default: "100", desc: "Amount of USDC to mint (human units)" },
  },
  "scripts/setup/mint-usdc.ts",
);

const raw = usdcToRaw(args.amount);
console.log(`Minting ${args.amount} testnet USDC...`);

const digest = await mintTestnetUsdc(signer, raw);
console.log(`Minted: ${fmtTx(digest)}`);

const balance = await getUsdcBalance(signer);
console.log(`Wallet USDC balance: ${fmtUsdc(balance)}`);
