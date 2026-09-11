/**
 * Resolving evidence.
 *
 * The asymmetry under test: a digest the chain HAS seen is conclusive at once,
 * while one it has not seen is conclusive only after a settle window — and a
 * lookup that merely *broke* is never conclusive at all. Reading a broken
 * lookup as absence is what licenses a retry of a transaction that executed.
 */
import { describe, expect, it, vi } from "vitest";

import type { ReadApi } from "../src/api/read.ts";
import { loadConfig } from "../src/config.ts";
import { Reconciler } from "../src/runner/reconcile.ts";
import { DEFAULT_LIMITS } from "../src/runner/types.ts";

const CONFIG = loadConfig({ network: "testnet", apiUrl: "https://example.invalid" });
const SENT_AT = 1_000_000;
const SETTLED = SENT_AT + DEFAULT_LIMITS.digestSettleMs + 1;

/** Stand in for the gRPC client the reconciler builds lazily. */
function withChain(getTransaction: () => Promise<unknown>, read?: Partial<ReadApi>): Reconciler {
  const reconciler = new Reconciler(CONFIG, (read ?? {}) as ReadApi);
  Object.defineProperty(reconciler, "client", {
    value: () => ({ core: { getTransaction } }),
  });
  return reconciler;
}

const rpcError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

describe("didLand", () => {
  it("is conclusive at once when the chain has the digest", async () => {
    const r = withChain(() => Promise.resolve({}));
    await expect(r.didLand("d", SENT_AT, DEFAULT_LIMITS.digestSettleMs, SENT_AT + 1)).resolves.toEqual({
      kind: "landed",
    });
  });

  it("withholds judgement while absence is still too young to mean anything", async () => {
    const r = withChain(() => Promise.reject(rpcError("NOT_FOUND", "not found")));
    const verdict = await r.didLand("d", SENT_AT, DEFAULT_LIMITS.digestSettleMs, SENT_AT + 1000);
    expect(verdict.kind).toBe("unknown");
  });

  it("concludes never-landed once absence has had time to be meaningful", async () => {
    const r = withChain(() => Promise.reject(rpcError("NOT_FOUND", "not found")));
    await expect(r.didLand("d", SENT_AT, DEFAULT_LIMITS.digestSettleMs, SETTLED)).resolves.toEqual({
      kind: "never-landed",
    });
  });

  it("recognises a percent-encoded not-found message", async () => {
    // Sui's gRPC-web transport percent-encodes the message, so it arrives as
    // `Transaction%20<digest>%20not%20found`. A naive substring match for
    // "not found" never fires, and the job sits ambiguous forever — which is
    // how this was found, on a live testnet run.
    const r = withChain(() =>
      Promise.reject(new Error("Transaction%2041Qf2nbHXGx%20not%20found")),
    );
    await expect(r.didLand("d", SENT_AT, DEFAULT_LIMITS.digestSettleMs, SETTLED)).resolves.toEqual({
      kind: "never-landed",
    });
  });

  it("never reads a broken lookup as absence, however long ago it was sent", async () => {
    for (const error of [
      rpcError("INVALID_ARGUMENT", "invalid%20digest"),
      rpcError("UNAVAILABLE", "connection reset"),
      new Error("socket hang up"),
    ]) {
      const r = withChain(() => Promise.reject(error));
      const verdict = await r.didLand("d", SENT_AT, DEFAULT_LIMITS.digestSettleMs, SETTLED);
      expect(verdict.kind).toBe("unknown");
    }
  });
});

