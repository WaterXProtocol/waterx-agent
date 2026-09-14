/**
 * Who told this agent which account to trade, and when.
 *
 * Adopting an account is choosing whose money the agent trades. Like an
 * approval, it cannot be made impossible for a process that can write files —
 * so it is made impossible BY MISTAKE (a name is required) and leaves a record
 * when it is not a mistake. Kept apart from the approvals ledger on purpose:
 * that ledger folds records per previewed plan, and an adoption is not one.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const ADOPTIONS_FILE = process.env.WATERX_ADOPTIONS_FILE?.trim() || ".waterx/adoptions.jsonl";

export interface AdoptionRecord {
  v: 1;
  at: number;
  accountId: string;
  ownerAddress: string;
  delegate: string;
  network: string;
  /** The person who chose this account. */
  by: string;
}

export function recordAdoption(
  input: Omit<AdoptionRecord, "v" | "at">,
  now = Date.now(),
  path = ADOPTIONS_FILE,
): AdoptionRecord {
  const record: AdoptionRecord = { v: 1, at: now, ...input };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}
