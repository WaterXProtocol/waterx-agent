/**
 * `WaterXAgent` — the surface an automated caller uses.
 *
 * Every write follows the same three steps: shape the request in display units,
 * ask the backend to build the PTB, hand the result to `TxExecutor` to sign and
 * submit. This file owns step one and nothing else; it never constructs a
 * transaction and never produces a signature.
 *
 * Amounts crossing into `api/tx.ts` are already raw strings — the conversion
 * happens here, once, through `units.ts`, so a caller works in USD and base
 * assets and no scale conversion is spread across call sites.
 */
import { PERM_ALL_TRADING } from "@waterx/sdk";

import { HttpClient } from "../api/http.ts";
import { ReadApi } from "../api/read.ts";
import { TxApi } from "../api/tx.ts";
import type { AccountData, DelegateData, OrderResponse, Position, TxResponse } from "../api/types.ts";
import { type AgentConfig, loadConfig, requireAccountId, signsAsDelegate } from "../config.ts";
import { type ExecuteResult, TxExecutor } from "../chain/executor.ts";
import { createSigner } from "../chain/create-signer.ts";
import type { SignerProvider } from "../chain/signer.ts";
import { type Permit, PolicyGate, type WriteIntent } from "../policy.ts";
import {
  acceptablePriceFor,
  toRawCollateral,
  toRawPrice,
  toRawSize,
  toRawTokenAmount,
} from "../units.ts";
import { assertNotCrossing, MarketRegistry } from "./markets.ts";

/** Default slippage bound on market-priced actions, in percent. */
const DEFAULT_SLIPPAGE_PERCENT = 0.5;

interface WriteOptions {
  /** Required under the `interactive` execution policy. */
  confirm?: boolean;
  /**
   * Called with the transaction digest before the submission leaves this
   * process, and awaited. A durable caller persists it here; see
   * `ExecuteOptions.onSubmitting`.
   */
  onSubmitting?: (digest: string) => Promise<void>;
}

export interface OpenPositionParams extends WriteOptions {
  /** `BTC` or `BTCUSD` — both resolve against the deployment's market list. */
  ticker: string;
  /** Collateral in display USD, e.g. `10`. */
  collateral: string | number;
  /** Either this or `size`. */
  leverage?: number;
  /** Base-asset size, e.g. `0.15` BTC. Overrides `leverage`. */
  size?: string | number;
  /** Slippage bound in percent. Defaults to 0.5. */
  slippagePercent?: number;
  /** Take-profit trigger, in USD. */
  takeProfitPrice?: string | number;
  /** Stop-loss trigger, in USD. */
  stopLossPrice?: string | number;
}

export interface LimitOrderParams extends WriteOptions {
  ticker: string;
  isLong: boolean;
  collateral: string | number;
  leverage?: number;
  size?: string | number;
  /** Trigger price in USD. */
  triggerPrice: string | number;
  isStopOrder?: boolean;
  reduceOnly?: boolean;
  linkedPositionId?: number;
  takeProfitPrice?: string | number;
  stopLossPrice?: string | number;
}

export interface ClosePositionParams extends WriteOptions {
  ticker: string;
  positionId: number;
  slippagePercent?: number;
}

export interface ReducePositionParams extends ClosePositionParams {
  /** Base-asset size to close. Either this or `percent`. */
  size?: string | number;
  /** Fraction of the position to close, 0 < percent <= 100. */
  percent?: number;
}

export interface AgentOptions {
  config?: Partial<AgentConfig>;
  /**
   * Where the key lives. Omitted, it comes from configuration: an external
   * `SIGNER_PROTOCOL` command when one is set, otherwise the `.env` keypair.
   */
  signer?: SignerProvider;
}

export class WaterXAgent {
  readonly config: AgentConfig;
  readonly read: ReadApi;
  readonly tx: TxApi;
  readonly markets: MarketRegistry;
  readonly executor: TxExecutor;
  readonly gate: PolicyGate;

  constructor(options: AgentOptions = {}) {
    this.config = loadConfig(options.config);
    const http = new HttpClient({ baseUrl: this.config.apiUrl });
    this.read = new ReadApi(http);
    this.tx = new TxApi(http);
    this.markets = new MarketRegistry(this.read);
    // The gate has to know whether this process holds a delegate key, because
    // `delegated-auto`'s whole safety argument rests on it.
    // The signer is built first: whether this is a delegate is a comparison
    // against its address, not a question about which variables are set.
    const signer = options.signer ?? createSigner(this.config);
    this.gate = new PolicyGate(
      this.config.executionPolicy,
      this.config.policyScope,
      signsAsDelegate(this.config, signer.address),
    );
    this.executor = new TxExecutor(signer, this.config, this.tx, this.gate);
  }

