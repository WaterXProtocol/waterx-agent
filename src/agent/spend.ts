/**
 * What this installation has already committed, on disk.
 *
 * `maxCumulativeCollateral` was a number in memory: `private
 * cumulativeCollateral = 0`, reset by every process start. This package takes
 * real trouble to survive a restart everywhere else — the runner persists its
 * jobs, takes a lock, and reconciles anything ambiguous before doing new work,
 * so a submission happens at most once across crashes. The spend ceiling was
 * the exception, and the exception mattered: a runner that crashes and restarts
 * is a thing the design explicitly supports, and it came back with a fresh
 * budget. "$200 cumulative" meant "$200 per process", and processes are cheap.
 *
 * So it lives beside the other ledgers in `.waterx/`, which `bootstrap` already
 * keeps out of git. Append-only, and summed on load, for the same reason the
 * adoption ledger is: an append cannot lose an earlier entry to a concurrent
 * writer, and a read-modify-write of a running total can. Two processes racing
 * on a total would each read the old value and write back their own, which
 * loses spend — and losing spend widens the ceiling, which is the direction
 * that must never be cheap.
 *
 * It is also the audit trail. "You have $120 of $200 left" is answerable now,
 * and so is "on what".
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const SPEND_FILE = process.env.WATERX_SPEND_FILE?.trim() || ".waterx/spend.jsonl";

export interface SpendEntry {
  v: 1;
  at: number;
  /** The action that committed it, for reading the ledger back. */
  action: string;
  accountId: string;
  /** Display USD. The same units the scope is written in. */
  collateral: number;
}

/** Append one committed amount. Throws rather than losing it silently. */
export function recordSpend(
  entry: Omit<SpendEntry, "v" | "at">,
  now = Date.now(),
  path = SPEND_FILE,
): SpendEntry {
  const record: SpendEntry = { v: 1, at: now, ...entry };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

/**
 * Every entry the ledger holds, in order.
 *
 * A line that will not parse is skipped rather than fatal: an append-only file
 * can end in a partial write, and one torn last line must not make the whole
 * history unreadable. A file that cannot be READ is different — see
 * {@link spentTotal}.
 */
export function readSpend(path = SPEND_FILE): SpendEntry[] | undefined {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Not "nothing spent". The caller decides, and under an unattended policy
    // the only safe decision is to refuse.
    return undefined;
  }
  const entries: SpendEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      const entry = parsed as Partial<SpendEntry>;
      if (typeof entry.collateral !== "number" || !Number.isFinite(entry.collateral)) continue;
      entries.push({
        v: 1,
        at: typeof entry.at === "number" ? entry.at : 0,
        action: typeof entry.action === "string" ? entry.action : "unknown",
        accountId: typeof entry.accountId === "string" ? entry.accountId : "unknown",
        collateral: entry.collateral,
      });
    } catch {
      continue;
    }
  }
  return entries;
}

/**
 * How much has been committed, or `undefined` when the ledger cannot be read.
 *
 * `undefined` is not zero, and the difference is the whole point: a ceiling
 * that cannot be accounted against is not a ceiling, so an unattended caller
 * refuses rather than starting again from nothing.
 */
export function spentTotal(path = SPEND_FILE): number | undefined {
  const entries = readSpend(path);
  if (entries === undefined) return undefined;
  return entries.reduce((total, entry) => total + entry.collateral, 0);
}

/**
 * What `next` should say about the cumulative budget before a run hits it.
 *
 * The budget is the one ceiling that gives no warning by its nature: the
 * per-order and concurrent ceilings refuse an order and stay exactly where
 * they were, so retrying smaller works. The cumulative one only decays, and
 * the first sign of it used to be a refusal with no remedy short of editing
 * the scope file — which, for an unattended runner, means the run has stopped
 * and nobody knows why. So it is announced while there is still room.
 */
export function budgetWarnings(spent: number | undefined, ceiling: number): string[] {
  if (spent === undefined) {
    return [
      `The spend ledger (${SPEND_FILE}) exists but could not be read, so every write under ` +
        `delegated-auto refuses. Fix or remove it.`,
    ];
  }
  const left = Math.round((ceiling - spent) * 100) / 100;
  if (left <= 0) {
    return [
      `The cumulative collateral budget is spent ($${String(spent)} of $${String(ceiling)}). ` +
        `Writes that increase exposure refuse until the ceiling is raised.`,
    ];
  }
  if (ceiling > 0 && spent / ceiling >= 0.8) {
    return [
      `$${String(left)} left of the $${String(ceiling)} cumulative collateral budget ` +
        `($${String(spent)} used). It does not reset when positions close.`,
    ];
  }
  return [];
}