describe("outcomeOf", () => {
  /** One page, already older than the submission — so the walk stops after it. */
  const reconcilerFor = (items: unknown[]): Reconciler =>
    new Reconciler(CONFIG, {
      history: vi.fn().mockResolvedValue({
        items: items.map((i) => ({ timestamp: SENT_AT - 1, ...(i as object) })),
        hasMore: false,
        nextCursor: null,
      }),
    } as unknown as ReadApi);

  it("returns undefined while the indexer has no row — absence is not an outcome", async () => {
    await expect(reconcilerFor([]).outcomeOf("0xacc", "d", SENT_AT)).resolves.toBeUndefined();
  });

  it("reports the order ids and a terminal status", async () => {
    const r = reconcilerFor([
      { id: 7, txDigest: "d", status: "filled" },
      { id: 9, txDigest: "other", status: "cancelled" },
    ]);
    await expect(r.outcomeOf("0xacc", "d", SENT_AT)).resolves.toEqual({ orderIds: [7], status: "filled" });
  });

  it("finishes a bracketed order on its main row, not on legs that outlive it", async () => {
    // A bracketed open writes the main order plus its TP/SL legs. The legs stay
    // `open` for as long as the position does — waiting for them would leave a
    // filled order pending for days.
    const r = reconcilerFor([
      { id: 10, txDigest: "d", status: "filled" },
      { id: 11, txDigest: "d", status: "open" },
      { id: 12, txDigest: "d", status: "open" },
    ]);
    await expect(r.outcomeOf("0xacc", "d", SENT_AT)).resolves.toEqual({
      orderIds: [10, 11, 12],
      status: "filled",
    });
  });

  it("finds a job whose rows were pushed past the first page", async () => {
    // The regression. A row count is not a time bound: on an active account 50
    // rows covered the newest 49 transactions with more behind them, so a job
    // that aged out became permanently invisible — reported `unresolved`
    // despite having filled, which then wedged its key.
    const page1 = Array.from({ length: 50 }, (_, i) => ({
      id: 100 + i,
      txDigest: `other-${String(i)}`,
      status: "filled",
      timestamp: SENT_AT + 1000,
    }));
    const page2 = [{ id: 7, txDigest: "d", status: "filled", timestamp: SENT_AT + 1 }];
    const history = vi
      .fn()
      .mockResolvedValueOnce({ items: page1, hasMore: true, nextCursor: "c1" })
      .mockResolvedValueOnce({ items: page2, hasMore: false, nextCursor: null });
    const r = new Reconciler(CONFIG, { history } as unknown as ReadApi);

    await expect(r.outcomeOf("0xacc", "d", SENT_AT)).resolves.toEqual({
      orderIds: [7],
      status: "filled",
    });
    expect(history).toHaveBeenCalledTimes(2);
    expect(history.mock.calls[1]?.[0]).toMatchObject({ cursor: "c1" });
  });

  it("stops walking once it is older than the job's own submission", async () => {
    // The job's rows cannot predate its submission, so the first page older
    // than that settles it. This is what makes the search terminate on an
    // account with years of history.
    const history = vi.fn().mockResolvedValue({
      items: [{ id: 1, txDigest: "ancient", status: "filled", timestamp: SENT_AT - 5000 }],
      hasMore: true,
      nextCursor: "c1",
    });
    const r = new Reconciler(CONFIG, { history } as unknown as ReadApi);

    await expect(r.outcomeOf("0xacc", "d", SENT_AT)).resolves.toBeUndefined();
    expect(history).toHaveBeenCalledTimes(1);
  });

  it("raises rather than reporting 'not there' when the page cap ends the search", async () => {
    // Swallowing this would recreate the original bug one order of magnitude
    // out: a silent "no answer" that a caller eventually calls `unresolved`.
    const history = vi.fn().mockResolvedValue({
      items: [{ id: 1, txDigest: "other", status: "filled", timestamp: SENT_AT + 1000 }],
      hasMore: true,
      nextCursor: "c",
    });
    const r = new Reconciler(CONFIG, { history } as unknown as ReadApi);

    await expect(r.outcomeOf("0xacc", "d", SENT_AT)).rejects.toThrow(/busier than this search/);
  });

  it("reports `open` while nothing has reached a terminal status", async () => {
    const r = reconcilerFor([{ id: 7, txDigest: "d", status: "open" }]);
    await expect(r.outcomeOf("0xacc", "d", SENT_AT)).resolves.toEqual({ orderIds: [7], status: "open" });
  });
});
