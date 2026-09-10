/**
 * Resolving what actually happened, from evidence rather than from a clock.
 *
 * Two questions, two sources, deliberately not the same one:
 *
 *  - **Did the transaction land?** The chain, by digest. Authoritative and not
 *    subject to indexer lag. This is the question that decides whether a retry
 *    would duplicate a trade, so it is answered from the ledger itself.
 *  - **What became of the order?** Account history, by digest. The indexer
 *    knows the order id a transaction created and its terminal status; the
 *    chain would require decoding events to say the same thing.
 *
 * The asymmetry in how absence is treated is the important part. A digest the
 * chain has never seen might simply not have propagated yet, so "absent" only
 * becomes "never landed" after a settle window. A digest the chain HAS seen is
 * conclusive immediately.
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";

import type { ReadApi } from "../api/read.ts";
import type { AgentConfig } from "../config.ts";

export type LandedVerdict =
  | { kind: "landed" }
  | { kind: "never-landed" }
  /**
   * On chain, and it aborted. A Move abort is still a
   * committed transaction, so "the chain has this digest" is not the same
   * answer as "the request took effect".
   */
  | { kind: "aborted"; reason: string }
  /** Not on chain yet, and not old enough for absence to mean anything. */
  | { kind: "unknown"; reason: string };

export interface OrderOutcome {
  orderIds: number[];
  /** `open` while resting; the rest are terminal. */
  status: "open" | "filled" | "cancelled" | "invalidated";
}

interface HistoryRow {
  id: number | string;
  txDigest?: string;
  status?: OrderOutcome["status"];
  action?: string;
  /** Unix ms. The bound that makes the backward search terminate. */
  timestamp?: number;
}

/** Rows per history request. The API's own maximum for this route is larger, but
 *  the search is bounded by time rather than by page size, so a bigger page only
 *  changes how many round trips it takes. */
const HISTORY_PAGE = 50;

/**
 * Hard cap on pages walked per lookup. The time bound below is the real
 * terminator; this exists so a pathological account cannot turn one tick into
 * an unbounded crawl. Hitting it is reported, never swallowed — silently
 * returning "no answer" at the cap would recreate the very bug this paging
 * fixes, just further out.
 */
const MAX_HISTORY_PAGES = 20;

export class Reconciler {
  private grpc?: SuiGrpcClient;

  constructor(
    private readonly config: AgentConfig,
    private readonly read: ReadApi,
  ) {}

  /**
   * Has this digest executed?
   *
   * `submittedAt` and `settleMs` bound how long absence is treated as
   * inconclusive. Reporting `never-landed` too early is the one error that
   * costs money — the caller retries, and the first transaction lands after
   * all.
   */
  async didLand(digest: string, submittedAt: number, settleMs: number, now: number): Promise<LandedVerdict> {
    try {
      const result = await this.client().core.getTransaction({ digest });
      // Inspect the execution status, don't just observe
      // that the lookup succeeded. A Move abort commits like any other
      // transaction, so the old `return { kind: "landed" }` said "landed" for
      // one. The caller then moved the job to `submitted`, and for an on-chain
      // settled intent `awaitOutcome` immediately finished it as `filled` with
      // "the request is on chain" — the ledger recording a trade that aborted,
      // and the keyed cooldown starting on a decision that never took effect.
      const tx = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
      const status = tx?.status;
      if (status?.success === false) {
        return { kind: "aborted", reason: describe(status.error) };
      }
      if (result.$kind === "FailedTransaction") {
        return { kind: "aborted", reason: "the chain reports this transaction as failed" };
      }
      return { kind: "landed" };
    } catch (error) {
      // A lookup that failed for a transport reason is not evidence of absence.
      if (!isNotFound(error)) {
        return { kind: "unknown", reason: `chain lookup failed: ${describe(error)}` };
      }
      if (now - submittedAt < settleMs) {
        return {
          kind: "unknown",
          reason: `not on chain yet, and only ${String(Math.round((now - submittedAt) / 1000))}s since it was sent`,
        };
      }
      return { kind: "never-landed" };
    }
  }

