/**
 * Submit one approved plan, and be honest about what happened.
 *
 * The last of the three steps. Everything about the order was decided at
 * `preview` and agreed at `approve`; this command re-derives nothing. It reads
 * the plan back, hands it to the policy gate, and signs whatever the backend
 * builds from it — with the gate binding the permit to the intent and to the
 * bytes, and the verifier decoding those bytes and checking them against the
 * intent immediately before the signature. None of that is new here; what is
 * new is that the intent came from a file a person read.
 *
 * ## The timeout, and why it is the interesting part
 *
 * Submitting can hang. Not often, but the window between "the bytes went out"
 * and "we saw the result" cannot be closed, and a command that waits forever
 * inside it is a command an agent will eventually kill — losing, with the
 * process, the only record of what it had just done.
 *
 * So the digest is written to the submission ledger *before* the bytes leave,
 * through the executor's `onSubmitting` hook, and `--timeout` gives up waiting
 * afterwards. What it reports then is `ambiguous`, never `rejected`:
 *
 *   - the approval is already marked consumed, so nothing can spend it twice;
 *   - the digest is on disk, so the question is answerable;
 *   - the envelope carries `reconcileRequired: true` and the exact command.
 *
 * The one thing this must never do is guess. "It probably did not go through"
 * is how an agent places the same trade twice, and the loss is real money on a
 * transaction that already executed.
 */
