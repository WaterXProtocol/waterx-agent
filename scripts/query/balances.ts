/**
 * Show wallet and account balances.
 * Usage: npx tsx scripts/query/balances.ts
 */
import { initSigner, requireAccountId, fmtSui, fmtUsdc } from "../lib/init.ts";
import {
  getSuiBalance,
  getUsdcBalance,
  getAccountBalances,
} from "../../src/agent/index.ts";

const signer = initSigner();
const accountId = requireAccountId();

const [sui, usdc, accBal] = await Promise.all([
  getSuiBalance(signer),
  getUsdcBalance(signer),
  getAccountBalances(signer, accountId),
]);

console.log("=== Balances ===\n");
console.log("Wallet:");
console.log(`  SUI:  ${fmtSui(sui)}`);
console.log(`  USDC: ${fmtUsdc(usdc)}`);
console.log(`\nAccount (${accountId}):`);
console.log(`  USDC:   ${fmtUsdc(accBal.usdc)}`);
console.log(`  USDSUI: ${fmtUsdc(accBal.usdsui)}`);
