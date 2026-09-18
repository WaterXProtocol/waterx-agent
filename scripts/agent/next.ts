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
import { delegationStatus, perpGrantCommand } from "../../src/agent/delegation.ts";
import { decide, sentenceOf } from "../../src/agent/guidance.ts";
import { gasBalance, MIN_GAS_SUI } from "../../src/chain/gas.ts";
import { unsettled } from "../../src/agent/submissions.ts";
import { signsAsDelegate } from "../../src/config.ts";
import { runDoctor } from "../../src/doctor.ts";
import { invoke, succeeded } from "../../src/cli/contract.ts";
import { initAgent, note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";

parseArgs({}, "next");

await run(async () => {
  const agent = initAgent();
  const report = await runDoctor();
  const account = agent.config.accountId;

  // The owner is read from the account when it is not configured. Settle it
  // before asking whether this process is a delegate, or a wallet that only
  // has WATERX_ACCOUNT_ID would be described as the account's owner.
  if (report.readReady) {
    try {
      await agent.resolveIdentity();
    } catch {
      // An unreadable account is reported by the checks below; an owner is not guessed.
    }
  }

  // Gas, because an account cannot be created without it and "create the
  // account" is useless advice to a wallet that cannot pay for the transaction.
  const gas =
    report.signerReady && report.readReady
      ? await gasBalance(agent.config, agent.signer.address)
      : undefined;

  // Only when this process holds a delegate key: signing as the owner has no
  // handshake to be part-way through.
  //
  // `reviewUrl` and `authorizeUrl` are the two places an owner goes — to review,
  // and to grant — and they are different places. `grantUrl` rides along only
  // because a caller may already read it: it has always held the review page,
  // where perp permission cannot be granted, so nothing should be sent there to
  // grant.
  let delegation:
    | {
        state: string;
        headline: string;
        link?: string;
        detail?: string;
        reviewUrl: string;
        authorizeUrl?: string;
        grantUrl: string;
      }
    | undefined;
  if (report.signerReady && signsAsDelegate(agent.config, agent.signer.address)) {
    let delegates;
    try {
      delegates = account === undefined ? undefined : await agent.read.delegates(account);
    } catch {
      delegates = undefined;
    }
    const status = delegationStatus({
      network: agent.config.network,
      delegateAddress: agent.signer.address,
      grantCommand: perpGrantCommand({
        agentWallet: agent.signer.address,
        ...(account === undefined ? {} : { accountId: account }),
        invoke,
      }),
      ...(agent.config.ownerAddress === undefined ? {} : { ownerAddress: agent.config.ownerAddress }),
      ...(account === undefined ? {} : { accountId: account }),
      ...(delegates === undefined ? {} : { delegates }),
    });
    delegation = {
      state: status.state,
      headline: status.headline,
      ...(status.authorizeUrl === undefined ? {} : { link: status.authorizeUrl }),
      ...(status.detail === undefined ? {} : { detail: status.detail }),
      reviewUrl: status.reviewUrl,
      ...(status.authorizeUrl === undefined ? {} : { authorizeUrl: status.authorizeUrl }),
      grantUrl: status.grantUrl,
    };
  }

  const open = unsettled();
  const pending = listApprovals().filter((a) => a.state === "pending");

  let freeMargin: number | undefined;
  let positions = 0;
  let orders = 0;
  if (account !== undefined && report.readReady) {
    const overview = (await agent.read.overview(account)) as { freeMargin?: number };
    freeMargin = overview.freeMargin ?? 0;
    positions = (await agent.read.positions(account)).length;
    orders = (await agent.read.orders({ account })).length;
  }

  const { state, headline, detail, link, suggestions } = decide({
    open: open.length,
    firstUnsettled: open[0]?.submission.id,
    pending: pending.map((a) => ({ id: a.request.id, action: a.request.action })),
    // The policy is asked about separately, so "I chose not to write" does not
    // read as "you have not finished setting up".
    configured:
      report.signerReady &&
      agent.config.accountId !== undefined &&
      !report.checks.some((c) => c.status === "fail"),
    network: agent.config.network,
    // Both set and different is a delegate; an account with no owner named is
    // this wallet's own; neither is a decision nobody has made yet.
    mode:
      agent.config.ownerAddress !== undefined && delegation !== undefined
        ? "delegate"
        : account !== undefined
          ? "owner"
          : "undecided",
    ...(report.signerReady ? { address: agent.signer.address } : {}),
    ...(delegation === undefined ? {} : { delegation }),
    missing: {
      signer: !report.signerReady,
      // `undefined` is "could not ask", not "empty" — reporting a fullnode
      // wobble as an empty wallet would name the wrong blocker.
      gas: gas !== undefined && gas < MIN_GAS_SUI,
      account: agent.config.accountId === undefined,
    },
    readOnly: agent.config.executionPolicy === "read-only",
    freeMargin,
    positions,
    orders,
    blockers: report.checks.filter((c) => c.status === "fail").map((c) => c.name),
  });

  note("");
  // The sentence, then the link on a line of its own. Inside the paragraph it
  // wrapped across three lines of an 80-column terminal, which is where a URL
  // stops being clickable; the envelope's `headline` still carries it whole,
  // for an agent that relays one field and stops.
  note(`  ${sentenceOf({ headline, ...(link === undefined ? {} : { link }) })}`);
  if (link !== undefined) {
    note("");
    note(`  ${link}`);
  }
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
      ...(link === undefined ? {} : { link }),
      // In the envelope, not on the screen: this is the answer to "why?", asked
      // by a minority of callers, and it is what made the headline unreadable.
      ...(detail === undefined ? {} : { detail }),
      suggestions,
      network: agent.config.network,
    // Both set and different is a delegate; an account with no owner named is
    // this wallet's own; neither is a decision nobody has made yet.
    mode:
      agent.config.ownerAddress !== undefined && delegation !== undefined
        ? "delegate"
        : account !== undefined
          ? "owner"
          : "undecided",
      account: account ?? null,
      freeMargin: freeMargin ?? null,
      gasSui: gas ?? null,
      exposure: { positions, orders },
      ...(delegation === undefined ? {} : { delegation }),
      unsettledSubmissions: open.length,
      pendingApprovals: pending.length,
      readReady: report.readReady,
      writeReady: report.writeReady,
    },
    { rendered: true },
  );

  setOutcome(succeeded(headline));
});
