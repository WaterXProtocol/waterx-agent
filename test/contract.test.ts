/**
 * The five booleans an automated caller branches on.
 *
 * Each of these is a claim about money, not about presentation. `submitted`
 * wrong in one direction makes a caller retry a trade that executed;
 * `retryable` wrong makes it hammer a permanent refusal; `reconcileRequired`
 * dropped turns an unknown transaction into a forgotten one. So the mapping is
 * tested at the level of the contract rather than through any one command.
 */
import { describe, expect, it } from "vitest";

import { classify } from "../src/cli/classify.ts";
import { EXIT, firstRunnable, invoke } from "../src/cli/contract.ts";
import { SignerError } from "../src/chain/signer.ts";
import {
  AmbiguousSubmissionError,
  ConfigError,
  ErrorCode,
  ExecutionPolicyError,
  TxExecutionError,
  UsageError,
  WaterXApiError,
} from "../src/errors.ts";

describe("classify", () => {
  it("treats a timed-out submission as ambiguous, never as a failure", () => {
    // The one case that may not be guessed. "Probably did not go through" is
    // how the same order gets placed twice.
    const outcome = classify(
      new AmbiguousSubmissionError("timed out", "digest-1", "sub_1"),
    );
    expect(outcome.status).toBe("ambiguous");
    expect(outcome.submitted).toBe(true);
    expect(outcome.reconcileRequired).toBe(true);
    expect(outcome.retryable, "a retry here duplicates a trade").toBe(false);
    expect(outcome.nextCommand).toContain("reconcile");
    expect(outcome.nextCommand).toContain("sub_1");
    // Runnable as printed: no package-manager banner to break the one-document
    // guarantee the caller is about to rely on.
    expect(outcome.nextCommand).not.toContain("pnpm run");
  });

  it("still hands over a reconcile command when it knows no digest", () => {
    // The timeout can fire before anything reported a digest. That is not
    // proof nothing was sent — giving up waiting does not cancel the work — so
    // the answer is to reconcile broadly rather than to leave the agent
    // deciding for itself in the one situation where it must not.
    const outcome = classify(new AmbiguousSubmissionError("timed out early", undefined, undefined));
    expect(outcome.status).toBe("ambiguous");
    expect(outcome.submitted, "conservative: may have been").toBe(true);
    expect(outcome.retryable).toBe(false);
    // Spelled the way `invoke` spells it, because `nextCommand` is meant to be
    // run verbatim — an emitted command that needs editing is not a next
    // command, it is a hint.
    expect(outcome.nextCommand).toBe(invoke("reconcile", "--all", "--json"));
  });

  it("calls a policy refusal a policy refusal, with nothing submitted", () => {
    const outcome = classify(new ExecutionPolicyError('Policy is "read-only"; refusing openLong.'));
    expect(outcome.status).toBe("policy");
    expect(outcome.submitted).toBe(false);
    expect(outcome.retryable).toBe(false);
  });

  it("points at the flag when — and only when — a flag is the fix", () => {
    expect(
      classify(new ExecutionPolicyError('openLong needs an explicit `confirm: true`')).nextCommand,
    ).toContain("--yes");
    // A scope refusal is not fixable by confirming harder, and suggesting it
    // would point at the one thing that cannot help.
    expect(classify(new ExecutionPolicyError("Out of scope: openLong")).nextCommand).toBeUndefined();
  });

  it("separates a transient backend from a rejected request", () => {
    const down = classify(new WaterXApiError(0, "fetch failed", 0));
    expect(down.status).toBe("unavailable");
    expect(down.retryable).toBe(true);

    const refused = classify(new WaterXApiError(2005, "insufficient balance", 400));
    expect(refused.status).toBe("rejected");
    expect(refused.retryable).toBe(false);
  });

  it("treats absent sponsorship as transient, because it is", () => {
    const outcome = classify(
      new WaterXApiError(ErrorCode.SponsorshipRequiredForDelegate, "sponsorship down", 503),
    );
    expect(outcome.status).toBe("unavailable");
    expect(outcome.retryable).toBe(true);
  });

  it("marks a chain abort as submitted but not retryable", () => {
    // It reached the chain and the chain refused it: nothing moved, a digest
    // exists, and the same bytes will abort the same way.
    const outcome = classify(new TxExecutionError("aborted", "digest-2", { code: 6002 }));
    expect(outcome.status).toBe("rejected");
    expect(outcome.submitted).toBe(true);
    expect(outcome.retryable).toBe(false);
  });

  it("distinguishes bad arguments from a bad environment", () => {
    expect(classify(new UsageError("unknown market")).status).toBe("usage");
    expect(classify(new ConfigError("no account")).status).toBe("config");
    expect(classify(new SignerError("no key", "cmd")).status).toBe("auth");
  });

  it("reads rate limiting as transient — it says so in words", () => {
    // The testnet faucet is the first thing a new wallet touches, and it
    // answers a busy client with "Too many requests … Please retry later".
    // Classified `rejected`, that told an agent to give up permanently on the
    // one step every new user takes first.
    for (const message of [
      "Too many requests from this client have been sent to the faucet. Please retry later",
      "HTTP 429",
      "rate limit exceeded",
      "service is temporarily unavailable",
    ]) {
      const outcome = classify(new Error(message));
      expect(outcome.status, message).toBe("unavailable");
      expect(outcome.retryable, message).toBe(true);
    }
  });

  it("reads a bare network fault as transient rather than as a rejection", () => {
    // These never become `WaterXApiError` — a gRPC submission, a config fetch.
    // Labelling one `rejected` tells a caller to stop when it should wait.
    expect(classify(new Error("ECONNRESET")).status).toBe("unavailable");
    expect(classify(new Error("The operation timed out")).retryable).toBe(true);
  });

  it("defaults an unmapped failure to rejected, not to retryable", () => {
    // An unknown failure a caller retries in a loop is worse than one it reports.
    const outcome = classify(new Error("something nobody anticipated"));
    expect(outcome.status).toBe("rejected");
    expect(outcome.retryable).toBe(false);
  });
});

