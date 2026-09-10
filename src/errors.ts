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

  /**
   * Transport failures, 5xx, and the explicitly-transient 6003 are worth
   * retrying; 4xx are not.
   *
   * `status === 0` is the transport-failure sentinel that
   * `http.ts` raises for a DNS/connect/timeout error, with a comment saying it
   * picks 0 so that `retryable` treats it as transient — but `0 >= 500` is
   * false, so the one class the GET backoff loop exists for was the one class
   * it never retried. Worse, `runner.ts` shares this predicate: a single
   * timed-out `GET /markets/:t/ticker` inside `closePosition` moved the job to
   * terminal `failed`, permanently abandoning a close and leaving the position
   * open on chain.
   */
  get retryable(): boolean {
    return (
      this.status === 0 ||
      this.status >= 500 ||
      this.code === ErrorCode.SponsorshipRequiredForDelegate
    );
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
