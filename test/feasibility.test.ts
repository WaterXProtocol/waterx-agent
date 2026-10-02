/**
 * Whether an order could work at all — the check `preview` was missing.
 *
 * `interactive` rests its whole safety argument on a person having looked, and
 * what the person was shown was a well-formed description of an order that
 * could never fill. Each case below is one from the external-beta pass, and
 * each one produced an approvable request.
 */
import { describe, expect, it } from "vitest";

import { checkFeasibility, type FeasibilityFacts, type FeasibleOrder } from "../src/agent/feasibility.ts";

const MARKET: FeasibilityFacts = { maxLeverage: 25.25, minCollateral: 10, freeMargin: 63 };
const OPEN: FeasibleOrder = {
  action: "open-long",
  side: "long",
  leverage: 3,
  collateralUsd: 20,
  referencePrice: 1.17,
  bound: { slippagePercent: 1 },
};

const codes = (order: FeasibleOrder, facts: FeasibilityFacts = MARKET): string[] =>
  checkFeasibility(order, facts).findings.map((f) => f.code);

describe("an order the market itself refuses", () => {
  it("refuses leverage above the market's cap", () => {
    const result = checkFeasibility({ ...OPEN, leverage: 1000 }, MARKET);
    expect(result.blocking).toContain("LEVERAGE_ABOVE_MARKET_MAX");
    expect(result.findings[0]?.detail).toContain("25.25");
  });

  it("refuses collateral the account does not have", () => {
    // $500 against $63 free. The order was approvable and could never fund.
    expect(codes({ ...OPEN, collateralUsd: 500 })).toContain("COLLATERAL_ABOVE_FREE_MARGIN");
  });

  it("refuses collateral below the market's minimum", () => {
    expect(codes({ ...OPEN, collateralUsd: 1 })).toContain("COLLATERAL_BELOW_MARKET_MIN");
  });

  it("allows an order that fits all three", () => {
    expect(checkFeasibility(OPEN, MARKET).blocking).toEqual([]);
  });
});

describe("a protective leg on the wrong side of the trade", () => {
  // Direction, not distance. How far a stop sits from entry is a judgement
  // nobody here may make for a trader; which side of entry it sits on is not a
  // judgement at all.
  it("refuses a long whose take-profit is below entry and whose stop is above it", () => {
    const found = codes({
      ...OPEN,
      legs: [
        { kind: "take-profit", triggerPrice: 0.5 },
        { kind: "stop-loss", triggerPrice: 2 },
      ],
    });
    expect(found).toContain("TAKE_PROFIT_ON_THE_LOSING_SIDE");
    expect(found).toContain("STOP_LOSS_ON_THE_WINNING_SIDE");
  });

  it("refuses the mirror image on a short", () => {
    const found = codes({
      ...OPEN,
      action: "open-short",
      side: "short",
      legs: [
        { kind: "take-profit", triggerPrice: 2 },
        { kind: "stop-loss", triggerPrice: 0.5 },
      ],
    });
    expect(found).toContain("TAKE_PROFIT_ON_THE_LOSING_SIDE");
    expect(found).toContain("STOP_LOSS_ON_THE_WINNING_SIDE");
  });

  it("allows legs that protect the position they are attached to", () => {
    expect(
      codes({
        ...OPEN,
        legs: [
          { kind: "take-profit", triggerPrice: 2 },
          { kind: "stop-loss", triggerPrice: 0.5 },
        ],
      }),
    ).toEqual([]);
  });
});

describe("what is said rather than refused", () => {
  it("warns about a bound that leaves no room, and still allows it", () => {
    // Zero is a legitimate instruction — fill at exactly this price or not at
    // all — and refusing it would be this deciding somebody's order for them.
    const result = checkFeasibility({ ...OPEN, bound: { slippagePercent: 0 } }, MARKET);
    expect(result.blocking).toEqual([]);
    expect(result.findings.map((f) => f.code)).toContain("SLIPPAGE_LEAVES_NO_ROOM");
  });

  it("warns about an unusually wide bound, and still allows it", () => {
    const result = checkFeasibility({ ...OPEN, bound: { slippagePercent: 50 } }, MARKET);
    expect(result.blocking).toEqual([]);
    expect(result.findings.map((f) => f.code)).toContain("SLIPPAGE_UNUSUALLY_WIDE");
  });
});

describe("what it does not claim to know", () => {
  it("says nothing was checked when the market could not be read", () => {
    // Not the same answer as "nothing is wrong", and collapsing the two would
    // make an outage look like an endorsement.
    const result = checkFeasibility({ ...OPEN, leverage: 1000 }, undefined);
    expect(result.checked).toBe(false);
    expect(result.blocking).toEqual([]);
    expect(result.reason).toMatch(/could not be read/u);
  });

  it("checks only the facts it was given", () => {
    // A market that reported no maximum leverage is not a market with no
    // maximum leverage.
    expect(codes({ ...OPEN, leverage: 1000 }, { freeMargin: 63 })).toEqual([]);
  });

  it("does not hold a close to a market's entry limits", () => {
    // `minCollateral` and `maxLeverage` bound what may be OPENED. Applying them
    // to an exit would refuse somebody the ability to get out.
    expect(codes({ action: "close-position", side: "long", collateralUsd: 1, leverage: 1000 })).toEqual([]);
  });
});

describe("what is decidable without a market", () => {
  /**
   * Unreadable facts returned early, so NOTHING was checked — including the two
   * things that need no market at all. A stop-loss on the winning side and a
   * slippage of zero are both decidable from the order itself, and both went
   * unsaid because a market lookup had failed.
   */
  it("still catches a stop-loss on the winning side with no facts at all", () => {
    const result = checkFeasibility(
      {
        action: "open-long",
        side: "long",
        referencePrice: 1.17,
        legs: [{ kind: "stop-loss", triggerPrice: 2 }],
      },
      undefined,
    );
    expect(result.blocking).toContain("STOP_LOSS_ON_THE_WINNING_SIDE");
  });

  it("still warns about an impossible slippage with no facts at all", () => {
    const result = checkFeasibility(
      { action: "open-long", bound: { slippagePercent: 0 } },
      undefined,
    );
    expect(result.findings.map((f) => f.code)).toContain("SLIPPAGE_LEAVES_NO_ROOM");
  });

  it("still reports that the market facts were not read", () => {
    // Running some checks is not the same as having checked. A caller that sees
    // no leverage finding must be able to tell "within the cap" from "no cap was
    // ever fetched", and `checked` is the only thing that says which.
    const result = checkFeasibility({ action: "open-long", leverage: 1000 }, undefined);
    expect(result.checked).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.blocking).not.toContain("LEVERAGE_ABOVE_MARKET_MAX");
  });
});
