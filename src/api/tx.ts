/**
 * Transaction-build plane: the backend composes the PTB, this agent signs it.
 *
 * Nothing here executes. Each call returns a `TxResponse` carrying base64
 * transaction bytes; `TxExecutor` turns that into a digest. Keeping the two
 * apart is the point of the design — the signing decision (and the execution
 * policy that gates it) stays in one place, separate from request shaping.
 *
 * Why the backend builds rather than this repo: a perp PTB has to refresh the
 * right oracle rules for the deployment it is aimed at, dedup those refreshes
 * per ticker, and respect the per-position reentrancy lock
 * (core/perp-ptb-composer.ts). That composition tracks oracle re-weightings and
 * package upgrades continuously. A second implementation here would be a second
 * thing to keep in step, and it would fail silently — an unrefreshed leg aborts
 * on chain as `EMissingPriceSource`, not as a type error.
 */
import type { HttpClient } from "./http.ts";
import type {
  AddDelegateBody,
  BurnWlpBody,
  CancelOrderBody,
  CancelWlpBurnBody,
  ClaimWlpRewardsBody,
  ClosePositionBody,
  CreateAccountBody,
  DepositBody,
  DepositMarginBody,
  IncreasePositionBody,
  MarketOrderBody,
  MintWlpBody,
  PlaceOrderBody,
  PlaceTpSlBody,
  ReducePositionBody,
  RemoveDelegateBody,
  TxBody,
  TxResponse,
  UpdateOrderBody,
  WithdrawBody,
  WithdrawMarginBody,
} from "./types.ts";

export class TxApi {
  constructor(private readonly http: HttpClient) {}

  // ─── Orders ─────────────────────────────────────────────────────────────

  /** Immediate fill at the oracle price, bounded by `acceptablePrice`. */
  marketOrder(body: MarketOrderBody): Promise<TxResponse> {
    return this.http.post<TxResponse>("/order/market", body);
  }

  /**
   * Resting limit or stop order.
   *
   * A **crossing** limit — a buy above market or a sell below it — is refused
   * on chain (`ECrossingLimitOrder`) at both placement and re-price. Send a
   * market order when immediate execution is what you want.
   */
  limitOrder(body: PlaceOrderBody): Promise<TxResponse> {
    return this.http.post<TxResponse>("/order/limit", body);
  }

  /** Attach TP and/or SL to an already-open position. */
  placeTpSl(body: PlaceTpSlBody): Promise<TxResponse> {
    return this.http.post<TxResponse>("/order/tpsl", body);
  }

  /** Re-price and re-size a resting order in one call. Subject to the crossing check. */
  updateOrder(ticker: string, orderId: number, body: UpdateOrderBody): Promise<TxResponse> {
    return this.http.patch<TxResponse>(`/order/${ticker}/${String(orderId)}`, body);
  }

  cancelOrder(ticker: string, orderId: number, body: CancelOrderBody): Promise<TxResponse> {
    return this.http.delete<TxResponse>(`/order/${ticker}/${String(orderId)}`, body);
  }

  // ─── Positions ──────────────────────────────────────────────────────────

  closePosition(ticker: string, positionId: number, body: ClosePositionBody): Promise<TxResponse> {
    return this.http.delete<TxResponse>(`/position/${ticker}/${String(positionId)}`, body);
  }

  reducePosition(ticker: string, positionId: number, body: ReducePositionBody): Promise<TxResponse> {
    return this.http.post<TxResponse>(`/position/${ticker}/${String(positionId)}/reduce`, body);
  }

  increasePosition(
    ticker: string,
    positionId: number,
    body: IncreasePositionBody,
  ): Promise<TxResponse> {
    return this.http.post<TxResponse>(`/position/${ticker}/${String(positionId)}/increase`, body);
  }

  depositMargin(ticker: string, positionId: number, body: DepositMarginBody): Promise<TxResponse> {
    return this.http.post<TxResponse>(
      `/position/${ticker}/${String(positionId)}/margin/deposit`,
      body,
    );
  }

  withdrawMargin(
    ticker: string,
    positionId: number,
    body: WithdrawMarginBody,
  ): Promise<TxResponse> {
    return this.http.post<TxResponse>(
      `/position/${ticker}/${String(positionId)}/margin/withdraw`,
      body,
    );
  }

  // ─── Account ────────────────────────────────────────────────────────────

  createAccount(body: CreateAccountBody): Promise<TxResponse> {
    return this.http.post<TxResponse>("/account", body);
  }

  /**
   * Mint wxUSD credit against a backing asset. Note this is no longer a plain
   * collateral transfer: `assetType` names the Move coin type registered on the
   * custody vault.
   */
  deposit(body: DepositBody): Promise<TxResponse> {
    return this.http.post<TxResponse>("/account/deposit", body);
  }

  /**
   * Withdraw wxUSD to a stablecoin, on the Sui side (`native`) or across a
   * bridge (`wormhole`).
   *
   * Funds-out paths are **owner-only** on chain since the delegate-phishing
   * hardening: a delegate signature cannot move money out, whatever its
   * permission mask says.
   */
  withdraw(body: WithdrawBody): Promise<TxResponse> {
    return this.http.post<TxResponse>("/account/withdraw", body);
  }

  addDelegate(body: AddDelegateBody): Promise<TxResponse> {
    return this.http.post<TxResponse>("/account/delegate", body);
  }

  removeDelegate(body: RemoveDelegateBody): Promise<TxResponse> {
    return this.http.delete<TxResponse>("/account/delegate", body);
  }

  /** Remove every delegate across all of the owner's accounts in one PTB. */
  removeAllDelegates(body: TxBody): Promise<TxResponse & { skippedAccounts: string[] }> {
    return this.http.delete<TxResponse & { skippedAccounts: string[] }>(
      "/account/delegate/all",
      body,
    );
  }

  // ─── WLP ────────────────────────────────────────────────────────────────

  mintWlp(body: MintWlpBody): Promise<TxResponse> {
    return this.http.post<TxResponse>("/wlp/mint", body);
  }

  /** Queue a redemption. Settlement is asynchronous via the withdrawal queue. */
  burnWlp(body: BurnWlpBody): Promise<TxResponse> {
    return this.http.post<TxResponse>("/wlp/burn", body);
  }

  cancelWlpBurn(body: CancelWlpBurnBody): Promise<TxResponse> {
    return this.http.post<TxResponse>("/wlp/cancel-burn", body);
  }

  claimWlpRewards(body: ClaimWlpRewardsBody): Promise<TxResponse> {
    return this.http.post<TxResponse>("/wlp/claim-rewards", body);
  }

  // ─── Sponsored execution ────────────────────────────────────────────────

  /**
   * Submit a sponsored transaction: the caller signs the bytes, Enoki pays gas.
   * `source` is a log breadcrumb only — the convention is `agent/<intent>`.
   */
  executeSponsored(input: {
    digest: string;
    signature: string;
    source?: string;
  }): Promise<{ digest: string }> {
    return this.http.post<{ digest: string }>("/sponsor/execute", input);
  }
}
