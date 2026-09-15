/**
 * Which account this agent was told to trade, when, and on what evidence.
 *
 * Adopting an account is choosing whose money the agent trades, so the record
 * says what the choice rested on rather than only who made it. A name alone was
 * a weak record in the worst way: anything at the terminal can type one, and a
 * line reading "approved by cj" looks the same whether cj approved or not. So
 * `evidence` is either `pairing` — the owner's grant carried this agent's code,
 * read back from chain — or `attestation`, where `attestedBy` is the name a
 * person gave and nothing verified it. Kept apart from the approvals ledger on
 * purpose: that ledger folds records per previewed plan, and an adoption is not
 * one.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const ADOPTIONS_FILE = process.env.WATERX_ADOPTIONS_FILE?.trim() || ".waterx/adoptions.jsonl";

export interface AdoptionRecord {
  v: 2;
  at: number;
  accountId: string;
  ownerAddress: string;
  delegate: string;
  network: string;
  /** What established that this is the account to trade. */
  evidence: "pairing" | "attestation";
  /** The pairing alias the owner's grant carried, when that is the evidence. */
  alias?: string;
  /** The name a person gave for the choice. Recorded, never verified. */
  attestedBy?: string;
}

export function recordAdoption(
  input: Omit<AdoptionRecord, "v" | "at">,
  now = Date.now(),
  path = ADOPTIONS_FILE,
): AdoptionRecord {
  const record: AdoptionRecord = { v: 2, at: now, ...input };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}
