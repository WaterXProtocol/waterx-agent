/**
 * What has been previewed, what a person approved, and what was spent.
 *
 * Read-only, and the first thing to run when an agent is unsure whether it
 * already sent something. Pairs with `pnpm run reconcile`, which answers the
 * same question from the chain's side.
 */
import { list } from "../../src/agent/approvals.ts";
import { list as submissions } from "../../src/agent/submissions.ts";
import { invoke, succeeded } from "../../src/cli/contract.ts";
import { note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";

const args = parseArgs(
  {
    state: { desc: "Only show this state: pending | approved | consumed | rejected | expired" },
    limit: { desc: "How many to show, newest first", default: "20" },
  },
  "approvals",
);

await run(async () => {
  const limit = Number(args.limit ?? 20);
  const all = list();
  const filtered = args.state === undefined ? all : all.filter((a) => a.state === args.state);
  const shown = filtered.slice(0, limit);
  const open = submissions().filter((s) => !s.settled);

  for (const entry of shown) {
    note(
      `  ${entry.state.padEnd(9)} ${entry.request.id}  ${entry.request.action.padEnd(18)} ` +
        `${entry.request.preview.ticker ?? ""}` +
        (entry.digest === undefined ? "" : `  ${entry.digest}`),
    );
  }
  if (shown.length === 0) note("  (none)");

  show({
    approvals: shown.map((entry) => ({
      id: entry.request.id,
      state: entry.state,
      action: entry.request.action,
      network: entry.request.network,
      createdAt: new Date(entry.request.createdAt).toISOString(),
      expiresAt: new Date(entry.request.expiresAt).toISOString(),
      approvedBy: entry.approvedBy ?? null,
      digest: entry.digest ?? null,
      preview: entry.request.preview,
    })),
    // Surfaced here because it changes what an agent may do next: a submission
    // nobody has settled is a transaction whose effect is unknown, and placing
    // another order on top of an unknown one is the failure this guards.
    unsettledSubmissions: open.map((s) => ({
      id: s.submission.id,
      digest: s.submission.digest,
      action: s.submission.action,
      at: new Date(s.submission.at).toISOString(),
    })),
  }, { rendered: true });

  setOutcome(
    open.length === 0
      ? succeeded(`${String(shown.length)} approval(s); nothing outstanding`)
      : {
          status: "ambiguous",
          message:
            `${String(open.length)} submission(s) have never been settled. Reconcile before ` +
            `trading again.`,
          submitted: true,
          retryable: false,
          reconcileRequired: true,
          awaitingApproval: false,
          nextCommand: invoke("reconcile", "--all", "--json"),
        },
  );
});
