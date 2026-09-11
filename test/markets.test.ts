/**
 * `assertNotCrossing` mirrors the contract's `ECrossingLimitOrder` check. The
 * boundary case matters: a limit exactly *at* market is legal on chain, so
 * rejecting it here would block an established pattern.
 */
import { describe, expect, it } from "vitest";

import { assertNotCrossing } from "../src/agent/markets.ts";

const base = { ticker: "BTCUSD", spotPrice: 100 };

describe("assertNotCrossing", () => {
  it("rejects a long limit above market", () => {
    expect(() => assertNotCrossing({ ...base, isLong: true, triggerPrice: 101 })).toThrow(
      /ECrossingLimitOrder/,
    );
  });

  it("rejects a short limit below market", () => {
    expect(() => assertNotCrossing({ ...base, isLong: false, triggerPrice: 99 })).toThrow(
      /ECrossingLimitOrder/,
    );
  });

  it("allows a non-crossing limit on both sides", () => {
    expect(() => assertNotCrossing({ ...base, isLong: true, triggerPrice: 99 })).not.toThrow();
    expect(() => assertNotCrossing({ ...base, isLong: false, triggerPrice: 101 })).not.toThrow();
  });

  it("allows a limit exactly at market — the comparison is strict", () => {
    expect(() => assertNotCrossing({ ...base, isLong: true, triggerPrice: 100 })).not.toThrow();
    expect(() => assertNotCrossing({ ...base, isLong: false, triggerPrice: 100 })).not.toThrow();
  });

  it("exempts stop and reduce-only orders, which are meant to trigger through price", () => {
    expect(() =>
      assertNotCrossing({ ...base, isLong: true, triggerPrice: 101, isStopOrder: true }),
    ).not.toThrow();
    expect(() =>
      assertNotCrossing({ ...base, isLong: true, triggerPrice: 101, reduceOnly: true }),
    ).not.toThrow();
  });
});
