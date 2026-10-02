/**
 * A protective order must not be larger than the position it protects.
 *
 * A position reduced to 5.93 still showed a stop for 11.87. Both legs are
 * reduce-only so neither can close more than exists — a clarity bug, not a money
 * one — but an operator reading 11.87 is reading protection that is not there.
 *
 * The tests here are mostly about what this must NOT do, because the dangerous
 * version of this feature is the obvious one: resize the stop to the size the
 * position is about to be. A reduce returns when the request is on chain and a
 * keeper fills it afterwards, so that version leaves the position
 * under-protected until the fill lands.
 */
import { describe, expect, it } from "vitest";

import { oversizedStops } from "../src/agent/stops.ts";
import type { OrderResponse, Position } from "../src/api/types.ts";

const order = (over: Partial<OrderResponse>): OrderResponse =>
  ({
    id: "1",
    ticker: "SUIUSD",
    side: "short",
    size: 10,
    sizeInAsset: 10,
    collateral: 1,
    collateralCurrency: "USD",
    triggerPrice: 1,
    triggerCondition: "lte",
    spotPrice: 2,
    orderType: "stop" as never,
    orderTypeTag: 3,
    reduceOnly: true,
    linkedPositionId: "7",
    linkedOrderId: null,
    linkedOrders: [],
    createdAt: 0,
    ...over,
  }) as OrderResponse;

const position = (over: Partial<Position> = {}): Position =>
  ({
    id: "7",
    ticker: "SUIUSD",
    side: "long",
    size: 100,
    sizeInAsset: 5.93,
    collateral: 10,
    collateralCurrency: "USD",
    leverage: 2,
    entryPrice: 2,
    spotPrice: 2,
    priceStale: false,
    estLiqPrice: 1,
    estPnl: 0,
    estPnlRatio: 0,
    pnlBreakdown: {} as never,
    linkedOrders: [],
    openedAt: 0,
    tradingFeeRate: 0,
    ...over,
  }) as Position;

describe("oversizedStops", () => {
  it("finds the stop left behind by a partial close", () => {
    const found = oversizedStops(
      position({ linkedOrders: [order({ id: "42", sizeInAsset: 11.87, triggerPrice: 1 })] }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ orderId: 42, size: 11.87, shouldBe: 5.93, kind: "stop-loss" });
  });

  it("finds an oversized take-profit too", () => {
    // The same defect on the other leg. Fixing one of a pair is how a
    // half-checked set starts, and this repository has had three of those.
    const found = oversizedStops(
      position({ linkedOrders: [order({ id: "43", sizeInAsset: 11.87, triggerPrice: 3 })] }),
    );
    expect(found[0]).toMatchObject({ orderId: 43, kind: "take-profit" });
  });

  it("keeps the trigger price, because where a stop sits is not its size", () => {
    const found = oversizedStops(
      position({ linkedOrders: [order({ sizeInAsset: 11.87, triggerPrice: 1.23 })] }),
    );
    expect(found[0]?.triggerPrice).toBe(1.23);
  });

  it("leaves a leg that already fits", () => {
    expect(
      oversizedStops(position({ linkedOrders: [order({ sizeInAsset: 5.93 })] })),
    ).toEqual([]);
    expect(
      oversizedStops(position({ linkedOrders: [order({ sizeInAsset: 1 })] })),
    ).toEqual([]);
  });

  it("leaves an order that is not reduce-only, whatever its size", () => {
    // A resting order that would OPEN exposure is not protection and is not
    // bounded by the position. Shrinking one would be editing somebody's entry.
    expect(
      oversizedStops(
        position({ linkedOrders: [order({ sizeInAsset: 999, reduceOnly: false })] }),
      ),
    ).toEqual([]);
  });

  it("finds nothing on a position with no size", () => {
    // A closing or unopened position. The protocol cancels the legs itself when a
    // position closes, so this must not propose resizing them to zero.
    expect(
      oversizedStops(
        position({ sizeInAsset: 0, linkedOrders: [order({ sizeInAsset: 11.87 })] }),
      ),
    ).toEqual([]);
  });

  it("names the leg `protective` rather than guessing when entry says nothing", () => {
    // A leg exactly at entry is neither, and an unknown entry price makes both
    // names a guess. The name is reported to a person; the wrong one is worse
    // than none.
    const atEntry = oversizedStops(
      position({ linkedOrders: [order({ sizeInAsset: 11.87, triggerPrice: 2 })] }),
    );
    expect(atEntry[0]?.kind).toBe("protective");
    const noEntry = oversizedStops(
      position({ entryPrice: 0, linkedOrders: [order({ sizeInAsset: 11.87, triggerPrice: 1 })] }),
    );
    expect(noEntry[0]?.kind).toBe("protective");
  });

  it("reads the position as it IS, so running it before a fill finds nothing", () => {
    // The load-bearing property. A reduce is keeper-filled: at the moment the
    // write returns the position is usually still its original size, and the
    // stop still matches it. The obvious version of this feature — resize to the
    // size the position is about to be — would shrink the stop here and leave
    // the position under-protected until the keeper arrives.
    const beforeTheFill = position({
      sizeInAsset: 11.87,
      linkedOrders: [order({ sizeInAsset: 11.87 })],
    });
    expect(oversizedStops(beforeTheFill)).toEqual([]);
  });

  it("is idempotent, because it compares rather than subtracts", () => {
    const after = position({ linkedOrders: [order({ sizeInAsset: 11.87 })] });
    const first = oversizedStops(after);
    expect(first).toHaveLength(1);
    // The resize applied: the order now matches, and a second run proposes
    // nothing. Nothing here tracks whether it has run.
    const resized = position({
      linkedOrders: [order({ sizeInAsset: first[0]?.shouldBe ?? 0 })],
    });
    expect(oversizedStops(resized)).toEqual([]);
  });
});
