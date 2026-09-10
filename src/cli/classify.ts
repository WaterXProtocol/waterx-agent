/**
 * One thrown value → one {@link Outcome}.
 *
 * Kept apart from the CLI harness because the mapping is a *contract*, not
 * presentation: it decides what a caller is told about retrying and about
 * whether a transaction left the process, and those answers must not depend on
 * which script threw.
 *
 * The rule the whole file follows: **when the honest answer is "I do not know
 * whether it was submitted", say `ambiguous`.** Every other unknown may be
 * guessed conservatively; that one may not, because guessing "not submitted"
 * makes the caller retry a trade that already happened.
 */
import {
  AmbiguousSubmissionError,
  ConfigError,
  ErrorCode,
  ExecutionPolicyError,
  TxExecutionError,
  UsageError,
  WaterXApiError,
} from "../errors.ts";
import { SignerError } from "../chain/signer.ts";
import type { Outcome } from "./contract.ts";

export function classify(error: unknown): Outcome {
  const base = {
    submitted: false,
    retryable: false,
    reconcileRequired: false,
    awaitingApproval: false,
  };

  // First, because it is the only one whose answer cannot be reconstructed
  // from anything else. It is thrown holding the digest precisely so this
  // branch can hand the caller the command that settles it.
  if (error instanceof AmbiguousSubmissionError) {
    return {
      ...base,
      status: "ambiguous",
      message: error.message,
      submitted: true,
      reconcileRequired: true,
      ...(error.submissionId !== undefined
        ? { nextCommand: `pnpm run reconcile -- --id ${error.submissionId} --json` }
        : error.digest !== undefined
          ? { nextCommand: `pnpm run reconcile -- --digest ${error.digest} --json` }
          : {}),
      details: { digest: error.digest, submissionId: error.submissionId },
    };
  }

  if (error instanceof ExecutionPolicyError) {
    // Refused before anything was built, in every case: the gate decides first
    // and the builder runs inside it. So nothing left the process, and a
    // retry changes nothing until the policy or the request does.
    return {
      ...base,
      status: "policy",
      message: error.message,
      // The one policy refusal a flag fixes. Naming it here rather than in the
      // harness keeps "what to do next" attached to the reason.
      ...(error.message.includes("confirm: true")
        ? { nextCommand: "re-run with --yes, or use the preview → approve → execute path" }
        : {}),
    };
  }

  if (error instanceof SignerError) {
    return { ...base, status: "auth", message: error.message };
  }

  if (error instanceof UsageError) {
    return { ...base, status: "usage", message: error.message };
  }

  if (error instanceof ConfigError) {
    return { ...base, status: "config", message: error.message };
  }

  if (error instanceof TxExecutionError) {
    // It reached the chain and the chain refused it. Deterministic: the same
    // bytes abort the same way, so this is `rejected` and not retryable — but
    // it IS submitted, and a caller tracking exposure needs to know a digest
    // exists even though nothing moved.
    return {
      ...base,
      status: "rejected",
      message: error.message,
      submitted: true,
      details: { digest: error.digest, effects: error.effects },
    };
  }

  if (error instanceof WaterXApiError) {
    // `retryable` already encodes 5xx and the explicitly-transient 6003; a
    // transport failure arrives as status 0, which that covers too.
    const transient = error.retryable || error.status === 0;
    return {
      ...base,
      status: transient ? "unavailable" : "rejected",
      message: error.message,
      retryable: transient,
      details: {
        code: error.code,
        httpStatus: error.status,
        ...(error.details === undefined ? {} : { backend: error.details }),
        ...(error.code === ErrorCode.SponsorshipRequiredForDelegate
          ? { hint: "Enoki sponsorship is down and a delegate holds no gas — retry later." }
          : {}),
      },
    };
  }

  const message = error instanceof Error ? error.message : String(error);

  // A network fault that never became a `WaterXApiError` — a gRPC submission,
  // a config-document fetch. Transient, and mislabelling it `rejected` would
  // tell a caller to stop when it should wait.
  if (looksTransient(message)) {
    return { ...base, status: "unavailable", message, retryable: true };
  }

  // Anything left is a bug or an unmapped condition. `rejected`, not
  // `unavailable`: an unknown failure that a caller retries in a loop is worse
  // than one it reports.
  return { ...base, status: "rejected", message };
}

/**
 * Phrases that mean "ask again later", not "this cannot work".
 *
 * Rate limiting belongs here and was missing. The testnet faucet answers a
 * fresh wallet with "Too many requests from this client have been sent to the
 * faucet. Please retry later" — a sentence that says, in words, that it is
 * transient — and it was classified `rejected`, telling an agent to give up
 * permanently on the one step every new user takes first.
 */
const TRANSIENT = [
  "fetch failed",
  "timeout",
  "timed out",
  "econnreset",
  "econnrefused",
  "enotfound",
  "etimedout",
  "socket hang up",
  "network",
  "unavailable",
  "too many requests",
  "rate limit",
  "rate-limited",
  "429",
  "retry later",
  "try again later",
  "temporarily",
];

const looksTransient = (message: string): boolean => {
  const text = message.toLowerCase();
  return TRANSIENT.some((needle) => text.includes(needle));
};
