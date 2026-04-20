import type {
  ApiResponse,
  ApiMarketInfo,
  ApiMarketParams,
  TickerData,
  CandleBar,
  CandleTimeframe,
  RecentTrade,
  TickerFunding,
  FundingRecord,
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

export class WaterXApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "WaterXApiError";
  }
}

export class WaterXApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    const url = baseUrl ?? process.env.WATERX_API_URL;
    if (!url) {
      throw new Error(
        "WATERX_API_URL not set. Pass baseUrl to constructor or set WATERX_API_URL env var.",
      );
    }
    this.baseUrl = url.replace(/\/+$/, "");
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private async request<T>(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      let errorMsg = `HTTP ${res.status}`;
      let errorCode = res.status;
      try {
        const body = (await res.json()) as ApiResponse<unknown>;
        if (body.error) {
          errorMsg = body.error.message;
          errorCode = body.error.code;
        }
      } catch {
        /* ignore parse error */
      }
      throw new WaterXApiError(errorCode, errorMsg, res.status);
    }

    const body = (await res.json()) as ApiResponse<T>;
    if (!body.success || body.data === undefined) {
      throw new WaterXApiError(
        body.error?.code ?? 0,
        body.error?.message ?? "Unknown API error",
        res.status,
      );
    }
    return body.data;
  }

  // ─── Market Data ─────────────────────────────────────────────────────

  /** Get list of all markets with metadata and status. */
  async getMarkets(): Promise<ApiMarketInfo[]> {
    return this.request<ApiMarketInfo[]>("/markets");
  }

  /** Get tickers for all markets. */
  async getTickers(): Promise<Record<string, TickerData>> {
    return this.request<Record<string, TickerData>>("/markets/tickers");
  }

  /** Get ticker for a specific market symbol (e.g. "BTC"). */
  async getTicker(symbol: string): Promise<TickerData> {
    return this.request<TickerData>(`/markets/${symbol}/ticker`);
  }

  /** Get market parameters (leverage limits, fees, etc.). */
  async getMarketParams(symbol: string): Promise<ApiMarketParams> {
    return this.request<ApiMarketParams>(`/markets/${symbol}/params`);
  }

  /** Get available market config (on-chain base assets). */
  async getAvailableConfig(): Promise<ApiMarketInfo[]> {
    return this.request<ApiMarketInfo[]>("/markets/available-config");
  }

  /** Get candlestick data for a market. */
  async getCandles(
    symbol: string,
    opts: {
      tf: CandleTimeframe;
      from?: number;
      to?: number;
      limit?: number;
    },
  ): Promise<CandleBar[]> {
    return this.request<CandleBar[]>(`/markets/${symbol}/candles`, {
      tf: opts.tf,
      from: opts.from,
      to: opts.to,
      limit: opts.limit,
    });
  }

  /** Get recent trades for a market. */
  async getRecentTrades(
    symbol: string,
    limit?: number,
  ): Promise<RecentTrade[]> {
    return this.request<RecentTrade[]>(`/markets/${symbol}/trades`, { limit });
  }

  /** Get current funding rate info for a market. */
  async getFundingInfo(symbol: string): Promise<TickerFunding> {
    return this.request<TickerFunding>(`/markets/${symbol}/funding-info`);
  }

  /** Get funding rate history for a market. */
  async getFundingHistory(
    symbol: string,
    limit?: number,
  ): Promise<FundingRecord[]> {
    return this.request<FundingRecord[]>(
      `/markets/${symbol}/funding-history`,
      { limit },
    );
  }

  // ─── Account Analytics ───────────────────────────────────────────────

  /** Get trade/order history for an account. */
  async getHistory(opts: {
    user?: string;
    account?: string;
    cursor?: string;
    limit?: number;
    category?: "trade" | "order";
  }): Promise<HistoryResponse> {
    return this.request<HistoryResponse>("/account/history", {
      user: opts.user,
      account: opts.account,
      cursor: opts.cursor,
      limit: opts.limit,
      category: opts.category,
    });
  }

  /** Get PnL summary for an account. */
  async getPnlSummary(account: string): Promise<PnlSummary> {
    return this.request<PnlSummary>("/account/pnl", { account });
  }

  /** Get balance history chart data. */
  async getBalanceHistory(opts?: {
    account?: string;
    period?: ChartPeriod;
  }): Promise<AccountChartPoint[]> {
    return this.request<AccountChartPoint[]>("/account/balance-history", {
      account: opts?.account,
      period: opts?.period,
    });
  }

  /** Get PnL history chart data. */
  async getPnlHistory(opts?: {
    account?: string;
    period?: ChartPeriod;
  }): Promise<AccountChartPoint[]> {
    return this.request<AccountChartPoint[]>("/account/pnl-history", {
      account: opts?.account,
      period: opts?.period,
    });
  }

  // ─── WLP Analytics ───────────────────────────────────────────────────

  /** Get WLP NAV history. */
  async getNavHistory(period: WlpPeriod): Promise<NavPoint[]> {
    return this.request<NavPoint[]>("/wlp/nav-history", { period });
  }

  /** Get staked WLP balance for a user. */
  async getStakedBalance(user: string): Promise<WlpStakedBalance> {
    return this.request<WlpStakedBalance>("/wlp/staked", { user });
  }

  /** Get claimable staking rewards for a user. */
  async getStakedRewards(user: string): Promise<WlpStakedRewards> {
    return this.request<WlpStakedRewards>("/wlp/rewards", { user });
  }

  /** Get WLP fee earned for a user. */
  async getWlpFeeEarned(user: string): Promise<WlpFeeEarned> {
    return this.request<WlpFeeEarned>("/wlp/wlp-fee-earned", { user });
  }

  /** Get total perpetual trading volume. */
  async getTotalVolume(): Promise<WlpPerpVolume> {
    return this.request<WlpPerpVolume>("/wlp/total-volume");
  }

  /** Get WLP APY for a period. */
  async getWlpApy(period: WlpPeriod): Promise<WlpApy> {
    return this.request<WlpApy>("/wlp/apy", { period });
  }

  /** Get total WLP fees collected. */
  async getTotalFees(): Promise<WlpFeeStats> {
    return this.request<WlpFeeStats>("/wlp/total-fees");
  }

  /** Get WLP pool summary. */
  async getPoolSummary(): Promise<unknown> {
    return this.request<unknown>("/wlp/pool-summary");
  }

  /** Get token pool summaries. */
  async getTokenPoolSummaries(): Promise<unknown> {
    return this.request<unknown>("/wlp/token-pool-summaries");
  }

  /** Get WLP utilization rate. */
  async getUtilization(): Promise<WlpUtilization> {
    return this.request<WlpUtilization>("/wlp/utilization");
  }

  // ─── Market Intelligence ─────────────────────────────────────────────

  /** Get coin prices by CoinGecko ID (comma-separated). */
  async getCoinPrices(coinIds: string): Promise<CoinPrices> {
    return this.request<CoinPrices>("/market-data/prices", { coinIds });
  }

  /** Get trending coins. */
  async getTrending(): Promise<unknown> {
    return this.request<unknown>("/market-data/trending");
  }

  /** Get coin detail by CoinGecko ID. */
  async getCoinDetail(coinId: string): Promise<unknown> {
    return this.request<unknown>(`/market-data/coins/${coinId}`);
  }

  /** Get market overview (top coins by market cap). */
  async getMarketOverview(limit?: number): Promise<unknown> {
    return this.request<unknown>("/market-data/market-overview", { limit });
  }

  /** Get Fear & Greed Index (current or historical). */
  async getFearGreed(
    days?: number,
  ): Promise<FearGreedIndex | FearGreedIndex[]> {
    return this.request<FearGreedIndex | FearGreedIndex[]>(
      "/market-data/fear-greed",
      { days },
    );
  }

  // ─── Referral ────────────────────────────────────────────────────────

  /** Get user's referral codes. */
  async getUserReferralCodes(user: string): Promise<ReferralCodeResponse> {
    return this.request<ReferralCodeResponse>("/referral/user-codes", { user });
  }

  /** Get user's referrer. */
  async getReferrer(user: string): Promise<ReferrerResponse> {
    return this.request<ReferrerResponse>("/referral/referrer", { user });
  }

  /** Get user's referees. */
  async getReferees(user: string): Promise<RefereesResponse> {
    return this.request<RefereesResponse>("/referral/referees", { user });
  }

  /** Get referral stats. */
  async getReferralStats(user: string): Promise<ReferralStatsResponse> {
    return this.request<ReferralStatsResponse>("/referral/stats", { user });
  }

  /** Validate a referral code format. */
  async validateReferralCode(code: string): Promise<{ valid: boolean }> {
    return this.request<{ valid: boolean }>("/referral/validate", { code });
  }
}
