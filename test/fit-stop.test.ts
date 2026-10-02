/**
 * The runner resizing a protective leg after the reduce it outgrew has filled.
 *
 * A position reduced to 5.93 still shows a stop for 11.87. The command that fixes
 * it exists; this is the half that runs it without a person. Most of what is
 * asserted here is what it must NOT do, because the obvious implementation is the
 * dangerous one.
 *
 * **A reduce job reaches `filled` when its REQUEST is on chain.** The keeper fills
 * it afterwards, under its own digest, which this job cannot watch. So "filled"
 * here does not mean the position shrank, and a follow-up that resized the stop at
 * that moment would shrink it ahead of the fill and leave the position
 * under-protected through exactly the move a stop exists for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Inbox } from "../src/runner/inbox.ts";
import { JobStore } from "../src/runner/store.ts";
import { Runner } from "../src/runner/runner.ts";
import type { Reconciler } from "../src/runner/reconcile.ts";
import type { WaterXAgent } from "../src/agent/agent.ts";
import type { Intent } from "../src/runner/types.ts";

const ACCOUNT = `0x${"a".repeat(64)}`;
let dir: string;
let clock: number;
const now = (): number => clock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "waterx-fitstop-"));
  clock = 1_000_000;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const leg = (id: string, sizeInAsset: number) => ({
  id,
  ticker: "SUIUSD",
  side: "short",
  size: sizeInAsset * 2,
  sizeInAsset,
  reduceOnly: true,
  triggerPrice: 1.5,
  linkedOrders: [],
});

const positionOf = (sizeInAsset: number, legs: ReturnType<typeof leg>[]) => ({
  id: "7",
  ticker: "SUIUSD",
  side: "long",
  size: sizeInAsset * 2,
  sizeInAsset,
  collateral: 10,
  entryPrice: 2,
  spotPrice: 2,
  linkedOrders: legs,
});

interface Harness {
  runner: Runner;
  store: JobStore;
  inbox: Inbox;
  updateOrder: ReturnType<typeof vi.fn>;
  positions: ReturnType<typeof vi.fn>;
}

function harness(options: { fitStops?: boolean } = {}): Harness {
  const store = new JobStore(join(dir, "jobs.json"));
  store.open();
  const inbox = new Inbox(join(dir, "jobs.inbox"));
  const updateOrder = vi.fn().mockResolvedValue({ digest: "fit-digest" });
  const positions = vi.fn();
  const agent = {
    accountId: ACCOUNT,
    gate: { mode: "delegated-auto" },
    read: { positions },
    reducePosition: vi.fn().mockResolvedValue({ digest: "reduce-digest" }),
    updateOrder,
  } as unknown as WaterXAgent;
  const reconciler = {
    didLand: vi.fn(),
    outcomeOf: vi.fn().mockResolvedValue(undefined),
    positionGone: vi.fn().mockResolvedValue(true),
    orderGone: vi.fn().mockResolvedValue(true),
  } as unknown as Reconciler;
  const runner = new Runner({
    agent,
    store,
    reconciler,
    inbox,
    now,
    log: () => undefined,
    ...(options.fitStops === undefined ? {} : { fitStops: options.fitStops }),
  });
  return { runner, store, inbox, updateOrder, positions };
}

const REDUCE: Intent = { kind: "reduce", ticker: "SUIUSD", positionId: 7, percent: 50 };

/** Drive a reduce from queued to terminal, with the position as the chain has it. */
async function runTheReduce(h: Harness, position: unknown): Promise<void> {
  h.positions.mockResolvedValue([position]);
  h.inbox.submit({ intent: REDUCE });
  await h.runner.tick(); // drains the inbox and submits
  await h.runner.tick(); // submitted → filled, and queues the follow-ups
}

describe("what a reduce leaves behind", () => {
  it("queues one follow-up per protective leg", async () => {
    const h = harness();
    await runTheReduce(h, positionOf(11.87, [leg("42", 11.87), leg("43", 11.87)]));
    const queued = h.inbox.pending();
    expect(queued).toHaveLength(2);
    expect(queued.map((q) => (q.entry?.intent as { orderId?: number }).orderId).sort()).toEqual([42, 43]);
  });

  it("records what the position held, which is not what it will hold", async () => {
    // The reduce's request is on chain and the keeper has not filled it, so the
    // position is still 11.87. That number is carried for ONE decision — whether
    // the fill has landed — and never to size a write.
    const h = harness();
    await runTheReduce(h, positionOf(11.87, [leg("42", 11.87)]));
    expect((h.inbox.pending()[0]?.entry?.intent as { wasHolding?: number }).wasHolding).toBe(11.87);
  });

  it("queues nothing when the position carries no protective leg", async () => {
    const h = harness();
    await runTheReduce(h, positionOf(11.87, []));
    expect(h.inbox.pending()).toHaveLength(0);
  });

  it("queues nothing when the operator turned it off", async () => {
    const h = harness({ fitStops: false });
    await runTheReduce(h, positionOf(11.87, [leg("42", 11.87)]));
    expect(h.inbox.pending()).toHaveLength(0);
  });

  it("reports the reduce terminal BEFORE any follow-up work, so nothing it does can change that", async () => {
    // The ordering is the property, and it is load-bearing. Queue first and a
    // throw would leave the job in `submitted`; the next tick would reach
    // `awaitOutcome` again, finish again, and queue again — a loop emitting
    // duplicates. Finish first and a failed follow-up costs a log line.
    //
    // Checked by making the read fail, which is the only failure this path has.
    const h = harness();
    h.positions.mockRejectedValue(new Error("read failed"));
    h.inbox.submit({ intent: REDUCE });
    await h.runner.tick();
    const id = h.store.all().find((j) => j.intent.kind === "reduce")?.id ?? "";
    await h.runner.tick();
    expect(h.store.get(id)?.state).toBe("filled");
    expect(h.inbox.pending()).toHaveLength(0);

    // And it stays there. A second pass must not retry the follow-up by way of
    // re-finishing a job that is already done.
    await h.runner.tick();
    expect(h.store.get(id)?.state).toBe("filled");
    expect(h.inbox.pending()).toHaveLength(0);
  });

  it("queues each leg once, even if the reduce is finished twice", async () => {
    // The key is the reduce's own digest, so the inbox suppresses a repeat. Belt
    // and braces: `fit-stop` compares observed sizes, so a duplicate that did get
    // through would find nothing to do.
    const h = harness();
    await runTheReduce(h, positionOf(11.87, [leg("42", 11.87)]));
    expect(h.inbox.pending()).toHaveLength(1);
    // The next tick drains it into the store, where it waits out its grace. Two
    // more passes must leave exactly one — counted in the store, because that is
    // where it has moved to.
    await h.runner.tick();
    await h.runner.tick();
    expect(h.store.all().filter((j) => j.intent.kind === "fit-stop")).toHaveLength(1);
    expect(h.inbox.pending()).toHaveLength(0);
  });
});

