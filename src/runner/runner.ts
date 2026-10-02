/**
 * The loop that survives a restart.
 *
 * Its whole job is to make one guarantee true: **an intent is submitted at most
 * once.** Everything else — retries, the fill wait, the scheduler — is ordinary.
 * That one property is not, because the failure it prevents is silent: a
 * duplicate trade looks exactly like a trade.
 *
 * The guarantee is bought with ordering, not cleverness. Before a submission is
 * attempted the job is written as `submitting`; before the bytes leave the
 * process the digest is written beside it. So every crash lands in a state that
 * can be resolved from evidence afterwards:
 *
 *   crashed before `submitting` was written  → nothing was sent; the job is still `queued`
 *   crashed after it, before the digest      → nothing was signed; retry is safe
 *   crashed after the digest                 → ask the chain about that digest
 *
 * There is no fourth case, and none of them is resolved by a timer.
 */
import { randomUUID } from "node:crypto";

import type { WaterXAgent } from "../agent/agent.ts";
import { ExecutionPolicyError, UsageError, WaterXApiError } from "../errors.ts";
import { oversizedStops } from "../agent/stops.ts";
import type { Position } from "../api/types.ts";
import type { Inbox, InboxEntry } from "./inbox.ts";
import type { Reconciler } from "./reconcile.ts";
import type { JobStore } from "./store.ts";
import {
  DEFAULT_LIMITS,
  type Intent,
  type Job,
  type JobState,
  type RunnerLimits,
  settlementOf,
  TERMINAL_STATES,
} from "./types.ts";

export interface RunnerOptions {
  agent: WaterXAgent;
  store: JobStore;
  reconciler: Reconciler;
  limits?: RunnerLimits;
  /** Where `queue` leaves work. Absent means this runner accepts none. */
  inbox?: Inbox;
  /** Injected so tests do not depend on the machine's clock. */
  now?: () => number;
  /** Progress reporting. Defaults to stdout. */
  log?: (line: string) => void;
  /**
   * Whether a reduce queues a follow-up to resize the protective legs it
   * outgrows. On by default, because a stale stop is the defect and an off-by-
   * default fix stays broken for everyone who does not know it exists.
   *
   * An off switch exists because this is the one thing the runner does that
   * nobody queued. It is still bounded by the scope — the follow-up is an
   * `updateOrder` and the gate checks it like any other write.
   */
  fitStops?: boolean;
}

export class Runner {
  private readonly agent: WaterXAgent;
  private readonly store: JobStore;
  private readonly reconciler: Reconciler;
  private readonly fitStopsEnabled: boolean;
  private readonly limits: RunnerLimits;
  private readonly inbox: Inbox | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** So a sustained hold is reported once, not on every pass. */
  private lastAmbiguityBlock?: string;

  constructor(options: RunnerOptions) {
    this.agent = options.agent;
    this.store = options.store;
    this.reconciler = options.reconciler;
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.inbox = options.inbox;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
    this.fitStopsEnabled = options.fitStops ?? true;
  }

  /**
   * Refuse to run unattended under a policy that cannot sign unattended.
   *
   * A runner started under `interactive` would answer, recover, and then refuse
   * every submission — a process that looks healthy and does nothing. Saying so
   * at start-up is the difference between a misconfiguration and a mystery.
   */
  assertCanRunUnattended(): void {
    if (this.agent.gate.mode !== "delegated-auto") {
      throw new ExecutionPolicyError(
        `The runner signs with nobody watching, so it needs WATERX_EXECUTION_POLICY=delegated-auto ` +
          `and a scope file. The current policy is "${this.agent.gate.mode}", under which every ` +
          `submission would be refused.`,
      );
    }
  }

