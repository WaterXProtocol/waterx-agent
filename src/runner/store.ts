/**
 * The durable record. Everything the runner believes lives here, and it is
 * written before it is acted on.
 *
 * A single JSON file, replaced atomically (write a temp file, fsync, rename).
 * Rename on the same filesystem is atomic on POSIX, so a crash leaves either
 * the old file or the new one and never a half-written one — which is the whole
 * requirement. A database would buy concurrent writers and range queries; this
 * runner has one writer and a handful of jobs, so it would buy a native
 * dependency and nothing else.
 *
 * One writer is enforced rather than assumed: the store takes an exclusive lock
 * file. Two runners over one store would each believe they owned a job and
 * submit it twice, which is the exact failure everything here exists to prevent.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { type Job, TERMINAL_STATES } from "./types.ts";

export class StoreLockedError extends Error {
  readonly name = "StoreLockedError";
}

interface StoreFile {
  version: 1;
  jobs: Job[];
}

export class JobStore {
  private jobs: Job[] = [];
  private lockFd?: number;

  constructor(private readonly path: string) {}

  private get lockPath(): string {
    return `${this.path}.lock`;
  }

  /**
   * Load without taking the lock.
   *
   * Inspection must not need the writer's lock, and must not take one: an
   * operator asking what the runner is doing would otherwise be told the runner
   * is doing it, and a crash in the inspector would strand a lock over a store
   * it never wrote to. The snapshot may be one flush stale, which is the
   * correct trade for a read.
   */
  openReadOnly(): void {
    this.jobs = this.load();
  }

  /**
   * Take the lock and load. `wx` fails if the lock exists — a running peer, or
   * one that died holding it. The stale case is left for a human on purpose:
   * breaking a lock automatically is indistinguishable from racing a live
   * runner, and the cost of being wrong is a duplicate trade.
   */
  open(): void {
    // The store owns its directory. Making the caller create it invites the
    // failure below to be reported as a lock conflict, which is what happened.
    mkdirSync(dirname(this.path), { recursive: true });

    // Taking the lock is its own step, so the catch below reasons about
    // acquisition alone — everything after it is this process's own failure.
    try {
      this.lockFd = openSync(this.lockPath, "wx");
    } catch (cause) {
      // Only EEXIST means "someone holds this". Anything else — a missing
      // directory, a read-only mount, a permission problem — is its own fault
      // and must say so, or an operator goes looking for a runner that was
      // never there.
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(
          `Cannot take the job-store lock at ${this.lockPath}: ${describeCause(cause)}`,
        );
      }
      // Name the holder so the stale case can be settled in one command. The
      // check itself stays a human's: `kill -0` on a recycled pid would say
      // "alive" about an unrelated process, and repairing the lock on that
      // basis is how two runners end up submitting the same job.
      let holder = "unknown";
      try {
        holder = readFileSync(this.lockPath, "utf8").trim();
      } catch {
        // Raced with a release; the message degrades and nothing else does.
      }
      throw new StoreLockedError(
        `Another runner holds ${this.lockPath} (written by pid ${holder}). ` +
          `If that process is gone — check with \`ps -p ${holder}\` — remove the file and start again.`,
      );
    }

    // From here the lock is HELD, so every failure has to
    // release it. The `wx` open is what takes the lock, and a throw from the pid
    // write or from `load()` used to leave a lock file behind with no live
    // holder — and this class deliberately refuses to break a stale lock, so the
    // next start failed and needed a human. (`run.ts` calls `open()` outside its
    // try/finally, so it cannot clean this up either.) Releasing a lock this
    // process just took is not the same as breaking someone else's.
    try {
      writeFileSync(this.lockPath, `${String(process.pid)}\n`);
      this.jobs = this.load();
    } catch (cause) {
      this.close();
      throw cause;
    }
  }

  close(): void {
    if (this.lockFd === undefined) return;
    closeSync(this.lockFd);
    this.lockFd = undefined;
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Already gone; nothing to release.
    }
  }

  private load(): Job[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (cause) {
      // ONLY a missing file means "no ledger yet". A permissions problem, a
      // truncated mount, an I/O error — any of those read as an empty store,
      // and an empty store means every in-flight job is forgotten and every
      // queued one is submitted again. Losing the ledger must be loud.
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(
        `Cannot read the job store at ${this.path}: ${describeCause(cause)}. ` +
          `Refusing to start on an unreadable ledger — treating it as empty would re-submit ` +
          `every job it contains.`,
      );
    }
    const parsed = JSON.parse(raw) as StoreFile;
    if (parsed.version !== 1) {
      throw new Error(`Unsupported job store version ${String(parsed.version)} at ${this.path}.`);
    }
    return parsed.jobs;
  }

  /** Every job, oldest first. */
  all(): readonly Job[] {
    return this.jobs;
  }

  get(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  private assertWritable(): void {
    if (this.lockFd === undefined) {
      throw new Error("This store was opened read-only; it cannot be written to.");
    }
  }

  add(job: Job): void {
    this.assertWritable();
    this.jobs.push(job);
    this.flush();
  }

  /**
   * Apply a change and make it durable **before** returning, so a caller can
   * treat the write as having happened. Nothing here is best-effort: a job
   * mutated in memory and lost to a crash is a job the runner will re-send.
   */
  update(id: string, mutate: (job: Job) => void): Job {
    this.assertWritable();
    const job = this.jobs.find((j) => j.id === id);
    if (job === undefined) throw new Error(`No job ${id} in the store.`);
    mutate(job);
    this.flush();
    return job;
  }

  /**
   * Drop finished jobs that are past their retention, and report how many.
   *
   * Deliberately not "all terminal jobs older than X": an `unresolved` job is
   * an open question about money and blocks its key until a person settles it,
   * and a job still inside its cooldown is what stops the same decision being
   * taken twice. Dropping either would turn a safety property into a silent
   * timeout. Writes only when something was actually removed.
   */
  pruneFinished(retentionMs: number, now: number): number {
    this.assertWritable();
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((job) => {
      if (!TERMINAL_STATES.has(job.state)) return true;
      if (job.state === "unresolved") return true;
      if (job.cooldownMs !== undefined && now - job.updatedAt < job.cooldownMs) return true;
      return now - job.updatedAt < retentionMs;
    });
    const dropped = before - this.jobs.length;
    if (dropped > 0) this.flush();
    return dropped;
  }

  private flush(): void {
    const temp = join(dirname(this.path), `.${String(process.pid)}.tmp`);
    const body: StoreFile = { version: 1, jobs: this.jobs };
    const fd = openSync(temp, "w");
    try {
      writeFileSync(fd, `${JSON.stringify(body, null, 2)}\n`);
      // Without the fsync the rename can land while the bytes are still in the
      // page cache, which turns a crash into an empty-but-present store.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.path);

    // The rename is atomic, but the DIRECTORY ENTRY it creates is not durable
    // until the directory itself is synced. Without this a power loss can leave
    // the store pointing at the pre-rename file — losing the digest we wrote
    // precisely so a crash would be recoverable.
    const dir = openSync(dirname(this.path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
}

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
