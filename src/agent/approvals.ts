/**
 * The approval a person gives, made durable — because the person and the
 * signature are in different processes.
 *
 * `preview` derives a plan and stops. `approve` records that a human looked at
 * that exact plan and said yes. `execute` signs it. Three commands, three
 * process lifetimes, so the thing being approved has to be written down; and if
 * it is written down, the interesting question becomes what stops the plan that
 * gets signed from differing from the plan that was shown.
 *
 * The answer here is that there is only one plan. `preview` writes the intent
 * and the build request; `execute` reads them back and submits them unchanged.
 * Nothing is re-derived in between — which matters most for the numbers that
 * move on their own: a size and an acceptable price computed again at execute
 * time would be a different order from the one on screen, and the difference
 * would be exactly whatever the market did while the person was reading.
 *
 * **What this does not do.** It does not stop a compromised process from
 * writing its own approval line. Nothing local could: an agent with a shell can
 * append to any file this process can. What it does is make approval a
 * separate, explicit, timestamped act with a named approver — so an unapproved
 * trade is a thing someone *did*, recorded, rather than a field that was left
 * unset. The same distinction the rest of this package draws: mistakes are
 * prevented, an attacker with execution here is not.
 */
import { randomBytes } from "node:crypto";

import { fingerprintIntent } from "../policy.ts";
import type { Preview, TradePlan } from "./plan.ts";
import { append, historyOf, read, type LedgerRecord } from "./ledger.ts";

/** Where approvals live. `.waterx/` is gitignored and already the runner's home. */
export const APPROVALS_FILE = process.env.WATERX_APPROVALS_FILE?.trim() ?? ".waterx/approvals.jsonl";

/** How long a preview stays approvable. Long enough to read, short enough that the price still means something. */
export const DEFAULT_TTL_SECONDS = 600;

export function ttlSeconds(): number {
  const raw = process.env.WATERX_APPROVAL_TTL_SECONDS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_TTL_SECONDS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`WATERX_APPROVAL_TTL_SECONDS must be a positive integer, got "${raw}".`);
  }
  return value;
}

export interface ApprovalRequest {
  id: string;
  createdAt: number;
  expiresAt: number;
  action: string;
  /** Recorded so an approval cannot be spent against a different deployment. */
  network: string;
  apiUrl: string;
  accountId?: string;
  /**
   * Digest of the intent as it was previewed.
   *
   * Compared again at execute time against the intent actually being submitted.
   * It cannot stop a determined edit of both lines, but it does catch the case
   * that would otherwise be silent: a plan changed in the ledger after a person
   * approved what they saw.
   */
  fingerprint: string;
  plan: TradePlan;
  preview: Preview;
}

export type ApprovalState = "pending" | "approved" | "consumed" | "rejected" | "expired";

export interface ApprovalStatus {
  request: ApprovalRequest;
  state: ApprovalState;
  approvedAt?: number;
  approvedBy?: string;
  consumedAt?: number;
  /** The transaction an approval was spent on. Present once consumed. */
  digest?: string;
  submissionId?: string;
  rejectedAt?: number;
  reason?: string;
}

const id = (prefix: string): string => `${prefix}_${randomBytes(6).toString("hex")}`;

/** Record a plan awaiting a person. Returns the id they will approve by. */
export function requestApproval(
  input: Omit<ApprovalRequest, "id" | "createdAt" | "expiresAt" | "fingerprint">,
  now = Date.now(),
  path = APPROVALS_FILE,
): ApprovalRequest {
  const request: ApprovalRequest = {
    ...input,
    id: id("apr"),
    createdAt: now,
    expiresAt: now + ttlSeconds() * 1000,
    fingerprint: fingerprintIntent(input.plan.intent),
  };
  append(path, { v: 1, type: "request", id: request.id, at: now, request } as unknown as LedgerRecord);
  return request;
}

/**
 * Fold an id's records into its current state.
 *
 * `expired` is computed from the clock rather than stored, because nothing
 * writes a record when time passes. Order matters: consumed beats approved,
 * and expiry is only asked about a request still waiting — an approval that was
 * *used* does not become questionable later.
 */
export function statusOf(id: string, now = Date.now(), path = APPROVALS_FILE): ApprovalStatus | undefined {
  const records = historyOf(read(path), id);
  const created = records.find((r) => r.type === "request");
  if (created === undefined) return undefined;
  const request = created.request as ApprovalRequest;

  const consumed = records.find((r) => r.type === "consumed");
  if (consumed !== undefined) {
    return {
      request,
      state: "consumed",
      consumedAt: consumed.at,
      ...(typeof consumed.digest === "string" ? { digest: consumed.digest } : {}),
      ...(typeof consumed.submissionId === "string" ? { submissionId: consumed.submissionId } : {}),
    };
  }

  const rejected = records.find((r) => r.type === "rejected");
  if (rejected !== undefined) {
    return {
      request,
      state: "rejected",
      rejectedAt: rejected.at,
      ...(typeof rejected.reason === "string" ? { reason: rejected.reason } : {}),
    };
  }

  const approved = records.find((r) => r.type === "approval");
  if (approved !== undefined) {
    // An approval that has aged past the request's expiry is not spendable:
    // the price it was given against is gone. Say `expired` rather than
    // `approved` so `execute` refuses for the reason that is true.
    if (now > request.expiresAt) {
      return { request, state: "expired", approvedAt: approved.at };
    }
    return {
      request,
      state: "approved",
      approvedAt: approved.at,
      ...(typeof approved.by === "string" ? { approvedBy: approved.by } : {}),
    };
  }

  return { request, state: now > request.expiresAt ? "expired" : "pending" };
}

/** Record a person's approval. */
export function approve(
  id: string,
  by: string,
  now = Date.now(),
  path = APPROVALS_FILE,
): void {
  append(path, { v: 1, type: "approval", id, at: now, by } as unknown as LedgerRecord);
}

/** Record that a person declined. Kept, rather than deleted, so the decision is auditable. */
export function reject(
  id: string,
  reason: string,
  now = Date.now(),
  path = APPROVALS_FILE,
): void {
  append(path, { v: 1, type: "rejected", id, at: now, reason } as unknown as LedgerRecord);
}

/**
 * Spend an approval.
 *
 * Written **before** the transaction is submitted, not after. If the process
 * dies mid-submission the approval must already read as used — an approval that
 * only becomes `consumed` on success is one a crashed retry can spend a second
 * time, which is the duplicate-order failure this whole path exists to avoid.
 */
export function markConsumed(
  id: string,
  detail: { digest?: string; submissionId?: string },
  now = Date.now(),
  path = APPROVALS_FILE,
): void {
  append(path, { v: 1, type: "consumed", id, at: now, ...detail } as unknown as LedgerRecord);
}

/** Every approval this ledger knows about, newest first. */
export function list(now = Date.now(), path = APPROVALS_FILE): ApprovalStatus[] {
  const ids = read(path)
    .filter((r) => r.type === "request")
    .map((r) => r.id);
  return ids
    .map((each) => statusOf(each, now, path))
    .filter((s): s is ApprovalStatus => s !== undefined)
    .reverse();
}
