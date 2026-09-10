/**
 * What a durable run is made of.
 *
 * The state machine exists for one reason: **a process can die between sending
 * a transaction and learning what happened to it**, and that window cannot be
 * closed. It can only be made recoverable. So every transition that could be
 * interrupted is written down before it is attempted, and `submitting` — the
 * ambiguous state — carries the one fact that resolves it later: the digest.
 */

/** What the runner is asked to do. Display units, exactly as `WaterXAgent` takes them. */
export type Intent =
  | {
      kind: "open";
      ticker: string;
      side: "long" | "short";
      collateral: string | number;
      leverage?: number;
      size?: string | number;
      slippagePercent?: number;
      takeProfitPrice?: string | number;
      stopLossPrice?: string | number;
    }
  | {
      /**
       * A resting limit or stop order. Distinct from `open`, which is a market
       * order: this one names the price it will fill at.
       */
      kind: "limit";
      ticker: string;
      side: "long" | "short";
      collateral: string | number;
      leverage?: number;
      size?: string | number;
      /** Trigger price in USD. */
      triggerPrice: string | number;
      isStopOrder?: boolean;
      reduceOnly?: boolean;
      linkedPositionId?: number;
      takeProfitPrice?: string | number;
      stopLossPrice?: string | number;
    }
  | {
      kind: "close";
      ticker: string;
      positionId: number;
      slippagePercent?: number;
    }
  | {
      kind: "cancel";
      ticker: string;
      orderId: number;
    }
  | {
      kind: "reduce";
      ticker: string;
      positionId: number;
      /** Base-asset size to close. Either this or `percent`. */
      size?: string | number;
      /** Fraction of the position to close, 0 < percent <= 100. */
      percent?: number;
      slippagePercent?: number;
    }
  | {
      kind: "increase";
      ticker: string;
      positionId: number;
      collateral: string | number;
      leverage?: number;
      size?: string | number;
      slippagePercent?: number;
    }
  | {
      kind: "add-margin";
      ticker: string;
      positionId: number;
      amount: string | number;
    }
  | {
      kind: "remove-margin";
      ticker: string;
      positionId: number;
      amount: string | number;
    }
  | { kind: "wlp-mint"; amount: string | number }
  | { kind: "wlp-burn"; amount: string | number }
  | { kind: "wlp-cancel-burn"; requestId: string | number }
  | { kind: "wlp-claim" };

/**
 * What counts as this intent having finished.
 *
 * Not every action leaves the same trace, and pretending otherwise is how a
 * successful cancel gets reported as `unresolved`. Three rules, because there
 * are three kinds of evidence:
 *
 * - `order-status` — the intent creates a resting order, and account history
 *   ties that order to our digest. Wait for its terminal status.
 * - `gone` — the intent names a position or order that should cease to exist.
 *   Its disappearance is attributable *because the intent named it*.
 * - `onchain` — the transaction landing is all we can honestly attest. A
 *   keeper-executed request (reduce, increase) fills under the KEEPER's digest,
 *   not ours, so the fill cannot be tied back to this job; and a margin or WLP
 *   call simply takes effect when it lands. Claiming more would be inventing
 *   evidence.
 */
export type Settlement = "order-status" | "gone" | "onchain";

export function settlementOf(intent: Intent): Settlement {
  switch (intent.kind) {
    case "open":
    case "limit":
      return "order-status";
    case "close":
    case "cancel":
      return "gone";
    default:
      return "onchain";
  }
}

/**
 * - `queued`     accepted; nothing has been sent.
 * - `submitting` a transaction may or may not have reached the chain. The one
 *                state that needs evidence rather than a decision to leave.
 * - `submitted`  observed on chain; awaiting the keeper's fill sweep.
 * - `filled` / `cancelled` / `failed`  terminal.
 * - `unresolved` terminal-by-deadline: we could not establish an outcome and
 *                will not guess one. Requires a human.
 */
export type JobState =
  | "queued"
  | "submitting"
  | "submitted"
  | "filled"
  | "cancelled"
  | "failed"
  | "unresolved"
  /** Its window passed before it was ever sent. Terminal, and nothing happened. */
  | "expired";

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  "filled",
  "cancelled",
  "failed",
  "unresolved",
  "expired",
]);

