/**
 * Which transactions left this process, written down before they left.
 *
 * The window between "sent" and "observed the result" cannot be closed — a
 * process can die inside it, a network can stall inside it, and a `--timeout`
 * fires inside it by design. What can be closed is the question afterwards:
 * *which* transaction should I ask the chain about? A digest recorded before
 * the submission makes that answerable exactly. Without one, a caller has to
 * guess from timestamps and order shapes, and guessing wrong means trading
 * twice.
 *
 * `TxExecutor.execute()` already exposes the hook for this — `onSubmitting`,
 * awaited before the bytes go out, and throwing from it aborts the submission.
 * This module is what the CLI passes it: an fsync'd append, so a record that
 * this call returns from is a record a later process will find.
 *
 * The runner has its own, richer ledger (`runner/store.ts`) for the same
 * reason. This one exists because a one-shot `execute` has no runner, and the
 * external-beta path is one-shot commands.
 */
import { randomBytes } from "node:crypto";

import { append, historyOf, read, type LedgerRecord } from "./ledger.ts";

export const SUBMISSIONS_FILE =
  process.env.WATERX_SUBMISSIONS_FILE?.trim() ?? ".waterx/submissions.jsonl";

export interface Submission {
  id: string;
  at: number;
  action: string;
  network: string;
  accountId?: string;
  /** Known before the submission goes out; that is the whole point. */
  digest: string;
  /** The approval this was spent on, when it came through that path. */
  approvalId?: string;
  ticker?: string;
  positionId?: number;
  orderId?: number;
  /**
   * Display USD this submission commits, when it commits any.
   *
   * Recorded so an in-flight order counts against a concurrent ceiling. Without
   * it, two orders sent seconds apart both pass that check: neither is in
   * `positions` yet, because a keeper has not filled them. Absent on records
   * written before this existed, and on actions that commit nothing.
   */
  collateral?: number;
}

/** What the chain and the indexer eventually said. */
export interface Settlement {
  landed: boolean | "unknown";
  reason?: string;
  orderIds?: number[];
  status?: string;
}

export interface SubmissionStatus {
  submission: Submission;
  settled: boolean;
  settlement?: Settlement;
  settledAt?: number;
}

/**
 * Record a submission. Returns its id, which is also the reconcile handle.
 *
 * Callers pass this to `onSubmitting`, so it runs inside the executor and
 * before the signature is dispatched — a throw here aborts the submission,
 * which is the honest behaviour when the record could not be written.
 */
export function recordSubmission(
  input: Omit<Submission, "id" | "at">,
  now = Date.now(),
  path = SUBMISSIONS_FILE,
): Submission {
  const submission: Submission = { ...input, id: `sub_${randomBytes(6).toString("hex")}`, at: now };
  append(path, {
    v: 1,
    type: "submitted",
    id: submission.id,
    at: now,
    submission,
  } as unknown as LedgerRecord);
  return submission;
}

/** Record what reconciling found. */
export function settle(
  id: string,
  settlement: Settlement,
  now = Date.now(),
  path = SUBMISSIONS_FILE,
): void {
  append(path, {
    v: 1,
    type: "settled",
    id,
    at: now,
    settlement,
  } as unknown as LedgerRecord);
}

export function statusOf(
  id: string,
  path = SUBMISSIONS_FILE,
): SubmissionStatus | undefined {
  const records = historyOf(read(path), id);
  const created = records.find((r) => r.type === "submitted");
  if (created === undefined) return undefined;
  const submission = created.submission as Submission;
  const settled = records.find((r) => r.type === "settled");
  return settled === undefined
    ? { submission, settled: false }
    : {
        submission,
        settled: true,
        settlement: settled.settlement as Settlement,
        settledAt: settled.at,
      };
}

/** All submissions, newest first. */
export function list(path = SUBMISSIONS_FILE): SubmissionStatus[] {
  return read(path)
    .filter((r) => r.type === "submitted")
    .map((r) => statusOf(r.id, path))
    .filter((s): s is SubmissionStatus => s !== undefined)
    .reverse();
}

/**
 * Submissions nobody has settled yet.
 *
 * The list an agent must be empty of before it trades again. A submission left
 * open is a transaction whose effect on the account is unknown, and placing a
 * second order on top of an unknown first one is the failure mode, not a
 * tidiness problem.
 */
export const unsettled = (path = SUBMISSIONS_FILE): SubmissionStatus[] =>
  list(path).filter((s) => !s.settled || s.settlement?.landed === "unknown");

/** Find one by its id or by the digest it carries. */
export function find(handle: string, path = SUBMISSIONS_FILE): SubmissionStatus | undefined {
  const byId = statusOf(handle, path);
  if (byId !== undefined) return byId;
  return list(path).find((s) => s.submission.digest === handle);
}
