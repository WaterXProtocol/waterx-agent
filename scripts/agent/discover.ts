/**
 * Find the accounts that have granted this wallet, and confirm each on chain.
 *
 * The step after an owner signs. It used to be a person copying an account id
 * and an owner address into `.env`; now the wallet asks. It never adopts. An
 * address can be made a delegate of anyone's account without its consent, so
 * finding a grant is not knowing which account to trade — unless the grant
 * carries this agent's pairing code, which only a grant made through this
 * agent's link can. Such a grant needs nobody to vouch for it; any other is a
 * person's call, made with `adopt --approver`.
 */
import { grantEvidence, UNPAIRED_REASON } from "../../src/agent/adoption.ts";
import { discoverGrants } from "../../src/agent/discovery.ts";
import { loadPairing } from "../../src/agent/pairing.ts";
import { signerReadiness } from "../../src/chain/create-signer.ts";
import { invoke, succeeded } from "../../src/cli/contract.ts";
import { asNumber, initAgent, note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";
import { discoveryDeps } from "../lib/discovery.ts";

const args = parseArgs(
  {
    wait: { desc: "Keep looking for up to this many seconds (default: look once)" },
    interval: { desc: "Seconds between looks while waiting (default 10)" },
  },
  "discover",
);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const quiet = { submitted: false, reconcileRequired: false } as const;

await run(async () => {
  const agent = initAgent();
  if (!signerReadiness(agent.config).ready) {
    setOutcome({
      ...quiet,
      status: "config",
      message: "No agent wallet yet, so nothing can have been granted to it. `bootstrap` makes one; it signs nothing.",
      retryable: false,
      awaitingApproval: false,
      nextCommand: invoke("bootstrap", "--json"),
    });
    return;
  }

  const me = agent.signer.address;
  const deps = await discoveryDeps(agent);

  const waitMs = Math.max(0, asNumber(args.wait) ?? 0) * 1000;
  const intervalMs = Math.max(2, asNumber(args.interval) ?? 10) * 1000;
  const deadline = Date.now() + waitMs;

  // Both sources can fail at once — the backend without the endpoint or down,
  // and the public GraphQL endpoint refusing. That is an outage to report with
  // its cause, not a crash, and not "nothing granted": the grant may exist.
  let failure: string | undefined;
  const look = async () => {
    try {
      failure = undefined;
      return await discoverGrants(me, deps);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  };

  let result = await look();
  // Wait only for "nothing yet". An unreadable candidate or a grant found is
  // an answer to report now, not a reason to keep polling.
  while (
    result !== undefined &&
    result.grants.length === 0 &&
    result.unverified.length === 0 &&
    Date.now() + intervalMs <= deadline
  ) {
    await sleep(intervalMs);
    result = await look();
  }

  if (result === undefined) {
    show({ delegate: me, error: failure ?? "unknown" }, { rendered: true });
    setOutcome({
      ...quiet,
      status: "unavailable",
      message:
        `Could not look for grants — neither the backend nor recent chain events could be read ` +
        `(${failure ?? "unknown"}). Whether this wallet is granted is unknown; try again.`,
      retryable: true,
      awaitingApproval: false,
      nextCommand: invoke("discover", "--json"),
    });
    return;
  }

  // What each grant proves. One carrying this agent's pairing code was made
  // through the link this agent issued; any other could be anyone's. And only a
  // LONE paired grant is proof: the code is public once a grant has used it, so
  // a second grant carrying it is a copy.
  const pairing = loadPairing(me, agent.config.network);
  const judged = result.grants.map((grant) => ({ grant, evidence: grantEvidence(grant.alias, pairing) }));
  const pairedCount = judged.filter((j) => j.evidence.paired).length;
  const provesItself = (j: (typeof judged)[number]): boolean => j.evidence.paired && pairedCount === 1;
  const adoptCommand = (j: (typeof judged)[number]): string =>
    provesItself(j)
      ? invoke("adopt", "--account", j.grant.accountId, "--json")
      : invoke("adopt", "--account", j.grant.accountId, '--approver "<their name>"', "--json");
  const configured = agent.config.accountId?.toLowerCase();

  note("");
  note(`  wallet        ${me}`);
  note(`  looked in     ${result.source === "backend" ? "the backend's delegate index" : "recent on-chain grant events"}${result.fallbackReason === undefined ? "" : ` (backend: ${result.fallbackReason})`}`);
  note(`  pairing code  ${pairing?.alias ?? "none issued from this directory — `onboard` issues one"}`);
  for (const j of judged) {
    note(`  granted by    ${j.grant.accountId}`);
    note(`    owner       ${j.grant.ownerAddress}`);
    note(`    expires     ${j.grant.expiresAtMs === null ? "never" : new Date(j.grant.expiresAtMs).toISOString()}`);
    note(
      `    pairing     ${
        j.evidence.paired
          ? `carries this agent's code${pairedCount > 1 ? " — and so does another grant, so one is a copy" : ""}`
          : UNPAIRED_REASON[j.evidence.why]
      }`,
    );
  }
  for (const id of result.unverified) note(`  unreadable    ${id}  (could not confirm either way)`);
  if (result.truncated) note("  truncated     more candidates exist than one look reads");
  note("");

  show({
    delegate: me,
    source: result.source,
    ...(result.fallbackReason === undefined ? {} : { fallbackReason: result.fallbackReason }),
    pairingCode: pairing?.alias ?? null,
    grants: judged.map((j) => ({
      ...j.grant,
      paired: j.evidence.paired,
      ...(j.evidence.paired ? {} : { unpaired: j.evidence.why }),
      adoptCommand: adoptCommand(j),
    })),
    unverified: result.unverified,
    truncated: result.truncated,
  }, { rendered: true });

  if (configured !== undefined && result.grants.some((g) => g.accountId === configured)) {
    setOutcome(succeeded(`Already adopted: ${configured} grants this wallet and WATERX_ACCOUNT_ID names it.`, {
      nextCommand: invoke("next", "--json"),
    }));
    return;
  }

  if (result.grants.length === 0) {
    setOutcome(
      result.unverified.length > 0
        ? {
            ...quiet,
            status: "unavailable",
            message: `${String(result.unverified.length)} candidate account(s) could not be read from chain, so whether this wallet is granted is unknown. Try again.`,
            retryable: true,
            awaitingApproval: false,
            nextCommand: invoke("discover", "--json"),
          }
        : {
            ...quiet,
            status: "config",
            message: `No account grants ${me} yet. Hand the owner the link \`onboard\` prints; once they sign, this finds it.`,
            retryable: true,
            awaitingApproval: false,
            nextCommand: invoke("discover", "--wait", "300", "--json"),
          },
    );
    return;
  }

  const lone = judged.find(provesItself);
  if (lone !== undefined) {
    setOutcome(
      succeeded(
        `${lone.grant.accountId}, owned by ${lone.grant.ownerAddress}, carries this agent's pairing ` +
          `code (${lone.grant.alias}), so it was granted through the link this agent issued. Adopt ` +
          `it — nobody has to vouch for it.`,
        { nextCommand: adoptCommand(lone) },
      ),
    );
    return;
  }

  // Found, and not provable. Never adopted here: a grant needs no consent from
  // this wallet, so "an account grants me" is not "the account I am meant to trade".
  const [only] = judged;
  setOutcome(
    pairedCount > 1
      ? {
          ...quiet,
          status: "needs-approval",
          message: `${String(pairedCount)} grants carry this agent's pairing code. The code is public once a grant has used it, so all but one are copies. A person must choose — comparing each owner address in full with the wallet that signed — and adopt it under their own name; do not pick one.`,
          retryable: false,
          awaitingApproval: true,
        }
      : judged.length === 1 && only !== undefined && !only.evidence.paired
        ? {
            ...quiet,
            status: "needs-approval",
            message: `${only.grant.accountId}, owned by ${only.grant.ownerAddress}, grants this wallet but ${UNPAIRED_REASON[only.evidence.why]} Anyone can grant an address without its consent, so a person must confirm this is the account to trade — comparing the owner address in full with the wallet that signed — and adopt it under their own name.`,
            retryable: false,
            awaitingApproval: true,
            nextCommand: adoptCommand(only),
          }
        : {
            ...quiet,
            status: "needs-approval",
            message: `${String(judged.length)} accounts grant this wallet and none proves it was granted through this agent's link. A person must choose which one it trades; do not pick one. Each grant lists its own adopt command.`,
            retryable: false,
            awaitingApproval: true,
          },
  );
});
