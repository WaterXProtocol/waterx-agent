/**
 * Choose the account this agent trades — on evidence, after checking it on chain.
 *
 * Writes WATERX_ACCOUNT_ID and nothing else: the owner is a field on the
 * account, read at run time, not a second value to keep in step. And it records
 * what the choice rested on. When the owner's grant carries this agent's pairing
 * code, and no other grant does, the chain has already said whose it is, so
 * nobody is asked. Otherwise a person decides with `--approver`, and the record
 * calls their name what it is: an attestation, which nothing verifies.
 */
import { normalizeSuiAddress } from "@mysten/sui/utils";

import { decideAdoption, grantEvidence } from "../../src/agent/adoption.ts";
import { recordAdoption } from "../../src/agent/adoptions.ts";
import { NotAGrantError, verifyAdoptable } from "../../src/agent/adopt.ts";
import { discoverGrants } from "../../src/agent/discovery.ts";
import { loadPairing } from "../../src/agent/pairing.ts";
import { AccountNotFoundError, accountObjectReader } from "../../src/chain/account-object.ts";
import { signerReadiness } from "../../src/chain/create-signer.ts";
import { ensureEnvIgnored } from "../../src/chain/secrets.ts";
import { saveToEnv } from "../../src/chain/wallet.ts";
import { invoke, succeeded } from "../../src/cli/contract.ts";
import { demand, initAgent, note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";
import { discoveryDeps } from "../lib/discovery.ts";

const args = parseArgs(
  {
    account: { desc: "The account id `discover` reported", required: true },
    approver: {
      desc:
        "Only when the grant does not carry this agent's pairing code: the name of the person " +
        "confirming this account. Recorded as their attestation, so it must come from them",
    },
  },
  "adopt",
);

const quiet = { submitted: false, reconcileRequired: false } as const;
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

await run(async () => {
  const accountId = demand(args.account, "--account", "which account this agent should trade");
  const agent = initAgent();

  if (!signerReadiness(agent.config).ready) {
    setOutcome({
      ...quiet,
      status: "config",
      message: "No agent wallet yet. `bootstrap` makes one; it signs nothing.",
      retryable: false,
      awaitingApproval: false,
      nextCommand: invoke("bootstrap", "--json"),
    });
    return;
  }
  const me = agent.signer.address;

  let adoptable;
  try {
    adoptable = await verifyAdoptable({ accountId, delegate: me, readAccount: accountObjectReader(agent.config) });
  } catch (error) {
    if (error instanceof NotAGrantError) {
      setOutcome({ ...quiet, status: "auth", message: error.message, retryable: false, awaitingApproval: false, nextCommand: invoke("onboard", "--json") });
      return;
    }
    if (error instanceof AccountNotFoundError) {
      setOutcome({ ...quiet, status: "usage", message: error.message, retryable: false, awaitingApproval: false, nextCommand: invoke("discover", "--json") });
      return;
    }
    setOutcome({
      ...quiet,
      status: "unavailable",
      message: `Could not read ${accountId} from chain, so the grant is unconfirmed and nothing was written: ${describe(error)}`,
      retryable: true,
      awaitingApproval: false,
    });
    return;
  }

  // A leftover owner that disagrees with the chain would make every write
  // claim the wrong principal. Refuse rather than write a contradiction.
  const configuredOwner = agent.config.ownerAddress;
  if (configuredOwner !== undefined && normalizeSuiAddress(configuredOwner) !== adoptable.ownerAddress) {
    setOutcome({
      ...quiet,
      status: "config",
      message:
        `WATERX_OWNER_ADDRESS is ${configuredOwner}, but ${adoptable.accountId} is owned by ` +
        `${adoptable.ownerAddress} on chain. Remove WATERX_OWNER_ADDRESS from .env — the owner is ` +
        `read from the account — then adopt again.`,
      retryable: false,
      awaitingApproval: false,
    });
    return;
  }

  const pairing = loadPairing(me, agent.config.network);
  const evidence = grantEvidence(adoptable.alias, pairing);

  // Counted only when this grant is paired, because only then does the count
  // decide anything: one grant carrying the code is proof, two means it was
  // copied. Anything short of a complete count — an unreadable candidate, a
  // truncated list, an index that has not caught up with this very grant — is
  // left uncounted, and uncounted is not proof.
  let pairedGrants: number | undefined;
  if (evidence.paired) {
    try {
      const found = await discoverGrants(me, await discoveryDeps(agent));
      const complete =
        found.unverified.length === 0 &&
        !found.truncated &&
        found.grants.some((grant) => grant.accountId === adoptable.accountId);
      pairedGrants = complete
        ? found.grants.filter((grant) => grant.alias === evidence.alias).length
        : undefined;
    } catch {
      pairedGrants = undefined;
    }
  }

  const decision = decideAdoption({
    accountId: adoptable.accountId,
    ownerAddress: adoptable.ownerAddress,
    grantAlias: adoptable.alias,
    pairing,
    pairedGrants,
    approver: args.approver,
  });

  if (!decision.adopt) {
    show(
      {
        ...adoptable,
        delegate: me,
        pairingCode: pairing?.alias ?? null,
        paired: evidence.paired,
        ...(pairedGrants === undefined ? {} : { pairedGrants }),
      },
      { rendered: true },
    );
    note("");
    note(`  ${decision.message}`);
    note("");
    setOutcome({
      ...quiet,
      status: "needs-approval",
      message: decision.message,
      retryable: false,
      awaitingApproval: true,
      nextCommand: invoke("adopt", "--account", adoptable.accountId, '--approver "<their name>"', "--json"),
    });
    return;
  }

  // Before the ledger is written: `.waterx/` records who adopted what, and a
  // project that ignored only `.env` would otherwise commit it.
  const ignored = ensureEnvIgnored();
  saveToEnv("WATERX_ACCOUNT_ID", adoptable.accountId);
  recordAdoption({
    accountId: adoptable.accountId,
    ownerAddress: adoptable.ownerAddress,
    delegate: me,
    network: agent.config.network,
    evidence: decision.evidence,
    ...(decision.evidence === "pairing" ? { alias: decision.alias } : {}),
    ...(decision.attestedBy === undefined ? {} : { attestedBy: decision.attestedBy }),
  });

  const basis =
    decision.evidence === "pairing"
      ? `the owner's grant carries this agent's pairing code (${decision.alias}), and no other grant does`
      : `${decision.attestedBy}'s attestation — recorded, not verified`;
  note("");
  note(`  adopted       ${adoptable.accountId}`);
  note(`  owner         ${adoptable.ownerAddress}  (read from chain)`);
  note(`  on            ${basis}`);
  note("  wrote         WATERX_ACCOUNT_ID — the owner is read from the account, not stored");
  note("");
  show(
    {
      ...adoptable,
      delegate: me,
      evidence: decision.evidence,
      ...(decision.attestedBy === undefined ? {} : { attestedBy: decision.attestedBy }),
      ...(ignored.kind === "added" || ignored.kind === "failed" ? { gitignore: ignored } : {}),
    },
    { rendered: true },
  );
  setOutcome(
    succeeded(
      `This wallet now trades ${adoptable.accountId}, owned by ${adoptable.ownerAddress}, on ${basis}.`,
      { nextCommand: invoke("next", "--json") },
    ),
  );
});
