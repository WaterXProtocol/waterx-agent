/** What the runner believes, and why. Read-only. */
import { JobStore } from "../../src/runner/store.ts";
import { describeIntent } from "../../src/runner/runner.ts";
import { parseArgs, run } from "../lib/cli.ts";

const args = parseArgs(
  {
    store: { desc: "Path to the job store", default: ".waterx/jobs.json" },
    verbose: { desc: "Show each job's event trail", flag: true },
  },
  "runner-jobs",
);

await run(async () => {
  const store = new JobStore(args.store ?? ".waterx/jobs.json");
  // Read-only: inspecting a runner must never block on it, or block it.
  store.openReadOnly();
  {
    const jobs = store.all();
    if (jobs.length === 0) {
      console.log("no jobs");
      return;
    }
    for (const job of jobs) {
      console.log(
        `${job.state.padEnd(11)} ${job.id.slice(0, 8)}  ${describeIntent(job.intent).padEnd(30)} ` +
          `attempts=${String(job.attempts)}${job.digest === undefined ? "" : `  ${job.digest}`}` +
          `${job.error === undefined ? "" : `\n            ${job.error}`}`,
      );
      if (args.verbose === "true") {
        for (const event of job.events) {
          console.log(`              ${new Date(event.at).toISOString()}  ${event.state.padEnd(11)} ${event.note}`);
        }
      }
    }
  }
  await Promise.resolve();
});
