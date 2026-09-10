/**
 * The long-running runner.
 *
 * Recovery happens at start-up, before the first new submission: any job left
 * ambiguous by the previous process is resolved against the chain first. That
 * ordering is the reason a restart is safe.
 *
 * Ctrl-C finishes the pass in flight and then stops. A pass abandoned halfway
 * would manufacture, on every clean shutdown, exactly the ambiguity the ledger
 * exists to recover from.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { HttpClient } from "../../src/api/http.ts";
import { ReadApi } from "../../src/api/read.ts";
import { Inbox } from "../../src/runner/inbox.ts";
import { Reconciler } from "../../src/runner/reconcile.ts";
import { Runner } from "../../src/runner/runner.ts";
import { JobStore } from "../../src/runner/store.ts";
import { asNumber, initAgent, parseArgs, run } from "../lib/cli.ts";

const args = parseArgs(
  {
    store: { desc: "Path to the job store", default: ".waterx/jobs.json" },
    interval: { desc: "Seconds between passes", default: "20" },
    once: { desc: "Run a single pass and exit", flag: true },
  },
  "runner",
);

await run(async () => {
  const storePath = args.store ?? ".waterx/jobs.json";
  mkdirSync(dirname(storePath), { recursive: true });

  const agent = initAgent();
  const store = new JobStore(storePath);
  store.open();

  try {
    const reconciler = new Reconciler(
      agent.config,
      new ReadApi(new HttpClient({ baseUrl: agent.config.apiUrl })),
    );
    const runner = new Runner({
      agent,
      store,
      reconciler,
      // Lets `queue` add work without the store's writer lock.
      inbox: new Inbox(`${storePath.replace(/\.json$/, "")}.inbox`),
    });
    runner.assertCanRunUnattended();

    const pending = runner.pending();
    console.log(
      `runner  account=${agent.accountId.slice(0, 10)}…  signer=${agent.executor.signerDescription}`,
    );
    console.log(`store   ${storePath}  (${String(pending.length)} unfinished)`);
    for (const job of pending) {
      console.log(`  recovered ${job.id.slice(0, 8)} in "${job.state}"`);
    }

    if (args.once === "true") {
      await runner.tick();
      return;
    }

    const intervalMs = (asNumber(args.interval, "interval") ?? 20) * 1000;
    let stopping = false;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        console.log(`\n${signal} — finishing the pass in flight, then stopping.`);
        stopping = true;
      });
    }

    while (!stopping) {
      await runner.tick();
      if (runner.pending().length === 0) console.log("idle    nothing left to drive");
      // Sleep in slices so a signal is honoured promptly without ever cutting
      // a pass short.
      for (let waited = 0; waited < intervalMs && !stopping; waited += 500) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    console.log(
      `stopped with ${String(runner.pending().length)} unfinished job(s); they resume on restart.`,
    );
  } finally {
    // Always release the lock — a runner that dies holding it needs a human,
    // and a clean exit must never impose that.
    store.close();
  }
});
