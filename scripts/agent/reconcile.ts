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
import { succeeded } from "../../src/cli/contract.ts";
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
  landed: boolean | "unknown";
  /** Whether re-sending the original order is safe. Only ever true for `landed: false`. */
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

    // On chain. What became of the order is the indexer's to say, and it may
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
      nextCommand: `pnpm run reconcile -- --id ${stillUnknown[0]?.submissionId ?? ""} --json`,
      details: { unresolved: stillUnknown },
    });
    return;
  }

  setOutcome(
    succeeded(
      `${String(results.filter((r) => r.landed === true).length)} landed, ` +
        `${String(results.filter((r) => r.landed === false).length)} never landed`,
    ),
  );
});

function expect(handle: string): SubmissionStatus {
  const found = find(handle);
  if (found === undefined) {
    throw new UsageError(
      `No submission ${handle}. \`pnpm run reconcile -- --all\` settles everything outstanding.`,
    );
  }
  return found;
}
