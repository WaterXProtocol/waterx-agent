/**
 * What makes an account the one this agent trades — decided from evidence, and
 * recorded as the evidence it was.
 *
 * `adopt` used to require `--approver <name>` for every account. The name was
 * the whole of the check, and a name is not evidence: a person can mean one and
 * anything at the terminal can type one, so the record said "someone approved"
 * whether anyone had or not. What adoption actually needs to know is whether the
 * grant came from the owner this agent sent its link to, and there are only two
 * honest answers:
 *
 * - **pairing** — the owner's grant carries this agent's pairing code, read back
 *   from chain (see `pairing.ts`). Nobody has to vouch for it, so nobody is asked.
 * - **attestation** — it does not, or its code has been copied, so the chain
 *   cannot say. A person has to decide, their name is recorded, and the record
 *   says it was an attestation: a claim, never verified.
 */
import type { Pairing } from "./pairing.ts";

/** Why a grant does not count as paired. */
export type Unpaired =
  /** This directory issued no pairing code, so there is nothing to match against. */
  | "no-pairing"
  /** The grant carries no alias: whatever built it does not write one yet. */
  | "no-alias"
  /** The grant carries a label that is not this agent's code. */
  | "other-alias";

export type GrantEvidence = { paired: true; alias: string } | { paired: false; why: Unpaired };

export function grantEvidence(grantAlias: string, pairing: Pairing | undefined): GrantEvidence {
  if (pairing === undefined) return { paired: false, why: "no-pairing" };
  if (grantAlias === "") return { paired: false, why: "no-alias" };
  return grantAlias === pairing.alias
    ? { paired: true, alias: pairing.alias }
    : { paired: false, why: "other-alias" };
}

/** The clause that finishes "<account>, owned by <owner>, …" for an unpaired grant. */
export const UNPAIRED_REASON: Readonly<Record<Unpaired, string>> = {
  "no-pairing":
    "cannot be checked against a pairing code: this directory never issued one (`onboard` does).",
  "no-alias":
    "carries no pairing code — whatever built the grant does not write one yet.",
  "other-alias": "carries a label that is not this agent's pairing code.",
};

const ATTEST =
  `adopt it with --approver "<their name>". The name is recorded as their attestation; ` +
  `nothing verifies it, so it has to come from them, not from whoever is running the command.`;

export type AdoptionDecision =
  | { adopt: true; evidence: "pairing"; alias: string; attestedBy?: string }
  | { adopt: true; evidence: "attestation"; attestedBy: string }
  | { adopt: false; message: string };

export function decideAdoption(input: {
  accountId: string;
  ownerAddress: string;
  grantAlias: string;
  pairing: Pairing | undefined;
  /**
   * How many live grants to this wallet carry the pairing alias, or `undefined`
   * when they could not be counted. One is proof; more than one is a copy; not
   * knowing is not proof.
   */
  pairedGrants: number | undefined;
  approver: string | undefined;
}): AdoptionDecision {
  const approver = input.approver?.trim() || undefined;
  const evidence = grantEvidence(input.grantAlias, input.pairing);

  if (evidence.paired) {
    if (input.pairedGrants === 1) {
      return {
        adopt: true,
        evidence: "pairing",
        alias: evidence.alias,
        ...(approver === undefined ? {} : { attestedBy: approver }),
      };
    }
    if (approver !== undefined) return { adopt: true, evidence: "attestation", attestedBy: approver };
    return {
      adopt: false,
      message:
        input.pairedGrants === undefined
          ? `${input.accountId} carries this agent's pairing code, but the other grants to this ` +
            `wallet could not be counted, so a copy of the code cannot be ruled out. A person ` +
            `must confirm it is the account to trade and ${ATTEST}`
          : `${String(input.pairedGrants)} grants to this wallet carry its pairing code. The code ` +
            `is public once a grant has used it, so all but one are copies. A person must choose — ` +
            `comparing each owner address in full with the wallet that signed — and ${ATTEST}`,
    };
  }

  if (approver !== undefined) return { adopt: true, evidence: "attestation", attestedBy: approver };
  return {
    adopt: false,
    message:
      `${input.accountId}, owned by ${input.ownerAddress}, ${UNPAIRED_REASON[evidence.why]} ` +
      `Nothing on chain shows it was granted through this agent's link, so a person must ` +
      `confirm it is the account to trade — comparing the owner address in full with the ` +
      `wallet that signed — and ${ATTEST}`,
  };
}
