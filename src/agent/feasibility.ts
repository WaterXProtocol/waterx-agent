/**
 * Whether an order could work at all, checked before a person is asked to
 * approve it.
 *
 * `previewOf` decodes the exact intent the gate authorizes and the verifier
 * binds the transaction to, and that purity is deliberate: a preview authored
 * beside the order could disagree with it, and the failure mode of two
 * descriptions is that a change lands in one. So nothing here touches the
 * preview. These are facts read from the market and the account, attached
 * ALONGSIDE it.
 *
 * What they are for is the approval, not the wording. `interactive` rests its
 * whole safety argument on a person having looked — and what the person was
 * shown was a well-formed description of an order that could never fill:
 * 1000x leverage into a market that caps at 25, $500 of collateral against $63
 * of free margin, a long whose take-profit sat below its stop-loss. Every one
 * of those produced an approvable request. The person's approval was spent
 * before the chain refused the order, and the only thing their attention bought
 * was a refusal they could have been shown first.
 *
 * Only what can be READ is checked, and a fact nobody could read is not a
 * finding. A market whose parameters could not be fetched yields `checked:
 * false`, which is not the same answer as "nothing wrong" and must never be
 * collapsed into it.
 */

/** What the market and the account say, when they could be asked. */
export interface FeasibilityFacts {
  /** `marketParams.maxLeverage` for the plan's ticker. */
  maxLeverage?: number;
  /** `marketParams.minCollateral`, in display USD. */
  minCollateral?: number;
  /** `overview.freeMargin`, in display USD. */
  freeMargin?: number;
}

/** The part of a preview this reasons about. Structural, so tests need no plan. */
export interface FeasibleOrder {
  action: string;
  side?: "long" | "short";
  leverage?: number;
  collateralUsd?: number;
  referencePrice?: number;
  legs?: readonly { kind: "take-profit" | "stop-loss"; triggerPrice: number }[];
  bound?: { slippagePercent?: number };
}

export interface Finding {
  code: string;
  /** Blocking findings withhold the approval; the rest are said and allowed. */
  blocking: boolean;
  detail: string;
}

export interface Feasibility {
  checked: boolean;
  findings: readonly Finding[];
  blocking: readonly string[];
  /** Why nothing was checked, when nothing was. */
  reason?: string;
}

const money = (value: number): string => `$${value.toFixed(2)}`;

/**
 * An opening action commits collateral at a leverage; the others do not, and
 * checking them against a market's entry limits would refuse a perfectly good
 * close.
 */
const OPENS = new Set(["open-long", "open-short", "place-order", "increase-position"]);

export function checkFeasibility(order: FeasibleOrder, supplied: FeasibilityFacts | undefined): Feasibility {
  // Unreadable facts used to return here, which stopped the checks that need no
  // facts at all — a stop-loss on the winning side and an impossible slippage
  // are both decidable from the order alone, and both went unsaid because a
  // market lookup had failed. Each check below already requires the fact it
  // compares against, so an empty set simply means the comparisons that need
  // one do not fire.
  const facts = supplied ?? {};
  const unread = supplied === undefined;

  const findings: Finding[] = [];
  const opening = OPENS.has(order.action);

  if (opening && order.leverage !== undefined && facts.maxLeverage !== undefined && order.leverage > facts.maxLeverage) {
    findings.push({
      code: "LEVERAGE_ABOVE_MARKET_MAX",
      blocking: true,
      detail: `${order.leverage}x is above this market's maximum of ${facts.maxLeverage}x. The chain refuses it; nothing here can raise the cap.`,
    });
  }

  if (opening && order.collateralUsd !== undefined && facts.minCollateral !== undefined && order.collateralUsd < facts.minCollateral) {
    findings.push({
      code: "COLLATERAL_BELOW_MARKET_MIN",
      blocking: true,
      detail: `${money(order.collateralUsd)} is below this market's minimum collateral of ${money(facts.minCollateral)}.`,
    });
  }

  if (opening && order.collateralUsd !== undefined && facts.freeMargin !== undefined && order.collateralUsd > facts.freeMargin) {
    findings.push({
      code: "COLLATERAL_ABOVE_FREE_MARGIN",
      blocking: true,
      detail: `This commits ${money(order.collateralUsd)} and the account has ${money(facts.freeMargin)} free. The order cannot be funded.`,
    });
  }

  // Direction, not distance. How far a stop sits from entry is a judgement
  // nobody here may make for a trader; which SIDE of entry it sits on is not a
  // judgement at all — a long whose stop-loss is above its entry is stopped out
  // by the market moving its way.
  const reference = order.referencePrice;
  if (order.side !== undefined && reference !== undefined) {
    const long = order.side === "long";
    for (const leg of order.legs ?? []) {
      const profitable = leg.kind === "take-profit" ? (long ? leg.triggerPrice > reference : leg.triggerPrice < reference) : long ? leg.triggerPrice < reference : leg.triggerPrice > reference;
      if (profitable) continue;
      findings.push({
        code: leg.kind === "take-profit" ? "TAKE_PROFIT_ON_THE_LOSING_SIDE" : "STOP_LOSS_ON_THE_WINNING_SIDE",
        blocking: true,
        detail:
          leg.kind === "take-profit"
            ? `A ${order.side}'s take-profit at ${leg.triggerPrice} is on the losing side of ${reference}: it takes a profit this position cannot make.`
            : `A ${order.side}'s stop-loss at ${leg.triggerPrice} is on the winning side of ${reference}: it closes the position when the market moves the way it was opened for.`,
      });
    }
  }

  // Said, not refused. Zero is a legitimate instruction — fill at exactly this
  // price or not at all — and a wide one is a choice somebody is entitled to
  // make. Neither is a mistake this may decide on their behalf.
  const slippage = order.bound?.slippagePercent;
  if (slippage !== undefined && slippage <= 0) {
    findings.push({
      code: "SLIPPAGE_LEAVES_NO_ROOM",
      blocking: false,
      detail: "A 0% bound fills only at exactly this price. On a moving market that is usually no fill at all rather than a better one.",
    });
  }
  if (slippage !== undefined && slippage >= 10) {
    findings.push({
      code: "SLIPPAGE_UNUSUALLY_WIDE",
      blocking: false,
      detail: `A ${String(slippage)}% bound accepts a fill that far from the price shown above. That is the protection, so it is worth meaning it.`,
    });
  }

  return {
    // `checked` is about the FACTS, not about whether anything ran. A caller
    // that sees no findings needs to know which of the two it is looking at:
    // an order checked against its market, or one nothing could be compared to.
    checked: !unread,
    findings,
    blocking: findings.filter((f) => f.blocking).map((f) => f.code),
    ...(unread
      ? {
          reason:
            "the market parameters and the account could not be read, so nothing was checked " +
            "against them — the checks that need no market facts still ran",
        }
      : {}),
  };
}
