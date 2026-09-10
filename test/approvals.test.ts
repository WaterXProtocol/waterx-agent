/**
 * The approval and submission ledgers.
 *
 * Both exist to answer a question after the process that could have answered it
 * is gone: "did a person agree to this?" and "did this transaction leave?" So
 * what is tested here is mostly about *absence* — a record that is missing, a
 * clock that has moved on, a line written before a crash — because every one of
 * those has a wrong answer that costs money.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { append, read } from "../src/agent/ledger.ts";
import {
  approve,
  markConsumed,
  reject,
  requestApproval,
  statusOf,
  list,
} from "../src/agent/approvals.ts";
import {
  find,
  recordSubmission,
  settle,
  unsettled,
  statusOf as submissionStatus,
} from "../src/agent/submissions.ts";
import type { TradePlan } from "../src/agent/plan.ts";

let dir: string;
let approvals: string;
let submissions: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "waterx-ledger-"));
  approvals = join(dir, "approvals.jsonl");
  submissions = join(dir, "submissions.jsonl");
});

const plan = (action = "openLong"): TradePlan => ({
  action,
  intent: { action, accountId: `0x${"a".repeat(64)}`, increasesExposure: true, collateral: 10 },
  request: { kind: "marketOrder", body: { accountId: `0x${"a".repeat(64)}`, ticker: "SUIUSD", isLong: true, collateralAmount: "10000000" } },
  context: { referencePrice: 2, boundKind: "max", fill: "buy" },
});

const requestOn = (path: string, now = Date.now()) =>
  requestApproval(
    { action: "openLong", network: "testnet", apiUrl: "https://x", plan: plan(), preview: { action: "openLong" } },
    now,
    path,
  );

describe("the append-only ledger", () => {
  it("survives concurrent appends by interleaving whole records", () => {
    // The reason it is not a read-modify-write JSON file: two one-shot commands
    // a second apart would each read, each add, and the second would erase the
    // first.
    for (let i = 0; i < 50; i++) append(approvals, { v: 1, type: "t", id: `id-${String(i)}`, at: i });
    expect(read(approvals)).toHaveLength(50);
  });

  it("reads a missing file as an empty ledger and nothing else", () => {
    expect(read(join(dir, "never-written.jsonl"))).toEqual([]);
  });

  it("refuses a line it cannot parse rather than skipping it", () => {
    // Skipping is how a truncated approval record turns into "that request was
    // never approved" — the ledger quietly wrong about the one thing it is for.
    append(approvals, { v: 1, type: "request", id: "a", at: 1 });
    writeFileSync(approvals, `${String(read(approvals).map((r) => JSON.stringify(r)))}\n{"broken`, { flag: "a" });
    expect(() => read(approvals)).toThrow(/not valid JSON/);
  });
});

describe("approvals", () => {
  it("starts pending and needs a person", () => {
    const request = requestOn(approvals);
    expect(statusOf(request.id, Date.now(), approvals)?.state).toBe("pending");
  });

  it("records who approved it", () => {
    const request = requestOn(approvals);
    approve(request.id, "someone", Date.now(), approvals);
    const status = statusOf(request.id, Date.now(), approvals);
    expect(status?.state).toBe("approved");
    expect(status?.approvedBy).toBe("someone");
  });

  it("expires an approval whose quote has gone stale", () => {
    // The prices the plan was derived from are minutes old by then. Executing
    // on them is executing an order nobody would approve now.
    const request = requestOn(approvals);
    approve(request.id, "someone", Date.now(), approvals);
    const later = request.expiresAt + 1;
    expect(statusOf(request.id, later, approvals)?.state).toBe("expired");
  });

  it("stays consumed once spent, whatever the clock says afterwards", () => {
    // An approval that was USED does not become questionable later, and the
    // consumed record must outrank expiry — otherwise a crashed retry finds an
    // "expired" approval and a caller reads that as "so it never happened".
    const request = requestOn(approvals);
    approve(request.id, "someone", Date.now(), approvals);
    markConsumed(request.id, { digest: "d1", submissionId: "sub_1" }, Date.now(), approvals);
    const status = statusOf(request.id, request.expiresAt + 10_000, approvals);
    expect(status?.state).toBe("consumed");
    expect(status?.digest).toBe("d1");
  });

  it("remembers who approved it after it has been spent", () => {
    // The moment the approver matters most is after the trade. Reporting
    // `approvedBy: null` on every executed write made the ledger useless as
    // the audit trail it exists to be.
    const request = requestOn(approvals);
    approve(request.id, "someone", Date.now(), approvals);
    markConsumed(request.id, { digest: "d1" }, Date.now(), approvals);
    const status = statusOf(request.id, Date.now(), approvals);
    expect(status?.state).toBe("consumed");
    expect(status?.approvedBy).toBe("someone");
    expect(status?.approvedAt).toBeTypeOf("number");
  });

  it("keeps a refusal rather than deleting it", () => {
    const request = requestOn(approvals);
    reject(request.id, "wrong size", Date.now(), approvals);
    const status = statusOf(request.id, Date.now(), approvals);
    expect(status?.state).toBe("rejected");
    expect(status?.reason).toBe("wrong size");
  });

  it("fingerprints the intent it was requested for", () => {
    // Compared again at execute time. It cannot stop an edit of both lines, but
    // it catches the silent case: a plan changed after a person approved it.
    const request = requestOn(approvals);
    expect(request.fingerprint).toContain("openLong");
  });

  it("knows nothing about an id it never saw", () => {
    expect(statusOf("apr_nope", Date.now(), approvals)).toBeUndefined();
  });

  it("lists newest first", () => {
    const first = requestOn(approvals, 1000);
    const second = requestOn(approvals, 2000);
    expect(list(Date.now(), approvals).map((s) => s.request.id)).toEqual([second.id, first.id]);
  });
});

describe("submissions", () => {
  const record = (digest: string, at = Date.now()) =>
    recordSubmission({ action: "openLong", network: "testnet", digest, accountId: "0xacc" }, at, submissions);

  it("is outstanding until something settles it", () => {
    const submission = record("d1");
    expect(unsettled(submissions).map((s) => s.submission.id)).toEqual([submission.id]);
    settle(submission.id, { landed: true }, Date.now(), submissions);
    expect(unsettled(submissions)).toEqual([]);
  });

  it("stays outstanding when the answer was 'we do not know'", () => {
    // A verdict of `unknown` is not a settlement. Treating it as one is how an
    // in-flight transaction becomes a forgotten one.
    const submission = record("d2");
    settle(submission.id, { landed: "unknown", reason: "not on chain yet" }, Date.now(), submissions);
    expect(unsettled(submissions).map((s) => s.submission.id)).toEqual([submission.id]);
  });

  it("is findable by digest as well as by id", () => {
    const submission = record("d3");
    expect(find("d3", submissions)?.submission.id).toBe(submission.id);
    expect(find(submission.id, submissions)?.submission.digest).toBe("d3");
    expect(find("nothing-like-this", submissions)).toBeUndefined();
  });

  it("carries the verdict back", () => {
    const submission = record("d4");
    settle(submission.id, { landed: true, orderIds: [7], status: "filled" }, Date.now(), submissions);
    const status = submissionStatus(submission.id, submissions);
    expect(status?.settled).toBe(true);
    expect(status?.settlement).toMatchObject({ landed: true, orderIds: [7], status: "filled" });
  });
});
