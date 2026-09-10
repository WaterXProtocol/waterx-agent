/**
 * A decision, fully derived, before anything is authorized or built.
 *
 * The reason this type exists is the preview → approve → execute path. Those
 * are three separate processes, so whatever a human approves has to survive
 * being written to a file and read back — which rules out the closure that used
 * to carry the request. A plan is therefore *data*: the intent the gate will
 * authorize, a serializable description of the build call, and the numbers a
 * person needs to see before saying yes.
 *
 * It also removes the thing that would otherwise be dangerous about a preview:
 * if `preview` derived the size and the acceptable price, and `execute` derived
 * them again a minute later, the two would differ by whatever the market did in
 * between — and the human would have approved neither. Deriving once and
 * carrying the result means the bytes signed are the bytes described.
 *
 * `request` deliberately omits `sender` and `delegateSender`. Those come from
 * the executor at build time, which is what lets a plan be *made* by a process
 * holding no key at all.
 */
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
  TxResponse,
  UpdateOrderBody,
  WithdrawBody,
  WithdrawMarginBody,
} from "../api/types.ts";
import type { TxApi } from "../api/tx.ts";
import type { WriteIntent } from "../policy.ts";
import { fromRawCollateral, fromRawFloat } from "../units.ts";

/** A request body with the sender fields removed — the executor supplies those. */
type Unsigned<T> = Omit<T, "sender" | "delegateSender">;

/**
 * Which backend build call this plan makes, and with what.
 *
 * A tagged union rather than a function, because it has to round-trip through
 * JSON. `buildTx` below is the only place that turns one back into a call, so
 * a new action is a case in two places and cannot be half-added.
 */
export type BuildRequest =
  | { kind: "marketOrder"; body: Unsigned<MarketOrderBody> }
  | { kind: "limitOrder"; body: Unsigned<PlaceOrderBody> }
  | { kind: "placeTpSl"; body: Unsigned<PlaceTpSlBody> }
  | { kind: "updateOrder"; ticker: string; orderId: number; body: Unsigned<UpdateOrderBody> }
  | { kind: "cancelOrder"; ticker: string; orderId: number; body: Unsigned<CancelOrderBody> }
  | { kind: "closePosition"; ticker: string; positionId: number; body: Unsigned<ClosePositionBody> }
  | { kind: "reducePosition"; ticker: string; positionId: number; body: Unsigned<ReducePositionBody> }
  | { kind: "increasePosition"; ticker: string; positionId: number; body: Unsigned<IncreasePositionBody> }
  | { kind: "depositMargin"; ticker: string; positionId: number; body: Unsigned<DepositMarginBody> }
  | { kind: "withdrawMargin"; ticker: string; positionId: number; body: Unsigned<WithdrawMarginBody> }
  | { kind: "createAccount"; body: Unsigned<CreateAccountBody> }
  | { kind: "deposit"; body: Unsigned<DepositBody> }
  | { kind: "withdraw"; body: Unsigned<WithdrawBody> }
  | { kind: "addDelegate"; body: Unsigned<AddDelegateBody> }
  | { kind: "removeDelegate"; body: Unsigned<RemoveDelegateBody> }
  | { kind: "removeAllDelegates" }
  | { kind: "mintWlp"; body: Unsigned<MintWlpBody> }
  | { kind: "burnWlp"; body: Unsigned<BurnWlpBody> }
  | { kind: "cancelWlpBurn"; body: Unsigned<CancelWlpBurnBody> }
  | { kind: "claimWlpRewards"; body: Unsigned<ClaimWlpRewardsBody> };

/** The sender fields the executor contributes, spread into every body. */
export interface SenderFields {
  sender: string;
  delegateSender?: string;
}

/**
 * Turn a request back into the backend call it describes.
 *
 * The exhaustiveness check at the bottom is load-bearing: an action added to
 * the union and forgotten here would be a plan that previews, gets approved,
 * and then cannot be built — the worst moment to discover it.
 */
