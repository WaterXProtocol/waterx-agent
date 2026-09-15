/**
 * Wire types mirrored from bucket-backend-mono `main` (apps/waterx/src).
 *
 * These are hand-maintained copies, not generated: the backend does not publish
 * a client package, and vendoring the whole NestJS app to borrow its interfaces
 * would drag in its DI graph. Each block names the file it mirrors so a drift
 * check has somewhere to look.
 */

// ─── Transactions ─────────────────────────────────────────────────────────────
// mirrors: core/sdk.tokens.ts

/**
 * Every tx-build route returns this. Discriminated on `sponsored`: the
 * sponsored branch always carries the Enoki `digest` that `/sponsor/execute`
 * needs, the regular branch never does.
 */
export type TxResponse = SponsoredTxResponse | RegularTxResponse;

interface TxResponseBase {
  /** Base64 transaction bytes to sign. */
  txBytes: string;
  /** Present on account creation only. */
  generatedReferralCode?: string;
}

export interface SponsoredTxResponse extends TxResponseBase {
  sponsored: true;
  digest: string;
}

export interface RegularTxResponse extends TxResponseBase {
  sponsored: false;
  /** `'policy'` = sponsorship was withheld by rule, not by an outage. */
  selfPayReason?: "policy";
}

// ─── Account ──────────────────────────────────────────────────────────────────
// mirrors: account/account.service.ts

export interface AccountData {
  accountId: string;
  owner: string;
  alias: string;
  /** `0` is the wallet's main account; 1, 2, … are sub-accounts. */
  accountIndex: number;
  isMainAccount: boolean;
  createdAtMs: number;
}

export type TradingPermissionName =
  | "OPEN_POSITION"
  | "CLOSE_POSITION"
  | "INCREASE_POSITION"
  | "DECREASE_POSITION"
  | "PLACE_ORDER"
  | "CANCEL_ORDER"
  | "DEPOSIT_COLLATERAL"
  | "WITHDRAW_COLLATERAL"
  | "MINT_WLP"
  | "REDEEM_WLP";

/**
 * A delegate now carries **four independent** bitmasks, not one. They key on
 * different on-chain scopes, so perp authority grants nothing on WLP and vice
 * versa (core/delegate-auth.service.ts).
 */
export interface DelegateData {
  delegateAddress: string;
  /**
   * Perp authority. Since the backend's delegate-mask fix this is the
   * `account_data::WaterXPerp` bitmap the chain actually enforces, covering the
   * trading and WLP bits alike. Against a backend from before that fix it is
   * the superseded `TradingRequest<CREDIT>` mask, which governs nothing.
   */
  permissions: number;
  permissionList: TradingPermissionName[];
  predictPermissions: number;
  predictPermissionList: string[];
  stakingPermissions: number;
  stakingPermissionList: string[];
  /**
   * Present, and `true`, only when the delegate holds authority solely in the
   * superseded slot — it reads as permissioned and aborts on chain. The backend
   * omits it otherwise, so its absence means "not known to be stale", never
   * "confirmed healthy". `doctor` reads the slot from chain instead of inferring
   * anything from a missing field.
   */
  stale?: true;
}

// ─── Positions ────────────────────────────────────────────────────────────────
// mirrors: position/position.types.ts

export interface PnlBreakdown {
  perpsPnl: number;
  fundingFee: number;
  borrowFee: number;
  openFee: number;
  closeFee: number;
  pnlAfterFees: number;
}

export interface Position {
  /** Per-market index. Unique only together with `ticker`. */
  id: string;
  ticker: string;
  side: "long" | "short";
  /** Notional, in USD. */
  size: number;
  sizeInAsset: number;
  collateral: number;
  collateralCurrency: string;
  leverage: number;
  entryPrice: number;
  spotPrice: number;
  /** `spotPrice` is not a live oracle read; everything derived from it inherits this. */
  priceStale: boolean;
  /** `0` means "cannot estimate" — never "no liquidation risk". */
  estLiqPrice: number;
  estPnl: number;
  /** Decimal fraction: `0.052` = 5.2%. */
  estPnlRatio: number;
  pnlBreakdown: PnlBreakdown;
  linkedOrders: OrderResponse[];
  openedAt: number;
  tradingFeeRate: number;
  /** `0` means unknown; consumers gate on `> 0` rather than substituting a default. */
  maintenanceMarginRatio: number;
}

// ─── Orders ───────────────────────────────────────────────────────────────────
// mirrors: order/order-response.factory.ts

