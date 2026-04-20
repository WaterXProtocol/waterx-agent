import {
  getAccountsByOwner,
  getAccountBalance,
  getAccountCoins,
  getAccountOrders,
  getAllAccountOrders,
  getAccountPositions,
  getMarketSummary,
  getPoolSummary,
  TESTNET_TYPES,
} from "@waterx/perp-sdk";
import type {
  BaseAsset,
  AccountData,
  PositionDataView,
  OrderDataView,
  MarketData,
  PoolData,
} from "@waterx/perp-sdk";
import type { AgentSigner } from "./signer.ts";

/**
 * Get all WaterX accounts owned by the signer's wallet.
 */
export async function getAccounts(
  signer: AgentSigner,
): Promise<AccountData[]> {
  return getAccountsByOwner(signer.client, signer.address);
}

/**
 * Get USDC and USDSUI balances inside a WaterX account.
 */
export async function getAccountBalances(
  signer: AgentSigner,
  accountId: string,
): Promise<{ usdc: bigint; usdsui: bigint }> {
  const [usdc, usdsui] = await Promise.all([
    getAccountBalance(signer.client, accountId, TESTNET_TYPES.USDC).catch(
      () => 0n,
    ),
    getAccountBalance(signer.client, accountId, TESTNET_TYPES.USDSUI).catch(
      () => 0n,
    ),
  ]);
  return { usdc, usdsui };
}

/**
 * Get all coins in a WaterX account (with object IDs for trading).
 */
export async function getAccountCoinObjects(
  signer: AgentSigner,
  accountId: string,
  coinType?: string,
) {
  return getAccountCoins(signer.client, accountId, coinType);
}

/**
 * Get open positions for a specific market.
 * Note: positions require a base price for PnL calculation.
 * Pass a rough USD price (e.g. 65000 for BTC).
 */
export async function getPositions(
  signer: AgentSigner,
  accountId: string,
  base: BaseAsset,
  basePriceUsd: number,
): Promise<PositionDataView[]> {
  return getAccountPositions(signer.client, base, accountId, basePriceUsd);
}

/**
 * Get open orders for a specific market.
 */
export async function getOrders(
  signer: AgentSigner,
  accountId: string,
  base: BaseAsset,
): Promise<OrderDataView[]> {
  return getAccountOrders(signer.client, base, accountId);
}

/**
 * Get all open orders across all markets for an account.
 */
export async function getAllOrders(
  signer: AgentSigner,
  accountId: string,
): Promise<OrderDataView[]> {
  return getAllAccountOrders(signer.client, accountId);
}

/**
 * Get market summary for a specific base asset.
 */
export async function getMarketInfo(
  signer: AgentSigner,
  base: BaseAsset,
): Promise<MarketData> {
  const entry = signer.client.getMarketEntry(base);
  return getMarketSummary(signer.client, entry.marketId, entry.baseType);
}

/**
 * Get WLP pool summary.
 */
export async function getPoolInfo(
  signer: AgentSigner,
): Promise<PoolData> {
  return getPoolSummary(signer.client);
}

/**
 * Get wallet balance for a specific coin type.
 * @param coinType - Full type string (default: SUI)
 */
export async function getWalletBalance(
  signer: AgentSigner,
  coinType: string = "0x2::sui::SUI",
): Promise<bigint> {
  const res = await signer.client.getBalance({
    owner: signer.address,
    coinType,
  });
  return BigInt(res.balance.coinBalance);
}

/**
 * Get wallet USDC balance (testnet mock USDC).
 */
export async function getWalletUsdcBalance(
  signer: AgentSigner,
): Promise<bigint> {
  return getWalletBalance(signer, TESTNET_TYPES.USDC);
}

/**
 * Print a summary of the agent's state (wallet + account balances, orders).
 */
export async function printAccountSummary(
  signer: AgentSigner,
  accountId: string,
): Promise<void> {
  const [suiBal, walletUsdc, accBal, orders] = await Promise.all([
    getWalletBalance(signer),
    getWalletUsdcBalance(signer),
    getAccountBalances(signer, accountId),
    getAllOrders(signer, accountId).catch(() => []),
  ]);

  console.log("\n=== Agent Account Summary ===");
  console.log(`Address:    ${signer.address}`);
  console.log(`Account ID: ${accountId}`);
  console.log(`\nWallet:`);
  console.log(`  SUI:  ${Number(suiBal) / 1e9} SUI`);
  console.log(`  USDC: ${Number(walletUsdc) / 1e6} USDC`);
  console.log(`\nAccount:`);
  console.log(`  USDC:   ${Number(accBal.usdc) / 1e6} USDC`);
  console.log(`  USDSUI: ${Number(accBal.usdsui) / 1e6} USDSUI`);
  console.log(`\nOrders: ${orders.length}`);
  for (const o of orders) {
    console.log(
      `  #${o.orderId} ${o.isLong ? "LONG" : "SHORT"} trigger=${Number(o.triggerPrice) / 1e9}`,
    );
  }
  console.log("=============================\n");
}