describe("exit codes", () => {
  it("reserves 1 for a process that fell over rather than decided", () => {
    // Node exits 1 on an unhandled throw. Keeping it unused is what makes
    // "this command decided" distinguishable from "this command crashed".
    expect(Object.values(EXIT)).not.toContain(1);
  });

  it("gives every status its own code", () => {
    const codes = Object.values(EXIT);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

/**
 * An envelope with no exit is where an agent stops.
 *
 * `bootstrap` handed back no `nextCommand` on the path it takes most often --
 * setup unfinished -- and an install read that as the end of the road: it had
 * a wallet, a remaining item addressed to the account owner, and nothing to
 * run. It stopped one command short of the link its user needed.
 */
describe("firstRunnable", () => {
  const FALLBACK = "npx waterx next --json";

  it("hands back the first command there is", () => {
    expect(firstRunnable(["npx waterx onboard --wait 300 --json"], FALLBACK)).toBe(
      "npx waterx onboard --wait 300 --json",
    );
  });

  it("skips the steps that carry no command at all", () => {
    expect(firstRunnable([undefined, "", "  ", "npx waterx doctor --json"], FALLBACK)).toBe(
      "npx waterx doctor --json",
    );
  });

  it("skips a command nobody can run as printed", () => {
    // `nextCommand` is a promise: copy it, do not compose one. A placeholder
    // asks the caller to invent a number, which is the one thing an agent must
    // not do here.
    expect(firstRunnable(["npx waterx deposit --amount <n> --yes --json"], FALLBACK)).toBe(FALLBACK);
  });

  it("prefers a runnable command over an earlier placeholder", () => {
    expect(
      firstRunnable(
        ["npx waterx deposit --amount <n> --yes --json", "npx waterx onboard --wait 300 --json"],
        FALLBACK,
      ),
    ).toBe("npx waterx onboard --wait 300 --json");
  });

  it("always yields something, so no envelope is a dead end", () => {
    expect(firstRunnable([], FALLBACK)).toBe(FALLBACK);
    expect(firstRunnable([undefined, undefined], FALLBACK)).toBe(FALLBACK);
  });
});
