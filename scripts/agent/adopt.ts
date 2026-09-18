/**
 * Adopt the account this agent trades, after checking the grant on chain.
 *
 * Writes WATERX_ACCOUNT_ID and nothing else: the owner is a field on the
 * account, read at run time, not a second value to keep in step. It does not
 * stop to ask for a name. `--approver` puts one on the record when someone
 * wants it there; without it the record gets a generated id, marked as
 * generated, so the ledger still tells adoptions apart and never claims a
 * sign-off that did not happen.
 */
import { adoptAccount, NotAGrantError, OwnerMismatchError } from "../../src/agent/adopt.ts";
import { exposureLine, exposureWarnings, summarise } from "../../src/agent/exposure.ts";
import { AccountNotFoundError, accountObjectReader } from "../../src/chain/account-object.ts";
import { signerReadiness } from "../../src/chain/create-signer.ts";
import { invoke, succeeded } from "../../src/cli/contract.ts";
import { demand, initAgent, note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";

const args = parseArgs(
  {
    account: { desc: "The account id `discover` reported", required: true },
    approver: {
      desc: "A name to put on the record. Optional: without one, a generated id is recorded and marked as generated",
    },
  },
  "adopt",
);

const quiet = { submitted: false, reconcileRequired: false, awaitingApproval: false } as const;
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
      nextCommand: invoke("bootstrap", "--json"),
    });
    return;
  }
  const me = agent.signer.address;

  // Verified on chain and written down in one place, because `onboard --wait`
  // adopts too and the order of those writes matters: the `.gitignore` rule
  // goes in before the ledger line that says which account this agent trades.
  let adopted;
  try {
    adopted = await adoptAccount({
      accountId,
      delegate: me,
      network: agent.config.network,
      readAccount: accountObjectReader(agent.config),
      ...(agent.config.ownerAddress === undefined
        ? {}
        : { configuredOwner: agent.config.ownerAddress }),
      ...(args.approver === undefined ? {} : { approver: args.approver }),
    });
  } catch (error) {
    if (error instanceof NotAGrantError) {
      setOutcome({ ...quiet, status: "auth", message: error.message, retryable: false, nextCommand: invoke("onboard", "--json") });
      return;
    }
    if (error instanceof AccountNotFoundError) {
      setOutcome({ ...quiet, status: "usage", message: error.message, retryable: false, nextCommand: invoke("discover", "--json") });
      return;
    }
    // A leftover owner that disagrees with the chain would make every write
    // claim the wrong principal. Refuse rather than write a contradiction.
    if (error instanceof OwnerMismatchError) {
      setOutcome({ ...quiet, status: "config", message: error.message, retryable: false });
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

  const recordedAs = `${adopted.by}${adopted.generated ? " (generated — no approver was given)" : ""}`;
  note("");
  note(`  adopted       ${adopted.accountId}`);
  note(`  owner         ${adopted.ownerAddress}  (read from chain)`);
  note(`  recorded as   ${recordedAs}`);
  note("  wrote         WATERX_ACCOUNT_ID — the owner is read from the account, not stored");

  // What was just taken on. This is the moment of maximum ignorance -- an
  // account id, and no idea whether it holds nothing or ten leveraged
  // positions -- and the reads that answer it are two lines away.
  let exposure;
  try {
    const overview: unknown = await agent.read.overview(adopted.accountId);
    const open = await agent.read.positions(adopted.accountId);
    const resting = await agent.read.orders({ account: adopted.accountId });
    exposure = summarise({ overview, positions: open, orders: resting.length });
    note(`  holding       ${exposureLine(exposure)}`);
    for (const warning of exposureWarnings(exposure)) note(`  !             ${warning}`);
  } catch {
    // A failed read does not undo an adoption that has already been written.
    note("  holding       could not be read just now — `next` will say");
  }
  note("");
  show(
    {
      ...adopted,
      chosenBy: adopted.by,
      ...(exposure === undefined ? {} : { exposure }),
      ...(adopted.gitignore.kind === "added" || adopted.gitignore.kind === "failed"
        ? { gitignore: adopted.gitignore }
        : {}),
    },
    { rendered: true },
  );
  setOutcome(
    succeeded(
      `This wallet now trades ${adopted.accountId}, owned by ${adopted.ownerAddress}. Recorded as ${recordedAs}.`,
      { nextCommand: invoke("next", "--json") },
    ),
  );
});
