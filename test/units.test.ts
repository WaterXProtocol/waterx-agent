/**
 * The scale conversions are where a wrong answer costs money rather than
 * throwing, so they are tested against the exact widths and decimal counts the
 * backend DTOs enforce.
 */
import { describe, expect, it } from "vitest";

import {
  acceptablePriceFor,
  fromRawCollateral,
  fromRawFloat,
  toRawAcceptablePrice,
  toRawCollateral,
  toRawPrice,
  toRawSize,
} from "../src/units.ts";

describe("toRawCollateral", () => {
  it("scales display USD to 6 decimals", () => {
    expect(toRawCollateral(8)).toBe("8000000");
    expect(toRawCollateral("10.5")).toBe("10500000");
    expect(toRawCollateral("0.000001")).toBe("1");
  });

  it("refuses precision it cannot represent rather than rounding it away", () => {
    expect(() => toRawCollateral("1.0000001")).toThrow(/decimal places/);
  });

  it("refuses negative and non-finite amounts", () => {
    expect(() => toRawCollateral(-1)).toThrow();
    expect(() => toRawCollateral(Number.NaN)).toThrow();
    expect(() => toRawCollateral(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("refuses a number that cannot survive the round-trip", () => {
    expect(() => toRawCollateral(1e21)).toThrow(/exponential|safe-integer/);
  });
});

describe("toRawPrice / toRawSize", () => {
  it("scales USD prices by 1e9", () => {
    expect(toRawPrice(65_000)).toBe("65000000000000");
    expect(toRawPrice("0.123456789")).toBe("123456789");
  });

  it("scales base-asset size by 1e9", () => {
    expect(toRawSize("0.15")).toBe("150000000");
  });

  it("accepts a u128-scale price as a string", () => {
    // Far past 2^53 — this is exactly why prices travel as decimal text.
    expect(toRawPrice("12345678901234567890")).toBe("12345678901234567890000000000");
  });
});

describe("toRawAcceptablePrice", () => {
  it("is bounded to u64, unlike toRawPrice", () => {
    // acceptable_price is the one 1e9-scaled field the contract keeps at u64.
    expect(() => toRawAcceptablePrice("99999999999")).toThrow(/overflows/);
    expect(toRawPrice("99999999999")).toBe("99999999999000000000");
  });
});

describe("acceptablePriceFor", () => {
  it("bounds a buy above the reference and a sell below it", () => {
    const buy = BigInt(acceptablePriceFor(100, "buy", 1));
    const sell = BigInt(acceptablePriceFor(100, "sell", 1));
    const reference = BigInt(toRawPrice(100));
    expect(buy).toBeGreaterThan(reference);
    expect(sell).toBeLessThan(reference);
    expect(buy).toBe(BigInt(toRawPrice("101")));
    expect(sell).toBe(BigInt(toRawPrice("99")));
  });

  it("survives the float noise that multiplication leaves behind", () => {
    expect(() => acceptablePriceFor(77499.05, "buy", 0.5)).not.toThrow();
  });

  it("refuses a non-positive reference or an out-of-range slippage", () => {
    expect(() => acceptablePriceFor(0, "buy", 1)).toThrow();
    expect(() => acceptablePriceFor(100, "buy", 100)).toThrow();
    expect(() => acceptablePriceFor(100, "buy", -1)).toThrow();
  });
});

describe("fromRaw", () => {
  it("round-trips through the display scale", () => {
    expect(fromRawCollateral("8000000")).toBe(8);
    expect(fromRawFloat("65000000000000")).toBe(65_000);
  });
});
