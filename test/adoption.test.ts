/**
 * Adoption on evidence.
 *
 * A lone grant carrying this agent's pairing code proves itself; everything else
 * needs a person, and their name is recorded as what it is. The dangerous
 * direction is adopting on something that only looks like proof — a copied code,
 * a count that did not finish, a name nobody checked.
 */
import { describe, expect, it } from "vitest";

import { decideAdoption, grantEvidence } from "../src/agent/adoption.ts";
import type { Pairing } from "../src/agent/pairing.ts";

const PAIRING: Pairing = {
  v: 1,
  network: "mainnet",
  delegate: `0x${"a".repeat(64)}`,
  alias: "waterx-agent:K7Q2M9XDP4R8",
  createdAt: 0,
};

const base = {
  accountId: `0x${"1".repeat(64)}`,
  ownerAddress: `0x${"2".repeat(64)}`,
  grantAlias: PAIRING.alias,
  pairing: PAIRING as Pairing | undefined,
  pairedGrants: 1 as number | undefined,
  approver: undefined as string | undefined,
};

describe("grantEvidence", () => {
  it("pairs an exact match and nothing else", () => {
    expect(grantEvidence(PAIRING.alias, PAIRING)).toEqual({ paired: true, alias: PAIRING.alias });
    expect(grantEvidence(PAIRING.alias.toLowerCase(), PAIRING)).toEqual({ paired: false, why: "other-alias" });
  });

  it("says why a grant is unpaired", () => {
    expect(grantEvidence("", PAIRING)).toEqual({ paired: false, why: "no-alias" });
    expect(grantEvidence(PAIRING.alias, undefined)).toEqual({ paired: false, why: "no-pairing" });
  });
});

describe("decideAdoption", () => {
  it("adopts a lone paired grant without asking anyone", () => {
    expect(decideAdoption(base)).toEqual({ adopt: true, evidence: "pairing", alias: PAIRING.alias });
  });

  it("will not take a grant anybody could have made on no one's word", () => {
    const decision = decideAdoption({ ...base, grantAlias: "" });

    expect(decision.adopt).toBe(false);
    if (!decision.adopt) {
      expect(decision.message).toContain("carries no pairing code");
      expect(decision.message).toContain("--approver");
      expect(decision.message).toContain("nothing verifies it");
    }
  });

  it("records a person's name as an attestation, never as proof", () => {
    expect(decideAdoption({ ...base, grantAlias: "", approver: "  Mario " })).toEqual({
      adopt: true,
      evidence: "attestation",
      attestedBy: "Mario",
    });
  });

  it("does not count a blank name as a name", () => {
    expect(decideAdoption({ ...base, grantAlias: "", approver: "   " }).adopt).toBe(false);
  });

  it("treats a second grant carrying the code as a copy, not as proof", () => {
    // The code is public once the owner's grant lands. Anyone watching can
    // write it into a grant on their own account.
    const decision = decideAdoption({ ...base, pairedGrants: 2 });

    expect(decision.adopt).toBe(false);
    if (!decision.adopt) expect(decision.message).toMatch(/copies/u);
  });

  it("does not take proof it could not finish checking", () => {
    // An unreadable candidate or a lagging index could be hiding the copy.
    expect(decideAdoption({ ...base, pairedGrants: undefined }).adopt).toBe(false);
  });

  it("lets a person settle an ambiguous pairing, on the record as an attestation", () => {
    expect(decideAdoption({ ...base, pairedGrants: 2, approver: "Mario" })).toEqual({
      adopt: true,
      evidence: "attestation",
      attestedBy: "Mario",
    });
  });

  it("keeps a name given alongside proof, without letting it stand in for the proof", () => {
    expect(decideAdoption({ ...base, approver: "Mario" })).toEqual({
      adopt: true,
      evidence: "pairing",
      alias: PAIRING.alias,
      attestedBy: "Mario",
    });
  });
});
