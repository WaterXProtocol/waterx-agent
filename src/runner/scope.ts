/**
 * Whether a queued intent is one the scope could ever permit.
 *
 * `queue` accepted anything. A 10x intent under a 3x ceiling, an ETH intent under
 * a SUI-only scope, an account the scope does not name — all were written to the
 * inbox and answered `ok`, and the refusal arrived later, one runner pass at a
 * time, if a runner was up at all. An operator reading `ok` believes the queue
 * has been validated; what they have is work that cannot run.
 *
 * This checks the scope's **settled** rules — the ones whose answer does not
 * change between now and the write — by calling the same function the gate calls.
 * There is no second copy of a ceiling here, and that is the whole design: a
 * second copy would drift, and a drifted copy of an authority rule is worse than
 * no check at all, because it refuses work that is fine and admits work that is
 * not.
 *
 * What it deliberately does NOT answer: the concurrent and cumulative collateral
 * ceilings. Those read live state, and an answer about them now is an answer
 * about a different moment. So admission here is not authorization, every caller
 * is told so in those words, and the gate still decides at the moment of signing.
 */
import { isOwnerOnlyAction, statelessScopeViolations, type PolicyScope } from "../policy.ts";
import type { Intent } from "./types.ts";

/**
 * The action name each queued kind becomes.
 *
 * Must match what the agent method actually puts in its `WriteIntent`, because
 * `EXITS` and the owner-only set are keyed on it: a name that drifted would check
 * a different rule here than the gate applies there, which is exactly the
 * "validated" illusion this module exists to remove. Pinned by a test that reads
 * the agent's own source.
 */
export function actionOfIntent(intent: Intent): string {
  switch (intent.kind) {
    case "open":
      return intent.side === "long" ? "openLong" : "openShort";
    case "limit":
      return "placeLimitOrder";
    case "close":
      return "closePosition";
    case "cancel":
      return "cancelOrder";
    case "reduce":
      return "reducePosition";
    case "increase":
      return "increasePosition";
    case "add-margin":
      return "addMargin";
    case "fit-stop":
      // The write it becomes. Keyed on the same name the gate sees, so a scope
      // that does not permit an order update refuses this too rather than
      // letting a follow-up write slip past the ceilings its parent obeyed.
      return "updateOrder";
    case "remove-margin":
      return "removeMargin";
    case "wlp-mint":
      return "mintWlp";
    case "wlp-burn":
      return "burnWlp";
    case "wlp-cancel-burn":
      return "cancelWlpBurn";
    case "wlp-claim":
      return "claimWlpRewards";
  }
}

/**
 * Whether this intent increases exposure, as the agent method will declare it.
 *
 * `remove-margin` is the one that surprises: taking margin out raises leverage on
 * what is already open, so it is metered rather than treated as an exit.
 */
function increasesExposure(intent: Intent): boolean {
  switch (intent.kind) {
    case "open":
    case "increase":
    case "remove-margin":
    case "wlp-mint":
      return true;
    case "limit":
      return intent.reduceOnly !== true;
    case "fit-stop":
      // It only ever shrinks a reduce-only leg. Nothing it can do adds exposure.
      return false;
    default:
      return false;
  }
}

/** The fields the settled scope rules read, projected from a queued intent. */
function checkable(
  intent: Intent,
  accountId: string,
): Parameters<typeof statelessScopeViolations>[0] {
  const collateral = "collateral" in intent ? Number(intent.collateral) : undefined;
  return {
    action: actionOfIntent(intent),
    accountId,
    increasesExposure: increasesExposure(intent),
    ...("ticker" in intent && intent.ticker !== "" ? { ticker: intent.ticker } : {}),
    ...("side" in intent ? { side: intent.side } : {}),
    // A non-numeric collateral is left out rather than passed as NaN: every
    // comparison against NaN is false, so it would read as "within every
    // ceiling". The gate refuses it by its own rule at execution.
    ...(collateral !== undefined && Number.isFinite(collateral) ? { collateral } : {}),
    ...("leverage" in intent && intent.leverage !== undefined ? { leverage: intent.leverage } : {}),
    ...("slippagePercent" in intent && intent.slippagePercent !== undefined
      ? { slippagePercent: intent.slippagePercent }
      : {}),
  };
}

export interface AdmissionVerdict {
  /** Empty means nothing settled refuses it — NOT that it is authorized. */
  violations: string[];
  /** The action the gate will see, so a refusal names what the operator wrote. */
  action: string;
}

/**
 * Is this intent admissible to the queue?
 *
 * `startsAt` is when the write would be attempted, which for a deferred intent is
 * not now. Checking the scope's end against the deferred instant catches the one
 * thing only this moment can catch: work scheduled past the delegation's own
 * expiry, which would wait and then be refused for a reason that was knowable
 * when it was queued.
 */
export function admissible(
  intent: Intent,
  scope: PolicyScope,
  accountId: string,
  startsAt: number,
): AdmissionVerdict {
  const projected = checkable(intent, accountId);
  const violations = isOwnerOnlyAction(projected.action)
    ? [
        `${projected.action} moves funds or changes account authority, and is refused under ` +
          `delegated-auto whatever the scope says`,
      ]
    : statelessScopeViolations(projected, scope, startsAt);
  return { violations, action: projected.action };
}