  /** The address that signs. Equals the owner unless a delegate key is loaded. */
  get address(): string {
    return this.executor.address;
  }

  /** The account this agent trades. Throws when `WATERX_ACCOUNT_ID` is unset. */
  get accountId(): string {
    return requireAccountId(this.config);
  }

  /**
   * Decide before building. An out-of-scope action is refused here, so it costs
   * no request at all — and the permit it returns is what `execute()` requires
   * before it will sign. Every write this class exposes goes through that; the
   * signer itself is reachable without one, which is the threat model in
   * `chain/verify.ts` rather than a gap here.
   */
  private authorize(intent: WriteIntent, options: WriteOptions): Permit {
    return this.gate.authorize(intent, { confirm: options.confirm });
  }

  /**
   * Authorize, build, and submit — as one step, because the seam between them
   * is where an unbound permit and a substitutable transaction would coexist.
   *
   * The builder is handed to the gate rather than called here, so nothing in
   * this class ever holds bytes it could swap before they are bound. See
   * `PolicyGate.authorizeAndBuild` for what that does and does not guarantee.
   */
  private async run(
    intent: WriteIntent,
    options: WriteOptions,
    build: () => Promise<TxResponse>,
  ): Promise<ExecuteResult> {
    const { built, permit } = await this.gate.authorizeAndBuild(
      intent,
      options.confirm === undefined ? {} : { confirm: options.confirm },
      build,
    );
    return this.executor.execute(
      built,
      intent,
      permit,
      options.onSubmitting === undefined ? {} : { onSubmitting: options.onSubmitting },
    );
  }


  // ─── Positions ──────────────────────────────────────────────────────────

  openLong(params: OpenPositionParams): Promise<ExecuteResult> {
    return this.openPosition({ ...params, isLong: true });
  }

  openShort(params: OpenPositionParams): Promise<ExecuteResult> {
    return this.openPosition({ ...params, isLong: false });
  }

  /**
   * Open at the oracle price, bounded by `acceptablePrice`.
   *
   * TP/SL legs are sized here rather than left to the backend: the contract
   * requires each bracket leg's size to match the main order exactly, and the
   * backend sizes the main order from `leverage` only when the caller did not
   * pass `size`. Deriving size once and sending it on both makes the match a
   * fact rather than a coincidence of two independent roundings.
   */
  async openPosition(
    params: OpenPositionParams & { isLong: boolean },
  ): Promise<ExecuteResult> {
    const ticker = await this.markets.resolveTicker(params.ticker);
    const spot = await this.markets.spotPrice(ticker);
    const wantsBracket =
      params.takeProfitPrice !== undefined || params.stopLossPrice !== undefined;

    // Always computed here, never left to the backend. A size the agent did not
    // choose is a size it cannot authorize, and therefore one the verifier
    // cannot bind — which is how an order within its collateral ceiling could
    // still carry any leverage at all.
    const size =
      params.size !== undefined
        ? toRawSize(params.size)
        : deriveSize(params.collateral, requireLeverage(params), spot);

    // Hoisted out of the build closure so the intent states the SAME value the
    // transaction will carry. Computing it twice would let the two drift by a
    // tick and refuse a legitimate order; computing it once makes the binding
    // exact.
    const acceptablePrice = acceptablePriceFor(
      spot,
      params.isLong ? "buy" : "sell",
      params.slippagePercent ?? DEFAULT_SLIPPAGE_PERCENT,
    );
    const legs = wantsBracket && size !== undefined ? bracketLegs(params, params.isLong, size) : [];

    const action = params.isLong ? "openLong" : "openShort";
    return this.run(
      {
        action,
        accountId: this.accountId,
        increasesExposure: true,
        ticker,
        side: params.isLong ? "long" : "short",
        reduceOnly: false,
        collateral: Number(params.collateral),
        collateralRaw: toRawCollateral(params.collateral),
        sizeRaw: size,
        // Derived, not copied: an order sized directly carries leverage the
        // caller never named, and the ceiling must see it either way.
        leverage: effectiveLeverage(
          Number(params.collateral),
          params.size ?? Number(size) / 1e9,
          params.leverage,
          spot,
        ),
        slippagePercent: params.slippagePercent ?? DEFAULT_SLIPPAGE_PERCENT,
        acceptablePriceRaw: acceptablePrice,
        // A market order is never a stop. Stated rather than left absent so the
        // verifier compares it: unbound, the backend could return the resting
        // stop this is not.
        isStopOrder: false,
        // Derived from the same call that builds them, so the authorization and
        // the transaction cannot describe different legs.
        legs: legs.map((leg) => ({
          triggerPriceRaw: leg.triggerPrice,
          isStopOrder: leg.isStopOrder,
          isLong: leg.isLong,
        })),
      },
      params,
      () => this.tx.marketOrder({
      ...this.executor.txBody(),
      accountId: this.accountId,
      ticker,
      isLong: params.isLong,
      collateralAmount: toRawCollateral(params.collateral),
      size,
      acceptablePrice,
      ...(legs.length > 0 ? { preOrders: legs } : {}),
    }),
    );
  }

