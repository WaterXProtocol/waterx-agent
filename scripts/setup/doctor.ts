/**
 * Preflight: is this agent pointed at a live, matching deployment? Signs
 * nothing, and needs no key — a fresh clone can run it before anything else.
 *
 * The exit code separates two failures a caller has to treat differently. A
 * deployment that cannot be read at all is `unavailable` and worth retrying; a
 * check that failed is `config` and will keep failing until someone changes
 * something. Reporting both as "1" told an agent to retry a stale account id
 * forever.
 */
import { runDoctor } from "../../src/doctor.ts";
import { note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";
import { succeeded } from "../../src/cli/contract.ts";

const ICON = { ok: "✓", warn: "!", fail: "✗" } as const;

parseArgs({}, "doctor");

await run(async () => {
  const report = await runDoctor();
  note("");
  for (const check of report.checks) {
    note(`  ${ICON[check.status]}  ${check.name.padEnd(18)} ${check.detail}`);
  }
  note("");

  show({
    healthy: report.healthy,
    readReady: report.readReady,
    writeReady: report.writeReady,
    signerReady: report.signerReady,
    network: report.config.network,
    apiUrl: report.config.apiUrl,
    executionPolicy: report.config.executionPolicy,
    accountId: report.config.accountId ?? null,
    checks: report.checks,
  }, { rendered: true });

  if (report.healthy) {
    note("Preflight passed.");
    setOutcome(
      succeeded(
        `preflight passed — reads ${report.readReady ? "ready" : "unavailable"}, ` +
          `writes ${report.writeReady ? "ready" : "not ready"}`,
      ),
    );
    return;
  }

  const failures = report.checks.filter((c) => c.status === "fail");
  note("Preflight failed — resolve the ✗ items before trading.");
  setOutcome({
    // Unreadable deployment first: it is the one failure that is nobody's
    // configuration and may simply be over in a minute.
    status: report.readReady ? "config" : "unavailable",
    message: `preflight failed: ${failures.map((c) => c.name).join(", ")}`,
    submitted: false,
    retryable: !report.readReady,
    reconcileRequired: false,
    awaitingApproval: false,
    details: { failures },
  });
});