export type OrderType = "market" | "limit" | "take-profit" | "stop-loss";

/** The order book's own side naming — `long`/`short`, not `buy`/`sell`. */
export type OrderSide = "long" | "short";

export interface OrderResponse {
  id: string;
  ticker: string;
  side: OrderSide;
  size: number;
  sizeInAsset: number;
  collateral: number;
  collateralCurrency: string;
  triggerPrice: number;
  triggerCondition: "lte" | "gte";
  spotPrice: number;
  orderType: OrderType;
  /** 0=limit_buy, 1=limit_sell, 2=stop_buy, 3=stop_sell. */
  orderTypeTag: number;
  reduceOnly: boolean;
  linkedPositionId: string | null;
  linkedOrderId: string | null;
  linkedOrders: OrderResponse[];
  createdAt: number;
}

// ─── Requests ─────────────────────────────────────────────────────────────────
// mirrors: core/dto/tx.dto.ts + the per-domain *-tx.dto.ts files

/**
 * Base of every tx-build body. `sender` is the **authorisation subject** — the
 * account owner — even when a delegate signs; `delegateSender` is the address
 * that actually signs and is set as the PTB sender.
 */
export interface TxBody {
  sender: string;
  delegateSender?: string;
}

/** One TP/SL bracket leg. The backend stamps reduce-only + the opposite side itself. */
export interface PreOrderLeg {
  /** Take-profit = `false` (limit), stop-loss = `true` (stop). */
  isStopOrder: boolean;
  /** 1e9-scaled. */
  triggerPrice: string;
  /** 1e9-scaled; must be > 0. */
  size: string;
}

export interface MarketOrderBody extends TxBody {
  accountId: string;
  ticker: string;
  isLong: boolean;
  /** Base units, 6 decimals. */
  collateralAmount: string;
  /** Either this or `size`. When both are set, `size` wins. */
  leverage?: number;
  size?: string;
  /** Slippage cap, 1e9-scaled, u64. */
  acceptablePrice?: string;
  preOrders?: PreOrderLeg[];
}

export interface PlaceOrderBody extends TxBody {
  accountId: string;
  ticker: string;
  isLong: boolean;
  isStopOrder?: boolean;
  reduceOnly?: boolean;
  collateralAmount: string;
  leverage?: number;
  size?: string;
  /** 1e9-scaled. */
  triggerPrice: string;
  linkedPositionId?: number;
  preOrders?: PreOrderLeg[];
}

export interface PlaceTpSlBody extends TxBody {
  accountId: string;
  ticker: string;
  /** Must match the position's side. */
  isLong: boolean;
  /** 1e9-scaled; applied to both legs. */
  size: string;
  linkedPositionId: number;
  takeProfitPrice?: string;
  stopLossPrice?: string;
}

export interface UpdateOrderBody extends TxBody {
  accountId: string;
  /** Locates the order in its price bucket; must match the live trigger. */
  currentTriggerPrice: string;
  /** 0=limit_buy, 1=limit_sell, 2=stop_buy, 3=stop_sell. */
  orderTypeTag: number;
  newTriggerPrice: string;
  newSize: string;
}

export interface CancelOrderBody extends TxBody {
  accountId: string;
}

export interface ClosePositionBody extends TxBody {
  accountId: string;
  /** 1e9-scaled, u64. `0` or absent = no limit. */
  acceptablePrice?: string;
}

export interface ReducePositionBody extends TxBody {
  accountId: string;
  /** 1e9-scaled. */
  size: string;
  acceptablePrice?: string;
}

export interface IncreasePositionBody extends TxBody {
  accountId: string;
  collateralAmount: string;
  leverage?: number;
  size?: string;
  acceptablePrice?: string;
}

export interface DepositMarginBody extends TxBody {
  accountId: string;
  collateralAmount: string;
}

export interface WithdrawMarginBody extends TxBody {
  accountId: string;
  amount: string;
}

export interface CreateAccountBody extends TxBody {
  /** Max 32 characters. */
  name: string;
  referralCode?: string;
  loginMethod?: "zklogin" | "wallet";
}

export interface AddDelegateBody extends TxBody {
  accountId: string;
  delegate: string;
  /** `PERM_*` from `@waterx/sdk`. */
  perpPermissions?: number;
  predictPermissions?: number;
  stakingPermissions?: number;
}

export interface RemoveDelegateBody extends TxBody {
  accountId: string;
  delegate: string;
}

