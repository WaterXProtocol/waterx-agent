/**
 * Find the accounts that have granted this wallet, and confirm each on chain.
 *
 * The step after an owner signs. It used to be a person copying an account id
 * and an owner address into `.env`; now the wallet asks. It never adopts: an
 * address can be made a delegate of anyone's account without its consent, so
 * finding a grant is not knowing which account to trade. That is a person's
 * call, made with `adopt --approver`.
 */
import { discoverGrants, type DiscoveryDeps } from "../../src/agent/discovery.ts";
import { accountObjectReader } from "../../src/chain/account-object.ts";
import { signerReadiness } from "../../src/chain/create-signer.ts";
import { loadDeployment } from "../../src/chain/deployment.ts";
import { grantEventCandidates } from "../../src/chain/grant-events.ts";
import { invoke, succeeded } from "../../src/cli/contract.ts";
import { asNumber, initAgent, note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";

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
  const deployment = await loadDeployment(agent.config.configUrl);
  // The ORIGINAL package id names event types; `idsFor` lists it last.
  const accountPackage = deployment.idsFor("waterx_account").at(-1);
  const deps: DiscoveryDeps = {
    delegatedAccounts: (delegate) => agent.read.delegatedAccounts(delegate),
    recentGrantEvents:
      accountPackage === undefined
        ? () => Promise.reject(new Error("the deployment config names no waterx_account package"))
        : grantEventCandidates(agent.config.network, accountPackage),
    readAccount: accountObjectReader(agent.config),
  };

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

  const adoptCommand = (accountId: string): string =>
    invoke("adopt", "--account", accountId, "--approver <who>", "--json");
  const configured = agent.config.accountId?.toLowerCase();

  note("");
  note(`  wallet        ${me}`);
  note(`  looked in     ${result.source === "backend" ? "the backend's delegate index" : "recent on-chain grant events"}${result.fallbackReason === undefined ? "" : ` (backend: ${result.fallbackReason})`}`);
  for (const grant of result.grants) {
    note(`  granted by    ${grant.accountId}`);
    note(`    owner       ${grant.ownerAddress}`);
    note(`    expires     ${grant.expiresAtMs === null ? "never" : new Date(grant.expiresAtMs).toISOString()}`);
  }
  for (const id of result.unverified) note(`  unreadable    ${id}  (could not confirm either way)`);
  if (result.truncated) note("  truncated     more candidates exist than one look reads");
  note("");

  show({
    delegate: me,
    source: result.source,
    ...(result.fallbackReason === undefined ? {} : { fallbackReason: result.fallbackReason }),
    grants: result.grants.map((g) => ({ ...g, adoptCommand: adoptCommand(g.accountId) })),
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

  // Found. Never adopted here: a grant needs no consent from this wallet, so
  // "an account grants me" is not "the account I am meant to trade".
  const [only] = result.grants;
  setOutcome(
    result.grants.length === 1 && only !== undefined
      ? {
          ...quiet,
          status: "needs-approval",
          message: `${only.accountId}, owned by ${only.ownerAddress}, grants this wallet. A person must confirm this is the account to trade — anyone can grant an address without its consent — and adopt it under their own name.`,
          retryable: false,
          awaitingApproval: true,
          nextCommand: adoptCommand(only.accountId),
        }
      : {
          ...quiet,
          status: "needs-approval",
          message: `${String(result.grants.length)} accounts grant this wallet. A person must choose which one it trades; do not pick one. Each grant lists its own adopt command.`,
          retryable: false,
          awaitingApproval: true,
        },
  );
});
