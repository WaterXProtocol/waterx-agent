/**
 * The pairing code: minted once per wallet, shaped to fit the grant, and read
 * back only for the wallet and network it was issued for.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ALIAS_MAX_BYTES,
  DEFAULT_LABEL,
  ensurePairing,
  isPairingAlias,
  loadPairing,
  mintAlias,
} from "../src/agent/pairing.ts";

const ME = `0x${"a".repeat(64)}`;
const OTHER = `0x${"b".repeat(64)}`;

const file = (): string => join(mkdtempSync(join(tmpdir(), "pairing-")), "nested", "pairing.json");

/** Bytes 0, 1, 2, … — so the code is predictable enough to inspect. */
const counting = (): ((size: number) => Uint8Array) => {
  let n = 0;
  return (size) => Uint8Array.from({ length: size }, () => n++);
};

describe("mintAlias", () => {
  it("names the agent and appends a code the contract will accept", () => {
    const alias = mintAlias();
    expect(alias.startsWith(`${DEFAULT_LABEL}:`)).toBe(true);
    expect(isPairingAlias(alias)).toBe(true);
    expect(Buffer.byteLength(alias)).toBeLessThanOrEqual(ALIAS_MAX_BYTES);
  });

  it("uses an alphabet a person can read back without mistaking one letter for another", () => {
    const code = mintAlias(DEFAULT_LABEL, counting()).split(":")[1] ?? "";
    expect(code).toHaveLength(12);
    expect(code).not.toMatch(/[ILOU]/u);
  });

  it("is different every time it is minted", () => {
    expect(new Set(Array.from({ length: 50 }, () => mintAlias())).size).toBe(50);
  });

  it("refuses a label that would not fit the grant, or would not read as what it is", () => {
    expect(() => mintAlias("")).toThrow();
    expect(() => mintAlias("x".repeat(52))).toThrow(/1–51/u);
    expect(() => mintAlias("bot:two")).toThrow();
    // A Greek omicron: it renders as "bot" and is not.
    expect(() => mintAlias("bοt")).toThrow();
    expect(mintAlias("x".repeat(51))).toHaveLength(ALIAS_MAX_BYTES);
  });
});

describe("ensurePairing", () => {
  it("mints once and returns the same code after, so a link already sent keeps matching", () => {
    const path = file();
    const first = ensurePairing({ delegate: ME, network: "mainnet" }, path, 1);
    const again = ensurePairing({ delegate: ME, network: "mainnet", label: "renamed" }, path, 2);

    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.pairing.alias).toBe(first.pairing.alias);
  });

  it("mints a new code for another wallet, and answers only for the one it was issued to", () => {
    const path = file();
    const mine = ensurePairing({ delegate: ME, network: "mainnet" }, path).pairing.alias;
    const theirs = ensurePairing({ delegate: OTHER, network: "mainnet" }, path).pairing.alias;

    expect(theirs).not.toBe(mine);
    expect(loadPairing(ME, "mainnet", path)).toBeUndefined();
    expect(loadPairing(OTHER, "testnet", path)).toBeUndefined();
  });

  it("matches the wallet however it was spelled", () => {
    const path = file();
    ensurePairing({ delegate: ME, network: "testnet" }, path);

    expect(loadPairing(`0x${ME.slice(2).toUpperCase()}`, "testnet", path)).toBeDefined();
  });

  it("treats an unreadable or altered file as no pairing, which fails closed", () => {
    const path = file();
    ensurePairing({ delegate: ME, network: "mainnet" }, path);
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

    writeFileSync(path, JSON.stringify({ ...record, alias: "waterx-agent:not a code" }));
    expect(loadPairing(ME, "mainnet", path)).toBeUndefined();

    writeFileSync(path, "{");
    expect(loadPairing(ME, "mainnet", path)).toBeUndefined();
  });
});