  async closePosition(params: ClosePositionParams): Promise<ExecuteResult> {
    const ticker = await this.markets.resolveTicker(params.ticker);
    const position = await this.requirePosition(ticker, params.positionId);
    const spot = await this.markets.spotPrice(ticker);

    // Closing a long is a sell, so the bound is on the downside.
    const acceptablePrice = acceptablePriceFor(
      spot,
      position.side === "long" ? "sell" : "buy",
      params.slippagePercent ?? DEFAULT_SLIPPAGE_PERCENT,
    );
    return this.run(
      {
        action: "closePosition",
        accountId: this.accountId,
        increasesExposure: false,
        ticker,
        slippagePercent: params.slippagePercent ?? DEFAULT_SLIPPAGE_PERCENT,
        positionId: params.positionId,
        acceptablePriceRaw: acceptablePrice,
      },
      params,
      () => this.tx.closePosition(ticker, params.positionId, {
      ...this.executor.txBody(),
      accountId: this.accountId,
      acceptablePrice,
    }),
    );
  }

  async reducePosition(params: ReducePositionParams): Promise<ExecuteResult> {
    const ticker = await this.markets.resolveTicker(params.ticker);
    const position = await this.requirePosition(ticker, params.positionId);
    const spot = await this.markets.spotPrice(ticker);

    const size = params.size !== undefined
      ? toRawSize(params.size)
      : toRawSize(reduceByPercent(position.sizeInAsset, params.percent));

    const acceptablePrice = acceptablePriceFor(
      spot,
      position.side === "long" ? "sell" : "buy",
      params.slippagePercent ?? DEFAULT_SLIPPAGE_PERCENT,
    );
    return this.run(
      {
        action: "reducePosition",
        accountId: this.accountId,
        increasesExposure: false,
        ticker,
        slippagePercent: params.slippagePercent ?? DEFAULT_SLIPPAGE_PERCENT,
        positionId: params.positionId,
        sizeRaw: size,
        acceptablePriceRaw: acceptablePrice,
      },
      params,
      () => this.tx.reducePosition(ticker, params.positionId, {
      ...this.executor.txBody(),
      accountId: this.accountId,
      size,
      acceptablePrice,
    }),
    );
  }

  async increasePosition(
    params: ClosePositionParams & {
      collateral: string | number;
      leverage?: number;
      size?: string | number;
    },
  ): Promise<ExecuteResult> {
    const ticker = await this.markets.resolveTicker(params.ticker);
    const position = await this.requirePosition(ticker, params.positionId);
    const spot = await this.markets.spotPrice(ticker);

    // Computed here rather than left to the backend's leverage derivation, for
    // the same reason opening does it: a size the agent did not choose is one
    // it cannot authorize, and therefore one the verifier cannot bind.
    const size =
      params.size !== undefined
        ? toRawSize(params.size)
        : deriveSize(params.collateral, requireLeverage(params), spot);
    const acceptablePrice = acceptablePriceFor(
      spot,
      position.side === "long" ? "buy" : "sell",
      params.slippagePercent ?? DEFAULT_SLIPPAGE_PERCENT,
    );

    return this.run(
      {
        action: "increasePosition",
        accountId: this.accountId,
        increasesExposure: true,
        ticker,
        side: position.side,
        collateral: Number(params.collateral),
        collateralRaw: toRawCollateral(params.collateral),
        leverage: effectiveLeverage(
          Number(params.collateral),
          params.size ?? Number(size) / 1e9,
          params.leverage,
          spot,
        ),
        slippagePercent: params.slippagePercent ?? DEFAULT_SLIPPAGE_PERCENT,
        positionId: params.positionId,
        sizeRaw: size,
        acceptablePriceRaw: acceptablePrice,
      },
      params,
      () => this.tx.increasePosition(ticker, params.positionId, {
      ...this.executor.txBody(),
      accountId: this.accountId,
      collateralAmount: toRawCollateral(params.collateral),
      size,
      acceptablePrice,
    }),
    );
  }

  /** Add margin to an open position, lowering its leverage. */
  async addMargin(
    params: WriteOptions & { ticker: string; positionId: number; amount: string | number },
  ): Promise<ExecuteResult> {
    const ticker = await this.markets.resolveTicker(params.ticker);
    // Adding margin lowers leverage; it is not metered as new exposure.
    return this.run(
      {
        action: "addMargin",
        accountId: this.accountId,
        increasesExposure: false,
        ticker,
        positionId: params.positionId,
        collateralRaw: toRawCollateral(params.amount),
      },
      params,
      () => this.tx.depositMargin(ticker, params.positionId, {
      ...this.executor.txBody(),
      accountId: this.accountId,
      collateralAmount: toRawCollateral(params.amount),
    }),
    );
  }

