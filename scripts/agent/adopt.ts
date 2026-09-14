/**
 * A person chooses the account this agent trades, by name, after checking it on chain.
 *
 * Writes WATERX_ACCOUNT_ID and nothing else: the owner is a field on the
 * account, read at run time, not a second value to keep in step. Records who
 * chose, because choosing an account is choosing whose money is traded.
 */
import { normalizeSuiAddress } from "@mysten/sui/utils";

import { recordAdoption } from "../../src/agent/adoptions.ts";
import { NotAGrantError, verifyAdoptable } from "../../src/agent/adopt.ts";
import { AccountNotFoundError, accountObjectReader } from "../../src/chain/account-object.ts";
import { signerReadiness } from "../../src/chain/create-signer.ts";
import { saveToEnv } from "../../src/chain/wallet.ts";
import { invoke, succeeded } from "../../src/cli/contract.ts";
import { demand, initAgent, note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";

const args = parseArgs(
  {
    account: { desc: "The account id `discover` reported", required: true },
    approver: { desc: "Who is choosing this account. Recorded; required.", required: true },
  },
  "adopt",
);

const quiet = { submitted: false, reconcileRequired: false, awaitingApproval: false } as const;
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

await run(async () => {
  const accountId = demand(args.account, "--account", "which account this agent should trade");
  const by = demand(args.approver, "--approver", "who is choosing the account this agent trades");
  const agent = initAgent();

  if (!signerReadiness(agent.config).ready) {
    setOutcome({
      ...quiet,
      status: "config",
      message: "No agent wallet yet. `bootstrap` makes one; it signs nothing.",
      retryable: false,
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
      setOutcome({ ...quiet, status: "auth", message: error.message, retryable: false, nextCommand: invoke("onboard", "--json") });
      return;
    }
    if (error instanceof AccountNotFoundError) {
      setOutcome({ ...quiet, status: "usage", message: error.message, retryable: false, nextCommand: invoke("discover", "--json") });
      return;
    }
    setOutcome({
      ...quiet,
      status: "unavailable",
      message: `Could not read ${accountId} from chain, so the grant is unconfirmed and nothing was written: ${describe(error)}`,
      retryable: true,
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
    });
    return;
  }

  saveToEnv("WATERX_ACCOUNT_ID", adoptable.accountId);
  recordAdoption({
    accountId: adoptable.accountId,
    ownerAddress: adoptable.ownerAddress,
    delegate: me,
    network: agent.config.network,
    by,
  });

  note("");
  note(`  adopted       ${adoptable.accountId}`);
  note(`  owner         ${adoptable.ownerAddress}  (read from chain)`);
  note(`  chosen by     ${by}  (recorded)`);
  note("  wrote         WATERX_ACCOUNT_ID — the owner is read from the account, not stored");
  note("");
  show({ ...adoptable, delegate: me, chosenBy: by }, { rendered: true });
  setOutcome(
    succeeded(`This wallet now trades ${adoptable.accountId}, owned by ${adoptable.ownerAddress}. Chosen by ${by}.`, {
      nextCommand: invoke("next", "--json"),
    }),
  );
});
