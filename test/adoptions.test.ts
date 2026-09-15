import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { recordAdoption, resolveApprover } from "../src/agent/adoptions.ts";

describe("recordAdoption", () => {
  it("appends one timestamped line per adoption, saying whether its name was given, creating the directory", () => {
    const path = join(mkdtempSync(join(tmpdir(), "adopt-")), "nested", "adoptions.jsonl");
    const base = {
      accountId: "0xa",
      ownerAddress: "0xo",
      delegate: "0xd",
      network: "testnet",
      by: "cj",
      generated: false,
    };

    recordAdoption(base, 1, path);
    recordAdoption({ ...base, accountId: "0xb", by: "auto-0123456789", generated: true }, 2, path);

    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as unknown);
    expect(lines).toEqual([
      { v: 2, at: 1, ...base },
      { v: 2, at: 2, ...base, accountId: "0xb", by: "auto-0123456789", generated: true },
    ]);
  });
});

describe("resolveApprover", () => {
  it("records the name it was given", () => {
    expect(resolveApprover("  Mario ")).toEqual({ by: "Mario", generated: false });
  });

  it("generates an id when none is given, and marks it as generated", () => {
    // Adoption does not stop to ask. The record still needs a handle, and it
    // must not read as somebody's sign-off.
    const approver = resolveApprover(undefined);

    expect(approver.generated).toBe(true);
    expect(approver.by).toMatch(/^auto-[0-9A-HJKMNP-TV-Z]{10}$/u);
  });

  it("treats a blank name as none, so no line is left with nobody on it", () => {
    expect(resolveApprover("   ").generated).toBe(true);
  });

  it("gives each adoption its own id", () => {
    expect(new Set(Array.from({ length: 50 }, () => resolveApprover(undefined).by)).size).toBe(50);
  });
});