export function buildTx(tx: TxApi, request: BuildRequest, who: SenderFields): Promise<TxResponse> {
  switch (request.kind) {
    case "marketOrder":
      return tx.marketOrder({ ...request.body, ...who });
    case "limitOrder":
      return tx.limitOrder({ ...request.body, ...who });
    case "placeTpSl":
      return tx.placeTpSl({ ...request.body, ...who });
    case "updateOrder":
      return tx.updateOrder(request.ticker, request.orderId, { ...request.body, ...who });
    case "cancelOrder":
      return tx.cancelOrder(request.ticker, request.orderId, { ...request.body, ...who });
    case "closePosition":
      return tx.closePosition(request.ticker, request.positionId, { ...request.body, ...who });
    case "reducePosition":
      return tx.reducePosition(request.ticker, request.positionId, { ...request.body, ...who });
    case "increasePosition":
      return tx.increasePosition(request.ticker, request.positionId, { ...request.body, ...who });
    case "depositMargin":
      return tx.depositMargin(request.ticker, request.positionId, { ...request.body, ...who });
    case "withdrawMargin":
      return tx.withdrawMargin(request.ticker, request.positionId, { ...request.body, ...who });
    case "createAccount":
      return tx.createAccount({ ...request.body, ...who });
    case "deposit":
      return tx.deposit({ ...request.body, ...who });
    case "withdraw":
      return tx.withdraw({ ...request.body, ...who });
    case "addDelegate":
      return tx.addDelegate({ ...request.body, ...who });
    case "removeDelegate":
      return tx.removeDelegate({ ...request.body, ...who });
    case "removeAllDelegates":
      return tx.removeAllDelegates(who);
    case "mintWlp":
      return tx.mintWlp({ ...request.body, ...who });
    case "burnWlp":
      return tx.burnWlp({ ...request.body, ...who });
    case "cancelWlpBurn":
      return tx.cancelWlpBurn({ ...request.body, ...who });
    case "claimWlpRewards":
      return tx.claimWlpRewards({ ...request.body, ...who });
    default: {
      const unreachable: never = request;
      throw new Error(`No build call for ${JSON.stringify(unreachable)}.`);
    }
  }
}

/**
 * One reduce-only bracket leg, as a person reads it.
 *
 * `kind` rather than `isStopOrder`, because "stop = true" is not what anyone
 * checks before approving — they check that the take-profit is on the
 * profitable side.
 */
export interface PreviewLeg {
  kind: "take-profit" | "stop-loss";
  triggerPrice: number;
  /** The side the leg takes: the opposite of the position it protects. */
  side: "long" | "short";
}

/**
 * The bound beyond which the order must not fill.
 *
 * `kind` says which end it caps, and it is not derivable from the side alone —
 * a `max` on a long entry and a `min` on that same long's exit are both "the
 * price that protects me". Stating it removes the step where a reviewer has to
 * work that out, which is the step people get wrong.
 */
export interface PreviewBound {
  kind: "max" | "min";
  price: number;
  slippagePercent?: number;
}

/**
 * Live context a plan carries only so the preview can be rendered.
 *
 * Deliberately small. Everything a person needs to check is already in the
 * intent — that is the object the gate authorizes and the verifier binds the
 * transaction to — and re-stating any of it here would create a second copy
 * that could disagree with the first. What is left is what the intent has no
 * field for: the spot price the numbers were derived from, and which end of
 * the market the acceptable price caps.
 */
export interface PlanContext {
  /** Spot at the moment the plan was made. */
  referencePrice?: number;
  /** Which end `acceptablePriceRaw` caps. Depends on whether this enters or exits. */
  boundKind?: "max" | "min";
  /** Which way this transaction trades. An exit on a long is a `sell`. */
  fill?: "buy" | "sell";
  /** For the handful of actions with no numbers worth tabulating. */
  note?: string;
}

/** A derived decision: what it does, what it authorizes, and how to build it. */
export interface TradePlan {
  action: string;
  intent: WriteIntent;
  request: BuildRequest;
  context: PlanContext;
}

/**
 * What a human is shown before approving, and what an agent renders.
 *
 * Display units throughout — dollars and base assets — because the 1e9-scaled
 * integers the transaction carries are not something a person can sanity check.
 */
