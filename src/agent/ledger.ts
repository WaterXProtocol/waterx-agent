/**
 * A small append-only ledger, one JSON object per line.
 *
 * Two things in this package outlive a single process and have to survive a
 * crash: which requests a human approved, and which transactions were sent.
 * Both are written by short-lived one-shot commands that may run concurrently,
 * which is exactly the case a read-modify-write JSON file handles badly — two
 * `execute` invocations a second apart would each read the file, each add a
 * line, and the second would erase the first.
 *
 * So: `O_APPEND`, one `write()` per record, `fsync` before the call returns.
 * Concurrent appends interleave by whole records instead of overwriting, and
 * nothing is reported as durable until it is. State that changes — an approval
 * being consumed — is expressed as a *later record*, not as an edit, and folded
 * on read. Nothing is ever rewritten in place.
 *
 * This is not the runner's `JobStore`. That one has a single writer, takes an
 * exclusive lock and holds a mutable set of jobs; borrowing it here would mean
 * an `execute` refusing to run because a `preview` was in flight.
 */
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Every record carries these; the rest is the caller's business. */
export interface LedgerRecord {
  /** Schema version of this line, so a future reader can tell what it is holding. */
  v: 1;
  /** What kind of record this is — `request`, `approval`, `consumed`, … */
  type: string;
  /** What it is about. Records sharing an id describe one thing over time. */
  id: string;
  /** Unix ms. */
  at: number;
  [key: string]: unknown;
}

/**
 * Append one record and return only once it is on disk.
 *
 * The `fsync` is the point. This ledger's whole job is to be readable *after* a
 * crash, and a record that is still in the page cache when the power goes is a
 * transaction nobody can reconcile — which is the failure the file exists to
 * prevent, reintroduced by the write that was supposed to prevent it.
 */
export function append(path: string, record: LedgerRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  // One write, one line: a record split across two calls is a record another
  // process can interleave into.
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Every record in the file, oldest first. A missing file is an empty ledger.
 *
 * A line that will not parse throws rather than being skipped. Skipping is how
 * a truncated approval record turns into "that request was never approved",
 * and the ledger would then be quietly wrong about the one thing it is for.
 */
export function read(path: string): LedgerRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Cannot read the ledger at ${path}: ${describe(cause)}`);
  }
  const records: LedgerRecord[] = [];
  const lines = raw.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as LedgerRecord);
    } catch {
      throw new Error(
        `${path}:${String(index + 1)} is not valid JSON. The ledger is append-only and is never ` +
          `rewritten, so a bad line means a crash during a write or an edit by hand — resolve it ` +
          `deliberately rather than letting it read as "this never happened".`,
      );
    }
  }
  return records;
}

/** The records for one id, oldest first. */
export const historyOf = (records: readonly LedgerRecord[], id: string): LedgerRecord[] =>
  records.filter((r) => r.id === id);

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