  /**
   * Accept an intent, optionally deferred and optionally keyed.
   *
   * A deferred intent must carry an expiry. The window between deciding and
   * firing is where the reason for the decision goes stale, and a delayed order
   * that survives an outage and fires into a moved market is a trade nobody
   * asked for. Refusing here — rather than defaulting — keeps that a decision.
   *
   * With a `key`, a repeat of the same idea is suppressed and `undefined` is
   * returned. Without one, the call always produces a job — which is why the
   * overloads differ: only a keyed caller has to handle "already handled".
   */
  enqueue(intent: Intent, schedule?: UnkeyedSchedule): Job;
  enqueue(intent: Intent, schedule: KeyedSchedule): Job | undefined;
  enqueue(intent: Intent, schedule: Schedule = {}): Job | undefined {
    const at = this.now();

    if (schedule.cooldownMs !== undefined && schedule.key === undefined) {
      throw new ExecutionPolicyError(
        `A cooldown needs a key — there is nothing for it to be a cooldown on otherwise.`,
      );
    }
    if (
      schedule.cooldownMs !== undefined &&
      (!Number.isFinite(schedule.cooldownMs) || schedule.cooldownMs <= 0)
    ) {
      // A negative or NaN cooldown compares false against every elapsed time,
      // so the job is accepted and the caller believes a limit is in force that
      // can never fire. Refuse rather than record a decoration.
      throw new ExecutionPolicyError(
        `A cooldown of ${String(schedule.cooldownMs)}ms bounds nothing — every comparison ` +
          `against it is false, so the key would never actually be held. Omit the cooldown if ` +
          `that is what you meant; do not record one that cannot fire.`,
      );
    }
    if (schedule.key !== undefined) {
      const blocker = this.blockingJob(schedule.key, schedule.cooldownMs, at);
      if (blocker !== undefined) {
        this.log(`skipped ${describeIntent(intent)} — ${blocker}`);
        return undefined;
      }
    }

    if (schedule.notBefore !== undefined && schedule.expiresAt === undefined) {
      throw new ExecutionPolicyError(
        `A deferred intent needs an expiry. Without one it fires whenever the runner next ` +
          `comes up, however long that is, on whatever the market has become.`,
      );
    }
    if (
      schedule.expiresAt !== undefined &&
      schedule.expiresAt <= (schedule.notBefore ?? at)
    ) {
      throw new ExecutionPolicyError(
        `The expiry is not after the time the job may first run, so it could never be sent.`,
      );
    }

    const job: Job = {
      id: randomUUID(),
      state: "queued",
      intent,
      createdAt: at,
      updatedAt: at,
      attempts: 0,
      ...(schedule.notBefore !== undefined ? { notBefore: schedule.notBefore } : {}),
      ...(schedule.expiresAt !== undefined ? { expiresAt: schedule.expiresAt } : {}),
      ...(schedule.key !== undefined ? { key: schedule.key } : {}),
      ...(schedule.cooldownMs !== undefined ? { cooldownMs: schedule.cooldownMs } : {}),
      ...(schedule.inboxId !== undefined ? { inboxId: schedule.inboxId } : {}),
      events: [{ at, state: "queued", note: describeSchedule(at, schedule) }],
    };
    this.store.add(job);
    this.log(
      `queued  ${job.id.slice(0, 8)}  ${describeIntent(intent)}` +
        (job.notBefore === undefined
          ? ""
          : `  (not before ${new Date(job.notBefore).toISOString()})`),
    );
    return job;
  }

  /**
   * Why a keyed intent must not be accepted, or `undefined` if it may be.
   *
   * Three reasons, and the middle one is not a cooldown:
   *
   *  - an unfinished job with this key — the same decision is already in play;
   *  - an **unresolved** job with this key, whatever the cooldown says. That job
   *    is an open question about money: its order may be live. Re-deciding on
   *    top of an unknown outcome is the duplicate this whole design exists to
   *    prevent, so it blocks until a person clears it;
   *  - a finished job inside the cooldown.
   *
   * An `expired` job never blocks: nothing happened.
   */
  private blockingJob(key: string, cooldownMs: number | undefined, at: number): string | undefined {
    for (const job of this.store.all()) {
      if (job.key !== key) continue;
      if (!TERMINAL_STATES.has(job.state)) {
        return `${job.id.slice(0, 8)} is already ${job.state} under key "${key}"`;
      }
      if (job.state === "unresolved") {
        return (
          `${job.id.slice(0, 8)} under key "${key}" is unresolved — its order may still be live. ` +
          `Settle it before deciding again.`
        );
      }
      if (job.state === "expired") continue;
      if (cooldownMs !== undefined && at - job.updatedAt < cooldownMs) {
        const left = Math.ceil((cooldownMs - (at - job.updatedAt)) / 1000);
        return `key "${key}" is in cooldown for another ${String(left)}s`;
      }
    }
    return undefined;
  }

  /**
   * Is an outcome currently unknown?
   *
   * `submitting` means a transaction may or may not exist; `unresolved` means we
   * gave up establishing whether one did. Either way the account's true position
   * is not known, and new submissions wait — logged once per pass so a halted
   * runner explains itself rather than looking idle.
   */
  private blockedByAmbiguity(): boolean {
    const blocker = this.store
      .all()
      .find((j) => j.state === "submitting" || j.state === "unresolved");
    if (blocker === undefined) return false;
    if (this.lastAmbiguityBlock !== blocker.id) {
      this.lastAmbiguityBlock = blocker.id;
      this.log(
        `holding  ${blocker.id.slice(0, 8)} is ${blocker.state} — no new submissions until its ` +
          `outcome is known`,
      );
    }
    return true;
  }

  /** Move anything `queue` left into the ledger. */
  private drainInbox(): void {
    if (this.inbox === undefined) return;
    for (const entry of this.inbox.drain()) {
      this.ingest(entry);
    }
  }

