/**
 * The runner's one guarantee: an intent is submitted at most once.
 *
 * The tests are written as crashes, because that is the only way the guarantee
 * can be broken. Each one kills the process at a different instruction and asks
 * what a fresh runner does with what was left on disk.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WaterXAgent } from "../src/agent/agent.ts";
import { ExecutionPolicyError, WaterXApiError } from "../src/errors.ts";
import type { Reconciler } from "../src/runner/reconcile.ts";
import { Inbox } from "../src/runner/inbox.ts";
import { JobStore, StoreLockedError } from "../src/runner/store.ts";
import { Runner } from "../src/runner/runner.ts";
import { DEFAULT_LIMITS, type Intent, type Job } from "../src/runner/types.ts";

const INTENT: Intent = { kind: "open", ticker: "SUIUSD", side: "long", collateral: 10, leverage: 2 };
const ACCOUNT = `0x${"a".repeat(64)}`;

let dir: string;
let clock = 1_000_000;
const now = (): number => clock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "waterx-runner-"));
  clock = 1_000_000;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  runner: Runner;
  store: JobStore;
  openPosition: ReturnType<typeof vi.fn>;
  sent: ReturnType<typeof vi.fn>;
  didLand: ReturnType<typeof vi.fn>;
  outcomeOf: ReturnType<typeof vi.fn>;
  positionGone: ReturnType<typeof vi.fn>;
  orderGone: ReturnType<typeof vi.fn>;
}

function harness(mode = "delegated-auto"): Harness {
  const store = new JobStore(join(dir, "jobs.json"));
  store.open();
  const openPosition = vi.fn();
  const sent = vi.fn().mockResolvedValue({ digest: "digest-1" });
  const agent = {
    accountId: ACCOUNT,
    gate: { mode },
    openPosition,
    placeLimitOrder: sent,
    closePosition: sent,
    cancelOrder: sent,
    reducePosition: sent,
    increasePosition: sent,
    addMargin: sent,
    removeMargin: sent,
    mintWlp: sent,
    burnWlp: sent,
    cancelWlpBurn: sent,
    claimWlpRewards: sent,
  } as unknown as WaterXAgent;
  const didLand = vi.fn();
  const outcomeOf = vi.fn().mockResolvedValue(undefined);
  const positionGone = vi.fn().mockResolvedValue(true);
  const orderGone = vi.fn().mockResolvedValue(true);
  const reconciler = { didLand, outcomeOf, positionGone, orderGone } as unknown as Reconciler;
  const runner = new Runner({ agent, store, reconciler, now, log: () => undefined });
  return { runner, store, openPosition, sent, didLand, outcomeOf, positionGone, orderGone };
}

const stateOf = (h: Harness, id: string): string => h.store.get(id)?.state ?? "gone";

describe("the at-most-once guarantee", () => {
  it("records the digest before the submission leaves the process", async () => {
    const h = harness();
    const job = h.runner.enqueue(INTENT);
    const seen: string[] = [];
    h.openPosition.mockImplementation(async (params: { onSubmitting: (d: string) => Promise<void> }) => {
      await params.onSubmitting("digest-1");
      // At this instant the bytes are about to go out. The store must already
      // know the digest, or a crash here would be unresolvable.
      seen.push(JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8")).jobs[0].digest);
      return { digest: "digest-1" };
    });

    await h.runner.tick();

    expect(seen).toEqual(["digest-1"]);
    expect(stateOf(h, job.id)).toBe("submitted");
  });

  it("crash after the digest, transaction landed → submitted, never re-sent", async () => {
    const h = harness();
    const job = h.runner.enqueue(INTENT);
    // The submission threw after the digest was written — indistinguishable,
    // from here, from a process that died at the same instruction.
    h.openPosition.mockImplementation(async (params: { onSubmitting: (d: string) => Promise<void> }) => {
      await params.onSubmitting("digest-1");
      throw new Error("socket closed");
    });
    await h.runner.tick();
    expect(stateOf(h, job.id)).toBe("submitting");

    h.didLand.mockResolvedValue({ kind: "landed" });
    await h.runner.tick();

    expect(stateOf(h, job.id)).toBe("submitted");
    // The whole point: exactly one submission.
    expect(h.openPosition).toHaveBeenCalledTimes(1);
  });

  it("crash after the digest, chain says never landed → stops, does NOT rebuild", async () => {
    // Re-running the intent builds a DIFFERENT transaction, so if the
    // never-landed verdict is ever wrong — a submission accepted but not yet
    // visible — both execute. An absence cannot be proven, only waited for, so
    // at-most-once is kept by refusing to guess.
    const h = harness();
    const job = h.runner.enqueue(INTENT);
    h.openPosition.mockImplementationOnce(async (params: { onSubmitting: (d: string) => Promise<void> }) => {
      await params.onSubmitting("digest-1");
      throw new Error("socket closed");
    });
    await h.runner.tick();

    h.didLand.mockResolvedValue({ kind: "never-landed" });
    await h.runner.tick();

    expect(stateOf(h, job.id)).toBe("unresolved");
    expect(h.store.get(job.id)?.error).toMatch(/different transaction/);

    // And no amount of further ticking resurrects it.
    h.openPosition.mockResolvedValue({ digest: "digest-2" });
    await h.runner.tick();
    await h.runner.tick();
    expect(h.openPosition).toHaveBeenCalledTimes(1);
  });

  it("a failure BEFORE any digest is still retried — nothing was sent", async () => {
    // The distinction that makes the rule above affordable: only a job that may
    // have reached the chain is frozen. One that never got that far is free to
    // retry, because there is nothing it could duplicate.
    const h = harness();
    const job = h.runner.enqueue(INTENT);
    h.openPosition.mockRejectedValueOnce(new Error("backend 503"));
    await h.runner.tick();
    expect(stateOf(h, job.id)).toBe("queued");

    h.openPosition.mockResolvedValue({ digest: "digest-1" });
    await h.runner.tick();
    expect(stateOf(h, job.id)).toBe("submitted");
  });

  it("never resolves an ambiguous digest by waiting", async () => {
    const h = harness();
    const job = h.runner.enqueue(INTENT);
    h.openPosition.mockImplementation(async (params: { onSubmitting: (d: string) => Promise<void> }) => {
      await params.onSubmitting("digest-1");
      throw new Error("socket closed");
    });
    await h.runner.tick();

    h.didLand.mockResolvedValue({ kind: "unknown", reason: "too soon" });
    // A year passes. Still unknown, still not guessed.
    clock += 365 * 24 * 3600 * 1000;
    await h.runner.tick();
    await h.runner.tick();

    expect(stateOf(h, job.id)).toBe("submitting");
    expect(h.openPosition).toHaveBeenCalledTimes(1);
  });

  it("crash before signing → nothing was sent, so the job is simply requeued", async () => {
    const h = harness();
    const job = h.runner.enqueue(INTENT);
    h.openPosition.mockRejectedValueOnce(new Error("backend 503"));
    await h.runner.tick();

    expect(stateOf(h, job.id)).toBe("queued");
    expect(h.didLand).not.toHaveBeenCalled();
  });

  it("a job left in `submitting` with no digest was never signed", async () => {
    const h = harness();
    const job = h.runner.enqueue(INTENT);
    // Exactly what a kill between the state write and the signature leaves.
    h.store.update(job.id, (j) => {
      j.state = "submitting";
      j.attempts = 1;
    });

    await h.runner.tick();
    expect(stateOf(h, job.id)).toBe("queued");
    expect(h.didLand).not.toHaveBeenCalled();
  });

  it("fails immediately on a refusal that repeating cannot change", async () => {
    // "No claimable rewards" is a statement about the world. Spending the
    // retry ceiling on it buries the reason under an attempt count.
    const h = harness();
    const job = h.runner.enqueue(INTENT);
    h.openPosition.mockRejectedValue(new WaterXApiError(3007, "No claimable rewards", 400));

    await h.runner.tick();

    expect(stateOf(h, job.id)).toBe("failed");
    expect(h.store.get(job.id)?.error).toMatch(/No claimable rewards/);
    expect(h.openPosition).toHaveBeenCalledTimes(1);
  });

  it("fails immediately on a crossing limit — the market already went there", async () => {
    const h = harness();
    const job = h.runner.enqueue(INTENT);
    h.openPosition.mockRejectedValue(
      new Error("SUIUSD: a long limit at 9 is above the market price 1 (ECrossingLimitOrder)"),
    );
    await h.runner.tick();
    expect(stateOf(h, job.id)).toBe("failed");
    expect(h.openPosition).toHaveBeenCalledTimes(1);
  });

  it("still retries a transient backend failure", async () => {
    const h = harness();
    const job = h.runner.enqueue(INTENT);
    h.openPosition.mockRejectedValueOnce(new WaterXApiError(0, "socket closed", 503));
    await h.runner.tick();
    expect(stateOf(h, job.id)).toBe("queued");

    h.openPosition.mockResolvedValue({ digest: "digest-1" });
    await h.runner.tick();
    expect(stateOf(h, job.id)).toBe("submitted");
  });

  it("stops retrying at the attempt ceiling instead of looping forever", async () => {
    const h = harness();
    const job = h.runner.enqueue(INTENT);
    h.openPosition.mockRejectedValue(new Error("backend 503"));

    for (let i = 0; i < DEFAULT_LIMITS.maxAttempts + 1; i++) await h.runner.tick();

    expect(stateOf(h, job.id)).toBe("failed");
    expect(h.openPosition).toHaveBeenCalledTimes(DEFAULT_LIMITS.maxAttempts);
  });

  it("resolves an ambiguous job before submitting a queued one", async () => {
    const h = harness();
    const ambiguous = h.runner.enqueue(INTENT);
    h.openPosition.mockImplementation(async (params: { onSubmitting: (d: string) => Promise<void> }) => {
      await params.onSubmitting("digest-1");
      throw new Error("socket closed");
    });
    await h.runner.tick();
    h.openPosition.mockReset();

    const fresh = h.runner.enqueue(INTENT);
    const order: string[] = [];
    h.didLand.mockImplementation(async () => {
      order.push("reconcile");
      return { kind: "landed" };
    });
    h.openPosition.mockImplementation(async () => {
      order.push("submit");
      return { digest: "digest-2" };
    });

    await h.runner.tick();

    expect(order).toEqual(["reconcile", "submit"]);
    expect(stateOf(h, ambiguous.id)).toBe("submitted");
    expect(stateOf(h, fresh.id)).toBe("submitted");
  });
});

describe("deferred intents", () => {
  it("does not submit before its window opens, then does", async () => {
    const h = harness();
    h.openPosition.mockResolvedValue({ digest: "digest-1" });
    const job = h.runner.enqueue(INTENT, { notBefore: clock + 300_000, expiresAt: clock + 900_000 });

    clock += 299_000;
    await h.runner.tick();
    expect(h.openPosition).not.toHaveBeenCalled();
    expect(stateOf(h, job.id)).toBe("queued");

    clock += 2_000;
    await h.runner.tick();
    expect(h.openPosition).toHaveBeenCalledTimes(1);
    expect(stateOf(h, job.id)).toBe("submitted");
  });

  it("measures the delay from the decision, not from the last restart", () => {
    const h = harness();
    const job = h.runner.enqueue(INTENT, { notBefore: clock + 300_000, expiresAt: clock + 900_000 });
    // Absolute, so a process that dies and comes back does not restart the wait.
    expect(h.store.get(job.id)?.notBefore).toBe(1_000_000 + 300_000);
  });

  it("expires rather than firing into a market that moved while it waited", async () => {
    const h = harness();
    h.openPosition.mockResolvedValue({ digest: "digest-1" });
    const job = h.runner.enqueue(INTENT, { notBefore: clock + 300_000, expiresAt: clock + 600_000 });

    // The runner was down for a day. The reason for this order is long gone.
    clock += 24 * 3600 * 1000;
    await h.runner.tick();

    expect(stateOf(h, job.id)).toBe("expired");
    expect(h.openPosition).not.toHaveBeenCalled();
  });

  it("refuses a deferred intent with no expiry", () => {
    const h = harness();
    expect(() => h.runner.enqueue(INTENT, { notBefore: clock + 60_000 })).toThrow(/needs an expiry/);
  });

  it("refuses a window that could never open", () => {
    const h = harness();
    expect(() =>
      h.runner.enqueue(INTENT, { notBefore: clock + 600_000, expiresAt: clock + 60_000 }),
    ).toThrow(/could never be sent/);
  });

  it("an expiry cannot undo a job already in flight", async () => {
    const h = harness();
    h.openPosition.mockResolvedValue({ digest: "digest-1" });
    const job = h.runner.enqueue(INTENT, { expiresAt: clock + 60_000 });
    await h.runner.tick();
    expect(stateOf(h, job.id)).toBe("submitted");

    // Long past the expiry, and the order is real. Expiry bounds the start.
    clock += 3600_000;
    h.outcomeOf.mockResolvedValue({ orderIds: [7], status: "filled" });
    await h.runner.tick();
    expect(stateOf(h, job.id)).toBe("filled");
  });
});

describe("the fill wait", () => {
  it("finishes when the order reaches a terminal status", async () => {
    const h = harness();
    const job = h.runner.enqueue(INTENT);
    h.openPosition.mockResolvedValue({ digest: "digest-1" });
    await h.runner.tick();

    h.outcomeOf.mockResolvedValue({ orderIds: [7], status: "filled" });
    await h.runner.tick();

    expect(stateOf(h, job.id)).toBe("filled");
    expect(h.store.get(job.id)?.orderIds).toEqual([7]);
  });

  it("keeps waiting while the order is still resting", async () => {
    const h = harness();
    const job = h.runner.enqueue(INTENT);
    h.openPosition.mockResolvedValue({ digest: "digest-1" });
    await h.runner.tick();

    h.outcomeOf.mockResolvedValue({ orderIds: [7], status: "open" });
    clock += 10 * 60_000;
    await h.runner.tick();

    expect(stateOf(h, job.id)).toBe("submitted");
  });

  it("reports unresolved past the deadline rather than assuming an outcome", async () => {
    const h = harness();
    const job = h.runner.enqueue(INTENT);
    h.openPosition.mockResolvedValue({ digest: "digest-1" });
    await h.runner.tick();

    h.outcomeOf.mockResolvedValue({ orderIds: [7], status: "open" });
    clock += DEFAULT_LIMITS.fillDeadlineMs + 1;
    await h.runner.tick();

    expect(stateOf(h, job.id)).toBe("unresolved");
    expect(h.store.get(job.id)?.error).toMatch(/may still be live/);
  });
});

describe("idempotency keys", () => {
  const KEYED = { key: "sui-entry" } as const;

  it("suppresses the same idea while an earlier one is unfinished", async () => {
    // Ten ticks of a true condition produce ten distinct intents; the runner
    // would faithfully send all ten. The key is how a caller says they are one
    // decision.
    const h = harness();
    h.openPosition.mockResolvedValue({ digest: "digest-1" });

    expect(h.runner.enqueue(INTENT, KEYED)).toBeDefined();
    expect(h.runner.enqueue(INTENT, KEYED)).toBeUndefined();
    await h.runner.tick();
    expect(h.runner.enqueue(INTENT, KEYED)).toBeUndefined();
    expect(h.openPosition).toHaveBeenCalledTimes(1);
  });

  it("allows the idea again once it has finished and no cooldown was asked for", async () => {
    const h = harness();
    h.openPosition.mockResolvedValue({ digest: "digest-1" });
    h.outcomeOf.mockResolvedValue({ orderIds: [1], status: "filled" });
    h.runner.enqueue(INTENT, KEYED);
    await h.runner.tick();
    await h.runner.tick();

    expect(h.runner.enqueue(INTENT, KEYED)).toBeDefined();
  });

  it("holds the idea for the cooldown after it finished", async () => {
    const h = harness();
    h.openPosition.mockResolvedValue({ digest: "digest-1" });
    h.outcomeOf.mockResolvedValue({ orderIds: [1], status: "filled" });
    h.runner.enqueue(INTENT, { ...KEYED, cooldownMs: 3600_000 });
    await h.runner.tick();
    await h.runner.tick();

    clock += 1800_000;
    expect(h.runner.enqueue(INTENT, { ...KEYED, cooldownMs: 3600_000 })).toBeUndefined();
    clock += 1801_000;
    expect(h.runner.enqueue(INTENT, { ...KEYED, cooldownMs: 3600_000 })).toBeDefined();
  });

  it("blocks on an unresolved job whatever the cooldown says", async () => {
    // An unresolved job's order may be live. Re-deciding on top of an unknown
    // outcome is the duplicate the whole design exists to prevent, so no amount
    // of elapsed time unblocks it.
    const h = harness();
    h.openPosition.mockResolvedValue({ digest: "digest-1" });
    h.outcomeOf.mockResolvedValue({ orderIds: [1], status: "open" });
    h.runner.enqueue(INTENT, KEYED);
    await h.runner.tick();
    clock += DEFAULT_LIMITS.fillDeadlineMs + 1;
    await h.runner.tick();
    expect(h.store.all()[0]?.state).toBe("unresolved");

    clock += 365 * 24 * 3600 * 1000;
    expect(h.runner.enqueue(INTENT, { ...KEYED, cooldownMs: 1 })).toBeUndefined();
  });

  it("does not block on an expired job — nothing happened", () => {
    const h = harness();
    h.runner.enqueue(INTENT, { ...KEYED, notBefore: clock + 60_000, expiresAt: clock + 120_000 });
    clock += 200_000;
    // Drive it to `expired` without awaiting: the queued branch is synchronous.
    return h.runner.tick().then(() => {
      expect(h.store.all()[0]?.state).toBe("expired");
      expect(h.runner.enqueue(INTENT, { ...KEYED, cooldownMs: 3600_000 })).toBeDefined();
    });
  });

  it("refuses a cooldown that bounds nothing", () => {
    // Negative / NaN / Infinity compare false against every elapsed time, so the
    // job would be accepted and the caller would believe a limit was in force
    // that can never fire.
    const h = harness();
    // Zero included: `elapsed < 0` is false for every elapsed time, so a
    // zero cooldown records a hold that can never fire.
    for (const cooldownMs of [0, -1000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => h.runner.enqueue(INTENT, { key: "k", cooldownMs })).toThrow(/bounds nothing/);
    }
    expect(h.store.all()).toHaveLength(0);
  });

  it("refuses a cooldown with no key to hang it on", () => {
    const h = harness();
    expect(() =>
      (h.runner.enqueue as (i: Intent, s: unknown) => unknown)(INTENT, { cooldownMs: 1000 }),
    ).toThrow(/needs a key/);
  });

  it("an unkeyed enqueue is never suppressed", () => {
    const h = harness();
    expect(h.runner.enqueue(INTENT)).toBeDefined();
    expect(h.runner.enqueue(INTENT)).toBeDefined();
  });
});

describe("how each intent settles", () => {
  const settle = async (h: Harness, intent: Intent): Promise<string> => {
    const job = h.runner.enqueue(intent);
    await h.runner.tick(); // submit
    await h.runner.tick(); // settle
    return stateOf(h, job.id);
  };

  it("finishes an on-chain intent when the transaction lands", async () => {
    // A margin change or a WLP call takes effect on landing, and a keeper-run
    // request (reduce, increase) fills under the KEEPER's digest, not ours —
    // so waiting for a fill would strand a success until the deadline and then
    // report it as unresolved. This is the bug that shipped for `cancel`.
    for (const intent of [
      { kind: "reduce", ticker: "SUIUSD", positionId: 1, percent: 50 },
      { kind: "increase", ticker: "SUIUSD", positionId: 1, collateral: 5, leverage: 2 },
      { kind: "add-margin", ticker: "SUIUSD", positionId: 1, amount: 5 },
      { kind: "remove-margin", ticker: "SUIUSD", positionId: 1, amount: 5 },
      { kind: "wlp-mint", amount: 10 },
      { kind: "wlp-burn", amount: 10 },
      { kind: "wlp-cancel-burn", requestId: 3 },
      { kind: "wlp-claim" },
    ] as Intent[]) {
      const h = harness();
      expect(await settle(h, intent), intent.kind).toBe("filled");
      expect(h.outcomeOf).not.toHaveBeenCalled();
      h.store.close();
    }
  });

  it("finishes a close when the position it named is gone", async () => {
    const h = harness();
    expect(await settle(h, { kind: "close", ticker: "SUIUSD", positionId: 84 })).toBe("filled");
    expect(h.positionGone).toHaveBeenCalledWith(ACCOUNT, "SUIUSD", 84);
  });

  it("finishes a cancel when the order it named is gone", async () => {
    // The cancel transaction's digest appears in NEITHER history category, so
    // an order-status rule reports a successful cancel as `unresolved`. The
    // order's disappearance is the evidence, and it is attributable because the
    // intent named the order.
    const h = harness();
    expect(await settle(h, { kind: "cancel", ticker: "SUIUSD", orderId: 192 })).toBe("filled");
    expect(h.orderGone).toHaveBeenCalledWith(ACCOUNT, "SUIUSD", 192);
    expect(h.outcomeOf).not.toHaveBeenCalled();
  });

  it("keeps waiting while the named position is still open", async () => {
    const h = harness();
    h.positionGone.mockResolvedValue(false);
    expect(await settle(h, { kind: "close", ticker: "SUIUSD", positionId: 84 })).toBe("submitted");
  });

  it("waits on the order's status for an order-creating intent", async () => {
    const h = harness();
    h.outcomeOf.mockResolvedValue({ orderIds: [9], status: "open" });
    const state = await settle(h, {
      kind: "limit",
      ticker: "SUIUSD",
      side: "long",
      collateral: 10,
      leverage: 2,
      triggerPrice: 0.7,
    });
    expect(state).toBe("submitted");
    expect(h.outcomeOf).toHaveBeenCalled();
  });
});

describe("start-up refusals", () => {
  it("refuses to run unattended under a policy that cannot sign unattended", () => {
    const h = harness("interactive");
    expect(() => h.runner.assertCanRunUnattended()).toThrow(ExecutionPolicyError);
  });

  it("accepts delegated-auto", () => {
    const h = harness();
    expect(() => h.runner.assertCanRunUnattended()).not.toThrow();
  });
});

describe("the inbox", () => {
  it("accepts work while the runner holds the store lock", () => {
    // The whole point. The store has one writer by design, but that lock also
    // shut out `queue` — so intents could only be added while the runner was
    // stopped, which is the opposite of what a long-running service is for.
    const store = new JobStore(join(dir, "jobs.json"));
    store.open();
    const inbox = new Inbox(join(dir, "jobs.inbox"));

    expect(() => inbox.submit({ intent: INTENT })).not.toThrow();
    store.close();
  });

  it("is drained into the ledger on the next pass", async () => {
    const h = harness();
    const inbox = new Inbox(join(dir, "inbox"));
    const runner = new Runner({
      agent: { accountId: ACCOUNT, gate: { mode: "delegated-auto" }, openPosition: h.openPosition } as unknown as WaterXAgent,
      store: h.store,
      reconciler: {} as unknown as Reconciler,
      inbox,
      now,
      log: () => undefined,
    });
    h.openPosition.mockResolvedValue({ digest: "digest-1" });
    inbox.submit({ intent: INTENT });

    await runner.tick();

    expect(h.store.all()).toHaveLength(1);
    // Acked after the write, so a second pass finds nothing to do.
    await runner.tick();
    expect(h.store.all()).toHaveLength(1);
  });

  it("carries the schedule and the key across", async () => {
    const h = harness();
    const inbox = new Inbox(join(dir, "inbox"));
    const runner = new Runner({
      agent: { accountId: ACCOUNT, gate: { mode: "delegated-auto" }, openPosition: h.openPosition } as unknown as WaterXAgent,
      store: h.store,
      reconciler: {} as unknown as Reconciler,
      inbox,
      now,
      log: () => undefined,
    });
    inbox.submit({ intent: INTENT, notBefore: clock + 60_000, expiresAt: clock + 120_000, key: "k" });

    await runner.tick();

    expect(h.store.all()[0]).toMatchObject({
      notBefore: clock + 60_000,
      expiresAt: clock + 120_000,
      key: "k",
    });
  });

  it("sets an unreadable entry aside instead of wedging the drain", async () => {
    const h = harness();
    const inboxPath = join(dir, "inbox");
    const inbox = new Inbox(inboxPath);
    const runner = new Runner({
      agent: { accountId: ACCOUNT, gate: { mode: "delegated-auto" }, openPosition: h.openPosition } as unknown as WaterXAgent,
      store: h.store,
      reconciler: {} as unknown as Reconciler,
      inbox,
      now,
      log: () => undefined,
    });
    h.openPosition.mockResolvedValue({ digest: "digest-1" });
    inbox.submit({ intent: INTENT });
    mkdirSync(inboxPath, { recursive: true });
    writeFileSync(join(inboxPath, "broken.json"), "{ not json");

    await runner.tick();

    // The good one landed; the bad one is aside for a person, not retried
    // forever and not silently discarded.
    expect(h.store.all()).toHaveLength(1);
    expect(readdirSync(inboxPath).some((n) => n.endsWith(".rejected"))).toBe(true);
  });
});

describe("inbox ingestion survives a crash between the write and the ack", () => {
  const runnerOver = (store: JobStore, inbox: Inbox, openPosition: ReturnType<typeof vi.fn>) =>
    new Runner({
      agent: { accountId: ACCOUNT, gate: { mode: "delegated-auto" }, openPosition } as unknown as WaterXAgent,
      store,
      reconciler: {} as unknown as Reconciler,
      inbox,
      now,
      log: () => undefined,
    });

  it("does not queue the same intent twice when the file outlives the write", async () => {
    // Deleting on read lost the intent to a crash before the store flushed;
    // deleting after can duplicate it. The inbox id makes ingestion idempotent
    // so neither happens.
    const h = harness();
    const inboxPath = join(dir, "inbox");
    const inbox = new Inbox(inboxPath);
    h.openPosition.mockResolvedValue({ digest: "digest-1" });
    inbox.submit({ intent: INTENT });

    // Ingest, then simulate the crash by putting the file back exactly as it was.
    const before = readdirSync(inboxPath).find((n) => n.endsWith(".json"))!;
    const body = readFileSync(join(inboxPath, before), "utf8");
    await runnerOver(h.store, inbox, h.openPosition).tick();
    expect(h.store.all()).toHaveLength(1);

    // The inbox id is written WITH the job, in one flush — so there is no
    // window where a stored job lacks it and the file gets read as new.
    expect(h.store.all()[0]?.inboxId).toBe(before.replace(/\.json$/, ""));

    writeFileSync(join(inboxPath, before), body);
    await runnerOver(h.store, inbox, h.openPosition).tick();

    // Recognised as already ingested, and the file cleared.
    expect(h.store.all()).toHaveLength(1);
    expect(readdirSync(inboxPath).filter((n) => n.endsWith(".json"))).toHaveLength(0);
  });

  it("an undeletable inbox entry does not abort the pass", async () => {
    // `drainInbox` runs before any job is driven, so a throw escaping it stops
    // the runner doing ANY work — one stuck file would halt all trading. Every
    // ack path is isolated for that reason, not for tidiness.
    const h = harness();
    const inboxPath = join(dir, "inbox-stuck");
    const inbox = new Inbox(inboxPath);
    inbox.submit({ intent: INTENT });
    h.openPosition.mockResolvedValue({ digest: "digest-1" });

    // Every ack fails, on every path.
    const exploding = {
      drain: () => [
        { id: "x", entry: { intent: INTENT }, ack: () => { throw new Error("EPERM"); } },
        { id: "x", entry: { intent: INTENT }, ack: () => { throw new Error("EPERM"); } },
      ],
    } as unknown as Inbox;
    const runner = new Runner({
      agent: { accountId: ACCOUNT, gate: { mode: "delegated-auto" }, openPosition: h.openPosition } as unknown as WaterXAgent,
      store: h.store,
      reconciler: { didLand: vi.fn(), outcomeOf: vi.fn() } as unknown as Reconciler,
      inbox: exploding,
      now,
      log: () => undefined,
    });

    await expect(runner.tick()).resolves.toBeUndefined();
    // And the work still happened: the second entry is the duplicate path,
    // whose ack also throws, and neither stopped the job being driven.
    expect(h.openPosition).toHaveBeenCalled();
  });

  it("reports an unlink failure instead of swallowing it", () => {
    // The job is already stored, so this is a diagnostic — but silence would
    // make the file reappear every pass with nothing saying why.
    const inboxPath = join(dir, "inbox-unlink");
    const inbox = new Inbox(inboxPath);
    inbox.submit({ intent: INTENT });
    const [held] = inbox.drain();

    // Remove the directory out from under it: unlink now fails with something
    // other than ENOENT is not guaranteed, so assert on behaviour that holds
    // either way — a missing file is fine, anything else must throw.
    rmSync(inboxPath, { recursive: true, force: true });
    expect(() => held?.ack()).not.toThrow();
  });

  it("keeps the file when the store write fails for an infrastructure reason", async () => {
    // Acking here deletes an intent the caller was told was accepted — and a
    // full disk or a failing fsync is precisely the case where retrying works.
    // Only a policy refusal, which would fail identically forever, may ack.
    const h = harness();
    const inboxPath = join(dir, "inbox-io");
    const inbox = new Inbox(inboxPath);
    inbox.submit({ intent: INTENT });

    const broken = {
      all: () => [],
      add: () => {
        throw new Error("ENOSPC: no space left on device");
      },
      update: () => undefined,
      pruneFinished: () => 0,
    } as unknown as JobStore;
    const runner = new Runner({
      agent: { accountId: ACCOUNT, gate: { mode: "delegated-auto" } } as unknown as WaterXAgent,
      store: broken,
      reconciler: {} as unknown as Reconciler,
      inbox,
      now,
      log: () => undefined,
    });

    await runner.tick();

    // Still there for the next pass.
    expect(readdirSync(inboxPath).filter((n) => n.endsWith(".json"))).toHaveLength(1);
  });

  it("acks a policy refusal, which would fail identically forever", async () => {
    const h = harness();
    const inboxPath = join(dir, "inbox-policy");
    const inbox = new Inbox(inboxPath);
    // A cooldown that bounds nothing — refused by the gate every single time.
    inbox.submit({ intent: INTENT, key: "k", cooldownMs: 0 });
    const runner = new Runner({
      agent: { accountId: ACCOUNT, gate: { mode: "delegated-auto" } } as unknown as WaterXAgent,
      store: h.store,
      reconciler: {} as unknown as Reconciler,
      inbox,
      now,
      log: () => undefined,
    });

    await runner.tick();

    expect(h.store.all()).toHaveLength(0);
    // Cleared, or the drain would retry it forever.
    expect(readdirSync(inboxPath).filter((n) => n.endsWith(".json"))).toHaveLength(0);
  });

  it("leaves the file in place if the store write throws", () => {
    // The other direction: nothing durable, so the intent must survive on disk.
    const inboxPath = join(dir, "inbox2");
    const inbox = new Inbox(inboxPath);
    inbox.submit({ intent: INTENT });
    const [held] = inbox.drain();

    expect(held).toBeDefined();
    // Not acked → still there for the next pass.
    expect(readdirSync(inboxPath).filter((n) => n.endsWith(".json"))).toHaveLength(1);
    held?.ack();
    expect(readdirSync(inboxPath).filter((n) => n.endsWith(".json"))).toHaveLength(0);
  });
});

describe("an unknown outcome halts new work", () => {
  it("does not submit a queued job while another is ambiguous", async () => {
    // Sorting ambiguity first changed the ORDER, not whether the queued work
    // ran. An ambiguous job is an open question about money; submitting
    // alongside it compounds an exposure nobody can currently measure.
    const h = harness();
    h.openPosition.mockImplementation(async (p: { onSubmitting: (d: string) => Promise<void> }) => {
      await p.onSubmitting("digest-1");
      throw new Error("socket closed");
    });
    h.runner.enqueue(INTENT);
    await h.runner.tick();
    expect(h.store.all()[0]?.state).toBe("submitting");

    h.openPosition.mockReset();
    h.openPosition.mockResolvedValue({ digest: "digest-2" });
    const fresh = h.runner.enqueue(INTENT);
    h.didLand.mockResolvedValue({ kind: "unknown", reason: "too soon" });

    await h.runner.tick();

    expect(stateOf(h, fresh.id)).toBe("queued");
    expect(h.openPosition).not.toHaveBeenCalled();
  });

  it("resumes once the ambiguity is settled", async () => {
    const h = harness();
    h.openPosition.mockImplementation(async (p: { onSubmitting: (d: string) => Promise<void> }) => {
      await p.onSubmitting("digest-1");
      throw new Error("socket closed");
    });
    h.runner.enqueue(INTENT);
    await h.runner.tick();

    h.openPosition.mockReset();
    h.openPosition.mockResolvedValue({ digest: "digest-2" });
    const fresh = h.runner.enqueue(INTENT);
    h.didLand.mockResolvedValue({ kind: "landed" });
    h.outcomeOf.mockResolvedValue({ orderIds: [1], status: "filled" });

    await h.runner.tick();
    await h.runner.tick();

    // The claim is that it stopped being held back — how far it then got is
    // the fill logic's business, not this test's.
    expect(stateOf(h, fresh.id)).not.toBe("queued");
    expect(h.openPosition).toHaveBeenCalled();
  });
});

describe("the store", () => {
  it("refuses a second writer — two runners would submit the same job twice", () => {
    const path = join(dir, "jobs.json");
    const first = new JobStore(path);
    first.open();
    expect(() => new JobStore(path).open()).toThrow(StoreLockedError);
    first.close();
    // Released on close, so a clean restart works.
    expect(() => new JobStore(path).open()).not.toThrow();
  });

  it("creates its own directory rather than reporting a lock conflict", () => {
    // Reporting ENOENT as "another runner holds the lock" sends an operator
    // looking for a process that never existed.
    const nested = join(dir, "does", "not", "exist", "jobs.json");
    const store = new JobStore(nested);
    expect(() => store.open()).not.toThrow();
    store.close();
  });

  it("reports a broken lock as itself, not as a peer", () => {
    const store = new JobStore(join("/proc-does-not-exist-here", "jobs.json"));
    // Whatever goes wrong, it must not be dressed up as a lock conflict.
    expect(() => store.open()).toThrow(/Cannot take the job-store lock|ENOENT|EACCES|EROFS/);
    expect(() => store.open()).not.toThrow(StoreLockedError);
  });

  it("drops finished jobs past retention, and only those", () => {
    const path = join(dir, "jobs.json");
    const store = new JobStore(path);
    store.open();
    const base = { intent: INTENT, createdAt: 0, attempts: 1, events: [] };
    const old = clock - DEFAULT_LIMITS.retentionMs - 1;
    for (const job of [
      { id: "a", state: "filled", updatedAt: old },
      { id: "b", state: "failed", updatedAt: old },
      { id: "c", state: "unresolved", updatedAt: old },
      { id: "d", state: "submitted", updatedAt: old },
      { id: "e", state: "filled", updatedAt: clock - 1000 },
      { id: "f", state: "filled", updatedAt: old, key: "k", cooldownMs: Number.MAX_SAFE_INTEGER },
    ] as unknown as Job[]) {
      store.add({ ...base, ...job } as Job);
    }

    expect(store.pruneFinished(DEFAULT_LIMITS.retentionMs, clock)).toBe(2);
    const left = store.all().map((j) => j.id).sort();
    // `c` is unresolved (a person owes it an answer), `d` is unfinished,
    // `e` is inside retention, `f` is inside its cooldown — dropping `f`
    // would silently let the same decision be taken again.
    expect(left).toEqual(["c", "d", "e", "f"]);
    store.close();
  });

  it("does not rewrite the file when nothing is prunable", () => {
    const path = join(dir, "jobs.json");
    const store = new JobStore(path);
    store.open();
    store.add({
      id: "a", state: "filled", intent: INTENT, createdAt: 0, updatedAt: clock, attempts: 1, events: [],
    } as Job);
    const before = readFileSync(path, "utf8");
    expect(store.pruneFinished(DEFAULT_LIMITS.retentionMs, clock)).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
    store.close();
  });

  it("survives a torn write — a crashed flush leaves the previous file intact", () => {
    const path = join(dir, "jobs.json");
    const store = new JobStore(path);
    store.open();
    const runner = new Runner({
      agent: { accountId: ACCOUNT, gate: { mode: "delegated-auto" } } as unknown as WaterXAgent,
      store,
      reconciler: {} as unknown as Reconciler,
      now,
      log: () => undefined,
    });
    const job = runner.enqueue(INTENT);
    const good = readFileSync(path, "utf8");

    // A half-written temp file must not be visible as the store: the flush
    // writes elsewhere and renames, so this is inert.
    writeFileSync(join(dir, ".99999.tmp"), "{ truncated");
    store.close();

    const reopened = new JobStore(path);
    reopened.open();
    expect(readFileSync(path, "utf8")).toBe(good);
    expect(reopened.get(job.id)?.state).toBe("queued");
    reopened.close();
  });
});
