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
import { createSigner, signerReadiness } from "../chain/create-signer.ts";
import type { SignerProvider } from "../chain/signer.ts";
import { PolicyGate, type WriteIntent } from "../policy.ts";
import {
  acceptablePriceFor,
  toRawCollateral,
  toRawPrice,
  toRawSize,
  toRawTokenAmount,
} from "../units.ts";
import { ExecutionPolicyError, UsageError } from "../errors.ts";
import { assertNotCrossing, MarketRegistry } from "./markets.ts";
import { type BuildRequest, buildTx, type PlanContext, type TradePlan } from "./plan.ts";

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

  /** Supplied by the caller, if any. Held rather than used, so reads stay key-free. */
  readonly #supplied: SignerProvider | undefined;
  #signer: SignerProvider | undefined;
  #writer: { gate: PolicyGate; executor: TxExecutor } | undefined;

  /**
   * Nothing about signing happens here.
   *
   * The signer used to be built in this constructor, which meant every
   * invocation loaded the key — `markets`, `ticker`, `positions` included. A
   * read that needs a private key to run is a read nobody can grant an agent
   * safely, and it made the obvious first command an external user types
   * (`pnpm run markets`) fail on a fresh clone with a message about wallets.
   *
   * So the read plane is built eagerly and the write plane on first use. The
   * seam is deliberate and narrow: `gate` and `executor` are the only two
   * things behind it, and reaching either is exactly what "this invocation
   * intends to sign" means.
   */
  constructor(options: AgentOptions = {}) {
    this.config = loadConfig(options.config);
    const http = new HttpClient({ baseUrl: this.config.apiUrl });
    this.read = new ReadApi(http);
    this.tx = new TxApi(http);
    this.markets = new MarketRegistry(this.read);
    this.#supplied = options.signer;
  }

  /**
   * The signer, built on demand.
   *
   * Memoised, because `signsAsDelegate` compares against its address and the
   * executor signs with it — two callers must not get two different keys.
   */
  get signer(): SignerProvider {
    this.#signer ??= this.#supplied ?? createSigner(this.config);
    return this.#signer;
  }

  /** Whether the signer has actually been constructed. A read path leaves this false. */
  get signerLoaded(): boolean {
    return this.#signer !== undefined;
  }

  /** Whether a signer *could* be built, without building one. See `signerReadiness`. */
  get signerReady(): boolean {
    return this.#supplied !== undefined || signerReadiness(this.config).ready;
  }

  /**
   * The write plane: the gate that authorizes and the executor that signs.
   *
   * Built together and once. The gate has to know whether this process holds a
   * delegate key, because `delegated-auto`'s whole safety argument rests on it
   * — and that is a comparison against the signer's address, not a question
   * about which variables are set. So the signer comes first, here, at the
   * moment a write is actually intended.
   */
  #write(): { gate: PolicyGate; executor: TxExecutor } {
    if (this.#writer === undefined) {
      const signer = this.signer;
      const gate = new PolicyGate(
        this.config.executionPolicy,
        this.config.policyScope,
        signsAsDelegate(this.config, signer.address),
      );
      this.#writer = { gate, executor: new TxExecutor(signer, this.config, this.tx, gate) };
    }
    return this.#writer;
  }

  /** Authorizes writes. Touching it loads the key. */
  get gate(): PolicyGate {
    return this.#write().gate;
  }

  /** Signs and submits. Touching it loads the key. */
  get executor(): TxExecutor {
    return this.#write().executor;
  }

  /** The address that signs. Equals the owner unless a delegate key is loaded. */
  get address(): string {
    return this.executor.address;
  }

  /**
   * The address the backend treats as the authorisation subject.
   *
   * Takes the configured owner when there is one, so an account lookup on a
   * machine with no key still works — `WATERX_OWNER_ADDRESS=0x… pnpm run accounts`
   * is a read, and reads do not need to sign.
   */
  get ownerAddress(): string {
    return this.config.ownerAddress ?? this.signer.address;
  }

  /** The account this agent trades. Throws when `WATERX_ACCOUNT_ID` is unset. */
  get accountId(): string {
    return requireAccountId(this.config);
  }

  /**
   * Authorize, build, and submit a plan — as one step, because the seam between
   * them is where an unbound permit and a substitutable transaction would
   * coexist.
   *
   * The builder is handed to the gate rather than called here, so nothing in
   * this class ever holds bytes it could swap before they are bound. See
   * `PolicyGate.authorizeAndBuild` for what that does and does not guarantee.
   *
   * It takes a {@link TradePlan} rather than an intent and a closure because a
   * plan is *data*: the same value can be shown to a person, written to the
   * approval ledger, read back by a different process minutes later, and
   * submitted here — with the guarantee that all four describe the same order.
   * A closure could not leave the process it was made in, which is why the
   * preview path could not exist before this.
   */
  async submit(plan: TradePlan, options: WriteOptions = {}): Promise<ExecuteResult> {
    // Resolved once, before the gate runs: reaching `executor` is what loads
    // the key, and doing it inside the build closure would put that after the
    // authorization decision rather than before it.
    const executor = this.executor;
    const { built, permit } = await this.gate.authorizeAndBuild(
      plan.intent,
      options.confirm === undefined ? {} : { confirm: options.confirm },
      () => buildTx(this.tx, plan.request, executor.txBody()),
    );
    return executor.execute(
      built,
      plan.intent,
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
  openPosition(
    params: OpenPositionParams & { isLong: boolean },
  ): Promise<ExecuteResult> {
    return this.planOpenPosition(params).then((plan) => this.submit(plan, params));
  }

  /** The plan openPosition submits. Derives everything; authorizes and builds nothing. */
  async planOpenPosition(
    params: OpenPositionParams & { isLong: boolean },
  ): Promise<TradePlan> {
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
    const intent: WriteIntent = {
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
    };
    return {
      action: intent.action,
      intent,
      request: {
        kind: "marketOrder",
        body: {
          accountId: this.accountId,
          ticker,
          isLong: params.isLong,
          collateralAmount: toRawCollateral(params.collateral),
          size,
          acceptablePrice,
          ...(legs.length > 0 ? { preOrders: legs } : {}),
        },
      },
      context: { referencePrice: spot, boundKind: params.isLong ? "max" : "min", fill: params.isLong ? "buy" : "sell" },
    };
  }

  closePosition(params: ClosePositionParams): Promise<ExecuteResult> {
    return this.planClosePosition(params).then((plan) => this.submit(plan, params));
  }

  /** The plan closePosition submits. Derives everything; authorizes and builds nothing. */
  async planClosePosition(params: ClosePositionParams): Promise<TradePlan> {
    const ticker = await this.markets.resolveTicker(params.ticker);
    const position = await this.requirePosition(ticker, params.positionId);
    const spot = await this.markets.spotPrice(ticker);

    // Closing a long is a sell, so the bound is on the downside.
    const acceptablePrice = acceptablePriceFor(
      spot,
      position.side === "long" ? "sell" : "buy",
      params.slippagePercent ?? DEFAULT_SLIPPAGE_PERCENT,
    );
    const intent: WriteIntent = {
      action: "closePosition",
      accountId: this.accountId,
      increasesExposure: false,
      ticker,
      slippagePercent: params.slippagePercent ?? DEFAULT_SLIPPAGE_PERCENT,
      positionId: params.positionId,
      acceptablePriceRaw: acceptablePrice,
    };
    return {
      action: intent.action,
      intent,
      request: {
        kind: "closePosition",
        ticker,
        positionId: params.positionId,
        body: {
          accountId: this.accountId,
          acceptablePrice,
        },
      },
      context: { referencePrice: spot, boundKind: position.side === "long" ? "min" : "max", fill: position.side === "long" ? "sell" : "buy" },
    };
  }

  reducePosition(params: ReducePositionParams): Promise<ExecuteResult> {
    return this.planReducePosition(params).then((plan) => this.submit(plan, params));
  }

  /** The plan reducePosition submits. Derives everything; authorizes and builds nothing. */
  async planReducePosition(params: ReducePositionParams): Promise<TradePlan> {
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
    const intent: WriteIntent = {
      action: "reducePosition",
      accountId: this.accountId,
      increasesExposure: false,
      ticker,
      slippagePercent: params.slippagePercent ?? DEFAULT_SLIPPAGE_PERCENT,
      positionId: params.positionId,
      sizeRaw: size,
      acceptablePriceRaw: acceptablePrice,
    };
    return {
      action: intent.action,
      intent,
      request: {
        kind: "reducePosition",
        ticker,
        positionId: params.positionId,
        body: {
          accountId: this.accountId,
          size,
          acceptablePrice,
        },
      },
      context: { referencePrice: spot, boundKind: position.side === "long" ? "min" : "max", fill: position.side === "long" ? "sell" : "buy" },
    };
  }

  increasePosition(
    params: ClosePositionParams & {
      collateral: string | number;
      leverage?: number;
      size?: string | number;
    },
  ): Promise<ExecuteResult> {
    return this.planIncreasePosition(params).then((plan) => this.submit(plan, params));
  }

  /** The plan increasePosition submits. Derives everything; authorizes and builds nothing. */
  async planIncreasePosition(
    params: ClosePositionParams & {
      collateral: string | number;
      leverage?: number;
      size?: string | number;
    },
  ): Promise<TradePlan> {
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

    const intent: WriteIntent = {
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
    };
    return {
      action: intent.action,
      intent,
      request: {
        kind: "increasePosition",
        ticker,
        positionId: params.positionId,
        body: {
          accountId: this.accountId,
          collateralAmount: toRawCollateral(params.collateral),
          size,
          acceptablePrice,
        },
      },
      context: { referencePrice: spot, boundKind: position.side === "long" ? "max" : "min", fill: position.side === "long" ? "buy" : "sell" },
    };
  }

  /** Add margin to an open position, lowering its leverage. */
  addMargin(
    params: WriteOptions & { ticker: string; positionId: number; amount: string | number },
  ): Promise<ExecuteResult> {
    return this.planAddMargin(params).then((plan) => this.submit(plan, params));
  }

  /** The plan addMargin submits. Derives everything; authorizes and builds nothing. */
  async planAddMargin(
    params: WriteOptions & { ticker: string; positionId: number; amount: string | number },
  ): Promise<TradePlan> {
    const ticker = await this.markets.resolveTicker(params.ticker);
    // Adding margin lowers leverage; it is not metered as new exposure.
    const intent: WriteIntent = {
      action: "addMargin",
      accountId: this.accountId,
      increasesExposure: false,
      ticker,
      positionId: params.positionId,
      collateralRaw: toRawCollateral(params.amount),
    };
    return {
      action: intent.action,
      intent,
      request: {
        kind: "depositMargin",
        ticker,
        positionId: params.positionId,
        body: {
          accountId: this.accountId,
          collateralAmount: toRawCollateral(params.amount),
        },
      },
      context: { note: "adds margin to an open position, lowering its leverage" },
    };
  }

  /** Withdraw margin from an open position, raising its leverage. */
  removeMargin(
    params: WriteOptions & { ticker: string; positionId: number; amount: string | number },
  ): Promise<ExecuteResult> {
    return this.planRemoveMargin(params).then((plan) => this.submit(plan, params));
  }

  /** The plan removeMargin submits. Derives everything; authorizes and builds nothing. */
  async planRemoveMargin(
    params: WriteOptions & { ticker: string; positionId: number; amount: string | number },
  ): Promise<TradePlan> {
    const ticker = await this.markets.resolveTicker(params.ticker);
    // Removing margin raises leverage on a live position, so the ceiling has to
    // see the leverage that results — metering the withdrawn amount alone would
    // let a position be levered arbitrarily high one small withdrawal at a time.
    const position = await this.requirePosition(ticker, params.positionId);
    const remaining = position.collateral - Number(params.amount);
    const intent: WriteIntent = {
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
    };
    return {
      action: intent.action,
      intent,
      request: {
        kind: "withdrawMargin",
        ticker,
        positionId: params.positionId,
        body: {
          accountId: this.accountId,
          amount: toRawCollateral(params.amount),
        },
      },
      context: { note: "withdraws margin from an open position, raising its leverage" },
    };
  }

  // ─── Orders ─────────────────────────────────────────────────────────────

  /**
   * Place a resting limit or stop order.
   *
   * A crossing limit is refused before the request is sent — see
   * `assertNotCrossing`.
   */
  placeLimitOrder(params: LimitOrderParams): Promise<ExecuteResult> {
    return this.planPlaceLimitOrder(params).then((plan) => this.submit(plan, params));
  }

  /** The plan placeLimitOrder submits. Derives everything; authorizes and builds nothing. */
  async planPlaceLimitOrder(params: LimitOrderParams): Promise<TradePlan> {
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

    const intent: WriteIntent = {
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
    };
    return {
      action: intent.action,
      intent,
      request: {
        kind: "limitOrder",
        body: {
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
        },
      },
      context: { referencePrice: spot, fill: params.isLong ? "buy" : "sell" },
    };
  }

  /** Attach TP and/or SL to an already-open position. */
  placeTpSl(
    params: WriteOptions & {
      ticker: string;
      positionId: number;
      takeProfitPrice?: string | number;
      stopLossPrice?: string | number;
      /** Base-asset size. Defaults to the position's full size. */
      size?: string | number;
    },
  ): Promise<ExecuteResult> {
    return this.planPlaceTpSl(params).then((plan) => this.submit(plan, params));
  }

  /** The plan placeTpSl submits. Derives everything; authorizes and builds nothing. */
  async planPlaceTpSl(
    params: WriteOptions & {
      ticker: string;
      positionId: number;
      takeProfitPrice?: string | number;
      stopLossPrice?: string | number;
      /** Base-asset size. Defaults to the position's full size. */
      size?: string | number;
    },
  ): Promise<TradePlan> {
    if (params.takeProfitPrice === undefined && params.stopLossPrice === undefined) {
      throw new UsageError("placeTpSl: pass takeProfitPrice, stopLossPrice, or both.");
    }
    const ticker = await this.markets.resolveTicker(params.ticker);
    const position = await this.requirePosition(ticker, params.positionId);
    const size = toRawSize(params.size ?? position.sizeInAsset);
    // The same list the request is built from, so the authorization cannot
    // describe a different set of legs than the transaction carries.
    const legs = bracketLegs(params, position.side === "long", size);

    // No `side` on purpose: a bracket leg is reduce-only and takes the
    // OPPOSITE side of the position it protects — the backend stamps
    // `isLong: !position.isLong` — so the position's side here would make the
    // verifier refuse every bracket. `reduceOnly` is what distinguishes this
    // from an opening order, which shares its entrypoint, account and market.
    const intent: WriteIntent = {
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
    };
    return {
      action: intent.action,
      intent,
      request: {
        kind: "placeTpSl",
        body: {
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
        },
      },
      context: {
        fill: position.side === "long" ? "sell" : "buy",
        note: "reduce-only legs attached to an open position",
      },
    };
  }

  /**
   * Re-price and re-size a resting order.
   *
   * The contract locates the order by its *current* trigger price and book, so
   * both are read from the live order rather than taken from the caller — a
   * mismatch there is not found, not corrected.
   */
  updateOrder(
    params: WriteOptions & {
      ticker: string;
      orderId: number;
      newTriggerPrice: string | number;
      newSize: string | number;
    },
  ): Promise<ExecuteResult> {
    return this.planUpdateOrder(params).then((plan) => this.submit(plan, params));
  }

  /** The plan updateOrder submits. Derives everything; authorizes and builds nothing. */
  async planUpdateOrder(
    params: WriteOptions & {
      ticker: string;
      orderId: number;
      newTriggerPrice: string | number;
      newSize: string | number;
    },
  ): Promise<TradePlan> {
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
    const intent: WriteIntent = {
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
    };
    return {
      action: intent.action,
      intent,
      request: {
        kind: "updateOrder",
        ticker,
        orderId: params.orderId,
        body: {
          accountId: this.accountId,
          currentTriggerPrice: toRawPrice(order.triggerPrice),
          orderTypeTag: order.orderTypeTag,
          newTriggerPrice: toRawPrice(params.newTriggerPrice),
          newSize: toRawSize(params.newSize),
        },
      },
      context: { referencePrice: spot, fill: order.side === "long" ? "buy" : "sell" },
    };
  }

  cancelOrder(
    params: WriteOptions & { ticker: string; orderId: number },
  ): Promise<ExecuteResult> {
    return this.planCancelOrder(params).then((plan) => this.submit(plan, params));
  }

  /** The plan cancelOrder submits. Derives everything; authorizes and builds nothing. */
  async planCancelOrder(
    params: WriteOptions & { ticker: string; orderId: number },
  ): Promise<TradePlan> {
    const ticker = await this.markets.resolveTicker(params.ticker);
    const intent: WriteIntent = {
      action: "cancelOrder",
      accountId: this.accountId,
      increasesExposure: false,
      ticker,
      orderId: params.orderId,
    };
    return {
      action: intent.action,
      intent,
      request: {
        kind: "cancelOrder",
        ticker,
        orderId: params.orderId,
        body: {
          accountId: this.accountId,
        },
      },
      context: { note: "cancels a resting order" },
    };
  }

  // ─── Account ────────────────────────────────────────────────────────────

  /** Create a WaterX trading account. The id is emitted by the indexer, not returned here. */
  createAccount(
    params: WriteOptions & { name: string; referralCode?: string },
  ): Promise<ExecuteResult> {
    return this.planCreateAccount(params).then((plan) => this.submit(plan, params));
  }

  /** The plan createAccount submits. Derives everything; authorizes and builds nothing. */
  async planCreateAccount(
    params: WriteOptions & { name: string; referralCode?: string },
  ): Promise<TradePlan> {
    const intent: WriteIntent = {
      action: "createAccount",
      accountId: "",
      increasesExposure: false,
      alias: params.name,
    };
    return {
      action: intent.action,
      intent,
      request: {
        kind: "createAccount",
        body: {
          name: params.name,
          ...(params.referralCode !== undefined ? { referralCode: params.referralCode } : {}),
        },
      },
      context: { note: "creates a WaterX trading account; the indexer assigns its id" },
    };
  }

  /**
   * Mint wxUSD credit against a backing asset.
   *
   * `assetType` is the fully-qualified Move type of the coin being deposited —
   * deposit is a credit mint against the custody vault now, not a transfer of
   * a fixed collateral coin.
   */
  deposit(
    params: WriteOptions & { assetType: string; amount: string | number },
  ): Promise<ExecuteResult> {
    return this.planDeposit(params).then((plan) => this.submit(plan, params));
  }

  /** The plan deposit submits. Derives everything; authorizes and builds nothing. */
  async planDeposit(
    params: WriteOptions & { assetType: string; amount: string | number },
  ): Promise<TradePlan> {
    const intent: WriteIntent = {
      action: "deposit",
      accountId: this.accountId,
      increasesExposure: false,
      // A deposit is paid from the signer's own balance, and the amount and
      // asset live in that reservation rather than in any call argument.
      movesFundsIn: true,
      collateralRaw: toRawTokenAmount(params.amount),
      assetType: params.assetType,
    };
    return {
      action: intent.action,
      intent,
      request: {
        kind: "deposit",
        body: {
          accountId: this.accountId,
          assetType: params.assetType,
          amount: toRawTokenAmount(params.amount),
        },
      },
      context: { note: "mints wxUSD credit against a backing asset the wallet already holds" },
    };
  }

  /**
   * Withdraw to a stablecoin on Sui.
   *
   * Funds-out is **owner-only** on chain, so this refuses up front when the
   * process holds a delegate key rather than letting the chain abort.
   */
  withdraw(
    params: WriteOptions & { assetType: string; amount: string | number; toAddress?: string },
  ): Promise<ExecuteResult> {
    return this.planWithdraw(params).then((plan) => this.submit(plan, params));
  }

  /** The plan withdraw submits. Derives everything; authorizes and builds nothing. */
  async planWithdraw(
    params: WriteOptions & { assetType: string; amount: string | number; toAddress?: string },
  ): Promise<TradePlan> {
    this.assertOwnerSigned("withdraw");
    const intent: WriteIntent = {
      action: "withdraw",
      accountId: this.accountId,
      increasesExposure: false,
      collateralRaw: toRawCollateral(params.amount),
      // Where the money lands. The contract takes this as an argument, so it
      // is the agent's to state rather than the contract's to be trusted on.
      recipient: params.toAddress ?? this.ownerAddress,
      // Which coin comes out. It is the route call's type argument, and
      // appears nowhere in `request_withdraw` itself.
      assetType: params.assetType,
    };
    return {
      action: intent.action,
      intent,
      request: {
        kind: "withdraw",
        body: {
          accountId: this.accountId,
          route: "native",
          assetType: params.assetType,
          amount: toRawTokenAmount(params.amount),
          ...(params.toAddress !== undefined ? { toAddress: params.toAddress } : {}),
        },
      },
      context: { note: "moves funds out of the account — owner-only on chain" },
    };
  }

  /**
   * Grant a delegate authority over this account.
   *
   * The masks are independent and key on different on-chain scopes: perp
   * authority grants nothing on predict or staking, and none of them grants a
   * funds-out path — that stayed owner-only after the delegate-phishing
   * hardening. Use `PERM_*` from `@waterx/sdk` rather than literals.
   */
  addDelegate(
    params: WriteOptions & {
      delegate: string;
      perpPermissions?: number;
      predictPermissions?: number;
      stakingPermissions?: number;
    },
  ): Promise<ExecuteResult> {
    return this.planAddDelegate(params).then((plan) => this.submit(plan, params));
  }

  /** The plan addDelegate submits. Derives everything; authorizes and builds nothing. */
  async planAddDelegate(
    params: WriteOptions & {
      delegate: string;
      perpPermissions?: number;
      predictPermissions?: number;
      stakingPermissions?: number;
    },
  ): Promise<TradePlan> {
    this.assertOwnerSigned("addDelegate");
    // Sent explicitly rather than left to the backend's default: a mask the
    // agent did not choose is one it cannot bound, and the grant would then be
    // ceilinged against a guess.
    const perpPermissions = params.perpPermissions ?? PERM_ALL_TRADING;
    const predictPermissions = params.predictPermissions ?? 0;
    const stakingPermissions = params.stakingPermissions ?? 0;
    const intent: WriteIntent = {
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
    };
    return {
      action: intent.action,
      intent,
      request: {
        kind: "addDelegate",
        body: {
          accountId: this.accountId,
          delegate: params.delegate,
          perpPermissions,
          predictPermissions,
          stakingPermissions,
        },
      },
      context: { note: "grants a delegate authority over this account" },
    };
  }

  removeDelegate(params: WriteOptions & { delegate: string }): Promise<ExecuteResult> {
    return this.planRemoveDelegate(params).then((plan) => this.submit(plan, params));
  }

  /** The plan removeDelegate submits. Derives everything; authorizes and builds nothing. */
  async planRemoveDelegate(params: WriteOptions & { delegate: string }): Promise<TradePlan> {
    this.assertOwnerSigned("removeDelegate");
    const intent: WriteIntent = {
      action: "removeDelegate",
      accountId: this.accountId,
      increasesExposure: false,
      delegateAddress: params.delegate,
    };
    return {
      action: intent.action,
      intent,
      request: {
        kind: "removeDelegate",
        body: {
          accountId: this.accountId,
          delegate: params.delegate,
        },
      },
      context: { note: "revokes a delegate" },
    };
  }

  /** Revoke every delegate across all of the owner's accounts, in one transaction. */
  removeAllDelegates(params: WriteOptions = {}): Promise<ExecuteResult> {
    return this.planRemoveAllDelegates(params).then((plan) => this.submit(plan, params));
  }

  /** The plan removeAllDelegates submits. Derives everything; authorizes and builds nothing. */
  async planRemoveAllDelegates(params: WriteOptions = {}): Promise<TradePlan> {
    this.assertOwnerSigned("removeAllDelegates");
    const intent: WriteIntent = {
      action: "removeAllDelegates",
      accountId: this.accountId,
      increasesExposure: false,
    };
    return {
      action: intent.action,
      intent,
      request: { kind: "removeAllDelegates" },
      context: { note: "revokes every delegate across all of the owner\u2019s accounts" },
    };
  }

  // ─── WLP ────────────────────────────────────────────────────────────────

  mintWlp(params: WriteOptions & { amount: string | number }): Promise<ExecuteResult> {
    return this.planMintWlp(params).then((plan) => this.submit(plan, params));
  }

  /** The plan mintWlp submits. Derives everything; authorizes and builds nothing. */
  async planMintWlp(params: WriteOptions & { amount: string | number }): Promise<TradePlan> {
    // Minting commits capital to the pool, so it is metered against the same
    // ceilings an opening order is — a bounded agent that could mint without
    // limit would be bounded only on paper.
    const intent: WriteIntent = {
      action: "mintWlp",
      accountId: this.accountId,
      increasesExposure: true,
      collateral: Number(params.amount),
      collateralRaw: toRawCollateral(params.amount),
    };
    return {
      action: intent.action,
      intent,
      request: {
        kind: "mintWlp",
        body: {
          accountId: this.accountId,
          amount: toRawTokenAmount(params.amount),
        },
      },
      context: { note: "commits capital to the liquidity pool" },
    };
  }

  /** Queue a WLP redemption. Settlement runs through the withdrawal queue. */
  burnWlp(params: WriteOptions & { amount: string | number }): Promise<ExecuteResult> {
    return this.planBurnWlp(params).then((plan) => this.submit(plan, params));
  }

  /** The plan burnWlp submits. Derives everything; authorizes and builds nothing. */
  async planBurnWlp(params: WriteOptions & { amount: string | number }): Promise<TradePlan> {
    const intent: WriteIntent = {
      action: "burnWlp",
      accountId: this.accountId,
      increasesExposure: false,
      amountRaw: toRawTokenAmount(params.amount),
    };
    return {
      action: intent.action,
      intent,
      request: {
        kind: "burnWlp",
        body: {
          accountId: this.accountId,
          amount: toRawTokenAmount(params.amount),
        },
      },
      context: { note: "queues a WLP redemption through the withdrawal queue" },
    };
  }

  cancelWlpBurn(
    params: WriteOptions & { requestId: string | number },
  ): Promise<ExecuteResult> {
    return this.planCancelWlpBurn(params).then((plan) => this.submit(plan, params));
  }

  /** The plan cancelWlpBurn submits. Derives everything; authorizes and builds nothing. */
  async planCancelWlpBurn(
    params: WriteOptions & { requestId: string | number },
  ): Promise<TradePlan> {
    const intent: WriteIntent = {
      action: "cancelWlpBurn",
      accountId: this.accountId,
      increasesExposure: false,
      requestId: Number(params.requestId),
    };
    return {
      action: intent.action,
      intent,
      request: {
        kind: "cancelWlpBurn",
        body: {
          accountId: this.accountId,
          requestId: String(params.requestId),
        },
      },
      context: { note: "cancels a queued WLP redemption" },
    };
  }

  claimWlpRewards(params: WriteOptions = {}): Promise<ExecuteResult> {
    return this.planClaimWlpRewards(params).then((plan) => this.submit(plan, params));
  }

  /** The plan claimWlpRewards submits. Derives everything; authorizes and builds nothing. */
  async planClaimWlpRewards(params: WriteOptions = {}): Promise<TradePlan> {
    const intent: WriteIntent = {
      action: "claimWlpRewards",
      accountId: this.accountId,
      increasesExposure: false,
    };
    return {
      action: intent.action,
      intent,
      request: { kind: "claimWlpRewards", body: { accountId: this.accountId } },
      context: { note: "claims accrued WLP rewards" },
    };
  }

  // ─── Convenience reads ──────────────────────────────────────────────────

  /**
   * The WaterX accounts an owner holds.
   *
   * `owner` is a parameter so this stays a read: without one it falls back to
   * `ownerAddress`, which loads the key only when no owner was configured.
   */
  accounts(owner?: string): Promise<AccountData[]> {
    return this.read.accounts(owner ?? this.ownerAddress);
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
      throw new ExecutionPolicyError(
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
      throw new UsageError(
        `No open position ${ticker}#${String(positionId)}. Open positions: ${open}`,
      );
    }
    return match;
  }

  private async requireOrder(ticker: string, orderId: number): Promise<OrderResponse> {
    const orders = await this.read.orders({ account: this.accountId });
    const match = orders.find((o) => o.ticker === ticker && o.id === String(orderId));
    if (match === undefined) {
      const open = orders.map((o) => `${o.ticker}#${o.id}`).join(", ") || "none";
      throw new UsageError(`No resting order ${ticker}#${String(orderId)}. Open orders: ${open}`);
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
    throw new UsageError(
      "Pass either `leverage` or `size` — the position cannot be sized without one.",
    );
  }
  if (!Number.isFinite(params.leverage) || params.leverage < 1) {
    throw new UsageError(`Leverage ${String(params.leverage)} must be at least 1.`);
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
    throw new UsageError(
      `Cannot size an order from collateral ${String(collateral)} at ${String(leverage)}x.`,
    );
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
    throw new UsageError(
      `On a ${isLong ? "long" : "short"}, take-profit ${String(tp)} and stop-loss ${String(sl)} are ` +
        `the wrong way round — check the pair before sending it.`,
    );
  }
}

function reduceByPercent(sizeInAsset: number, percent: number | undefined): string {
  if (percent === undefined) {
    throw new UsageError("reducePosition: pass either `size` or `percent`.");
  }
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    throw new UsageError(`reducePosition: percent ${String(percent)} must be within (0, 100].`);
  }
  return ((sizeInAsset * percent) / 100).toFixed(9);
}
