/**
 * Making a write durable, and what to do where the platform will not.
 *
 * Two different things get called "fsync" in this repository and they have
 * opposite failure rules:
 *
 *   the FILE   its bytes are the record. A ledger line that is still in the
 *              page cache when the power goes is a transaction nobody can
 *              reconcile, which is the exact failure the file exists to
 *              prevent. A failure here must propagate.
 *
 *   the DIRECTORY   the rename is already atomic; syncing the directory is what
 *              makes the ENTRY it created survive a power loss. It is an
 *              upgrade on a write that has already landed, and it is not
 *              available everywhere.
 *
 * Windows is where the difference stopped being academic. Node's `fsync` is
 * `FlushFileBuffers`, which needs a writable handle, so a directory and a file
 * opened `r` both come back `EPERM` — and the directory case threw *after* the
 * rename, which is the worst possible moment. `queue` told the caller its
 * intent had not been accepted while the file was already sitting in the inbox,
 * where the runner would pick it up and trade it on the next pass. A caller
 * doing the obvious thing with that error — running the command again — got two
 * orders out of one intent.
 *
 * So: directory syncing is best effort, and a platform that cannot offer it
 * degrades to the durability a plain rename gives rather than turning a
 * completed write into a reported failure. File syncing is not best effort, and
 * the way to keep it everywhere is to hold a writable handle — see
 * `src/agent/ledger.ts`, which appends through the same descriptor it syncs.
 */
import { closeSync, fsyncSync, openSync } from "node:fs";

/**
 * Codes that mean "this platform does not sync directories", not "this write
 * failed".
 *
 * `EPERM` is Windows. `EISDIR` and `EINVAL` are how several platforms and
 * filesystems refuse a directory handle. `ENOSYS` and `ENOTSUP` are the honest
 * "not implemented" answers.
 *
 * Deliberately NOT `EIO`, which is a disk saying it could not write, and not
 * `EBADF`, which is this code holding a descriptor it already closed. Both are
 * real and both would be hidden by a wider list.
 */
const UNAVAILABLE = new Set(["EPERM", "EACCES", "EISDIR", "EINVAL", "ENOSYS", "ENOTSUP"]);

const codeOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

/**
 * Make a directory entry durable, where the platform has a way to.
 *
 * Call it AFTER the rename or unlink it is meant to persist — that ordering is
 * the point, and it is why this must not throw for a platform reason: by the
 * time it runs, the change the caller asked for is already visible.
 *
 * Returns whether the sync happened, so a caller that wants to say so can.
 * Nothing in this repository changes behaviour on it; it exists for tests, and
 * so that "it silently did nothing" is at least observable.
 */
export function syncDirectory(path: string): boolean {
  let fd: number;
  try {
    // The open is inside the guard too: Windows refuses a directory handle here
    // rather than at the sync, so catching only around `fsyncSync` left the
    // original bug in place on the platform it was written for.
    fd = openSync(path, "r");
  } catch (error) {
    if (UNAVAILABLE.has(codeOf(error) ?? "")) return false;
    throw error;
  }
  try {
    fsyncSync(fd);
    return true;
  } catch (error) {
    if (UNAVAILABLE.has(codeOf(error) ?? "")) return false;
    throw error;
  } finally {
    closeSync(fd);
  }
}
