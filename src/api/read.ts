/**
 * Read plane: every unauthenticated GET the agent needs.
 *
 * Routes are throttled but carry no auth guard, so no credential is involved.
 * Paths are the ones on backend `main`; several moved since this repo was last
 * updated (`/account/pnl` → `/account/pnl-summary`, `/account/balance-history`
 * → `/account/equity-history`) and the old names are gone rather than aliased.
 */
import type { HttpClient } from "./http.ts";
import type {
  AccountData,
  AppInfo,
  CandleTimeframe,
  WlpPeriod,
  DelegateData,
  HistoryResponse,
  MarketInfo,
  OrderResponse,
  Position,
  TickerData,
} from "./types.ts";

export class ReadApi {
  constructor(private readonly http: HttpClient) {}

  // ─── Markets ────────────────────────────────────────────────────────────

  /** Every ticker in the deployment, including `not_listed` ones. */
  markets(): Promise<MarketInfo[]> {
    return this.http.get<MarketInfo[]>("/markets");
  }

  /** Live tickers keyed by market ticker. */
  tickers(): Promise<Record<string, TickerData>> {
    return this.http.get<Record<string, TickerData>>("/markets/tickers");
  }

  ticker(ticker: string): Promise<TickerData> {
    return this.http.get<TickerData>(`/markets/${ticker}/ticker`);
  }

  /** Per-market on-chain parameters (leverage cap, fees, margin ratios). */
  marketParams(ticker: string): Promise<unknown> {
    return this.http.get<unknown>(`/markets/${ticker}/params`);
  }

  borrowRate(): Promise<unknown> {
    return this.http.get<unknown>("/markets/borrow-rate");
  }

  candles(
    ticker: string,
    options: { tf: CandleTimeframe; from?: number; to?: number; limit?: number },
  ): Promise<unknown[]> {
    return this.http.get<unknown[]>(`/markets/${ticker}/candles`, {
      tf: options.tf,
      from: options.from,
      to: options.to,
      limit: options.limit,
    });
  }

  trades(ticker: string, limit?: number): Promise<unknown[]> {
    return this.http.get<unknown[]>(`/markets/${ticker}/trades`, { limit });
  }

  /**
   * Funding *history*. There is no `funding-info` route — the live rate is a
   * field on the ticker (`TickerData.funding`).
   */
  fundingHistory(ticker: string, limit?: number): Promise<unknown[]> {
    return this.http.get<unknown[]>(`/markets/${ticker}/funding-history`, { limit });
  }

  // ─── Account ────────────────────────────────────────────────────────────

  accounts(owner: string): Promise<AccountData[]> {
    return this.http.get<AccountData[]>("/account", { owner });
  }

  delegates(accountId: string): Promise<DelegateData[]> {
    return this.http.get<DelegateData[]>("/account/delegate", { account: accountId });
  }

  overview(accountId: string): Promise<unknown> {
    return this.http.get<unknown>("/account/overview", { account: accountId });
  }

  /** Replaces the removed `/account/pnl`. */
  pnlSummary(accountId: string): Promise<unknown> {
    return this.http.get<unknown>("/account/pnl-summary", { account: accountId });
  }

  /**
   * Replaces the removed `/account/balance-history`, which plotted free margin
   * only — equity is the series a caller actually means.
   */
  equityHistory(accountId: string, period?: string): Promise<unknown[]> {
    return this.http.get<unknown[]>("/account/equity-history", { account: accountId, period });
  }

  pnlHistory(accountId: string, period?: string): Promise<unknown[]> {
    return this.http.get<unknown[]>("/account/pnl-history", { account: accountId, period });
  }

  history(options: {
    account: string;
    category?: "trade" | "order";
    cursor?: string;
    limit?: number;
  }): Promise<HistoryResponse> {
    return this.http.get<HistoryResponse>("/account/history", {
      account: options.account,
      category: options.category,
      cursor: options.cursor,
      limit: options.limit,
    });
  }

  /**
   * Deposit history. Keyed on the **owner wallet**, not the account id — funds
   * arrive at a wallet before an account exists to attribute them to.
   */
  deposits(
    suiOwner: string,
    options: { kind?: string; cursor?: string; limit?: number } = {},
  ): Promise<unknown> {
    return this.http.get<unknown>("/account/deposits", {
      suiOwner,
      kind: options.kind,
      cursor: options.cursor,
      limit: options.limit,
    });
  }