import { markConsumed, statusOf } from "../../src/agent/approvals.ts";
import { recordSubmission } from "../../src/agent/submissions.ts";
import { previewOf } from "../../src/agent/plan.ts";
import { AmbiguousSubmissionError, ConfigError, UsageError } from "../../src/errors.ts";
import { invoke, succeeded } from "../../src/cli/contract.ts";
import { explorerTxUrl } from "../../src/config.ts";
import { demand, initAgent, note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";

/** Long enough for a slow build plus a submission; short enough to not hang an agent. */
const DEFAULT_TIMEOUT_MS = 90_000;

const args = parseArgs(
  {
    id: { desc: "The approval id to execute", required: true },
    timeout: { desc: "Milliseconds to wait before reporting AMBIGUOUS", default: String(DEFAULT_TIMEOUT_MS) },
  },
  "execute",
);

await run(async () => {
  const id = demand(args.id, "--id", "which approved plan to submit");
  const status = statusOf(id);
  if (status === undefined) {
    throw new UsageError(`No previewed plan ${id}. Run \`${invoke("approvals")}\` to list them.`);
  }

  // Already spent. This is the duplicate-order case, so it is reported with the
  // digest and the reconcile command rather than as a bare refusal — a caller
  // that lost its own record needs to be pointed at the transaction, not told
  // no.
  if (status.state === "consumed") {
    const digest = status.digest;
    setOutcome({
      status: "rejected",
      message:
        `${id} has already been executed. One approval buys one transaction; preview again if ` +
        `you mean to trade again.`,
      submitted: true,
      retryable: false,
      reconcileRequired: status.submissionId !== undefined,
      awaitingApproval: false,
      ...(status.submissionId === undefined
        ? {}
        : { nextCommand: invoke("reconcile", "--id", status.submissionId, "--json") }),
      details: { digest, submissionId: status.submissionId },
    });
    return;
  }
  if (status.state === "rejected") {
    throw new UsageError(`${id} was rejected${status.reason === undefined ? "" : `: ${status.reason}`}.`);
  }
  if (status.state === "expired") {
    throw new UsageError(
      `${id} expired at ${new Date(status.request.expiresAt).toISOString()}. It was derived from ` +
        `prices that have since moved — preview again.`,
    );
  }
  if (status.state === "pending") {
    setOutcome({
      status: "needs-approval",
      message: `${id} has not been approved. A person must approve it before it can be sent.`,
      submitted: false,
      retryable: false,
      reconcileRequired: false,
      awaitingApproval: true,
      nextCommand: invoke("approve", "--id", id, "--approver <who>", "--json"),
    });
    return;
  }

  const agent = initAgent();
  const request = status.request;

  // A plan is bound to the deployment it was derived against. Executing one
  // elsewhere would submit a testnet-priced order to mainnet, or an order for
  // an account this process does not hold.
  if (request.network !== agent.config.network) {
    throw new ConfigError(
      `${id} was previewed on ${request.network} but this process is configured for ` +
        `${agent.config.network}. An approval does not carry across networks.`,
    );
  }
  if (request.accountId !== undefined && request.accountId !== agent.config.accountId) {
    throw new ConfigError(
      `${id} was previewed for account ${request.accountId}; WATERX_ACCOUNT_ID is now ` +
        `${agent.config.accountId ?? "unset"}. Approvals are per account.`,
    );
  }

  const timeoutMs = Number(args.timeout ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new UsageError(`--timeout must be a positive number of milliseconds.`);
  }

  // Set inside `onSubmitting`, which the executor awaits before the bytes go
  // out. Its presence is exactly the difference between "nothing was sent" and
  // "something may have been".
  let submissionId: string | undefined;
  let digest: string | undefined;

  const submit = agent.submit(request.plan, {
    // The approval was checked above; this is the confirmation the interactive
    // policy asks for. An agent cannot reach it without one.
    confirm: true,
    onSubmitting: async (d) => {
      digest = d;
      const submission = recordSubmission({
        action: request.action,
        network: agent.config.network,
        ...(agent.config.accountId === undefined ? {} : { accountId: agent.config.accountId }),
        digest: d,
        approvalId: id,
        ...(request.preview.ticker === undefined ? {} : { ticker: request.preview.ticker }),
        ...(request.preview.positionId === undefined
          ? {}
          : { positionId: request.preview.positionId }),
        ...(request.preview.orderId === undefined ? {} : { orderId: request.preview.orderId }),
        // What it commits, so an order nobody has filled yet still counts
        // against the concurrent ceiling. Two opens sent seconds apart are both
        // invisible in `positions` until a keeper gets to them.
        ...(request.plan.intent.collateral === undefined
          ? {}
          : { collateral: request.plan.intent.collateral }),
      });
      submissionId = submission.id;
      // Before the transaction, not after it. An approval that only becomes
      // spent on success is one a crashed retry can spend again.
      markConsumed(id, { digest: d, submissionId: submission.id });
      await Promise.resolve();
    },
  });

  const result = await race(submit, timeoutMs, () => {
    // Everything this throw needs was written to disk before the bytes left.
    if (digest === undefined) {
      // No digest had been recorded when the clock ran out — so *probably*
      // nothing was signed, and this used to say exactly that. It cannot.
      // Giving up waiting does not cancel the work: the build may have
      // returned microseconds later and the submission gone out while this
      // message was being written. "Nothing was signed" is a claim about a race
      // this process lost, made in the one place where being wrong costs money.
      throw new AmbiguousSubmissionError(
        `${id} did not finish within ${String(timeoutMs)}ms, and no transaction had been ` +
          `created at the moment it gave up. That is not the same as nothing having been sent — ` +
          `the work was not cancelled. Reconcile before retrying.`,
        undefined,
        undefined,
      );
    }
    throw new AmbiguousSubmissionError(
      `${id} was submitted as ${digest} but the result did not arrive within ` +
        `${String(timeoutMs)}ms. It may or may not have executed — ask the chain before doing ` +
        `anything else. Do NOT retry this order.`,
      digest,
      submissionId,
    );
  });

  const url = explorerTxUrl(agent.config.network, result.digest);
  note(`${request.action} ✓  ${result.sponsored ? "sponsored" : "self-paid"}`);
  note(`  ${url}`);
  show({
    approvalId: id,
    action: request.action,
    digest: result.digest,
    sponsored: result.sponsored,
    explorer: url,
    submissionId,
    preview: previewOf(request.plan),
  });
  setOutcome(succeeded(`${request.action} executed as ${result.digest}`, { submitted: true }));
});

/**
 * Resolve `work`, or run `onTimeout` after `ms`.
 *
 * The pending work is deliberately NOT cancelled — there is no way to un-send a
 * transaction, and pretending otherwise is what would make the ambiguity worse.
 * The process exits through the thrown outcome; whatever the submission was
 * doing goes with it, and the ledger is what survives.
 */
async function race<T>(work: Promise<T>, ms: number, onTimeout: () => never): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, rejectWith) => {
        timer = setTimeout(() => {
          try {
            onTimeout();
          } catch (error) {
            rejectWith(error);
          }
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
