/**
 * The delegate handshake, from either side of it.
 *
 * An agent that trades an account it does not own needs one thing from a
 * person: a grant, made on chain from the wallet that owns the account. This
 * command says where that has got to and what the next move is — for the agent
 * ("give this address to the owner") and for the owner ("grant it here").
 *
 * It reads; it never grants. The grant is the owner's act, made from their own
 * wallet, and an agent that could make it for them would be an agent that could
 * grant itself authority.
 */
import {
  delegationStatus,
  perpGrantCommand,
  REQUESTED_PERMISSION_NAMES,
  REQUESTED_PERP_PERMISSIONS,
} from "../../src/agent/delegation.ts";
import { signerReadiness } from "../../src/chain/create-signer.ts";
import { invoke, succeeded } from "../../src/cli/contract.ts";
import type { DelegateData } from "../../src/api/types.ts";
import { initAgent, note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";

const args = parseArgs(
  {
    label: {
      desc: "A name for this agent, shown to the owner on the authorization screen",
    },
  },
  "onboard",
);

await run(async () => {
  const agent = initAgent();
  const ready = signerReadiness(agent.config);

  // The address only when a key exists. Asking for it otherwise would load one
  // that is not there and fail with a message about wallets.
  const delegateAddress = ready.ready ? agent.signer.address : undefined;
  const ownerAddress = agent.config.ownerAddress;
  const accountId = agent.config.accountId;

  // Only asked for when there is something to ask about; a failed lookup is
  // reported as unconfirmed rather than as an absent grant.
  let delegates: DelegateData[] | undefined;
  if (accountId !== undefined && delegateAddress !== undefined && ownerAddress !== undefined) {
    try {
      delegates = await agent.read.delegates(accountId);
    } catch {
      delegates = undefined;
    }
  }

  const status = delegationStatus({
    network: agent.config.network,
    ...(args.label === undefined ? {} : { label: args.label }),
    ...(delegateAddress === undefined
      ? {}
      : {
          grantCommand: perpGrantCommand({
            agentWallet: delegateAddress,
            ...(accountId === undefined ? {} : { accountId }),
            invoke,
          }),
        }),
    ...(delegateAddress === undefined ? {} : { delegateAddress }),
    ...(ownerAddress === undefined ? {} : { ownerAddress }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(delegates === undefined ? {} : { delegates }),
  });

  note("");
  note(`  ${status.headline}`);
  note("");
  if (status.delegateAddress !== undefined) {
    note(`  agent wallet   ${status.delegateAddress}`);
  }
  if (status.ownerAddress !== undefined) note(`  owner          ${status.ownerAddress}`);
  if (status.accountId !== undefined) note(`  account        ${status.accountId}`);
  note(`  the owner runs ${status.grantCommand ?? "(needs a wallet first)"}`);
  note(`                 with THEIR OWN key, and WATERX_ACCOUNT_ID set to their account`);
  note(`  review/revoke  ${status.grantUrl}  (Account → Delegates)`);
  note(`  note           the console's /agent/authorize page grants PREDICTION MARKETS and`);
  note(`                 states it does not grant perps — it will not work for this agent`);
  note(`  asks for       ${Object.keys(REQUESTED_PERMISSION_NAMES).join(", ")}`);
  note(`  never asks for DEPOSIT_COLLATERAL, WITHDRAW_COLLATERAL — funds-out is owner-only on chain`);
  if (status.granted !== undefined) note(`  granted        ${status.granted.join(", ") || "none"}`);
  note("");

  const next =
    status.state === "no-wallet"
      ? invoke("bootstrap", "--json")
      : status.state === "granted"
        ? invoke("next", "--json")
        : invoke("onboard", "--json");

  show(
    {
      ...status,
      network: agent.config.network,
      grantCommand: status.grantCommand ?? null,
      requestedPerpPermissions: REQUESTED_PERP_PERMISSIONS,
      requestedPermissionNames: Object.keys(REQUESTED_PERMISSION_NAMES),
      next,
    },
    { rendered: true },
  );

  setOutcome(
    status.state === "granted" || status.state === "owner-key"
      ? succeeded(status.headline, { nextCommand: next })
      : {
          status: "config",
          message: status.headline,
          submitted: false,
          retryable: false,
          reconcileRequired: false,
          awaitingApproval: false,
          nextCommand: next,
        },
  );
});
