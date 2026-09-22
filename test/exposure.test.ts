/**
 * What a person must hear about the account before anything is offered.
 *
 * The case these come from is real: an install adopted a live mainnet account
 * with ten positions, $11.85 of free margin against $312 of notional, and a 10x
 * short about 6% from its estimated liquidation priced off a feed that had
 * stopped. `next` said `read-only` and nothing else. Every number was already
 * in reads it had made.
 */
import { describe, expect, it } from "vitest";

import {
  exposureLine,
  exposureWarnings,
  openCollateralOf,
  summarise,
} from "../src/agent/exposure.ts";
import type { Position } from "../src/api/types.ts";

const position = (over: Partial<Position> = {}): Position =>
  ({
    id: "1",
    ticker: "SUIUSD",
    side: "long",
    size: 100,
    sizeInAsset: 10,
    collateral: 20,
    collateralCurrency: "USDCUSD",
    leverage: 5,
    entryPrice: 10,
    spotPrice: 10,
    priceStale: false,
    estLiqPrice: 8,
    estPnl: 0,
    estPnlRatio: 0,
    pnlBreakdown: {},
    linkedOrders: [],
    openedAt: 0,
    tradingFeeRate: 0,
    maintenanceMarginRatio: 0,
    ...over,
  }) as Position;

describe("summarise", () => {
  it("adds up notional and counts what cannot be trusted", () => {
    const exposure = summarise({
      overview: { freeMargin: 11.85, degraded: true, degradedReads: ["positionPrices"] },
      positions: [position({ size: 200 }), position({ id: "2", size: 112, priceStale: true })],
      orders: 3,
    });

    expect(exposure.freeMargin).toBe(11.85);
    expect(exposure.notional).toBe(312);
    expect(exposure.positions).toBe(2);
    expect(exposure.orders).toBe(3);
    expect(exposure.stale).toBe(1);
    expect(exposure.degraded).toBe(true);
    expect(exposure.degradedReads).toEqual(["positionPrices"]);
  });

  it("measures the distance to liquidation, and flags only the close ones", () => {
    const close = summarise({
      overview: {},
      positions: [position({ spotPrice: 100, estLiqPrice: 106, side: "short", leverage: 10 })],
      orders: 0,
    });
    expect(close.nearLiquidation).toHaveLength(1);
    expect(close.nearLiquidation[0]?.percent).toBe(6);

    const far = summarise({ overview: {}, positions: [position({ spotPrice: 100, estLiqPrice: 50 })], orders: 0 });
    expect(far.nearLiquidation).toEqual([]);
  });

  it("refuses to measure a distance from a price that is not live", () => {
    // Spot is stale, so a percentage derived from it is a guess wearing a
    // percentage sign. The staleness itself is what gets said.
    const exposure = summarise({
      overview: {},
      positions: [position({ spotPrice: 100, estLiqPrice: 101, priceStale: true })],
      orders: 0,
    });

    expect(exposure.nearLiquidation).toEqual([]);
    expect(exposure.stale).toBe(1);
  });

  it("treats `estLiqPrice: 0` as unknown, never as no risk", () => {
    const exposure = summarise({
      overview: {},
      positions: [position({ spotPrice: 100, estLiqPrice: 0 })],
      orders: 0,
    });

    expect(exposure.nearLiquidation).toEqual([]);
  });

  it("survives an overview it cannot read", () => {
    // `overview` is typed `unknown` for a reason: it is whatever the backend
    // sent. A summary that throws here would take `next` down with it.
    for (const overview of [undefined, null, "nonsense", 42, { degradedReads: "not a list" }]) {
      expect(() => summarise({ overview, positions: [], orders: 0 })).not.toThrow();
    }
    expect(summarise({ overview: null, positions: [], orders: 0 }).freeMargin).toBe(0);
  });
});

describe("exposureWarnings", () => {
  const fromSession = (): ReturnType<typeof summarise> =>
    summarise({
      overview: { freeMargin: 11.85, degraded: true, degradedReads: ["positionPrices"] },
      positions: [
        position({ size: 150, priceStale: true, ticker: "WTIUSD", side: "short", leverage: 10 }),
        position({ size: 162, spotPrice: 100, estLiqPrice: 94 }),
      ],
      orders: 0,
    });

  it("leads with the feed that stopped, because its numbers are fiction", () => {
    const warnings = exposureWarnings(fromSession());

    expect(warnings[0]).toMatch(/not live/u);
    expect(warnings[0]).toMatch(/not real numbers/u);
  });

  it("names the position that is close, with how close", () => {
    expect(exposureWarnings(fromSession()).join(" ")).toMatch(/6% from its estimated liquidation/u);
  });

  it("says when the margin is thin against what is open", () => {
    expect(exposureWarnings(fromSession()).join(" ")).toMatch(/Free margin is \$11\.85 against \$312/u);
  });

  it("passes on the backend's own admission that it could not price everything", () => {
    expect(exposureWarnings(fromSession()).join(" ")).toMatch(/degraded \(positionPrices\)/u);
  });

  it("says nothing about an account with nothing in it", () => {
    expect(exposureWarnings(summarise({ overview: { freeMargin: 0 }, positions: [], orders: 0 }))).toEqual([]);
  });
});

describe("exposureLine", () => {
  it("says what was just adopted, at the moment nobody knows yet", () => {
    const line = exposureLine(
      summarise({ overview: { freeMargin: 11.85 }, positions: [position({ size: 312 })], orders: 2 }),
    );

    expect(line).toContain("$11.85 free margin");
    expect(line).toContain("1 open position(s) worth $312");
    expect(line).toContain("2 resting order(s)");
  });
});

describe("openCollateralOf", () => {
  it("adds up what the open positions are holding", () => {
    expect(openCollateralOf([position({ collateral: 20 }), position({ collateral: 30.5 })], [], 50)).toBe(
      50.5,
    );
  });

  it("counts orders already sent that nobody has filled yet", () => {
    // The keeper fills asynchronously — measured between ~2 and ~7 minutes on
    // testnet. Two opens sent seconds apart are both absent from `positions`,
    // so a ceiling that read only positions would let the second one through
    // no matter how large the first was.
    expect(openCollateralOf([], [{ action: "openLong", collateral: 40 }], 50)).toBe(40);
  });

  it("charges a full per-order ceiling for an in-flight order whose amount was not kept", () => {
    // Records written before submissions carried an amount have no number to
    // add. Guessing zero would understate exposure precisely while an order is
    // outstanding, so the measurement assumes the largest that order could
    // have been — the per-order ceiling that authorized it.
    expect(openCollateralOf([], [{ action: "openLong" }], 50)).toBe(50);
  });

  it("does not count an in-flight order that reduces exposure", () => {
    // A close in flight is exposure on its way out; charging for it would make
    // the ceiling refuse the very orders that bring it back down.
    expect(
      openCollateralOf([], [{ action: "closePosition" }, { action: "openLong", collateral: 10 }], 50),
    ).toBe(10);
  });

  it("reads an account with nothing in it as nothing at risk", () => {
    expect(openCollateralOf([], [], 50)).toBe(0);
  });
});
