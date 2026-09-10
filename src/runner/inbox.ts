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
    // The id leads with a zero-padded submission timestamp,
    // because `drain()` sorts filenames and a bare UUIDv4 is random — two
    // intents queued in a deliberate order (close, then re-open) were ingested
    // in whatever order their random ids happened to sort in. The UUID stays as
    // the tiebreaker inside a millisecond and keeps the id unique.
    const id = `${String(Date.now()).padStart(13, "0")}-${randomUUID()}`;
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
    const dirFd = openSync(this.dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
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
   *
   * The sort is submission order because `submit` leads each name with a
   * zero-padded millisecond timestamp; names written by an older version are
   * bare UUIDs and sort arbitrarily among themselves, which is the behaviour
   * they always had.
   */
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
            // the ledger.
            const dirFd = openSync(this.dir, "r");
            try {
              fsyncSync(dirFd);
            } finally {
              closeSync(dirFd);
            }
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