  /** Withdraw margin from an open position, raising its leverage. */
  async removeMargin(
    params: WriteOptions & { ticker: string; positionId: number; amount: string | number },
  ): Promise<ExecuteResult> {
    const ticker = await this.markets.resolveTicker(params.ticker);
    // Removing margin raises leverage on a live position, so the ceiling has to
    // see the leverage that results — metering the withdrawn amount alone would
    // let a position be levered arbitrarily high one small withdrawal at a time.
    const position = await this.requirePosition(ticker, params.positionId);
    const remaining = position.collateral - Number(params.amount);
    return this.run(
      {
        action: "removeMargin",
        accountId: this.accountId,
        increasesExposure: true,
        ticker,
        collateral: Number(params.amount),
        collateralRaw: toRawCollateral(params.amount),
        // Non-positive remaining margin is not a leverage figure, it is a
        // liquidation; NaN reaches the gate's own refusal.
        leverage: remaining > 0 ? position.size / remaining : Number.NaN,
        positionId: params.positionId,
      },
      params,
      () => this.tx.withdrawMargin(ticker, params.positionId, {
      ...this.executor.txBody(),
      accountId: this.accountId,
      amount: toRawCollateral(params.amount),
    }),
    );
  }

  // ─── Orders ─────────────────────────────────────────────────────────────

  /**
   * Place a resting limit or stop order.
   *
   * A crossing limit is refused before the request is sent — see
   * `assertNotCrossing`.
   */
  async placeLimitOrder(params: LimitOrderParams): Promise<ExecuteResult> {
    const ticker = await this.markets.resolveTicker(params.ticker);
    const triggerPrice = Number(params.triggerPrice);
    const spot = await this.markets.spotPrice(ticker);

    assertNotCrossing({
      ticker,
      isLong: params.isLong,
      triggerPrice,
      spotPrice: spot,
      isStopOrder: params.isStopOrder,
      reduceOnly: params.reduceOnly,
    });

    const wantsBracket =
      params.takeProfitPrice !== undefined || params.stopLossPrice !== undefined;
    // Bracket legs size against the order's own trigger price, not spot — that
    // is the price the main order will fill at.
    const size =
      params.size !== undefined
        ? toRawSize(params.size)
        : deriveSize(params.collateral, requireLeverage(params), triggerPrice);
    const legs = wantsBracket && size !== undefined ? bracketLegs(params, params.isLong, size) : [];

    return this.run(
      {
        action: "placeLimitOrder",
        accountId: this.accountId,
        // A reduce-only leg lowers exposure; anything else commits collateral.
        increasesExposure: params.reduceOnly !== true,
        ticker,
        side: params.isLong ? "long" : "short",
        collateral: Number(params.collateral),
        collateralRaw: toRawCollateral(params.collateral),
        sizeRaw: size,
        triggerPriceRaw: toRawPrice(params.triggerPrice),
        // Sized against the order's own trigger price, which is where it fills.
        leverage: effectiveLeverage(
          Number(params.collateral),
          params.size ?? Number(size) / 1e9,
          params.leverage,
          triggerPrice,
        ),
        // A resting order fills at its own trigger, so it carries no
        // acceptable-price bound — and `acceptablePriceRaw` left unset is what
        // requires the transaction to carry none either.
        legs: legs.map((leg) => ({
          triggerPriceRaw: leg.triggerPrice,
          isStopOrder: leg.isStopOrder,
          isLong: leg.isLong,
        })),
        // The caller's own choice, carried into the authorization so the bytes
        // can be held to it. A limit and a stop at the same price are opposite
        // instructions, and `assertNotCrossing` above only cleared this price
        // for the one the caller asked for.
        isStopOrder: params.isStopOrder ?? false,
        // Stated rather than left absent: an unstated reduce-only is a
        // parameter the verifier refuses to check, and the default the backend
        // applies is "false" anyway.
        reduceOnly: params.reduceOnly ?? false,
        ...(params.linkedPositionId !== undefined
          ? { positionId: params.linkedPositionId }
          : {}),
      },
      params,
      () => this.tx.limitOrder({
      ...this.executor.txBody(),
      accountId: this.accountId,
      ticker,
      isLong: params.isLong,
      collateralAmount: toRawCollateral(params.collateral),
      size,
      triggerPrice: toRawPrice(params.triggerPrice),
      ...(params.isStopOrder !== undefined ? { isStopOrder: params.isStopOrder } : {}),
      ...(params.reduceOnly !== undefined ? { reduceOnly: params.reduceOnly } : {}),
      ...(params.linkedPositionId !== undefined
        ? { linkedPositionId: params.linkedPositionId }
        : {}),
      ...(legs.length > 0 ? { preOrders: legs } : {}),
    }),
    );
  }

