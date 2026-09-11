/**
 * A person says yes to one previewed plan.
 *
 * The step between deriving a write and signing it. It records *who* approved
 * *what*, at what time, in an append-only ledger — so an unapproved trade is an
 * act someone took and left a trace of, rather than a field nobody set.
 *
 * ## What this is worth, precisely
 *
 * It cannot stop a compromised process from appending its own approval line.
 * Nothing local could: an agent with a shell can write any file this command
 * can write. So the honest claim is the same one the policy gate makes about
 * signatures — it makes the unapproved case impossible **by mistake**, and
 * leaves an audit trail when it is not a mistake. What it does buy, in the
 * arrangement this exists for, is real: the plan a person read is the plan that
 * gets signed, byte for byte, and an agent cannot quietly enlarge an order
 * between the two.
 *
 * `--approver` is mandatory for the same reason. An approval with nobody's name
 * on it is a checkbox; one with a name is a record.
 */
import { createInterface } from "node:readline/promises";

import { approve, reject, statusOf } from "../../src/agent/approvals.ts";
import { previewOf } from "../../src/agent/plan.ts";
import { invoke, succeeded } from "../../src/cli/contract.ts";
import { UsageError } from "../../src/errors.ts";
import { demand, note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";

const args = parseArgs(
  {
    id: { desc: "The approval id `preview` printed", required: true },
    approver: { desc: "Who is approving this. Recorded; required.", required: true },
    reject: { desc: "Record a refusal instead of an approval", flag: true },
    reason: { desc: "Why it was refused (with --reject)" },
  },
  "approve",
);

await run(async () => {
  const id = demand(args.id, "--id", "which previewed plan to act on");
  const who = demand(args.approver, "--approver", "who is taking responsibility for this");
  const status = statusOf(id);

  if (status === undefined) {
    throw new UsageError(
      `No previewed plan ${id}. Run \`${invoke("approvals")}\` to list them, or preview again.`,
    );
  }

  if (args.reject === "true") {
    const reason = args.reason ?? `rejected by ${who}`;
    reject(id, reason);
    show({ approvalId: id, state: "rejected", reason, by: who });
    setOutcome(succeeded(`${id} rejected — it can never be executed`));
    return;
  }

  // Each of these is a different reason the answer is no, and an automated
  // caller has to be able to tell them apart: an expired plan should be
  // previewed again, a consumed one must not be, and a rejected one is settled.
  if (status.state === "consumed") {
    throw new UsageError(
      `${id} has already been executed${status.digest === undefined ? "" : ` (${status.digest})`}. ` +
        `One approval buys one transaction. Preview again if you mean to trade again.`,
    );
  }
  if (status.state === "rejected") {
    throw new UsageError(`${id} was rejected already; approving it now would rewrite a decision.`);
  }
  if (status.state === "expired") {
    throw new UsageError(
      `${id} expired at ${new Date(status.request.expiresAt).toISOString()}. The prices it was ` +
        `derived from are stale — preview again rather than approving an old quote.`,
    );
  }
  if (status.state === "approved") {
    note(`${id} was already approved${status.approvedBy === undefined ? "" : ` by ${status.approvedBy}`}.`);
    show({ approvalId: id, state: "approved", approvedBy: status.approvedBy });
    setOutcome(succeeded(`${id} is approved and ready to execute`));
    return;
  }

  const preview = previewOf(status.request.plan);
  note("");
  note(JSON.stringify(preview, null, 2));
  note("");

  // A terminal gets asked; a pipe does not. This is not a security boundary —
  // `--yes` and a non-TTY both skip it — but when a human IS at the keyboard,
  // showing them the plan and making them type the word is worth the two
  // seconds. See the header for what this does and does not prevent.
  if (process.stdin.isTTY === true && args.yes !== "true") {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question(`Approve ${id} as ${who}? Type "approve" to confirm: `);
    rl.close();
    if (answer.trim().toLowerCase() !== "approve") {
      reject(id, `declined at the prompt by ${who}`);
      show({ approvalId: id, state: "rejected", by: who });
      setOutcome(succeeded(`${id} declined`));
      return;
    }
  }

  approve(id, who);
  const executeCommand = invoke("execute", "--id", id, "--json");
  note(`Approved. Next: ${executeCommand}`);
  show({
    approvalId: id,
    state: "approved",
    approvedBy: who,
    expiresAt: new Date(status.request.expiresAt).toISOString(),
    preview,
    executeCommand,
  });
  setOutcome(succeeded(`${id} approved by ${who}`, { nextCommand: executeCommand }));
});