  /**
   * Take one inbox entry into the ledger.
   *
   * Every exit acks through {@link ackQuietly}, and the whole thing is
   * failure-isolated: one entry must never end the pass. `drainInbox` runs
   * BEFORE any job is driven, so a throw escaping here would stop the runner
   * doing any work at all — which is what an undeletable file used to cause.
   */
  private ingest({ id, entry, ack }: { id: string; entry: InboxEntry; ack: () => void }): void {
    // A crash between the store write and the ack leaves the file behind, so
    // the same intent is read again. Recognise it rather than queueing it twice.
    if (this.store.all().some((j) => j.inboxId === id)) {
      this.ackQuietly(ack);
      return;
    }
    try {
      // The overloads exist so a keyed CALLER must handle suppression; here
      // the schedule's shape is only known at runtime, and a suppressed
      // intent is simply one the runner already has.
      const schedule = toSchedule(entry, id);
      if (schedule.key === undefined) this.enqueue(entry.intent, schedule);
      else this.enqueue(entry.intent, schedule);
      // Only now: the ledger is durable, so losing the file loses nothing.
      this.ackQuietly(ack);
    } catch (error) {
      // Two very different failures arrive here and only one may be acked.
      //
      // A POLICY refusal — out of scope, a malformed schedule, a suppressed
      // key — will fail identically on every future pass, so keeping the file
      // wedges the drain forever. Ack it.
      //
      // Anything else is infrastructure: a full disk, a failing fsync, an
      // unwritable store. Acking that deletes an intent the caller was told
      // was accepted, and it is exactly the case where retrying works. Leave
      // the file; the next pass will try again.
      const permanent = error instanceof ExecutionPolicyError;
      this.log(
        `${permanent ? "rejected" : "deferred"} ${describeIntent(entry.intent)} — ` +
          `${describeError(error)}`,
      );
      if (permanent) this.ackQuietly(ack);
    }
  }

  /**
   * Ack, reporting a failure rather than propagating it.
   *
   * The job is already durably stored by the time this runs, so a file that
   * cannot be removed is a diagnostic, not a lost intent — ingestion is
   * idempotent and will recognise it next pass. Letting it throw would abort
   * the whole tick before any job was driven, so a single undeletable file
   * would stop all trading.
   */
  private ackQuietly(ack: () => void): void {
    try {
      ack();
    } catch (error) {
      this.log(`warning ${describeError(error)}`);
    }
  }

  /** Jobs that still need work, oldest first. */
  pending(): readonly Job[] {
    return this.store.all().filter((job) => !TERMINAL_STATES.has(job.state));
  }

  /**
   * One pass over every unfinished job.
   *
   * Ambiguous jobs are resolved **before** anything new is submitted: a runner
   * that queued fresh work while an unresolved submission was outstanding could
   * exceed its own scope without ever exceeding a single check.
   */
  async tick(): Promise<void> {
    // Before the work, not after: a pass that threw would otherwise skip the
    // prune every time, which is exactly when the store is growing fastest.
    // Take new work before driving, so an intent queued a moment ago is not
    // held back a whole interval.
    this.drainInbox();

    const dropped = this.store.pruneFinished(this.limits.retentionMs, this.now());
    if (dropped > 0) this.log(`pruned  ${String(dropped)} finished job(s) past retention`);

    // Resolve first, then decide whether anything new may go out. An ambiguous
    // job is an open question about money: submitting alongside it compounds an
    // exposure nobody can currently measure. Sorting ambiguity first was not
    // enough — it changed the ORDER, not whether the queued work ran.
    const ordered = [...this.pending()].sort(byAmbiguityFirst);
    for (const job of ordered) {
      if (job.state === "queued" && this.blockedByAmbiguity()) {
        continue;
      }
      try {
        await this.drive(job);
      } catch (error) {
        // A pass that throws must not take the other jobs down with it; the
        // job keeps its state and is retried on the next tick.
        this.log(`error   ${job.id.slice(0, 8)}  ${describeError(error)}`);
      }
    }
  }

  private async drive(job: Job): Promise<void> {
    switch (job.state) {
      case "queued": {
        // The window bounds the START only. A job already sent is in flight,
        // and no expiry can undo it — which is why this check lives here and
        // not in `tick`.
        const at = this.now();
        if (job.expiresAt !== undefined && at > job.expiresAt) {
          this.finish(job, "expired", "its window closed before it was ever sent");
          return;
        }
        if (job.notBefore !== undefined && at < job.notBefore) return;
        // A `fit-stop` may have nothing to do, and a job that sends nothing must
        // never enter `submitting` — the one state that needs evidence rather
        // than a decision to leave. So it looks before it leaps.
        if (job.intent.kind === "fit-stop" && !(await this.readyToFit(job, job.intent))) return;
        await this.submit(job);
        return;
      }
      case "submitting":
        await this.resolveAmbiguous(job);
        return;
      case "submitted":
        await this.awaitOutcome(job);
        return;
      default:
        return;
    }
  }

  // ── queued → submitting → submitted ─────────────────────────────────────