  /** Attach TP and/or SL to an already-open position. */
  async placeTpSl(
    params: WriteOptions & {
      ticker: string;
      positionId: number;
      takeProfitPrice?: string | number;
      stopLossPrice?: string | number;
      /** Base-asset size. Defaults to the position's full size. */
      size?: string | number;
    },
  ): Promise<ExecuteResult> {
    if (params.takeProfitPrice === undefined && params.stopLossPrice === undefined) {
      throw new Error("placeTpSl: pass takeProfitPrice, stopLossPrice, or both.");
    }
    const ticker = await this.markets.resolveTicker(params.ticker);
    const position = await this.requirePosition(ticker, params.positionId);
    const size = toRawSize(params.size ?? position.sizeInAsset);
    // The same list the request is built from, so the authorization cannot
    // describe a different set of legs than the transaction carries.
    const legs = bracketLegs(params, position.side === "long", size);

    return this.run(
      // No `side` on purpose: a bracket leg is reduce-only and takes the
      // OPPOSITE side of the position it protects — the backend stamps
      // `isLong: !position.isLong` — so the position's side here would make the
      // verifier refuse every bracket. `reduceOnly` is what distinguishes this
      // from an opening order, which shares its entrypoint, account and market.
      {
        action: "placeTpSl",
        accountId: this.accountId,
        increasesExposure: false,
        ticker,
        reduceOnly: true,
        // Which position the bracket protects. Without it, a bracket authorized
        // for one position could be attached to another in the same market —
        // same entrypoint, same account, same ticker, nothing else to tell them
        // apart.
        positionId: params.positionId,
        sizeRaw: size,
        // The full descriptor of each leg and, by their count, how many may be
        // attached. No `isStopOrder` on the intent itself: this action places
        // no main order, so there is nothing for one to describe.
        legs: legs.map((leg) => ({
          triggerPriceRaw: leg.triggerPrice,
          isStopOrder: leg.isStopOrder,
          isLong: leg.isLong,
        })),
      },
      params,
      () => this.tx.placeTpSl({
      ...this.executor.txBody(),
      accountId: this.accountId,
      ticker,
      isLong: position.side === "long",
      size,
      linkedPositionId: params.positionId,
      ...(params.takeProfitPrice !== undefined
        ? { takeProfitPrice: toRawPrice(params.takeProfitPrice) }
        : {}),
      ...(params.stopLossPrice !== undefined
        ? { stopLossPrice: toRawPrice(params.stopLossPrice) }
        : {}),
    }),
    );
  }

  /**
   * Re-price and re-size a resting order.
   *
   * The contract locates the order by its *current* trigger price and book, so
   * both are read from the live order rather than taken from the caller — a
   * mismatch there is not found, not corrected.
   */
  async updateOrder(
    params: WriteOptions & {
      ticker: string;
      orderId: number;
      newTriggerPrice: string | number;
      newSize: string | number;
    },
  ): Promise<ExecuteResult> {
    const ticker = await this.markets.resolveTicker(params.ticker);
    const order = await this.requireOrder(ticker, params.orderId);
    const spot = await this.markets.spotPrice(ticker);

    assertNotCrossing({
      ticker,
      isLong: order.side === "long",
      triggerPrice: Number(params.newTriggerPrice),
      spotPrice: spot,
      isStopOrder: order.orderType === "stop-loss",
      reduceOnly: order.reduceOnly,
    });

    // A re-price can enlarge a resting order, so it is metered as exposure —
    // and the new size is what the ceilings must judge, not the old one. Without
    // this, an order could be placed inside the scope and then grown past it.
    const newNotional = Number(params.newSize) * Number(params.newTriggerPrice);
    return this.run(
      {
        action: "updateOrder",
        accountId: this.accountId,
        increasesExposure: !order.reduceOnly,
        ticker,
        side: order.side,
        collateral: order.collateral,
        leverage: order.collateral > 0 ? newNotional / order.collateral : Number.NaN,
        orderId: params.orderId,
        sizeRaw: toRawSize(params.newSize),
        triggerPriceRaw: toRawPrice(params.newTriggerPrice),
      },
      params,
      () => this.tx.updateOrder(ticker, params.orderId, {
      ...this.executor.txBody(),
      accountId: this.accountId,
      currentTriggerPrice: toRawPrice(order.triggerPrice),
      orderTypeTag: order.orderTypeTag,
      newTriggerPrice: toRawPrice(params.newTriggerPrice),
      newSize: toRawSize(params.newSize),
    }),
    );
  }