export interface Preview {
  action: string;
  ticker?: string;
  /** The position's direction. Absent for actions that have none. */
  side?: "long" | "short";
  /** Which way this transaction trades. */
  fill?: "buy" | "sell";
  collateralUsd?: number;
  leverage?: number;
  sizeBase?: number;
  notionalUsd?: number;
  /** Spot at the moment the plan was made. What everything below was derived from. */
  referencePrice?: number;
  bound?: PreviewBound;
  /** Where a resting order rests. */
  triggerPrice?: number;
  isStopOrder?: boolean;
  reduceOnly?: boolean;
  positionId?: number;
  orderId?: number;
  legs?: PreviewLeg[];
  /** Amount and asset for the funds-moving actions. */
  amount?: number;
  assetType?: string;
  recipient?: string;
  delegate?: string;
  note?: string;
}

/**
 * Render a plan for a person, **derived from the intent** rather than written
 * beside it.
 *
 * That is the whole design of this function. A preview authored per action
 * would be a second description of the order, maintained by hand next to the
 * first — and the failure mode of two descriptions is that a change lands in
 * one of them. Here the only thing a person can be shown is a decoding of the
 * exact object the policy gate authorizes and the verifier binds the
 * transaction to. A preview that is wrong about the order is therefore a
 * preview of a different order, which cannot happen: there is one object.
 */
export function previewOf(plan: TradePlan): Preview {
  const { intent, context } = plan;
  const size = intent.sizeRaw === undefined ? undefined : fromRawFloat(intent.sizeRaw);
  const reference = context.referencePrice;
  // Notional from the price this order will actually transact at: a resting
  // order fills at its own trigger, everything else at spot.
  const priceForNotional =
    intent.triggerPriceRaw !== undefined ? fromRawFloat(intent.triggerPriceRaw) : reference;

  const preview: Preview = { action: plan.action };
  const set = <K extends keyof Preview>(key: K, value: Preview[K] | undefined): void => {
    if (value !== undefined) preview[key] = value;
  };

  set("ticker", intent.ticker);
  set("side", intent.side);
  set("fill", context.fill);
  set("collateralUsd", intent.collateral);
  set("leverage", intent.leverage);
  set("sizeBase", size);
  set(
    "notionalUsd",
    size !== undefined && priceForNotional !== undefined ? size * priceForNotional : undefined,
  );
  set("referencePrice", reference);
  set(
    "triggerPrice",
    intent.triggerPriceRaw === undefined ? undefined : fromRawFloat(intent.triggerPriceRaw),
  );
  set("isStopOrder", intent.isStopOrder);
  set("reduceOnly", intent.reduceOnly);
  set("positionId", intent.positionId);
  set("orderId", intent.orderId);
  set("recipient", intent.recipient);
  set("assetType", intent.assetType);
  set("delegate", intent.delegateAddress);
  set("note", context.note);

  // The amount that is not collateral: a WLP redemption, a deposit paid in a
  // backing asset. Both share the collateral scale.
  if (intent.amountRaw !== undefined) set("amount", fromRawCollateral(intent.amountRaw));
  else if (intent.collateral === undefined && intent.collateralRaw !== undefined) {
    set("amount", fromRawCollateral(intent.collateralRaw));
  }

  if (intent.acceptablePriceRaw !== undefined && context.boundKind !== undefined) {
    preview.bound = {
      kind: context.boundKind,
      price: fromRawFloat(intent.acceptablePriceRaw),
      ...(intent.slippagePercent === undefined ? {} : { slippagePercent: intent.slippagePercent }),
    };
  }

  if (intent.legs !== undefined && intent.legs.length > 0) {
    preview.legs = intent.legs.map((leg) => ({
      kind: leg.isStopOrder ? ("stop-loss" as const) : ("take-profit" as const),
      triggerPrice: fromRawFloat(leg.triggerPriceRaw),
      side: leg.isLong ? ("long" as const) : ("short" as const),
    }));
  }

  return preview;
}
