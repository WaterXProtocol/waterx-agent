/**
 * A protective order must not be larger than the position it protects.
 *
 * After a partial close the linked stop and take-profit keep their original size:
 * a position reduced to 5.93 was still showing a stop for 11.87. Both are
 * reduce-only, so neither can close more than exists — which is why this is a
 * clarity bug rather than a money one — but an operator reading 11.87 is reading
 * protection that is not there, and an agent relaying it says something false.
 *
 * **Driven by an observed position, never by an expected one.** This is the whole
 * of the design. A reduce returns when the request is on chain and a keeper fills
 * it afterwards, so at the moment `reduce` returns the position is usually still
 * its original size. Resizing a stop to the size the position is ABOUT to be
 * would leave it under-protected until the fill lands — and of the two ways to be
 * wrong, under-protection in a falling market is the one that costs money.
 * Over-protection does not: an oversized reduce-only stop closes what is there.
 *
 * So the rule is stated against what the chain says right now, which makes it
 * idempotent: run it before the fill and it finds nothing to do; run it twice
 * after and the second run is a no-op. Nothing here reads a delta.
 */
import type { OrderResponse, Position } from "../api/types.ts";

/** One protective order that is larger than the position it is attached to. */
export interface OversizedStop {
  orderId: number;
  ticker: string;
  /** `stop-loss` or `take-profit`, by which side of spot it rests on. */
  kind: "stop-loss" | "take-profit" | "protective";
  /** What it is sized for now, in the base asset. */
  size: number;
  /** What it should be, which is the position's own size. */
  shouldBe: number;
  /** Unchanged. Resizing must not reprice: where a stop sits is the trader's. */
  triggerPrice: number;
}

/**
 * Which of a position's linked orders are larger than the position itself.
 *
 * Only reduce-only orders. A resting order that would OPEN exposure is not
 * protection and is not bounded by the position's size — shrinking one would be
 * editing somebody's entry.
 *
 * Both a stop and a take-profit, because the defect is identical and fixing one
 * of a pair is how a half-checked set starts.
 */
export function oversizedStops(position: Position): OversizedStop[] {
  const holds = position.sizeInAsset;
  // A position with no size is being closed or was never opened. Nothing is
  // oversized relative to nothing, and the protocol cancels the legs itself when
  // a position closes — so an empty one yields no work rather than a resize to 0.
  if (!(holds > 0)) return [];

  return position.linkedOrders
    .filter((order) => order.reduceOnly && order.sizeInAsset > holds)
    .map((order) => ({
      orderId: Number(order.id),
      ticker: order.ticker,
      kind: kindOf(order, position),
      size: order.sizeInAsset,
      shouldBe: holds,
      triggerPrice: order.triggerPrice,
    }));
}

/**
 * Which leg of the bracket this is, from where it sits relative to entry.
 *
 * Reported for the operator's benefit only — nothing branches on it. `protective`
 * when the prices do not say: a leg exactly at entry is neither, and guessing
 * would name the wrong one in a refusal somebody reads.
 */
function kindOf(order: OrderResponse, position: Position): OversizedStop["kind"] {
  const entry = position.entryPrice;
  if (!(entry > 0) || order.triggerPrice === entry) return "protective";
  const above = order.triggerPrice > entry;
  if (position.side === "long") return above ? "take-profit" : "stop-loss";
  return above ? "stop-loss" : "take-profit";
}

/** One line per oversized leg, for a human and for a refusal. */
export const describeOversized = (stop: OversizedStop): string =>
  `${stop.ticker}#${String(stop.orderId)} (${stop.kind}) is sized ${stop.size} for a position ` +
  `holding ${stop.shouldBe}`;