describe("what the follow-up does when it runs", () => {
  /** Put a fit-stop straight in, as a reduce would have. */
  async function fitStopFor(h: Harness, wasHolding: number): Promise<string> {
    h.inbox.submit({
      intent: { kind: "fit-stop", ticker: "SUIUSD", positionId: 7, orderId: 42, wasHolding },
      notBefore: clock,
      expiresAt: clock + 900_000,
    });
    await h.runner.tick();
    return h.store.all().find((j) => j.intent.kind === "fit-stop")?.id ?? "";
  }

  it("writes nothing while the reduce is still unfilled", async () => {
    // THE test. The position is the size it was, so the stop still matches it and
    // there is nothing to fit TO. Resizing here would shrink the stop ahead of the
    // fill and leave the position under-protected until the keeper arrives.
    const h = harness();
    h.positions.mockResolvedValue([positionOf(11.87, [leg("42", 11.87)])]);
    const id = await fitStopFor(h, 11.87);
    expect(h.updateOrder).not.toHaveBeenCalled();
    // Deferred, not failed, and not terminal: it will ask again.
    expect(h.store.get(id)?.state).toBe("queued");
    expect(h.store.get(id)?.notBefore).toBeGreaterThan(clock);
  });

  it("resizes once the fill has landed, to the size the chain reports", async () => {
    const h = harness();
    h.positions.mockResolvedValue([positionOf(5.93, [leg("42", 11.87)])]);
    const id = await fitStopFor(h, 11.87);
    expect(h.updateOrder).toHaveBeenCalledOnce();
    expect(h.updateOrder.mock.calls[0]?.[0]).toMatchObject({
      orderId: 42,
      newSize: 5.93,
      // Unchanged. Resizing must not reprice.
      newTriggerPrice: 1.5,
    });
    expect(h.store.get(id)?.state).toBe("submitted");
  });

  it("never writes a size that was predicted rather than read", async () => {
    // The position settled at 6.2 rather than the 5.935 half of 11.87 — a partial
    // fill, or a fee. The write follows the chain, not the arithmetic.
    const h = harness();
    h.positions.mockResolvedValue([positionOf(6.2, [leg("42", 11.87)])]);
    await fitStopFor(h, 11.87);
    expect(h.updateOrder.mock.calls[0]?.[0]).toMatchObject({ newSize: 6.2 });
  });

  it("finishes without writing when the leg already fits", async () => {
    // Somebody ran `sync-stops`, or there was never a mismatch. Terminal, and
    // nothing was sent — which is why it is not `filled`.
    const h = harness();
    h.positions.mockResolvedValue([positionOf(5.93, [leg("42", 5.93)])]);
    const id = await fitStopFor(h, 11.87);
    expect(h.updateOrder).not.toHaveBeenCalled();
    expect(h.store.get(id)?.state).toBe("cancelled");
  });

  it("finishes without writing when the position has closed", async () => {
    // The protocol cancels a closed position's legs itself.
    const h = harness();
    h.positions.mockResolvedValue([]);
    const id = await fitStopFor(h, 11.87);
    expect(h.updateOrder).not.toHaveBeenCalled();
    expect(h.store.get(id)?.state).toBe("cancelled");
  });

  it("stays queued when the position cannot be read at all", async () => {
    // A failed read says nothing about the world. It must not become "already
    // fits" and it must not become a failure.
    const h = harness();
    h.positions.mockRejectedValue(new Error("network"));
    const id = await fitStopFor(h, 11.87);
    expect(h.updateOrder).not.toHaveBeenCalled();
    expect(h.store.get(id)?.state).toBe("queued");
  });

  it("gives up at its own deadline rather than asking forever", async () => {
    const h = harness();
    h.positions.mockResolvedValue([positionOf(11.87, [leg("42", 11.87)])]);
    const id = await fitStopFor(h, 11.87);
    expect(h.store.get(id)?.state).toBe("queued");
    // Past the window the job carries. Expiring is honest: the reduce never
    // filled inside it, so there was never anything to resize, and the legs are
    // where they started.
    clock += 1_000_000;
    await h.runner.tick();
    expect(h.store.get(id)?.state).toBe("expired");
    expect(h.updateOrder).not.toHaveBeenCalled();
  });
});
