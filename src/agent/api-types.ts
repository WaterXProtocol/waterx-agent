// ─── API Envelope ────────────────────────────────────────────────────────────

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: number; message: string };
}

// ─── Market Data ─────────────────────────────────────────────────────────────

export interface ApiMarketInfo {
  symbol: string;
  baseAsset: string;
  pair: string;
  category: string;
  maxLeverage: number;
  status: "open" | "closed" | "coming_soon";
}

export interface ApiMarketParams {
  symbol: string;
  maxLeverage: number;
  feeRate: { open: number; close: number };
  minCollateral: number;
  maxPositionSize: number;
  maintenanceMarginRatio: number;
}

export interface TickerFunding {
  currentRate: number;
  annualizedRate: number;
  nextFundingTime: number;
  interval: string;
  cap: number | null;
  floor: number | null;
}

export interface TickerData {
  spotPrice: number;
  previousClose: number;
  change24h: number;
  changePercent24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  openInterest: { long: number; short: number; total: number };
  availableOi: { long: number; short: number };
  funding: TickerFunding;
  borrowRate: number;
  priceConfidence: number;
  timestamp: number;
  stale: boolean;
  statsStale: boolean;
}

export interface CandleBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface RecentTrade {
  id: string;
  price: number;
  size: number;
  sizeUsd: number;
  side: "long" | "short";
  timestamp: number;
  isLiquidation: boolean;
}

export interface FundingRecord {
  timestamp: number;
  fundingRate: number;
  annualizedRate: number;
  longOi: number;
  shortOi: number;
}

// ─── Account Analytics ───────────────────────────────────────────────────────

export interface HistoryEntry {
  id: string;
  action: string;
  symbol: string;
  market: string;
  side?: "long" | "short";
  orderType?: string;
  size?: number;
  sizeInAsset?: number;
  collateralChange?: number;
  price?: number;
  realizedPnL?: number;
  fee?: number;
  status?: string;
  timestamp: string;
  txDigest: string;
}

export interface HistoryResponse {
  items: HistoryEntry[];
  cursor: string | null;
  hasMore: boolean;
}

export interface PnlSummary {
  today: number;
  sevenDay: number;
  thirtyDay: number;
  total: number;
}

export interface AccountChartPoint {
  timestamp: number;
  value: number;
}

// ─── WLP Analytics ───────────────────────────────────────────────────────────

export interface NavPoint {
  timestamp: number;
  nav: number;
}

export interface WlpStakedBalance {
  stakedAmount: string;
}

export interface WlpStakedRewards {
  claimableRewardAmount: string;
  cumulativeRewardAmount: string;
  claimableRewardValue: string | null;
  cumulativeRewardValue: string | null;
}

export interface WlpFeeEarned {
  feeEarned: string;
  currentBalance: string;
  sharePriceNow: string;
  avgEntrySharePrice: string;
  unrealizedPnl: string;
  realizedPnl: string;
  asOfMs: number;
}

export interface WlpPerpVolume {
  totalVolume: number;
}

export interface WlpApy {
  feeApy: number;
  incentiveApy: number;
}

export interface WlpFeeStats {
  totalFees: number;
  breakdown: {
    tradingFee: number;
    borrowFee: number;
    fundingFee: number;
    liquidationFee: number;
  };
}

export interface WlpUtilization {
  utilizationBps: number;
}

// ─── Market Intelligence ─────────────────────────────────────────────────────

export type CoinPrices = Record<
  string,
  { usd: number; usd_24h_change?: number }
>;

export interface FearGreedIndex {
  value: number;
  classification: string;
  timestamp: string;
}

// ─── Referral ────────────────────────────────────────────────────────────────

export interface ReferralCodeResponse {
  codes: Array<{ code: string; createdAt: string; txDigest: string }>;
}

export interface ReferrerResponse {
  referrer: {
    address: string;
    code: string;
    boundAt: string;
    txDigest: string;
  } | null;
}

export interface RefereesResponse {
  referees: Array<{
    address: string;
    code: string;
    boundAt: string;
    txDigest: string;
  }>;
  total: number;
}

export interface ReferralStatsResponse {
  totalReferees: number;
  totalVolume: number;
  volumeByReferee: Array<{
    address: string;
    volume: number;
    tradeCount: number;
  }>;
}

// ─── Utility Types ───────────────────────────────────────────────────────────

export type CandleTimeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export type ChartPeriod = "1D" | "1W" | "1M" | "3M" | "6M" | "1Y";

export type WlpPeriod = "1d" | "7d" | "30d" | "all";