  private async submit(job: Job): Promise<void> {
    if (job.attempts >= this.limits.maxAttempts) {
      this.finish(job, "failed", `gave up after ${String(job.attempts)} attempts`);
      return;
    }

    // Written before anything is attempted. If the process dies from here on,
    // recovery starts from "a submission may be outstanding" rather than from
    // "nothing has happened".
    this.transition(job, "submitting", `attempt ${String(job.attempts + 1)}`, (j) => {
      j.attempts += 1;
      delete j.digest;
      delete j.digestAt;
      delete j.submittedAt;
    });

    let sawDigest = false;
    const onSubmitting = async (digest: string): Promise<void> => {
      sawDigest = true;
      // Durable before the bytes leave. `update` fsyncs, and throwing from
      // this hook aborts the submission — which is correct: a submission whose
      // digest could not be recorded is one we could never resolve.
      this.store.update(job.id, (j) => {
        j.digest = digest;
        j.digestAt = this.now();
        j.updatedAt = this.now();
        j.events.push({ at: this.now(), state: "submitting", note: `digest ${digest}` });
      });
    };

    try {
      const result = await this.execute(job.intent, onSubmitting);
      this.transition(job, "submitted", `on chain as ${result.digest}`, (j) => {
        j.digest = result.digest;
        j.submittedAt = this.now();
      });
      this.log(`sent    ${job.id.slice(0, 8)}  ${result.digest}`);
    } catch (error) {
      if (sawDigest) {
        // The bytes may already be on their way. Nothing here can tell, so the
        // job stays ambiguous and the next tick asks the chain.
        this.log(`unsure  ${job.id.slice(0, 8)}  ${describeError(error)} — will reconcile`);
        return;
      }
      // Nothing was signed, so nothing was sent. Whether to try again depends
      // on WHY — and the backend already says so. "No claimable rewards" and
      // "insufficient balance" are statements about the world, not about the
      // attempt; asking twice more spends the ceiling and ends in `failed`,
      // burying the actual reason under a retry count.
      if (error instanceof WaterXApiError && !error.retryable) {
        this.finish(job, "failed", `refused: ${error.message} (code ${String(error.code)})`);
        return;
      }
      // Same argument for a request the agent itself refused — a crossing
      // limit, a position that is not there. Retrying cannot change either.
      if (isPermanentClientError(error)) {
        this.finish(job, "failed", `refused: ${describeError(error)}`);
        return;
      }
      this.transition(job, "queued", `not sent: ${describeError(error)}`);
    }
  }

  // ── submitting → (submitted | queued | failed) ──────────────────────────

  private async resolveAmbiguous(job: Job): Promise<void> {
    if (job.digest === undefined) {
      // The crash happened before signing. Nothing was sent.
      this.transition(job, "queued", "no digest was recorded, so nothing was sent");
      return;
    }

    const verdict = await this.reconciler.didLand(
      job.digest,
      job.digestAt ?? job.updatedAt,
      this.limits.digestSettleMs,
      this.now(),
    );

    switch (verdict.kind) {
      case "landed":
        this.transition(job, "submitted", `chain confirms ${job.digest}`, (j) => {
          j.submittedAt = this.now();
        });
        return;
      case "aborted":
        // Terminal, and deliberately NOT `unresolved`: the outcome is known.
        // The transaction was included and charged for, the Move call aborted,
        // and nothing in the chain's state moved — so unlike `never-landed`,
        // placing this intent again is safe, and the message says so rather
        // than leaving an operator to work out which of the two they have.
        this.finish(
          job,
          "failed",
          `${job.digest ?? "the transaction"} was included on chain and its execution failed: ` +
            `${verdict.reason}. Nothing was placed and nothing moved, so this intent can be queued again.`,
        );
        return;
      case "never-landed":
        // Deliberately NOT a retry. Re-running the intent builds a DIFFERENT
        // transaction — new gas coins, a new sponsored digest — so if this
        // verdict is ever wrong (a submission that was accepted and merely
        // invisible), both execute. `didLand` answers from an absence, and an
        // absence cannot be proven, only waited for. At-most-once is a promise
        // this runner keeps by refusing to guess, so the job stops here and a
        // person decides whether to place it again.
        this.finish(
          job,
          "unresolved",
          `the chain has not seen ${job.digest ?? "it"} after ${String(
            Math.round(this.limits.digestSettleMs / 1000),
          )}s. Re-running would build a different transaction, so this stops here — ` +
            `confirm the digest never landed, then queue it again.`,
        );
        return;
      case "unknown":
        // Deliberately no timeout into a guess. An unresolvable digest stays
        // unresolvable and stays visible.
        this.log(`waiting ${job.id.slice(0, 8)}  ${verdict.reason}`);
        return;
    }
  }

  // ── submitted → (filled | cancelled | unresolved) ───────────────────────

