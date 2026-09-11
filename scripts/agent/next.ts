/**
 * "Where am I, and what should I offer the user?" — in one read.
 *
 * This gathers the situation and renders it. The decision — which state applies
 * and in what order — is `src/agent/guidance.ts`, because the order is a safety
 * property: offering a trade to someone with an unsettled submission is how the
 * same position gets opened twice, and that must be tested rather than trusted
 * to a script.
 *
 * Read-only, and it works in every degraded state: no key, no account, no
 * collateral. Those are not errors here, they are answers.
 */
import { list as listApprovals } from "../../src/agent/approvals.ts";
import { decide } from "../../src/agent/guidance.ts";
import { unsettled } from "../../src/agent/submissions.ts";
import { runDoctor } from "../../src/doctor.ts";
import { succeeded } from "../../src/cli/contract.ts";
import { initAgent, note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";

parseArgs({}, "next");

await run(async () => {
  const agent = initAgent();
  const report = await runDoctor();

  const open = unsettled();
  const pending = listApprovals().filter((a) => a.state === "pending");

  const account = agent.config.accountId;
  let freeMargin: number | undefined;
  let positions = 0;
  let orders = 0;
  if (account !== undefined && report.readReady) {
    const overview = (await agent.read.overview(account)) as { freeMargin?: number };
    freeMargin = overview.freeMargin ?? 0;
    positions = (await agent.read.positions(account)).length;
    orders = (await agent.read.orders({ account })).length;
  }

  const { state, headline, suggestions } = decide({
    open: open.length,
    firstUnsettled: open[0]?.submission.id,
    pending: pending.map((a) => ({ id: a.request.id, action: a.request.action })),
    // The policy is asked about separately, so "I chose not to write" does not
    // read as "you have not finished setting up".
    configured:
      report.signerReady &&
      agent.config.accountId !== undefined &&
      !report.checks.some((c) => c.status === "fail"),
    readOnly: agent.config.executionPolicy === "read-only",
    freeMargin,
    positions,
    orders,
    blockers: report.checks.filter((c) => c.status === "fail").map((c) => c.name),
  });

  note("");
  note(`  ${headline}`);
  note("");
  for (const s of suggestions) {
    note(`    • ${s.what}`);
    note(`      ${s.command}`);
    if (s.needsFromUser !== undefined) {
      note(`      ask the user for: ${s.needsFromUser.join(", ")}`);
    }
  }
  note("");

  show(
    {
      state,
      headline,
      suggestions,
      network: agent.config.network,
      account: account ?? null,
      freeMargin: freeMargin ?? null,
      exposure: { positions, orders },
      unsettledSubmissions: open.length,
      pendingApprovals: pending.length,
      readReady: report.readReady,
      writeReady: report.writeReady,
    },
    { rendered: true },
  );

  setOutcome(succeeded(headline));
});
