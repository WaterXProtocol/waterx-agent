/**
 * Find the accounts that have granted this wallet, and confirm each on chain.
 *
 * The step after an owner signs. It used to be a person copying an account id
 * and an owner address into `.env`; now the wallet asks. It never adopts — that
 * is `adopt`, which re-checks the grant before writing anything. One grant found
 * is handed straight to it. More than one is a choice between accounts, and a
 * choice of whose money to trade is not something to guess, so that one is asked.
 */
import { completeHandshakeCommand } from "../../src/agent/delegation.ts";
import {
  awaitGrants,
  DEFAULT_POLL_SECONDS,
  type DiscoveryDeps,
  MIN_POLL_SECONDS,
} from "../../src/agent/discovery.ts";
import { accountObjectReader } from "../../src/chain/account-object.ts";
import { signerReadiness } from "../../src/chain/create-signer.ts";
import { loadDeployment } from "../../src/chain/deployment.ts";
import { grantEventCandidates } from "../../src/chain/grant-events.ts";
import { invoke, succeeded } from "../../src/cli/contract.ts";
import { asNumber, initAgent, note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";

const args = parseArgs(
  {
    wait: { desc: "Keep looking for up to this many seconds (default: look once)" },
    interval: { desc: `Seconds between looks while waiting (default ${String(DEFAULT_POLL_SECONDS)})` },
  },
  "discover",
);

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
  const intervalMs = Math.max(MIN_POLL_SECONDS, asNumber(args.interval) ?? DEFAULT_POLL_SECONDS) * 1000;

  // The loop lives in `src/agent/discovery.ts`: `onboard --wait` runs the same
  // one, and what counts as an answer — a grant, or a candidate that could not
  // be read — is a rule, not a detail of this script.
  const attempt = await awaitGrants(me, deps, { waitMs, intervalMs });
  const result = attempt.discovery;
  const failure = attempt.failure;

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
    invoke("adopt", "--account", accountId, "--json");
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
            message:
              `No account grants ${me} yet. Hand the owner the link \`onboard\` prints; ` +
              `\`onboard --wait\` hands it over, waits for the grant, and adopts the account ` +
              `that made it.`,
            retryable: true,
            awaitingApproval: false,
            nextCommand: completeHandshakeCommand(),
          },
    );
    return;
  }

  // Found. Never adopted here: `adopt` re-checks the grant and writes it down.
  // One grant goes straight on; between several, which account to trade is a
  // choice, and guessing it would be choosing whose money to trade at random.
  const [only] = result.grants;
  setOutcome(
    result.grants.length === 1 && only !== undefined
      ? succeeded(`${only.accountId}, owned by ${only.ownerAddress}, grants this wallet. Adopt it.`, {
          nextCommand: adoptCommand(only.accountId),
        })
      : {
          ...quiet,
          status: "needs-approval",
          message: `${String(result.grants.length)} accounts grant this wallet. Which one it trades is a choice, not a guess: ask which, then run that grant's adopt command.`,
          retryable: false,
          awaitingApproval: true,
        },
  );
});