export interface Job {
  id: string;
  state: JobState;
  intent: Intent;
  /** Wall-clock ms. Supplied by the caller so the store stays deterministic. */
  createdAt: number;
  updatedAt: number;
  /**
   * Absolute epoch ms before which the job must not be submitted. Absolute
   * rather than a duration on purpose: a relative delay would restart from zero
   * on every crash, so "in five minutes" would mean five minutes after the last
   * restart rather than five minutes after the decision.
   */
  notBefore?: number;
  /**
   * Absolute epoch ms after which the job must NOT be started. Required
   * whenever `notBefore` is set.
   *
   * The gap between deciding and firing is exactly the window in which the
   * reason for the decision can stop being true. A deferred order with no
   * expiry fires after an outage, on a market that has moved, for a reason
   * nobody remembers — so a deferred intent without one is refused rather than
   * given a default, in the same spirit as the policy scope's mandatory
   * ceilings.
   *
   * It bounds only the *start*. A job already submitted is in flight and an
   * expiry cannot undo it.
   */
  expiresAt?: number;
  /**
   * A caller-chosen name for *the idea* this job carries.
   *
   * The runner guarantees an intent is submitted at most once. It cannot know
   * that two intents are the same idea — a condition that stays true for ten
   * ticks produces ten distinct intents, and each would be faithfully sent. A
   * key is how a caller says "these are the same decision".
   */
  key?: string;
  /**
   * The cooldown this job was enqueued with, if any. Stored on the job rather
   * than looked up at prune time because the store cannot know what a future
   * caller will ask for — and a job dropped while still inside its cooldown
   * would silently lift it, letting the same decision be taken twice.
   */
  cooldownMs?: number;
  /**
   * The inbox file this job came from, when it came from one.
   *
   * Makes ingestion idempotent: the file is only removed after the job is
   * durably stored, so a crash in between leaves it to be read again — and this
   * is how that second read is recognised as the same intent rather than a new
   * one.
   */
  inboxId?: string;
  /**
   * Written **before** the submission leaves the process. Its presence means
   * "a transaction with this digest may exist"; its absence in `submitting`
   * means the crash happened before signing, so nothing was sent.
   */
  digest?: string;
  /**
   * When the digest was recorded — the instant the submission became
   * ambiguous. The settle window is measured from here rather than from
   * `updatedAt`, which moves on every transition and would keep pushing the
   * window out.
   */
  digestAt?: number;
  /**
   * When the transaction was observed on chain. The fill deadline is measured
   * from here, because it is a statement about how long the *order* has been
   * live — a fixed instant, not one that moves when the runner learns something
   * new about the job.
   */
  submittedAt?: number;
  /** Order ids this job's transaction created, resolved from account history. */
  orderIds?: number[];
  /**
   * How many times the job has been sent. Bounded: a retry loop that cannot
   * count is a retry loop that cannot stop.
   */
  attempts: number;
  /** Why it ended, when it ended badly. */
  error?: string;
  /** Appended, never rewritten — the record of what was believed and when. */
  events: JobEvent[];
}

export interface JobEvent {
  at: number;
  state: JobState;
  note: string;
}

export interface RunnerLimits {
  /** Submissions per job before it is failed rather than retried forever. */
  maxAttempts: number;
  /** How long a `submitted` job may wait for the keeper before it is unresolved. */
  fillDeadlineMs: number;
  /**
   * How long a digest may be absent from the chain before we conclude it never
   * landed. Absence is only evidence once propagation has had time to happen;
   * concluding early is how a runner sends the same trade twice.
   */
  digestSettleMs: number;
  /**
   * How long a finished job is kept.
   *
   * The store is one JSON file rewritten and fsynced on every update, and every
   * keyed enqueue scans it — so keeping jobs forever makes a process designed to
   * run for months progressively slower at the thing it does most. Two jobs are
   * never dropped whatever this says: one still inside its cooldown (dropping it
   * would silently permit a repeat decision) and one left `unresolved` (it is an
   * open question about money and is waiting for a person).
   */
  retentionMs: number;
}

export const DEFAULT_LIMITS: RunnerLimits = {
  maxAttempts: 3,
  // Fills were measured between ~2 and ~7 minutes on testnet, for identical
  // orders. The deadline is generous because the tail is not bounded and a
  // premature "unresolved" is a false alarm on a live position.
  fillDeadlineMs: 30 * 60_000,
  // Sui finalises in seconds, so a digest still absent after five minutes has
  // genuinely not landed. The old 60s was tight enough that a slow propagation
  // could be read as "never sent" — and the retry builds a NEW transaction
  // rather than resubmitting the same bytes, so being wrong here means both
  // execute. The cost of the longer wait falls only on submissions that already
  // failed; the cost of being wrong is a duplicate trade.
  digestSettleMs: 300_000,
  // Long enough that the ledger stays useful for working out what happened
  // last week, short enough that the file does not grow without limit.
  retentionMs: 30 * 24 * 3600_000,
};