  /** Withdrawal history, keyed on the **sender wallet** for the same reason. */
  withdraws(
    sender: string,
    options: { kind?: string; cursor?: string; limit?: number } = {},
  ): Promise<unknown> {
    return this.http.get<unknown>("/account/withdraws", {
      sender,
      kind: options.kind,
      cursor: options.cursor,
      limit: options.limit,
    });
  }

  // ─── Positions & orders ─────────────────────────────────────────────────

  /** Open positions across every market, each with its linked TP/SL legs. */
  positions(accountId: string): Promise<Position[]> {
    return this.http.get<Position[]>("/position", { account: accountId });
  }

  /** Resting orders. Pass `owner` instead to fan out across an owner's accounts. */
  orders(query: { account?: string; owner?: string }): Promise<OrderResponse[]> {
    return this.http.get<OrderResponse[]>("/order", query);
  }

  // ─── WLP ────────────────────────────────────────────────────────────────

  wlpOverview(): Promise<unknown> {
    return this.http.get<unknown>("/wlp/overview");
  }

  /**
   * Required, not optional. The backend rejects these three routes outright
   * when `period` is absent — `{"code":3001,"message":"Invalid period"}` — so
   * an optional parameter here meant every default call failed.
   */
  wlpApy(period: WlpPeriod): Promise<unknown> {
    return this.http.get<unknown>("/wlp/apy", { period });
  }

  wlpNavHistory(period: WlpPeriod): Promise<unknown[]> {
    return this.http.get<unknown[]>("/wlp/nav-history", { period });
  }

  /** Keyed on the **account id** under `account`, not on a wallet. */
  wlpStakeInfo(accountId: string): Promise<unknown> {
    return this.http.get<unknown>("/wlp/stake-info", { account: accountId });
  }

  wlpWithdrawals(accountId: string): Promise<unknown[]> {
    return this.http.get<unknown[]>("/wlp/withdrawals", { account: accountId });
  }

  wlpPerpVolume(period: WlpPeriod): Promise<unknown> {
    return this.http.get<unknown>("/wlp/perp-volume", { period });
  }

  // ─── Market intelligence ────────────────────────────────────────────────

  /**
   * Comma-separated **symbols** — `BTC,ETH,SUI` — not CoinGecko ids. The route
   * used to take `coinIds` and a `bitcoin`-style id; it now rejects both.
   */
  coinPrices(symbols: string): Promise<unknown> {
    return this.http.get<unknown>("/market-data/prices", { symbols });
  }

  coin(symbol: string): Promise<unknown> {
    return this.http.get<unknown>(`/market-data/coins/${symbol}`);
  }

  trending(): Promise<unknown> {
    return this.http.get<unknown>("/market-data/trending");
  }

  marketOverview(limit?: number): Promise<unknown[]> {
    return this.http.get<unknown[]>("/market-data/market-overview", { limit });
  }

  fearGreed(days?: number): Promise<unknown> {
    return this.http.get<unknown>("/market-data/fear-greed", { days });
  }

  // ─── Referral ───────────────────────────────────────────────────────────

  // Keyed on the **owner wallet** under `owner`. These four took `user` until
  // the backend renamed it and began rejecting the old name outright.

  referralCodes(owner: string): Promise<unknown> {
    return this.http.get<unknown>("/referral/user-codes", { owner });
  }

  referrer(owner: string): Promise<unknown> {
    return this.http.get<unknown>("/referral/referrer", { owner });
  }

  referralStats(owner: string): Promise<unknown> {
    return this.http.get<unknown>("/referral/stats", { owner });
  }

  referralOverview(owner: string): Promise<unknown> {
    return this.http.get<unknown>("/referral/overview", { owner });
  }

  // ─── Service ────────────────────────────────────────────────────────────

  /**
   * The deployment's own metadata: network, collateral, the backing assets a
   * deposit may be made in, and the market list. Prefer this over any list
   * compiled into the agent.
   */
  info(): Promise<AppInfo> {
    return this.http.get<AppInfo>("/info");
  }

  health(): Promise<unknown> {
    return this.http.get<unknown>("/health");
  }
}