  /**
   * What became of the orders a transaction created.
   *
   * Returns `undefined` while the indexer has not caught up — absence of a row
   * is not a statement that nothing happened, and treating it as one would
   * strand a filled order in `submitted`.
   *
   * **Why this pages.** It used to read one page of 50 rows and give up. The
   * window is a row COUNT, so it shrinks in transactions as the account gets
   * busier: measured on an active testnet account, 50 rows covered the newest
   * 49 transactions with `hasMore: true`. A job whose rows were pushed past
   * that became permanently invisible — it sat in `submitted` until the
   * deadline and was then reported `unresolved`, which is a false alarm on a
   * SUCCESSFUL order, and (because an unresolved job blocks its key by design)
   * one that wedges the strategy that produced it. The trigger was activity, so
   * a strategy stopped working precisely because it was working.
   *
   * `submittedAt` is what makes the backward walk terminate: this job's rows
   * cannot predate its own submission, so the first page older than that
   * settles the question. The bound is time, not row count, which is the
   * property the old code was missing.
   */
  async outcomeOf(
    accountId: string,
    digest: string,
    submittedAt: number,
  ): Promise<OrderOutcome | undefined> {
    let cursor: string | undefined;

    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const history = (await this.read.history({
        account: accountId,
        category: "order",
        limit: HISTORY_PAGE,
        ...(cursor !== undefined ? { cursor } : {}),
      })) as { items?: HistoryRow[]; nextCursor?: string | null; hasMore?: boolean };

      const items = history.items ?? [];
      const rows = items.filter((row) => row.txDigest === digest);
      if (rows.length > 0) return this.toOutcome(rows);

      // Walked past the submission: the rows cannot be behind us, so they are
      // not indexed yet. That is "no answer", not "nothing happened".
      const oldest = oldestTimestamp(items);
      if (oldest !== undefined && oldest < submittedAt) return undefined;

      if (history.hasMore !== true || history.nextCursor == null) return undefined;
      cursor = history.nextCursor;
    }

    // The cap, not the time bound, ended the search. Say so: a caller that
    // treated this as "not there" would be back where it started.
    throw new Error(
      `Could not settle ${digest}: walked ${String(MAX_HISTORY_PAGES)} pages of order history ` +
        `without reaching its submission time. The account is busier than this search is sized for.`,
    );
  }

  private toOutcome(rows: HistoryRow[]): OrderOutcome {
    const orderIds = rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
    // A bracketed order writes several rows — the main order and its TP/SL
    // legs. The main order is the one whose status decides the job, and the
    // legs are reduce-only children that outlive it, so a job is finished when
    // ANY row of its transaction has reached a terminal status. Taking the
    // first terminal row is deliberate: waiting for all of them would leave a
    // filled open order pending on legs that only resolve when the position
    // closes, possibly days later.
    const terminal = rows.find((row) => row.status !== undefined && row.status !== "open");
    return { orderIds, status: terminal?.status ?? "open" };
  }

  /**
   * Does the position the intent named still exist?
   *
   * The attribution works precisely because the intent named it: "position 84
   * is gone" is evidence about *this* job in a way that "a position closed
   * somewhere" would not be.
   */
  async positionGone(accountId: string, ticker: string, positionId: number): Promise<boolean> {
    const positions = await this.read.positions(accountId);
    return !positions.some((p) => p.ticker === ticker && p.id === String(positionId));
  }

  /** The same argument, for a resting order a cancel was aimed at. */
  async orderGone(accountId: string, ticker: string, orderId: number): Promise<boolean> {
    const orders = await this.read.orders({ account: accountId });
    return !orders.some((o) => o.ticker === ticker && o.id === String(orderId));
  }

  private client(): SuiGrpcClient {
    this.grpc ??= new SuiGrpcClient({
      network: this.config.network,
      baseUrl: this.config.grpcUrl,
    });
    return this.grpc;
  }
}

/**
 * Distinguish "the chain does not have this" from "the lookup broke".
 *
 * The gRPC status **code** is the signal; the message is a fallback. Both are
 * checked because getting this wrong in the permissive direction is what makes
 * a runner send a trade twice: an `INVALID_ARGUMENT` (a malformed digest) or a
 * dropped connection read as NOT_FOUND would license a retry of a transaction
 * that may well have executed.
 *
 * The message fallback is URL-decoded first. Sui's gRPC-web transport
 * percent-encodes it, so the text actually arrives as
 * `Transaction%20<digest>%20not%20found` and a naive substring match for
 * "not found" silently never fires — which is exactly how this was found.
 */
function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code.toUpperCase() === "NOT_FOUND";

  const text = decode(describe(error)).toLowerCase();
  return text.includes("not_found") || text.includes("not found");
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The oldest row in a page, or `undefined` when none carries a timestamp. */
function oldestTimestamp(rows: HistoryRow[]): number | undefined {
  let oldest: number | undefined;
  for (const row of rows) {
    if (typeof row.timestamp !== "number") continue;
    if (oldest === undefined || row.timestamp < oldest) oldest = row.timestamp;
  }
  return oldest;
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    // A stray `%` is not a reason to lose the message.
    return text;
  }
}
