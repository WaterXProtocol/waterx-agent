/**
 * What the account is carrying, and what about it a person must hear first.
 *
 * `next` answers "where am I, and what should I offer?" — and it answered the
 * first half about the PROCESS and said nothing about the ACCOUNT. An install
 * adopted a live mainnet account holding ten positions, $11.85 of free margin
 * against $312 of notional, and a 10x short about 6% from its estimated
 * liquidation priced off a feed that had stopped — and the only thing `next`
 * said was `read-only`. Every number above came from reads it had already made.
 *
 * So this turns those reads into sentences. It is a pure function of what the
 * caller found: no I/O, no client, nothing to mock. The caller decides what to
 * do with them; `decide()` carries them on every state, because a dead price
 * feed matters whether the process is `ready` or half configured.
 */
import type { Position } from "../api/types.ts";
import { EXITS } from "../chain/verify.ts";

/** How close to its liquidation estimate a position has to be to be worth saying. */
export const NEAR_LIQUIDATION_PERCENT = 15;

/** Free margin below this share of open notional is worth saying. */
export const THIN_MARGIN_RATIO = 0.1;

export interface NearLiquidation {
  ticker: string;
  id: string;
  side: Position["side"];
  leverage: number;
  /** How far spot is from the liquidation estimate, as a percentage of spot. */
  percent: number;
}

export interface Exposure {
  freeMargin: number;
  /**
   * Collateral committed to open positions, in display USD.
   *
   * The money that can actually be lost right now, which is what an operator
   * means when they cap "how much this agent may risk at a time". Notional is
   * the leveraged figure; this is the stake.
   */
  openCollateral: number;
  /** Open notional in USD, which is what leverage is applied to. */
  notional: number;
  positions: number;
  orders: number;
  /** Positions whose price is not a live read — their PnL and estimates are not real. */
  stale: number;
  /** The backend could not price everything it summed. */
  degraded: boolean;
  /** Which reads it could not price, when it says. */
  degradedReads: string[];
  nearLiquidation: NearLiquidation[];
}

const asNumber = (value: unknown): number => (typeof value === "number" && isFinite(value) ? value : 0);

/** Read `degraded` / `degradedReads` off an overview that is typed `unknown`. */
function degradation(overview: unknown): { degraded: boolean; degradedReads: string[] } {
  if (typeof overview !== "object" || overview === null) return { degraded: false, degradedReads: [] };
  const record = overview as Record<string, unknown>;
  const reads = record["degradedReads"];
  return {
    degraded: record["degraded"] === true,
    degradedReads: Array.isArray(reads) ? reads.filter((r): r is string => typeof r === "string") : [],
  };
}

export function summarise(input: {
  overview: unknown;
  positions: readonly Position[];
  orders: number;
}): Exposure {
  const { degraded, degradedReads } = degradation(input.overview);
  const freeMargin = asNumber(
    typeof input.overview === "object" && input.overview !== null
      ? (input.overview as Record<string, unknown>)["freeMargin"]
      : 0,
  );

  const nearLiquidation: NearLiquidation[] = [];
  let notional = 0;
  let openCollateral = 0;
  let stale = 0;
  for (const position of input.positions) {
    notional += asNumber(position.size);
    openCollateral += asNumber(position.collateral);
    if (position.priceStale) {
      stale += 1;
      // Distance is computed from spot, and spot is not a live read here. A
      // number derived from it would be a guess wearing a percentage sign.
      continue;
    }
    // `estLiqPrice: 0` means "cannot estimate", never "no liquidation risk".
    if (position.estLiqPrice <= 0 || position.spotPrice <= 0) continue;
    const percent = (Math.abs(position.spotPrice - position.estLiqPrice) / position.spotPrice) * 100;
    if (percent < NEAR_LIQUIDATION_PERCENT) {
      nearLiquidation.push({
        ticker: position.ticker,
        id: position.id,
        side: position.side,
        leverage: position.leverage,
        percent: Math.round(percent * 10) / 10,
      });
    }
  }

  return {
    freeMargin,
    openCollateral: Math.round(openCollateral * 100) / 100,
    notional: Math.round(notional * 100) / 100,
    positions: input.positions.length,
    orders: input.orders,
    stale,
    degraded,
    degradedReads,
    nearLiquidation,
  };
}

/**
 * The sentences, worst first.
 *
 * Ordered by what would cost the most to not know: a position priced from a
 * dead feed reports a PnL of zero and a liquidation estimate that is fiction,
 * and that is worse than a thin margin you can at least see.
 */
export function exposureWarnings(exposure: Exposure): string[] {
  const warnings: string[] = [];

  if (exposure.stale > 0) {
    warnings.push(
      `${String(exposure.stale)} open position(s) are priced from a feed that is not live. ` +
        `Their PnL and liquidation estimates are not real numbers — check the ticker before ` +
        `acting on any of them.`,
    );
  }

  for (const near of exposure.nearLiquidation) {
    warnings.push(
      `${near.ticker} #${near.id} (${near.side}, ${String(near.leverage)}x) is about ` +
        `${String(near.percent)}% from its estimated liquidation price.`,
    );
  }

  if (exposure.notional > 0 && exposure.freeMargin / exposure.notional < THIN_MARGIN_RATIO) {
    warnings.push(
      `Free margin is $${String(exposure.freeMargin)} against $${String(exposure.notional)} of ` +
        `open notional.`,
    );
  }

  if (exposure.degraded) {
    warnings.push(
      `The backend reports this account summary as degraded` +
        (exposure.degradedReads.length > 0 ? ` (${exposure.degradedReads.join(", ")})` : "") +
        `, so the totals are approximate.`,
    );
  }

  return warnings;
}

/** One line for the moment an account is adopted, when nobody knows what is in it yet. */
export function exposureLine(exposure: Exposure): string {
  return (
    `$${String(exposure.freeMargin)} free margin, ${String(exposure.positions)} open position(s) ` +
    `worth $${String(exposure.notional)}, ${String(exposure.orders)} resting order(s)`
  );
}

/** An order that was sent and has not settled, as the concurrent ceiling sees it. */
export interface InFlight {
  action: string;
  /** Display USD it commits. Absent on records written before this was kept. */
  collateral?: number;
}

/**
 * Collateral at risk right now: open positions, plus orders already sent that
 * nobody has filled.
 *
 * The second term is not a nicety. A keeper fills asynchronously, so two opens
 * sent seconds apart are both absent from `positions` — and a concurrent
 * ceiling that counted only positions would let them both through.
 *
 * A submission from before sizes were recorded has no amount. It is counted as
 * `perOrderCeiling`, because that is the most it can have been: every order
 * that got sent had already passed that ceiling. Counting it as zero would
 * widen the one thing this function exists to hold.
 */
export function openCollateralOf(
  positions: readonly Position[],
  inFlight: readonly InFlight[],
  perOrderCeiling: number,
): number {
  let total = 0;
  for (const position of positions) total += asNumber(position.collateral);
  for (const order of inFlight) {
    if (EXITS.has(order.action)) continue;
    total += order.collateral === undefined ? perOrderCeiling : asNumber(order.collateral);
  }
  return Math.round(total * 100) / 100;
}
