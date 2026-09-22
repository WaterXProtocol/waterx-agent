/**
 * A ceiling that resets when the process does is not a ceiling.
 *
 * `maxCumulativeCollateral` lived in `private cumulativeCollateral = 0`. This
 * package persists its jobs, takes a lock and reconciles ambiguous submissions
 * so a write happens at most once across crashes — and then handed a restarted
 * runner a fresh budget. "$200 cumulative" meant "$200 per process".
 */
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { budgetWarnings, readSpend, recordSpend, spentTotal } from "../src/agent/spend.ts";

const ledger = (): string => join(mkdtempSync(join(tmpdir(), "waterx-spend-")), "spend.jsonl");
const nestedLedger = (): string =>
  join(mkdtempSync(join(tmpdir(), "waterx-spend-")), "nested", "spend.jsonl");

describe("the spend ledger", () => {
  it("starts at nothing, and adds up what it is told", () => {
    const path = ledger();
    expect(spentTotal(path)).toBe(0);

    recordSpend({ action: "openLong", accountId: "0xa", collateral: 40 }, 1, path);
    recordSpend({ action: "increasePosition", accountId: "0xa", collateral: 25 }, 2, path);

    expect(spentTotal(path)).toBe(65);
  });

  it("creates its directory, like the ledgers it sits beside", () => {
    const path = nestedLedger();
    recordSpend({ action: "openLong", accountId: "0xa", collateral: 5 }, 1, path);

    expect(spentTotal(path)).toBe(5);
  });

  it("survives the thing it exists for: a new process", () => {
    // Nothing is held in memory between these two calls -- that is the test.
    const path = ledger();
    recordSpend({ action: "openLong", accountId: "0xa", collateral: 199 }, 1, path);

    expect(spentTotal(path)).toBe(199);
    expect(spentTotal(path)).toBe(199);
  });

  it("appends rather than rewriting a total, because a lost update widens the ceiling", () => {
    const path = ledger();
    recordSpend({ action: "openLong", accountId: "0xa", collateral: 10 }, 1, path);
    recordSpend({ action: "openShort", accountId: "0xb", collateral: 20 }, 2, path);

    const entries = readSpend(path);
    expect(entries).toHaveLength(2);
    expect(entries?.map((e) => e.collateral)).toEqual([10, 20]);
    // And it says on what, which is the other half of "how much is left?".
    expect(entries?.map((e) => e.action)).toEqual(["openLong", "openShort"]);
  });

  it("keeps the history when the last line was torn by a crash", () => {
    // An append-only file can end mid-write. One bad line must not make the
    // whole ledger unreadable -- that would read as "nothing spent".
    const path = ledger();
    recordSpend({ action: "openLong", accountId: "0xa", collateral: 30 }, 1, path);
    writeFileSync(path, `${JSON.stringify({ v: 1, at: 1, action: "openLong", accountId: "0xa", collateral: 30 })}\n{"v":1,"at":2,"acti`, "utf8");

    expect(spentTotal(path)).toBe(30);
  });

  it("skips an entry with no usable amount rather than poisoning the total", () => {
    // A NaN would make every ceiling comparison false for the rest of the run.
    const path = ledger();
    writeFileSync(
      path,
      [
        JSON.stringify({ v: 1, at: 1, action: "openLong", accountId: "0xa", collateral: 10 }),
        JSON.stringify({ v: 1, at: 2, action: "openLong", accountId: "0xa", collateral: "40" }),
        JSON.stringify({ v: 1, at: 3, action: "openLong", accountId: "0xa" }),
        "",
      ].join("\n"),
      "utf8",
    );

    expect(spentTotal(path)).toBe(10);
  });

  it("says it cannot read rather than saying nothing was spent", () => {
    // The difference decides whether an unattended process refuses or starts
    // over from a fresh budget.
    const path = ledger();
    recordSpend({ action: "openLong", accountId: "0xa", collateral: 10 }, 1, path);
    chmodSync(path, 0o000);

    const total = spentTotal(path);
    chmodSync(path, 0o600);

    // Root can read anything; skip the assertion rather than fail as root.
    if (process.getuid?.() !== 0) {
      expect(total).toBeUndefined();
    }
  });
});

describe("budgetWarnings", () => {
  it("says nothing while there is room", () => {
    expect(budgetWarnings(100, 200)).toEqual([]);
  });

  it("warns once four fifths of the budget is gone", () => {
    // The threshold exists so an unattended runner reports the coming stop
    // while a person can still act on it, rather than at the refusal.
    expect(budgetWarnings(160, 200).join(" ")).toMatch(/\$40 left of the \$200/u);
  });

  it("says the budget is spent, and that closing positions will not restore it", () => {
    // The distinction from the concurrent ceiling, at the moment it matters:
    // "close something" is the natural guess and it does not work here.
    expect(budgetWarnings(200, 200).join(" ")).toMatch(/budget is spent/u);
    expect(budgetWarnings(260, 200).join(" ")).toMatch(/budget is spent/u);
  });

  it("reports an unreadable ledger as the refusal it causes", () => {
    // `undefined` is "could not read", not "nothing spent" — and the gate
    // refuses every write in that state, so `next` has to name it or the
    // runner looks broken for no visible reason.
    expect(budgetWarnings(undefined, 200).join(" ")).toMatch(/could not be read/u);
  });
});

describe("a released commitment, read back", () => {
  it("nets out across a restart", () => {
    // The reversal has to survive the same way the commitment does: a process
    // that crashed after a failed build must not come back to a budget that
    // still counts the transaction which never existed.
    const path = ledger();
    recordSpend({ action: "openLong", accountId: "0xa", collateral: 50 }, 1, path);
    recordSpend({ action: "openLong:released", accountId: "0xa", collateral: -50 }, 2, path);
    recordSpend({ action: "openLong", accountId: "0xa", collateral: 30 }, 3, path);

    expect(spentTotal(path)).toBe(30);
    // And the history is still there to read, which is the point of appending
    // the reversal rather than editing the entry away.
    expect(readSpend(path)?.map((e) => e.action)).toEqual([
      "openLong",
      "openLong:released",
      "openLong",
    ]);
  });
});