  async cancelOrder(
    params: WriteOptions & { ticker: string; orderId: number },
  ): Promise<ExecuteResult> {
    const ticker = await this.markets.resolveTicker(params.ticker);
    return this.run(
      {
        action: "cancelOrder",
        accountId: this.accountId,
        increasesExposure: false,
        ticker,
        orderId: params.orderId,
      },
      params,
      () => this.tx.cancelOrder(ticker, params.orderId, {
      ...this.executor.txBody(),
      accountId: this.accountId,
    }),
    );
  }

  // ─── Account ────────────────────────────────────────────────────────────

  /** Create a WaterX trading account. The id is emitted by the indexer, not returned here. */
  async createAccount(
    params: WriteOptions & { name: string; referralCode?: string },
  ): Promise<ExecuteResult> {
    return this.run(
      { action: "createAccount", accountId: "", increasesExposure: false, alias: params.name },
      params,
      () => this.tx.createAccount({
      ...this.executor.txBody(),
      name: params.name,
      ...(params.referralCode !== undefined ? { referralCode: params.referralCode } : {}),
    }),
    );
  }

  /**
   * Mint wxUSD credit against a backing asset.
   *
   * `assetType` is the fully-qualified Move type of the coin being deposited —
   * deposit is a credit mint against the custody vault now, not a transfer of
   * a fixed collateral coin.
   */
  async deposit(
    params: WriteOptions & { assetType: string; amount: string | number },
  ): Promise<ExecuteResult> {
    return this.run(
      {
        action: "deposit",
        accountId: this.accountId,
        increasesExposure: false,
        // A deposit is paid from the signer's own balance, and the amount and
        // asset live in that reservation rather than in any call argument.
        movesFundsIn: true,
        collateralRaw: toRawTokenAmount(params.amount),
        assetType: params.assetType,
      },
      params,
      () => this.tx.deposit({
      ...this.executor.txBody(),
      accountId: this.accountId,
      assetType: params.assetType,
      amount: toRawTokenAmount(params.amount),
    }),
    );
  }

  /**
   * Withdraw to a stablecoin on Sui.
   *
   * Funds-out is **owner-only** on chain, so this refuses up front when the
   * process holds a delegate key rather than letting the chain abort.
   */
  async withdraw(
    params: WriteOptions & { assetType: string; amount: string | number; toAddress?: string },
  ): Promise<ExecuteResult> {
    this.assertOwnerSigned("withdraw");
    return this.run(
      {
        action: "withdraw",
        accountId: this.accountId,
        increasesExposure: false,
        collateralRaw: toRawCollateral(params.amount),
        // Where the money lands. The contract takes this as an argument, so it
        // is the agent's to state rather than the contract's to be trusted on.
        recipient: params.toAddress ?? this.executor.senderAddress,
        // Which coin comes out. It is the route call's type argument, and
        // appears nowhere in `request_withdraw` itself.
        assetType: params.assetType,
      },
      params,
      () => this.tx.withdraw({
      ...this.executor.txBody(),
      accountId: this.accountId,
      route: "native",
      assetType: params.assetType,
      amount: toRawTokenAmount(params.amount),
      ...(params.toAddress !== undefined ? { toAddress: params.toAddress } : {}),
    }),
    );
  }

  /**
   * Grant a delegate authority over this account.
   *
   * The masks are independent and key on different on-chain scopes: perp
   * authority grants nothing on predict or staking, and none of them grants a
   * funds-out path — that stayed owner-only after the delegate-phishing
   * hardening. Use `PERM_*` from `@waterx/sdk` rather than literals.
   */
  async addDelegate(
    params: WriteOptions & {
      delegate: string;
      perpPermissions?: number;
      predictPermissions?: number;
      stakingPermissions?: number;
    },
  ): Promise<ExecuteResult> {
    this.assertOwnerSigned("addDelegate");
    // Sent explicitly rather than left to the backend's default: a mask the
    // agent did not choose is one it cannot bound, and the grant would then be
    // ceilinged against a guess.
    const perpPermissions = params.perpPermissions ?? PERM_ALL_TRADING;
    const predictPermissions = params.predictPermissions ?? 0;
    const stakingPermissions = params.stakingPermissions ?? 0;
    return this.run(
      {
        action: "addDelegate",
        accountId: this.accountId,
        increasesExposure: false,
        delegateAddress: params.delegate,
        // The ceiling on what the grant may confer, across however many calls
        // the backend splits it into. The union rather than any single mask,
        // because `add_delegate` itself carries almost nothing — in a live
        // grant of every trading permission its own argument was zero, and the
        // authority arrived in a separate call.
        // Kept apart, not merged. Which protocol a grant applies to is the
        // Move type the call is parameterised with, so a single union ceiling
        // let a perp grant carry a bit only ever asked for on staking.
        delegatePermissions: {
          perp: perpPermissions,
          predict: predictPermissions,
          staking: stakingPermissions,
        },
        // `add_delegate`'s own mask, which every observed grant carried as zero.
        delegateBasePermissions: 0,
      },
      params,
      () => this.tx.addDelegate({
      ...this.executor.txBody(),
      accountId: this.accountId,
      delegate: params.delegate,
      perpPermissions,
      predictPermissions,
      stakingPermissions,
    }),
    );
  }