  private async awaitOutcome(job: Job): Promise<void> {
    if (job.digest === undefined) {
      this.finish(job, "unresolved", "submitted without a recorded digest");
      return;
    }

    switch (settlementOf(job.intent)) {
      case "onchain":
        // The transaction is on chain and that is the whole outcome. Waiting
        // for a fill that settles under the keeper's digest would strand this
        // job until the deadline and then call a success `unresolved`.
        this.finish(job, "filled", "the request is on chain");
        // And a reduce leaves its protective legs sized for the position it used
        // to be. Queued AFTER the job is terminal and outside its result, because
        // a follow-up that could fail the reduce would be a worse bug than a
        // stale stop: the reduce happened, and that is what this job reports.
        if (job.intent.kind === "reduce") await this.queueStopFits(job, job.intent);
        return;
      case "gone":
        await this.awaitDisappearance(job);
        return;
      case "order-status":
        await this.awaitOrderStatus(job, job.digest);
        return;
    }
  }

  /** For an intent that named the thing it was meant to remove. */
  private async awaitDisappearance(job: Job): Promise<void> {
    const gone =
      job.intent.kind === "close"
        ? await this.reconciler.positionGone(
            this.agent.accountId,
            job.intent.ticker,
            job.intent.positionId,
          )
        : job.intent.kind === "cancel"
          ? await this.reconciler.orderGone(
              this.agent.accountId,
              job.intent.ticker,
              job.intent.orderId,
            )
          : true;

    if (gone) {
      this.finish(job, "filled", "the position/order it named is gone");
      return;
    }
    this.expireIfPastDeadline(job, "it is still open");
  }

  private async awaitOrderStatus(job: Job, digest: string): Promise<void> {
    // The submission time bounds the backward search through history — without
    // it the lookup would give up after one page and misreport a busy account's
    // successful order as unresolved.
    const outcome = await this.reconciler.outcomeOf(
      this.agent.accountId,
      digest,
      job.submittedAt ?? job.createdAt,
    );
    if (outcome !== undefined && outcome.orderIds.length > 0 && job.orderIds === undefined) {
      this.store.update(job.id, (j) => {
        j.orderIds = outcome.orderIds;
        j.updatedAt = this.now();
      });
    }

    if (outcome?.status === "filled") {
      this.finish(job, "filled", `order ${(outcome.orderIds[0] ?? 0).toString()} filled`);
      return;
    }
    if (outcome?.status === "cancelled" || outcome?.status === "invalidated") {
      this.finish(job, "cancelled", `order ${outcome.status}`);
      return;
    }

    // Still resting, or the indexer has not caught up. Both look the same from
    // here, and neither is a reason to act.
    this.expireIfPastDeadline(job, "the order may still be live");
  }

