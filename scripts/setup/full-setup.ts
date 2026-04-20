/**
 * WaterX Agent Full Bootstrap Script
 *
 * Run with: npm run setup
 *
 * This script:
 * 1. Generates a SUI wallet (or loads existing)
 * 2. Requests testnet SUI from the faucet
 * 3. Mints testnet USDC
 * 4. Creates a WaterX account
 * 5. Deposits USDC into the account
 */
import dotenv from "dotenv";
dotenv.config();

import {
  getOrCreateWallet,
  AgentSigner,
  getSuiBalance,
  getUsdcBalance,
  getOrCreateAccount,
  depositToAccount,
  getAccountBalances,
  printAccountSummary,
} from "../../src/agent/index.ts";

const USDC_DEPOSIT_AMOUNT = 50_000_000n; // 50 USDC

async function main() {
  console.log("=== WaterX Agent Setup ===\n");

  // 1. Wallet
  console.log("Step 1: Setting up wallet...");
  const { keypair, address, isNew } = getOrCreateWallet();
  if (isNew) {
    console.log(`  Generated new wallet: ${address}`);
  } else {
    console.log(`  Loaded existing wallet: ${address}`);
  }

  const signer = new AgentSigner(keypair, "TESTNET");

  // 2. Fund with SUI
  console.log("\nStep 2: Checking SUI balance...");
  let suiBal = await getSuiBalance(signer);
  if (suiBal < 100_000_000n) {
    // < 0.1 SUI
    throw new Error(
      `Insufficient SUI balance: ${Number(suiBal) / 1e9} SUI\n` +
      `Please transfer testnet SUI to: ${address}\n` +
      `Then re-run: npm run setup`,
    );
  } else {
    console.log(`  SUI balance OK: ${Number(suiBal) / 1e9} SUI`);
  }

  // 3. Check USDC
  console.log("\nStep 3: Checking USDC balance...");
  let usdcBal = await getUsdcBalance(signer);
  if (usdcBal < 10_000_000n) {
    // < 10 USDC
    throw new Error(
      `Insufficient USDC balance: ${Number(usdcBal) / 1e6} USDC\n` +
      `Please transfer testnet USDC to: ${address}\n` +
      `Then re-run: npm run setup`,
    );
  }
  console.log(`  USDC balance: ${Number(usdcBal) / 1e6} USDC`);

  // 4. Create WaterX account
  console.log("\nStep 4: Setting up WaterX account...");
  const { accountId, isNew: isNewAccount } = await getOrCreateAccount(signer);
  if (isNewAccount) {
    console.log(`  Created new WaterX account: ${accountId}`);
  } else {
    console.log(`  Using existing WaterX account: ${accountId}`);
  }

  // 5. Deposit USDC
  if (usdcBal >= USDC_DEPOSIT_AMOUNT) {
    console.log("\nStep 5: Depositing USDC to account...");
    const accBal = await getAccountBalances(signer, accountId);
    if (accBal.usdc < 10_000_000n) {
      // < 10 USDC in account
      try {
        const digest = await depositToAccount(
          signer,
          accountId,
          USDC_DEPOSIT_AMOUNT,
        );
        console.log(
          `  Deposited ${Number(USDC_DEPOSIT_AMOUNT) / 1e6} USDC: https://suiscan.xyz/testnet/tx/${digest}`,
        );
      } catch (e: any) {
        console.warn(`  Deposit failed: ${e.message}`);
      }
    } else {
      console.log(
        `  Account already has ${Number(accBal.usdc) / 1e6} USDC, skipping deposit.`,
      );
    }
  } else {
    console.log("\nStep 5: Skipping deposit (insufficient wallet USDC).");
  }

  // Summary
  await printAccountSummary(signer, accountId);

  console.log("Setup complete! You can now use scripts to trade.\n");
  console.log("Examples:");
  console.log("  npm run balances");
  console.log("  npm run open-long -- --base BTC --collateral 10 --leverage 5");
  console.log("  npm run positions -- --base BTC --price 65000");
}

main().catch((e) => {
  console.error("Setup failed:", e);
  process.exit(1);
});
