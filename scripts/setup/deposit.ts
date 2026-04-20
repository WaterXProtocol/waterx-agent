/**
 * Deposit collateral into a WaterX account.
 * Usage: npx tsx scripts/setup/deposit.ts --amount 50 [--collateral USDC]
 */
import { initSigner, requireAccountId, parseArgs, fmtUsdc, usdcToRaw, fmtTx } from "../lib/init.ts";
import { depositToAccount } from "../../src/agent/index.ts";

const signer = initSigner();
const accountId = requireAccountId();
const args = parseArgs(
  {
    amount: { required: true, desc: "Amount to deposit (human units, e.g. 50)" },
    collateral: { default: "USDC", desc: "Collateral type: USDC or USDSUI" },
  },
  "scripts/setup/deposit.ts",
);

const raw = usdcToRaw(args.amount); // Both USDC and USDSUI use 6 decimals
const collateral = args.collateral as "USDC" | "USDSUI";

console.log(`Depositing ${args.amount} ${collateral} to account ${accountId}...`);
const digest = await depositToAccount(signer, accountId, raw, collateral);
console.log(`Done: ${fmtTx(digest)}`);