  async removeDelegate(params: WriteOptions & { delegate: string }): Promise<ExecuteResult> {
    this.assertOwnerSigned("removeDelegate");
    return this.run(
      {
        action: "removeDelegate",
        accountId: this.accountId,
        increasesExposure: false,
        delegateAddress: params.delegate,
      },
      params,
      () => this.tx.removeDelegate({
      ...this.executor.txBody(),
      accountId: this.accountId,
      delegate: params.delegate,
    }),
    );
  }

  /** Revoke every delegate across all of the owner's accounts, in one transaction. */
  async removeAllDelegates(params: WriteOptions = {}): Promise<ExecuteResult> {
    this.assertOwnerSigned("removeAllDelegates");
    return this.run(
      { action: "removeAllDelegates", accountId: this.accountId, increasesExposure: false },
      params,
      () => this.tx.removeAllDelegates(this.executor.txBody()),
    );
  }

  // ─── WLP ────────────────────────────────────────────────────────────────

  async mintWlp(params: WriteOptions & { amount: string | number }): Promise<ExecuteResult> {
    // Minting commits capital to the pool, so it is metered against the same
    // ceilings an opening order is — a bounded agent that could mint without
    // limit would be bounded only on paper.
    return this.run(
      {
        action: "mintWlp",
        accountId: this.accountId,
        increasesExposure: true,
        collateral: Number(params.amount),
        collateralRaw: toRawCollateral(params.amount),
      },
      params,
      () => this.tx.mintWlp({
      ...this.executor.txBody(),
      accountId: this.accountId,
      amount: toRawTokenAmount(params.amount),
    }),
    );
  }

  /** Queue a WLP redemption. Settlement runs through the withdrawal queue. */
  async burnWlp(params: WriteOptions & { amount: string | number }): Promise<ExecuteResult> {
    return this.run(
      {
        action: "burnWlp",
        accountId: this.accountId,
        increasesExposure: false,
        amountRaw: toRawTokenAmount(params.amount),
      },
      params,
      () => this.tx.burnWlp({
      ...this.executor.txBody(),
      accountId: this.accountId,
      amount: toRawTokenAmount(params.amount),
    }),
    );
  }

  async cancelWlpBurn(
    params: WriteOptions & { requestId: string | number },
  ): Promise<ExecuteResult> {
    return this.run(
      {
        action: "cancelWlpBurn",
        accountId: this.accountId,
        increasesExposure: false,
        requestId: Number(params.requestId),
      },
      params,
      () => this.tx.cancelWlpBurn({
      ...this.executor.txBody(),
      accountId: this.accountId,
      requestId: String(params.requestId),
    }),
    );
  }

  async claimWlpRewards(params: WriteOptions = {}): Promise<ExecuteResult> {
    return this.run(
      { action: "claimWlpRewards", accountId: this.accountId, increasesExposure: false },
      params,
      () => this.tx.claimWlpRewards({
      ...this.executor.txBody(),
      accountId: this.accountId,
    }),
    );
  }

  // ─── Convenience reads ──────────────────────────────────────────────────

  accounts(): Promise<AccountData[]> {
    return this.read.accounts(this.executor.senderAddress);
  }

  positions(): Promise<Position[]> {
    return this.read.positions(this.accountId);
  }

  orders(): Promise<OrderResponse[]> {
    return this.read.orders({ account: this.accountId });
  }

