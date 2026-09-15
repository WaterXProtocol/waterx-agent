/**
 * Which account this agent was told to trade, when, and under what name.
 *
 * Adopting an account is choosing whose money the agent trades, so each
 * adoption leaves a line. The name on it is whatever `--approver` said or, when
 * nobody gave one, a generated id — and the record says which. A generated id
 * names no one: it tells one adoption from another, and `generated: true` keeps
 * anyone reading the ledger later from taking it for a sign-off. Kept apart from
 * the approvals ledger on purpose: that ledger folds records per previewed plan,
 * and an adoption is not one.
 */
import { randomBytes } from "node:crypto";
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
  /** The name given with `--approver`, or a generated id when none was. */
  by: string;
  /** Whether `by` was generated rather than given. A generated one names no one. */
  generated: boolean;
}

/** Crockford base32 — no I, L, O or U — and 32 divides 256, so no bias. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_LENGTH = 10;

/**
 * The name the record goes under: the one given, or a generated id.
 *
 * Adoption does not stop to ask for a name. A blank one counts as none, so
 * `--approver ""` cannot leave a line with nobody on it.
 */
export function resolveApprover(
  given: string | undefined,
  random: (size: number) => Uint8Array = randomBytes,
): { by: string; generated: boolean } {
  const name = given?.trim();
  if (name !== undefined && name !== "") return { by: name, generated: false };
  const bytes = random(ID_LENGTH);
  let id = "";
  for (let i = 0; i < ID_LENGTH; i += 1) id += ALPHABET[(bytes[i] ?? 0) & 31];
  return { by: `auto-${id}`, generated: true };
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
