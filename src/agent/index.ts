// Wallet management
export {
  generateWallet,
  loadWallet,
  getOrCreateWallet,
  saveToEnv,
  type WalletInfo,
} from "./wallet.ts";

// Signer (client + keypair)
export { AgentSigner, type TxResult } from "./signer.ts";

// Testnet funding
export {
  requestTestnetSui,
  mintTestnetUsdc,
  getSuiBalance,
  getUsdcBalance,
} from "./faucet.ts";

// Account setup
export {
  createWaterXAccount,
  getOrCreateAccount,
  depositToAccount,
} from "./setup.ts";

// Trading
export {
  openLong,
  openShort,
  openPosition,
  closePosition,
  increasePosition,
  decreasePosition,
  addCollateral,
  removeCollateral,
  placeOrder,
  placeTakeProfit,
  placeStopLoss,
  cancelOrder,
  mintWlp,
  redeemWlp,
  stakeRewards,
  unstakeRewards,
  claimRewards,
  type OpenPositionParams,
  type PlaceOrderParams,
} from "./trading.ts";

// Account queries
export {
  getAccounts,
  getAccountBalances,
  getAccountCoinObjects,
  getPositions,
  getOrders,
  getAllOrders,
  getMarketInfo,
  getPoolInfo,
  getWalletBalance,
  getWalletUsdcBalance,
  printAccountSummary,
} from "./account.ts";

// Local helpers
export { FLOAT_SCALE, rawPrice } from "../helpers.ts";

// API client (REST backend integration)
export { WaterXApiClient, WaterXApiError } from "./api-client.ts";
export type {
  ApiResponse,
  ApiMarketInfo,
  ApiMarketParams,
  TickerData,
  TickerFunding,
  CandleBar,
  CandleTimeframe,
  RecentTrade,
  FundingRecord,
  HistoryEntry,
  HistoryResponse,
  PnlSummary,
  AccountChartPoint,
  ChartPeriod,
  NavPoint,
  WlpPeriod,
  WlpStakedBalance,
  WlpStakedRewards,
  WlpFeeEarned,
  WlpPerpVolume,
  WlpApy,
  WlpFeeStats,
  WlpUtilization,
  CoinPrices,
  FearGreedIndex,
  ReferralCodeResponse,
  ReferrerResponse,
  RefereesResponse,
  ReferralStatsResponse,
} from "./api-types.ts";

// Re-export commonly used SDK types for convenience
export type { BaseAsset, CollateralAsset } from "@waterx/perp-sdk";
export {
  TESTNET_TYPES,
  TESTNET_OBJECTS,
  TESTNET_PACKAGE_IDS,
  TESTNET_MARKETS,
  TESTNET_COLLATERALS,
  PERM_ALL,
  PERM_ALL_TRADING,
  ORDER_LIMIT_BUY,
  ORDER_LIMIT_SELL,
  ORDER_STOP_BUY,
  ORDER_STOP_SELL,
} from "@waterx/perp-sdk";
