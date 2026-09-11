/**
 * Error types for the two failure planes the agent talks to.
 *
 * `WaterXApiError` carries the backend's `AppError` code from the
 * `{ success: false, error: { code, message } }` envelope every route returns
 * (libs/shared/dto/response.dto.ts). The codes are stable and grouped by
 * thousand, so callers can branch on a class of failure without string-matching
 * a message that is free to change.
 */

export class WaterXApiError extends Error {
  readonly name = "WaterXApiError";

  constructor(
    /** Backend `AppError.code`, or the HTTP status when the body carried none. */
    readonly code: number,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }

  /** 5xx and the explicitly-transient 6003 are worth retrying; 4xx are not. */
  get retryable(): boolean {
    return this.status >= 500 || this.code === ErrorCode.SponsorshipRequiredForDelegate;
  }
}

/** Raised when a transaction is submitted but the chain rejects it. */
export class TxExecutionError extends Error {
  readonly name = "TxExecutionError";

  constructor(
    message: string,
    readonly digest: string | undefined,
    readonly effects?: unknown,
  ) {
    super(message);
  }
}

/** Raised when the configured `ExecutionPolicy` forbids the requested write. */
export class ExecutionPolicyError extends Error {
  readonly name = "ExecutionPolicyError";
}

/**
 * The caller asked for something that cannot be done as asked — a market that
 * is not listed, a position id that does not exist, a size expressed neither as
 * `size` nor as `leverage`.
 *
 * Distinct from `ConfigError` because the remedy is different and an automated
 * caller has to tell them apart: this one is fixed by changing the arguments of
 * the next call, and is never worth retrying unchanged.
 */
export class UsageError extends Error {
  readonly name = "UsageError";
}

/**
 * The process is not set up to do this — no account id, no key, a scope file
 * that will not parse.
 *
 * Fixed by changing the environment, not the arguments. An agent that receives
 * this should stop and report rather than try a different call.
 */
export class ConfigError extends Error {
  readonly name = "ConfigError";
}

/**
 * A transaction may or may not have been submitted, and nothing local can say
 * which.
 *
 * The one outcome that must never be retried blindly: the honest answer is
 * "ask the chain", so this carries the digest to ask about and the command that
 * asks. See `AGENT_INSTRUCTIONS.md`.
 */
export class AmbiguousSubmissionError extends Error {
  readonly name = "AmbiguousSubmissionError";

  constructor(
    message: string,
    /** The digest that was recorded before the submission left this process. */
    readonly digest: string | undefined,
    /** The submission-ledger id to reconcile. */
    readonly submissionId: string | undefined,
  ) {
    super(message);
  }
}

/**
 * The backend error codes the agent acts on. Mirrors
 * `apps/waterx/src/core/error-codes.ts` — a subset, kept to the ones a caller
 * can do something about. Values are the on-the-wire numbers.
 */
export const ErrorCode = {
  PriceUnavailable: 1007,
  InsufficientWalletBalance: 2005,
  InsufficientAccountBalance: 2007,
  InsufficientPositionMargin: 2012,
  DelegateSenderNotAllowed: 2018,
  DelegateNotAuthorized: 2022,
  DelegateInsufficientPermission: 2023,
  NoDelegatesToRemove: 2029,
  InsufficientWlpBalance: 3004,
  SponsoredTxNotConfigured: 6001,
  TxWouldFail: 6002,
  /** Enoki sponsorship down; a delegate has no gas of its own, so retry later. */
  SponsorshipRequiredForDelegate: 6003,
} as const;

export type ErrorCodeName = keyof typeof ErrorCode;
