/**
 * What happens to a write when the platform will not make it durable.
 *
 * The bug these are written against reported a FAILURE for work that had
 * already succeeded. `Inbox.submit` renames an intent into the inbox and then
 * syncs the directory so the new entry survives a power loss. The sync threw,
 * after the rename, and the caller was told its intent had not been queued —
 * while the runner was about to pick it up and trade it. Running the command
 * again, which is what anyone would do, turned one intent into two orders.
 *
 * On Windows that was every call: `fsync` there is `FlushFileBuffers`, which
 * needs a writable handle, and a directory never has one. The suite does not
 * run on Windows, so the case is reproduced here the way POSIX offers it — a
 * directory that can be written to but not opened for reading, which is exactly
 * the shape of the failure: the rename lands, the sync cannot happen.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { append, read } from "../src/agent/ledger.ts";
import { syncDirectory } from "../src/durability.ts";
import { Inbox } from "../src/runner/inbox.ts";
import type { Intent } from "../src/runner/types.ts";

const INTENT: Intent = { kind: "open", ticker: "SUIUSD", side: "long", collateral: 10, leverage: 2 };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "waterx-durability-"));
});
afterEach(() => {
  // Restore the mode first, or the cleanup cannot read what it is removing.
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Already gone, or never created.
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Windows has no way to sync a directory at all; POSIX does. */
const SYNCS_DIRECTORIES = process.platform !== "win32";

/**
 * Permission bits only mean something where they are enforced. Windows honours
 * almost none of them, and to uid 0 they are advisory — in both cases the open
 * below would succeed and the test would assert the opposite of what it means
 * to. Skipped rather than quietly inverted.
 */
const enforcesModes = SYNCS_DIRECTORIES && process.getuid?.() !== 0;

describe("syncing a directory", () => {
  it("reports whether it happened, per platform", () => {
    // Asserted rather than skipped on Windows: "this platform cannot sync a
    // directory" is the fact the tolerance exists for, so it is written down.
    expect(syncDirectory(dir)).toBe(SYNCS_DIRECTORIES);
  });

  (enforcesModes ? it : it.skip)("gives up rather than throwing when the platform will not", () => {
    // Write and traverse, no read. A rename INTO this directory still works;
    // opening it to sync does not. That is the POSIX shape of the Windows bug,
    // and it is how this is reproduced on the systems CI actually runs.
    chmodSync(dir, 0o300);
    expect(syncDirectory(dir)).toBe(false);
  });

  it("still throws for a failure that is not the platform's", () => {
    // The tolerance is for "this system cannot sync a directory", not for "the
    // path is wrong". A list wide enough to swallow the second would swallow a
    // disk reporting it could not write, too.
    expect(() => syncDirectory(join(dir, "does-not-exist"))).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });
});

describe("queueing an intent when the directory cannot be synced", () => {
  // Unconditional. On Windows this is simply the normal case — no directory can
  // be synced there — and on POSIX the `chmod` below manufactures it. Where
  // neither applies (as root) the sync succeeds and the assertions still hold,
  // which is the right answer for a safety net.
  it("accepts it rather than reporting a failure for work it did", () => {
    const inbox = new Inbox(dir);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o300);

    // The assertion is that this returns at all. It used to throw, after the
    // rename, which is the one answer that is neither true nor safe.
    const id = inbox.submit({ intent: INTENT });
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);

    chmodSync(dir, 0o700);
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files, "the entry is really there — which is why a thrown error was a lie").toHaveLength(1);
    const entry = JSON.parse(readFileSync(join(dir, files[0] as string), "utf8")) as { intent: Intent };
    expect(entry.intent).toEqual(INTENT);
  });

  it("leaves no temporary file behind on the ordinary path", () => {
    const inbox = new Inbox(dir);
    inbox.submit({ intent: INTENT });
    expect(readdirSync(dir).filter((f) => f.startsWith("."))).toHaveLength(0);
  });
});

describe("the submission ledger's own durability", () => {
  // Not tolerated, and deliberately so: a submission nobody can read back after
  // a crash is a transaction nobody can reconcile, which is the failure the
  // file exists to prevent. The fix for Windows there was to hold a writable
  // handle, not to ignore the error — so the guarantee below is that the
  // append and the sync go through one descriptor the platform will accept.
  it("appends through a handle it can also sync", () => {
    const path = join(dir, "nested", "submissions.jsonl");
    append(path, { v: 1, type: "submission", id: "sub_1", at: 1 });
    append(path, { v: 1, type: "submission", id: "sub_2", at: 2 });
    expect(read(path).map((r) => r.id)).toEqual(["sub_1", "sub_2"]);
  });

  it("appends to a file that already has records in it", () => {
    // `openSync(path, "a")` must not truncate. Opening `w` by mistake would
    // pass every single-record test and erase the ledger on the second call.
    const path = join(dir, "submissions.jsonl");
    writeFileSync(path, `${JSON.stringify({ v: 1, type: "submission", id: "sub_0", at: 0 })}\n`);
    append(path, { v: 1, type: "submission", id: "sub_1", at: 1 });
    expect(read(path).map((r) => r.id)).toEqual(["sub_0", "sub_1"]);
  });
});
