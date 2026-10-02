/**
 * Settle a submission whose result nobody saw — the command an `ambiguous`
 * outcome hands you.
 *
 * Two questions, answered from two different sources, deliberately:
 *
 *  - **Did the transaction land?** The chain, by digest. Authoritative, and not
 *    subject to indexer lag. This is what decides whether retrying would trade
 *    twice, so it is answered from the ledger itself.
 *  - **What became of the order?** Account history, by digest. The indexer
 *    knows the order id a transaction created and its terminal status.
 *
 * The asymmetry in how absence is treated is the load-bearing part, and it
 * lives in `src/runner/reconcile.ts`: a digest the chain has never seen might
 * simply not have propagated, so "absent" only becomes "never landed" after a
 * settle window. A digest the chain HAS seen is conclusive immediately.
 *
 * Reporting `never-landed` too early is the one error here that costs money.
 */
import { Reconciler } from "../../src/runner/reconcile.ts";
import { find, settle, unsettled, type SubmissionStatus } from "../../src/agent/submissions.ts";
import { invoke, succeeded } from "../../src/cli/contract.ts";
import { UsageError } from "../../src/errors.ts";
import { explorerTxUrl } from "../../src/config.ts";
import { initAgent, note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";

/** How long absence from the chain stays inconclusive. */
const DEFAULT_SETTLE_MS = 60_000;

/**
 * One submission's verdict.
 *
 * `landed` is deliberately three-valued. A boolean would force "we do not know
 * yet" into one of the two answers, and whichever way it fell it would be
 * wrong: `false` licenses a retry of a transaction that may have executed,
 * `true` reports a fill nobody got.
 */
interface ReconcileResult {
  submissionId: string;
  digest: string;
  action: string;
  landed: boolean | "aborted" | "unknown";
  /**
   * Whether re-sending the original order is safe.
   *
   * True for exactly the two outcomes where the chain's state did not move: the
   * transaction never arrived, or it arrived and aborted. False while anything
   * is unresolved, because an absence cannot be proven.
   */
  safeToRetry: boolean;
  reason?: string;
  explorer?: string;
  orderIds?: number[];
  orderStatus?: string;
}

const args = parseArgs(
  {
    id: { desc: "A submission id, or the digest itself" },
    digest: { desc: "A transaction digest (same as passing it to --id)" },
    all: { desc: "Settle every unsettled submission — the default when no id is given", flag: true },
    settleMs: {
      desc: "Milliseconds before absence from the chain counts as 'never landed'",
      default: String(DEFAULT_SETTLE_MS),
    },
  },
  "reconcile",
);

await run(async () => {
  const agent = initAgent();
  const settleMs = Number(args.settleMs ?? DEFAULT_SETTLE_MS);
  const reconciler = new Reconciler(agent.config, agent.read);

  const handle = args.id ?? args.digest;
  // With no handle, everything outstanding — `--all` is accepted as the
  // explicit spelling of the same thing. Settled submissions are deliberately
  // not re-checked: an empty result is the correct answer to "is anything in
  // flight?", and re-walking history on every run would bury it in noise.
  const pending: SubmissionStatus[] = handle === undefined ? unsettled() : [expect(handle)];

  if (pending.length === 0) {
    note("Nothing to reconcile — no submission is outstanding.");
    show({ outstanding: 0, results: [] });
    setOutcome(succeeded("nothing outstanding"));
    return;
  }

  const now = Date.now();
  const results: ReconcileResult[] = [];
  for (const entry of pending) {
    const { submission } = entry;
    const verdict = await reconciler.didLand(submission.digest, submission.at, settleMs, now);

    if (verdict.kind === "unknown") {
      // Still inconclusive. Recording it would turn "we do not know yet" into
      // an answer, so nothing is written and the caller is told to come back.
      results.push({
        submissionId: submission.id,
        digest: submission.digest,
        action: submission.action,
        landed: "unknown",
        reason: verdict.reason,
        safeToRetry: false,
      });
      continue;
    }

    if (verdict.kind === "never-landed") {
      settle(submission.id, { landed: false, reason: "not on chain after the settle window" });
      results.push({
        submissionId: submission.id,
        digest: submission.digest,
        action: submission.action,
        landed: false,
        // The only branch where retrying is safe, and it is safe because the
        // chain says the transaction does not exist.
        safeToRetry: true,
      });
      continue;
    }

    if (verdict.kind === "aborted") {
      // Included in a checkpoint, gas paid, and the Move call aborted. Settled
      // rather than left pending — the outcome is known — and safe to retry,
      // because a transaction that aborted changed nothing. A stale oracle
      // (`ETotalWeightNotEnough`) is the common cause and it clears on its own;
      // an insufficient-margin abort will not, which is why the chain's own
      // words are passed through rather than classified here.
      settle(submission.id, { landed: "aborted", reason: verdict.reason });
      results.push({
        submissionId: submission.id,
        digest: submission.digest,
        action: submission.action,
        landed: "aborted",
        reason: verdict.reason,
        safeToRetry: true,
        explorer: explorerTxUrl(agent.config.network, submission.digest),
      });
      continue;
    }

    // On chain and executed. What became of the order is the indexer's to say, and it may
    // not have caught up — `undefined` is "no answer yet", not "nothing
    // happened", so it is reported as such rather than as an empty result.
    let outcome: { orderIds: number[]; status: string } | undefined;
    if (submission.accountId !== undefined) {
      outcome = await reconciler.outcomeOf(submission.accountId, submission.digest, submission.at);
    }
    settle(submission.id, {
      landed: true,
      ...(outcome === undefined ? {} : { orderIds: outcome.orderIds, status: outcome.status }),
    });
    results.push({
      submissionId: submission.id,
      digest: submission.digest,
      action: submission.action,
      landed: true,
      safeToRetry: false,
      explorer: explorerTxUrl(agent.config.network, submission.digest),
      ...(outcome === undefined
        ? { orderStatus: "not-indexed-yet" }
        : { orderIds: outcome.orderIds, orderStatus: outcome.status }),
    });
  }

  for (const r of results) {
    note(
      `  ${String(r.landed).padEnd(11)} ${r.action.padEnd(18)} ${r.digest}` +
        (r.reason === undefined ? "" : `\n              ${r.reason}`),
    );
  }

  const stillUnknown = results.filter((r) => r.landed === "unknown");
  show({ outstanding: pending.length, results }, { rendered: true });

  if (stillUnknown.length > 0) {
    setOutcome({
      status: "ambiguous",
      message:
        `${String(stillUnknown.length)} submission(s) are still unresolved — the chain has not ` +
        `seen them and they are not old enough for that to mean anything. Wait and reconcile ` +
        `again; do not retry the order.`,
      submitted: true,
      retryable: false,
      reconcileRequired: true,
      awaitingApproval: false,
      nextCommand: invoke("reconcile", "--id", stillUnknown[0]?.submissionId ?? "", "--json"),
      details: { unresolved: stillUnknown },
    });
    return;
  }

  const aborted = results.filter((r) => r.landed === "aborted");
  const executed = results.filter((r) => r.landed === true).length;
  const absent = results.filter((r) => r.landed === false).length;
  const tally =
    `${String(executed)} executed, ${String(aborted.length)} aborted on chain, ` +
    `${String(absent)} never landed`;

  // An abort is not a success, and this used to report one. `rejected` rather
  // than `unavailable`: the transaction reached the chain and was refused
  // there, so a caller must look at the reason before sending anything again —
  // even though sending again is safe.
  setOutcome(
    aborted.length === 0
      ? succeeded(tally)
      : {
          status: "rejected",
          message:
            `${tally}. Aborted: ${aborted
              .map((r) => `${r.action} (${r.reason ?? "no reason given"})`)
              .join("; ")}. Nothing was placed and nothing moved, so these can be sent again — ` +
            `read the reason first, because a stale oracle clears on its own and an insufficient ` +
            `balance does not.`,
          submitted: true,
          retryable: false,
          reconcileRequired: false,
          awaitingApproval: false,
          details: { aborted },
        },
  );
});

function expect(handle: string): SubmissionStatus {
  const found = find(handle);
  if (found === undefined) {
    throw new UsageError(
      `No submission ${handle}. \`${invoke("reconcile", "--all")}\` settles everything outstanding.`,
    );
  }
  return found;
}