  delegates(): Promise<DelegateData[]> {
    return this.read.delegates(this.accountId);
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private assertOwnerSigned(intent: string): void {
    if (this.executor.delegateSender !== undefined) {
      throw new Error(
        `${intent} is owner-only on chain; this process is signing as a delegate ` +
          `(WATERX_OWNER_ADDRESS is set). Run it with the owner key.`,
      );
    }
  }

  private async requirePosition(ticker: string, positionId: number): Promise<Position> {
    const positions = await this.read.positions(this.accountId);
    // (id, ticker) is the composite key — a bare id repeats across markets.
    const match = positions.find((p) => p.ticker === ticker && p.id === String(positionId));
    if (match === undefined) {
      const open = positions.map((p) => `${p.ticker}#${p.id}`).join(", ") || "none";
      throw new Error(`No open position ${ticker}#${String(positionId)}. Open positions: ${open}`);
    }
    return match;
  }

  private async requireOrder(ticker: string, orderId: number): Promise<OrderResponse> {
    const orders = await this.read.orders({ account: this.accountId });
    const match = orders.find((o) => o.ticker === ticker && o.id === String(orderId));
    if (match === undefined) {
      const open = orders.map((o) => `${o.ticker}#${o.id}`).join(", ") || "none";
      throw new Error(`No resting order ${ticker}#${String(orderId)}. Open orders: ${open}`);
    }
    return match;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The leverage an order actually carries, however it was expressed.
 *
 * A caller may name `leverage` OR name a `size` — and a scope bounds leverage,
 * so an order sized directly would otherwise slip past the ceiling entirely:
 * `size: 1000` against `collateral: 10` is enormous leverage that no `maxLeverage`
 * ever sees. Both spellings are reduced to the same number before the gate runs.
 */
function effectiveLeverage(
  collateral: number,
  size: string | number | undefined,
  leverage: number | undefined,
  price: number,
): number | undefined {
  if (size === undefined) return leverage;
  const notional = Number(size) * price;
  if (!Number.isFinite(notional) || !Number.isFinite(collateral) || collateral <= 0) {
    // Unmeasurable — the gate refuses it rather than guessing.
    return Number.NaN;
  }
  return notional / collateral;
}

function requireLeverage(params: { leverage?: number; size?: string | number }): number {
  if (params.leverage === undefined) {
    throw new Error("Pass either `leverage` or `size` — the position cannot be sized without one.");
  }
  if (!Number.isFinite(params.leverage) || params.leverage < 1) {
    throw new Error(`Leverage ${String(params.leverage)} must be at least 1.`);
  }
  return params.leverage;
}

/**
 * `(collateralUsd × leverage) / price`, 1e9-scaled — the same derivation the
 * backend applies when only `leverage` is supplied. Reproduced here only for
 * the bracket case, where the main order and its legs must agree exactly.
 */
function deriveSize(collateral: string | number, leverage: number, price: number): string {
  const notional = Number(collateral) * leverage;
  if (!Number.isFinite(notional) || notional <= 0) {
    throw new Error(`Cannot size an order from collateral ${String(collateral)} at ${String(leverage)}x.`);
  }
  return toRawSize((notional / price).toFixed(9));
}

function bracketLegs(
  params: { takeProfitPrice?: string | number; stopLossPrice?: string | number },
  /** The side of the position being protected — the legs take the other one. */
  isLong: boolean,
  size: string,
): { isStopOrder: boolean; isLong: boolean; triggerPrice: string; size: string }[] {
  const legs: { isStopOrder: boolean; isLong: boolean; triggerPrice: string; size: string }[] = [];
  // A leg closes the position it protects, so it is always the opposite side.
  // Derived here, in the one place that knows the position's direction, so the
  // authorization and the request cannot disagree about it.
  const legSide = !isLong;
  if (params.takeProfitPrice !== undefined) {
    legs.push({
      isStopOrder: false,
      isLong: legSide,
      triggerPrice: toRawPrice(params.takeProfitPrice),
      size,
    });
  }
  if (params.stopLossPrice !== undefined) {
    legs.push({
      isStopOrder: true,
      isLong: legSide,
      triggerPrice: toRawPrice(params.stopLossPrice),
      size,
    });
  }
  assertBracketDirection(params, isLong);
  return legs;
}

/**
 * A take-profit below entry (or a stop above it) on a long is almost always a
 * transposed pair. The contract will happily accept it and trigger immediately,
 * which reads as "my position closed itself".
 */
function assertBracketDirection(
  params: { takeProfitPrice?: string | number; stopLossPrice?: string | number },
  isLong: boolean,
): void {
  const tp = params.takeProfitPrice === undefined ? undefined : Number(params.takeProfitPrice);
  const sl = params.stopLossPrice === undefined ? undefined : Number(params.stopLossPrice);
  if (tp === undefined || sl === undefined) return;

  const ordered = isLong ? sl < tp : tp < sl;
  if (!ordered) {
    throw new Error(
      `On a ${isLong ? "long" : "short"}, take-profit ${String(tp)} and stop-loss ${String(sl)} are ` +
        `the wrong way round — check the pair before sending it.`,
    );
  }
}

function reduceByPercent(sizeInAsset: number, percent: number | undefined): string {
  if (percent === undefined) {
    throw new Error("reducePosition: pass either `size` or `percent`.");
  }
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    throw new Error(`reducePosition: percent ${String(percent)} must be within (0, 100].`);
  }
  return ((sizeInAsset * percent) / 100).toFixed(9);
}
