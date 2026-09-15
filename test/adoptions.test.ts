import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { recordAdoption } from "../src/agent/adoptions.ts";

describe("recordAdoption", () => {
  it("appends one timestamped line per adoption, saying what it rested on, creating the directory", () => {
    const path = join(mkdtempSync(join(tmpdir(), "adopt-")), "nested", "adoptions.jsonl");
    const base = {
      accountId: "0xa",
      ownerAddress: "0xo",
      delegate: "0xd",
      network: "testnet",
      evidence: "attestation" as const,
      attestedBy: "cj",
    };

    recordAdoption(base, 1, path);
    recordAdoption({ ...base, accountId: "0xb" }, 2, path);

    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as unknown);
    expect(lines).toEqual([
      { v: 2, at: 1, ...base },
      { v: 2, at: 2, ...base, accountId: "0xb" },
    ]);
  });
});
