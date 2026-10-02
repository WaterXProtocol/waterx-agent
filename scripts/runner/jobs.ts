/** What the runner believes, and why. Read-only. */
import { Inbox } from "../../src/runner/inbox.ts";
import { JobStore } from "../../src/runner/store.ts";
import { describeIntent } from "../../src/runner/runner.ts";
import { note, parseArgs, run } from "../lib/cli.ts";

const args = parseArgs(
  {
    store: { desc: "Path to the job store", default: ".waterx/jobs.json" },
    verbose: { desc: "Show each job's event trail", flag: true },
  },
  "runner-jobs",
);

await run(async () => {
  const storePath = args.store ?? ".waterx/jobs.json";
  const store = new JobStore(storePath);
  // Read-only: inspecting a runner must never block on it, or block it.
  store.openReadOnly();

  // The inbox is half the answer and was not being read. An intent lives there
  // until a runner has a pass to spare for it, so an inbox holding ten and a
  // store holding none answered "no jobs" — and an operator who reads that
  // queues them again, or stops a runner believing nothing is pending on it.
  // Listed, never drained: asking what is queued must not consume the queue.
  const waiting = new Inbox(`${storePath.replace(/\.json$/u, "")}.inbox`).pending();
  if (waiting.length > 0) {
    note(`${String(waiting.length)} queued, not yet taken up by a runner:`);
    for (const item of waiting) {
      note(
        item.entry === undefined
          ? `  unreadable  ${item.id.slice(0, 8)}  (a file is here and could not be parsed)`
          : `  queued      ${item.id.slice(0, 8)}  ${describeIntent(item.entry.intent)}`,
      );
    }
    note("");
  }
  {
    const jobs = store.all();
    if (jobs.length === 0) {
      note(waiting.length === 0 ? "no jobs" : "no jobs in the store yet; the queued intents above are picked up on the runner's next pass");
      return;
    }
    for (const job of jobs) {
      note(
        `${job.state.padEnd(11)} ${job.id.slice(0, 8)}  ${describeIntent(job.intent).padEnd(30)} ` +
          `attempts=${String(job.attempts)}${job.digest === undefined ? "" : `  ${job.digest}`}` +
          `${job.error === undefined ? "" : `\n            ${job.error}`}`,
      );
      if (args.verbose === "true") {
        for (const event of job.events) {
          note(`              ${new Date(event.at).toISOString()}  ${event.state.padEnd(11)} ${event.note}`);
        }
      }
    }
  }
  await Promise.resolve();
});