  /**
   * Measured from `submittedAt`, never from `updatedAt`: learning the order ids
   * is a change to the job, and letting that restart the clock would mean a job
   * could never time out as long as the runner kept noticing things about it.
   */
  private expireIfPastDeadline(job: Job, caveat: string): void {
    const waited = this.now() - (job.submittedAt ?? job.updatedAt);
    if (waited > this.limits.fillDeadlineMs) {
      this.finish(
        job,
        "unresolved",
        `no terminal outcome after ${String(Math.round(waited / 60_000))} minutes — ${caveat}`,
      );
    }
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  private execute(
    intent: Intent,
    onSubmitting: (digest: string) => Promise<void>,
  ): Promise<{ digest: string }> {
    switch (intent.kind) {
      case "open":
        return this.agent.openPosition({
          ticker: intent.ticker,
          isLong: intent.side === "long",
          collateral: intent.collateral,
          ...(intent.leverage !== undefined ? { leverage: intent.leverage } : {}),
          ...(intent.size !== undefined ? { size: intent.size } : {}),
          ...(intent.slippagePercent !== undefined ? { slippagePercent: intent.slippagePercent } : {}),
          ...(intent.takeProfitPrice !== undefined ? { takeProfitPrice: intent.takeProfitPrice } : {}),
          ...(intent.stopLossPrice !== undefined ? { stopLossPrice: intent.stopLossPrice } : {}),
          onSubmitting,
        });
      case "limit":
        // `placeLimitOrder` refuses a crossing limit before sending. On a
        // deferred order that is a live possibility rather than a typo: the
        // market may have reached the price while the job waited, in which
        // case the refusal is the correct answer and not a retryable fault.
        return this.agent.placeLimitOrder({
          ticker: intent.ticker,
          isLong: intent.side === "long",
          collateral: intent.collateral,
          triggerPrice: intent.triggerPrice,
          ...(intent.leverage !== undefined ? { leverage: intent.leverage } : {}),
          ...(intent.size !== undefined ? { size: intent.size } : {}),
          ...(intent.isStopOrder !== undefined ? { isStopOrder: intent.isStopOrder } : {}),
          ...(intent.reduceOnly !== undefined ? { reduceOnly: intent.reduceOnly } : {}),
          ...(intent.linkedPositionId !== undefined
            ? { linkedPositionId: intent.linkedPositionId }
            : {}),
          ...(intent.takeProfitPrice !== undefined
            ? { takeProfitPrice: intent.takeProfitPrice }
            : {}),
          ...(intent.stopLossPrice !== undefined ? { stopLossPrice: intent.stopLossPrice } : {}),
          onSubmitting,
        });
      case "close":
        return this.agent.closePosition({
          ticker: intent.ticker,
          positionId: intent.positionId,
          ...(intent.slippagePercent !== undefined ? { slippagePercent: intent.slippagePercent } : {}),
          onSubmitting,
        });
      case "cancel":
        return this.agent.cancelOrder({
          ticker: intent.ticker,
          orderId: intent.orderId,
          onSubmitting,
        });
      case "reduce":
        return this.agent.reducePosition({
          ticker: intent.ticker,
          positionId: intent.positionId,
          ...(intent.size !== undefined ? { size: intent.size } : {}),
          ...(intent.percent !== undefined ? { percent: intent.percent } : {}),
          ...(intent.slippagePercent !== undefined ? { slippagePercent: intent.slippagePercent } : {}),
          onSubmitting,
        });
      case "increase":
        return this.agent.increasePosition({
          ticker: intent.ticker,
          positionId: intent.positionId,
          collateral: intent.collateral,
          ...(intent.leverage !== undefined ? { leverage: intent.leverage } : {}),
          ...(intent.size !== undefined ? { size: intent.size } : {}),
          ...(intent.slippagePercent !== undefined ? { slippagePercent: intent.slippagePercent } : {}),
          onSubmitting,
        });
      case "add-margin":
        return this.agent.addMargin({
          ticker: intent.ticker,
          positionId: intent.positionId,
          amount: intent.amount,
          onSubmitting,
        });
      case "remove-margin":
        return this.agent.removeMargin({
          ticker: intent.ticker,
          positionId: intent.positionId,
          amount: intent.amount,
          onSubmitting,
        });
      case "fit-stop":
        return this.fitStop(intent, onSubmitting);
      case "wlp-mint":
        return this.agent.mintWlp({ amount: intent.amount, onSubmitting });
      case "wlp-burn":
        return this.agent.burnWlp({ amount: intent.amount, onSubmitting });
      case "wlp-cancel-burn":
        return this.agent.cancelWlpBurn({ requestId: intent.requestId, onSubmitting });
      case "wlp-claim":
        return this.agent.claimWlpRewards({ onSubmitting });
    }
  }

  private transition(job: Job, state: JobState, note: string, mutate?: (job: Job) => void): void {
    const at = this.now();
    this.store.update(job.id, (j) => {
      j.state = state;
      j.updatedAt = at;
      j.events.push({ at, state, note });
      mutate?.(j);
    });
  }

  /**
   * Queue a `fit-stop` for each protective leg a reduce will outgrow.
   *
   * Best-effort by design, and it runs after the reduce job is already terminal:
   * nothing here may change what that job reported. A read that fails, an inbox
   * that will not write, a position that vanished — each leaves the legs where
   * they were, which is where they started, and `positions` still reports the
   * mismatch for a person.
   *
   * One job per leg, because one job is one write, one idempotency key and one
   * at-most-once guarantee. Two writes inside one job would make a crash between
   * them a new kind of ambiguity, and this feature is not worth that.
   *
   * The key is the reduce's own digest, so the inbox suppresses a repeat if this
   * runs twice — and a LATER reduce on the same position has a different digest
   * and queues its own. Even without that, `fit-stop` compares observed sizes, so
   * a duplicate finds nothing to do.
   */
  private async queueStopFits(
    job: Job,
    intent: Extract<Intent, { kind: "reduce" }>,
  ): Promise<void> {
    // No inbox means this runner accepts no queued work, so there is nowhere to
    // leave a follow-up. Not an error: such a runner was configured to drain a
    // store and nothing else.
    const inbox = this.inbox;
    if (!this.fitStopsEnabled || inbox === undefined) return;
    try {
      const position = await this.position(intent.ticker, intent.positionId);
      if (position === undefined) return;
      const legs = position.linkedOrders.filter((order) => order.reduceOnly);
      if (legs.length === 0) return;

      const at = this.now();
      for (const leg of legs) {
        inbox.submit({
          intent: {
            kind: "fit-stop",
            ticker: position.ticker,
            positionId: Number(position.id),
            orderId: Number(leg.id),
            // What the position holds NOW, before the keeper fills. Used to tell
            // "not filled yet" from "already correct", never to size a write.
            wasHolding: position.sizeInAsset,
          },
          // The keeper needs a moment, and asking before then costs a read to
          // learn nothing.
          notBefore: at + FIT_STOP_GRACE_MS,
          expiresAt: at + FIT_STOP_WINDOW_MS,
          key: `fit-stop:${position.ticker}:${position.id}:${leg.id}:${job.digest ?? String(at)}`,
        });
      }
      this.log(
        `queued  ${job.id.slice(0, 8)}  ${String(legs.length)} stop fit(s) for ` +
          `${position.ticker}#${position.id} once the fill lands`,
      );
    } catch (error) {
      // Said, not raised. The reduce is done and its job is terminal.
      this.log(`note    ${job.id.slice(0, 8)}  could not queue a stop fit: ${describeError(error)}`);
    }
  }

  /**
   * Whether a `fit-stop` has work to do yet. Writes nothing either way.
   *
   * Three answers, and the middle one is the whole reason this exists:
   *
   *  - **the leg is oversized** — go. The write resolves its own size.
   *  - **the position is still the size it was** — the keeper has not filled the
   *    reduce yet, so there is nothing to fit TO. Deferred, not failed: an answer
   *    of "no work" here would be indistinguishable from "already correct", and
   *    acting would shrink the stop ahead of the fill.
   *  - **smaller, and every leg fits** — somebody already did it, or the position
   *    never had an oversized leg. Terminal, and nothing was sent.
   *
   * `wasHolding` is read for the middle case alone. It never reaches a size that
   * gets written.
   */
  private async readyToFit(
    job: Job,
    intent: Extract<Intent, { kind: "fit-stop" }>,
  ): Promise<boolean> {
    let position: Position | undefined;
    try {
      position = await this.position(intent.ticker, intent.positionId);
    } catch (error) {
      // A read that failed says nothing about the world. Left queued so the next
      // tick asks again, bounded by the job's own window.
      this.log(`waiting ${job.id.slice(0, 8)}  could not read the position: ${describeError(error)}`);
      return false;
    }

    if (position === undefined) {
      this.finish(job, "cancelled", "the position is closed; the protocol cancels its legs");
      return false;
    }
    if (oversizedStops(position).some((stop) => stop.orderId === intent.orderId)) return true;

    if (position.sizeInAsset >= intent.wasHolding) {
      // Not filled yet. Try again after the grace period rather than now — a tick
      // is cheap but a read per tick for fifteen minutes is not.
      this.store.update(job.id, (j) => {
        j.notBefore = this.now() + FIT_STOP_GRACE_MS;
        j.updatedAt = this.now();
      });
      return false;
    }

    this.finish(job, "cancelled", `${intent.ticker}#${String(intent.orderId)} already fits`);
    return false;
  }

  /**
   * Resize one reduce-only leg to the position it protects.
   *
   * The size is read HERE, by the code that writes it. The pre-flight in `drive`
   * decided whether to write at all; it does not hand a number across, because a
   * number that travelled is a number that was true somewhere else. A reduce
   * fills under the keeper's digest after the request lands, so the only size
   * worth writing is the one the chain reports at this instant.
   *
   * The trigger price is carried over unchanged. Resizing must not reprice: where
   * a stop sits is the trader's decision and nothing here is entitled to move it.
   */
  private async fitStop(
    intent: Extract<Intent, { kind: "fit-stop" }>,
    onSubmitting: (digest: string) => Promise<void>,
  ): Promise<{ digest: string }> {
    const position = await this.position(intent.ticker, intent.positionId);
    if (position === undefined) {
      // Pre-flight saw it a moment ago. Gone now means closed in between, and the
      // protocol cancels its legs — so there is nothing to resize and nothing to
      // report as a failure either. Refused as permanent: retrying cannot bring a
      // closed position back.
      throw new UsageError(
        `position ${intent.ticker}#${String(intent.positionId)} is gone, so its legs need no resizing`,
      );
    }
    const stop = oversizedStops(position).find((s) => s.orderId === intent.orderId);
    if (stop === undefined) {
      throw new UsageError(
        `${intent.ticker}#${String(intent.orderId)} already fits the position it protects`,
      );
    }
    return this.agent.updateOrder({
      ticker: stop.ticker,
      orderId: stop.orderId,
      newTriggerPrice: stop.triggerPrice,
      newSize: stop.shouldBe,
      onSubmitting,
    });
  }

  /** One position by ticker and id, or `undefined`. */
  private async position(ticker: string, positionId: number): Promise<Position | undefined> {
    const positions = await this.agent.read.positions(this.agent.accountId);
    return positions.find((p) => p.ticker === ticker && p.id === String(positionId));
  }

  private finish(job: Job, state: JobState, note: string): void {
    this.transition(job, state, note, (j) => {
      if (state === "failed" || state === "unresolved") j.error = note;
    });
    this.log(`${state.padEnd(7)} ${job.id.slice(0, 8)}  ${note}`);
  }
}

/**
 * Ambiguity first. A `submitting` job is an outstanding question about money;
 * a `queued` one is a decision not yet made, and can wait one pass.
 */
const RANK: Record<JobState, number> = {
  submitting: 0,
  submitted: 1,
  queued: 2,
  filled: 3,
  cancelled: 3,
  failed: 3,
  unresolved: 3,
  expired: 3,
};
const byAmbiguityFirst = (a: Job, b: Job): number =>
  RANK[a.state] - RANK[b.state] || a.createdAt - b.createdAt;

/**
 * How long to wait between asking whether a reduce has filled.
 *
 * A reduce fills under the keeper's digest, which this job cannot watch, so the
 * only way to know is to look at the position. A tick is cheap; a read every tick
 * for the whole window is not.
 */
const FIT_STOP_GRACE_MS = 30_000;

/**
 * How long a `fit-stop` keeps asking before giving up.
 *
 * Expiring is an honest outcome: the reduce did not fill inside the window, so
 * there was never anything to resize. The legs are unchanged, which is where they
 * started, and `positions` reports the mismatch if one appears later.
 */
const FIT_STOP_WINDOW_MS = 15 * 60_000;

export function describeIntent(intent: Intent): string {
  switch (intent.kind) {
    case "open":
      return `open ${intent.side} ${intent.ticker} ${String(intent.collateral)}${
        intent.leverage === undefined ? "" : ` @${String(intent.leverage)}x`
      }`;
    case "limit":
      return `${intent.isStopOrder === true ? "stop" : "limit"} ${intent.side} ${intent.ticker} ${String(
        intent.collateral,
      )} @${String(intent.triggerPrice)}`;
    case "close":
      return `close ${intent.ticker}#${String(intent.positionId)}`;
    case "cancel":
      return `cancel ${intent.ticker}#${String(intent.orderId)}`;
    case "reduce":
      return `reduce ${intent.ticker}#${String(intent.positionId)} by ${
        intent.percent === undefined ? String(intent.size) : `${String(intent.percent)}%`
      }`;
    case "increase":
      return `increase ${intent.ticker}#${String(intent.positionId)} +${String(intent.collateral)}`;
    case "add-margin":
      return `add margin ${intent.ticker}#${String(intent.positionId)} +${String(intent.amount)}`;
    case "remove-margin":
      return `remove margin ${intent.ticker}#${String(intent.positionId)} -${String(intent.amount)}`;
    case "fit-stop":
      return `fit stop ${intent.ticker}#${String(intent.orderId)} to position #${String(intent.positionId)}`;
    case "wlp-mint":
      return `wlp mint ${String(intent.amount)}`;
    case "wlp-burn":
      return `wlp burn ${String(intent.amount)}`;
    case "wlp-cancel-burn":
      return `wlp cancel-burn #${String(intent.requestId)}`;
    case "wlp-claim":
      return "wlp claim";
  }
}

export interface UnkeyedSchedule {
  notBefore?: number;
  expiresAt?: number;
  key?: undefined;
  cooldownMs?: undefined;
  /** Set when the intent came from the inbox; recorded in the same write. */
  inboxId?: string;
}

export interface KeyedSchedule {
  notBefore?: number;
  expiresAt?: number;
  /** Names the *idea*, so a repeat of it is suppressed rather than queued again. */
  key: string;
  /** How long after this key last finished before the idea may be had again. */
  cooldownMs?: number;
  /** Set when the intent came from the inbox; recorded in the same write. */
  inboxId?: string;
}

type Schedule = UnkeyedSchedule | KeyedSchedule;

function describeSchedule(at: number, schedule: Schedule): string {
  const key = schedule.key === undefined ? "" : ` key="${schedule.key}"`;
  if (schedule.notBefore === undefined) return `accepted${key}`;
  const delay = Math.round((schedule.notBefore - at) / 1000);
  return `accepted${key}, deferred ${String(delay)}s, expires ${new Date(schedule.expiresAt ?? 0).toISOString()}`;
}

/**
 * Refusals the agent raises before a request is even shaped: an out-of-scope
 * order, a crossing limit, a position or order that does not exist. All are
 * statements about the request or the world, and none becomes true by repeating.
 *
 * Deliberately a small allow-list rather than "anything that is not a network
 * error": misclassifying a transient fault as permanent silently drops work,
 * so the default stays retry.
 */
function isPermanentClientError(error: unknown): boolean {
  if (error instanceof ExecutionPolicyError) return true;
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("ECrossingLimitOrder") ||
    /^No (open position|resting order)\b/.test(error.message) ||
    /^Unknown market\b/.test(error.message) ||
    /is not tradeable/.test(error.message)
  );
}

/** An inbox entry's scheduling half, in the shape `enqueue` takes. */
function toSchedule(entry: InboxEntry, inboxId: string): KeyedSchedule | UnkeyedSchedule {
  const base = {
    ...(entry.notBefore !== undefined ? { notBefore: entry.notBefore } : {}),
    ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
    inboxId,
  };
  return entry.key === undefined
    ? base
    : {
        ...base,
        key: entry.key,
        ...(entry.cooldownMs !== undefined ? { cooldownMs: entry.cooldownMs } : {}),
      };
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