export type WithdrawRoute = "native" | "wormhole";

/**
 * Deposit is now a **wxUSD credit** mint against a registered backing asset —
 * not a direct collateral transfer. `assetType` is the fully-qualified Move
 * type of the coin being deposited.
 */
export interface DepositBody extends TxBody {
  accountId: string;
  assetType: string;
  /** Base units of the backing asset. */
  amount: string;
}

export interface WithdrawBody extends TxBody {
  accountId: string;
  route: WithdrawRoute;
  /** Required for `route: 'native'`. */
  assetType?: string;
  evmDestinationChain?: number;
  evmRecipient?: string;
  evmToken?: string;
  amount?: string;
  /** Defaults to `sender`. */
  toAddress?: string;
}

export interface MintWlpBody extends TxBody {
  accountId: string;
  amount: string;
}

export interface BurnWlpBody extends TxBody {
  accountId: string;
  amount: string;
}

export interface CancelWlpBurnBody extends TxBody {
  accountId: string;
  requestId: string;
}

export interface ClaimWlpRewardsBody extends TxBody {
  accountId: string;
}

// ─── Market data ──────────────────────────────────────────────────────────────

// mirrors: ticker/ticker.types.ts

export interface TickerFunding {
  [key: string]: unknown;
}

export interface TickerData {
  spotPrice: number;
  open24h: number;
  change24h: number;
  high24h: number;
  low24h: number;
  /** USD volume over the trailing 24h. */
  volume24h: number;
  openInterest: { long: number; short: number; total: number };
  /** Remaining OI capacity per side, in base-asset units. */
  availableOi: { long: number; short: number };
  funding: TickerFunding;
  priceConfidence: number;
  timestamp: number;
  stale: boolean;
}

// mirrors: markets/markets.types.ts

export interface MarketInfo {
  ticker: string;
  /** "crypto" | "forex" | "commodity" | "stocks" | … */
  category: string;
  tradingHours: unknown | null;
  /**
   * `not_listed` means the ticker exists in the deployment config but has no
   * metadata entry — it is not tradeable. Filter these out before offering a
   * market to a caller.
   */
  status: "open" | "closed" | "coming_soon" | "paused" | "not_listed";
  /** Non-production only: the market is hidden in production. */
  hidden?: true;
}

// mirrors: info/info.types.ts

export interface InfoTokenMeta {
  /** Registry key, e.g. "USD", "USDC", "WLP", "SUI". */
  key: string;
  symbol: string;
  name: string;
  /** Fully-qualified Sui Move type — this is what `deposit`/`withdraw` want as `assetType`. */
  coinType: string;
  decimals: number;
}

export interface InfoRewardTokenMeta extends InfoTokenMeta {
  priceTicker: string;
}

/**
 * `GET /info` — the deployment's own account of itself. The authoritative list
 * of tradeable markets and of the backing assets a deposit may be made in, so
 * neither has to be hardcoded here.
 */
export interface AppInfo {
  network: "sui_testnet" | "sui_mainnet";
  serverTime: number;
  collateral: InfoTokenMeta;
  wlp: InfoTokenMeta;
  sui: InfoTokenMeta;
  /** Coins accepted as PSM mint inputs / native-route burn outputs. */
  backingAssets: InfoTokenMeta[];
  markets: { ticker: string; base: string }[];
  rewardTokens: InfoRewardTokenMeta[];
}

export type CandleTimeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

/**
 * The window the WLP statistics routes accept.
 *
 * Enumerated because the backend rejects anything else — including the empty
 * value an optional parameter produces, and including `7D` — and a rejected
 * period reads as "the pool has no data" rather than as a bad request.
 */
export type WlpPeriod = "1d" | "7d" | "30d" | "all";

// mirrors: account/account-history.types.ts

export interface HistoryResponse {
  items: unknown[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** One account that currently delegates to the queried address (`GET /account/delegated`). */
export interface DelegatedAccount {
  accountId: string;
  /** From the backend's account-creation index; `null` until that row is indexed. */
  ownerAddress: string | null;
  delegate: DelegateData;
}

/**
 * `GET /account/delegated` — accounts delegating to an address, each verified
 * against chain state by the backend. It lists; it never chooses.
 */
export interface DelegatedAccountsResponse {
  accounts: DelegatedAccount[];
  /** Candidates the backend could not read. Not the same as "not granted". */
  unverifiedAccounts: string[];
  /** More candidates existed than the backend verifies in one response. */
  truncated: boolean;
}
