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
 *
 * The one thing it writes is local: this wallet's pairing code, minted the first
 * time and reused after, which the authorize link carries and the owner's grant
 * writes back on chain — so `adopt` can tell their grant from anybody else's.
 */
import {
  DELEGATE_BOUNDARY,
  delegationStatus,
  perpGrantCommand,
  REQUESTED_PERMISSION_NAMES,
  REQUESTED_PERP_PERMISSIONS,
  requestedPermissions,
} from "../../src/agent/delegation.ts";
import { ensurePairing, type Pairing } from "../../src/agent/pairing.ts";
import { signerReadiness } from "../../src/chain/create-signer.ts";
import { ensureEnvIgnored } from "../../src/chain/secrets.ts";
import { invoke, succeeded } from "../../src/cli/contract.ts";
import { UsageError } from "../../src/errors.ts";
import type { DelegateData } from "../../src/api/types.ts";
import { initAgent, note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";

const args = parseArgs(
  {
    label: {
      desc:
        "A name for this agent, shown to the owner on the authorize page and written into the " +
        "grant with its pairing code. Used when the code is first minted",
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

  // Minted before the link is printed, and once per wallet, so a link already
  // handed to an owner keeps matching the grant they are about to sign.
  let pairing: Pairing | undefined;
  if (delegateAddress !== undefined) {
    try {
      pairing = ensurePairing({
        delegate: delegateAddress,
        network: agent.config.network,
        ...(args.label === undefined ? {} : { label: args.label }),
      }).pairing;
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    // `.waterx/` now holds the code; keep it and the ledgers beside it out of git.
    ensureEnvIgnored();
  }
  // Derived from the account when only WATERX_ACCOUNT_ID is configured.
  try {
    await agent.resolveIdentity();
  } catch {
    // Left unset: reported below as unconfirmed, never guessed.
  }
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
    ...(pairing === undefined ? {} : { alias: pairing.alias }),
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
  if (pairing !== undefined) {
    note(`  pairing code   ${pairing.alias}`);
    note(`                 the authorize page shows it; a grant that carries it back needs nobody to vouch for it`);
  }
  if (status.ownerAddress !== undefined) note(`  owner          ${status.ownerAddress}`);
  if (status.accountId !== undefined) note(`  account        ${status.accountId}`);
  if (status.authorizeUrl !== undefined) {
    // A page is configured, so that is the way in and the CLI is the fallback.
    // Printing the CLI first — and the "authorize page will not work" note —
    // under a working perp authorize URL told the owner the opposite of the
    // headline two lines above it.
    note(`  owner grants   ${status.authorizeUrl}`);
    note(`                 in their browser, signing with their own wallet`);
    note(`  or, terminal   ${status.grantCommand ?? "(needs a wallet first)"}`);
    note(`                 with THEIR OWN key, and WATERX_ACCOUNT_ID set to their account`);
  } else {
    note(`  the owner runs ${status.grantCommand ?? "(needs a wallet first)"}`);
    note(`                 with THEIR OWN key, and WATERX_ACCOUNT_ID set to their account`);
    note(`  note           the console's /agent/authorize page grants PREDICTION MARKETS and`);
    note(`                 states it does not grant perps — it will not work for this agent`);
  }
  // Where to review is not where to grant, whatever is configured.
  note(`  review/revoke  ${status.reviewUrl}  (Account → Delegates)`);
  // Each bit with what it does. The bare names put WITHDRAW_COLLATERAL a line
  // above "cannot take money out", and a careful reader took that for a
  // contradiction to resolve before anyone signed.
  note(`  asks for`);
  for (const { name, meaning } of requestedPermissions()) note(`    ${name.padEnd(20)} ${meaning}`);
  note(`  cannot         ${DELEGATE_BOUNDARY}`);
  if (status.granted !== undefined) note(`  granted        ${status.granted.join(", ") || "none"}`);
  note("");

  const next =
    status.state === "no-wallet"
      ? invoke("bootstrap", "--json")
      : status.state === "granted"
        ? invoke("next", "--json")
        : status.state === "awaiting-grant"
          ? invoke("discover", "--wait", "300", "--json")
          : invoke("onboard", "--json");

  show(
    {
      ...status,
      network: agent.config.network,
      grantCommand: status.grantCommand ?? null,
      pairingCode: pairing?.alias ?? null,
      requestedPerpPermissions: REQUESTED_PERP_PERMISSIONS,
      requestedPermissionNames: Object.keys(REQUESTED_PERMISSION_NAMES),
      // The same list with what each bit does, so an agent relaying it relays
      // the meaning too — and the one sentence on what the grant cannot do.
      requestedPermissions: requestedPermissions(),
      delegateCannot: DELEGATE_BOUNDARY,
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
