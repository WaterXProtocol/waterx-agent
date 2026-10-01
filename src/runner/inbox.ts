/**
 * A lock-free way to hand the runner new work.
 *
 * The store has one writer by design — two runners over one ledger would each
 * believe they owned a job and submit it twice. But that lock also shut out
 * `queue`, so intents could only be added while the runner was stopped, which
 * is the opposite of what a long-running service is for.
 *
 * So enqueueing does not touch the store. Each intent is written as its own file
 * here, and the runner drains them into the ledger on its next pass. One file
 * per intent, created by rename, so a reader never sees a partial one and two
 * writers never collide.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { syncDirectory } from "../durability.ts";
import type { Intent } from "./types.ts";

/** One queued intent, as it sits on disk. */
export interface InboxEntry {
  intent: Intent;
  notBefore?: number;
  expiresAt?: number;
  key?: string;
  cooldownMs?: number;
}

export class Inbox {
  constructor(private readonly dir: string) {}

  /**
   * Write one intent for the runner to pick up.
   *
   * Written to a temp name and renamed, so the runner cannot read a half-written
   * file: it either sees a complete entry or nothing.
   */
  submit(entry: InboxEntry): string {
    mkdirSync(this.dir, { recursive: true });
    const id = randomUUID();
    const temp = join(this.dir, `.${id}.tmp`);
    const final = join(this.dir, `${id}.json`);

    const fd = openSync(temp, "w");
    try {
      writeFileSync(fd, `${JSON.stringify(entry, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, final);

    // The rename is atomic; the directory entry it creates is not durable until
    // the directory is synced. Without this a power loss can lose an intent the
    // caller was already told was queued.
    //
    // Best effort, and it has to be: by this line the entry is already in the
    // inbox and the runner will pick it up. Throwing here reported a failure
    // for an intent that was in fact queued — and on Windows, where a directory
    // cannot be synced at all, that was every call. A caller who responded to
    // the error the obvious way got two orders from one intent.
    syncDirectory(this.dir);
    return id;
  }

  /**
   * Take everything waiting, WITHOUT removing it.
   *
   * Each entry comes with its id and an `ack` to call once the job is durably
   * in the ledger. Deleting on read lost the intent to any crash between the
   * unlink and the store's flush; deleting after the write can instead
   * duplicate it, so every entry carries its inbox id and the runner skips one
   * it has already ingested. Ingestion is idempotent, and the file is the
   * record until the ledger is.
   *
   * A file that cannot be parsed is moved aside rather than deleted or retried:
   * retrying would wedge the drain on every pass, and deleting would discard an
   * intent someone meant. It stays as `.rejected` for a person to look at.
   */
  /**
   * What is waiting, without taking it.
   *
   * `drain` is the runner's: it hands each entry over with an ack that deletes
   * it. A person asking what is queued must not be able to consume the queue by
   * asking, so this reads and returns.
   *
   * It exists because `jobs` reported only the STORE, and an intent lives in
   * the inbox until a runner has a pass to spare for it. An inbox holding ten
   * intents and a store holding none answered "no jobs" — and an operator who
   * reads that queues them again, or stops a runner believing nothing is
   * pending on it.
   *
   * A file that cannot be parsed is reported as unreadable rather than skipped.
   * "Something is here and I cannot read it" is the fact an operator needs; a
   * silent skip would restore the same wrong answer in a smaller place.
   */
  pending(): { id: string; entry?: InboxEntry; unreadable?: true }[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json")).sort();
    } catch {
      return [];
    }
    return names.map((name) => {
      const id = name.replace(/\.json$/u, "");
      try {
        return { id, entry: JSON.parse(readFileSync(join(this.dir, name), "utf8")) as InboxEntry };
      } catch {
        return { id, unreadable: true as const };
      }
    });
  }

  drain(): { id: string; entry: InboxEntry; ack: () => void }[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json")).sort();
    } catch {
      return [];
    }

    const out: { id: string; entry: InboxEntry; ack: () => void }[] = [];
    for (const name of names) {
      const path = join(this.dir, name);
      try {
        const entry = JSON.parse(readFileSync(path, "utf8")) as InboxEntry;
        out.push({
          id: name.replace(/\.json$/, ""),
          entry,
          ack: () => {
            try {
              unlinkSync(path);
            } catch (cause) {
              // ENOENT is fine — something else removed it and the ledger is
              // the record now either way. Anything else means the file will be
              // read again, which ingestion survives (it is idempotent) but
              // which will repeat every pass until someone looks. Silence would
              // turn that into a mystery.
              if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
                throw new Error(
                  `Could not remove the inbox entry ${path}: ` +
                    `${cause instanceof Error ? cause.message : String(cause)}. ` +
                    `Its job is already stored; the file will be re-read and recognised, ` +
                    `but it will keep reappearing until this is fixed.`,
                );
              }
              return;
            }
            // A rename made the entry durable; an unlink has to be made durable
            // the same way, or a crash resurrects a file whose job is already in
            // the ledger. Best effort for the same reason as the one in
            // `submit`: the unlink has happened, and a resurrected entry is
            // recognised on the next pass rather than traded twice.
            syncDirectory(this.dir);
          },
        });
      } catch {
        try {
          renameSync(path, `${path}.rejected`);
        } catch {
          // Nothing further to try; the next pass will attempt it again.
        }
      }
    }
    return out;
  }
}
