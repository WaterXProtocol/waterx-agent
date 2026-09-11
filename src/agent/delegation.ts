/**
 * The handshake that lets an agent trade an account it does not own.
 *
 * The arrangement this package is built for: a person keeps their own key and
 * their own account, and grants a **separate** wallet — the agent's —
 * permission to trade on it. The grant is an on-chain act by the owner, made
 * from their browser wallet, and it is revocable there. The agent holds only
 * the delegate key.
 *
 * Why that is worth the extra step rather than just handing over the owner key:
 * funds-out and authority changes are **owner-only on chain** since the
 * delegate-phishing hardening. A delegate can trade the account and cannot
 * withdraw from it or grant anyone else access — whatever its permission mask
 * says, and whatever a bug in this package does. That is the entire reason
 * `delegated-auto` is a bounded risk rather than a promise.
 *
 * What this module does NOT do is discover the grant by itself. The backend has
 * no reverse lookup — `/account/delegate` answers "who may act on this
 * account?", and there is no "which accounts may this wallet act on?" — so the
 * owner has to state the account id once. Everything after that is verified
 * against the chain rather than believed.
 */
import {
  PERM_ALL_TRADING,
  PERM_CANCEL_ORDER,
  PERM_CLOSE_POSITION,
  PERM_DECREASE_POSITION,
  PERM_INCREASE_POSITION,
  PERM_OPEN_POSITION,
  PERM_PLACE_ORDER,
} from "@waterx/sdk";

import type { DelegateData } from "../api/types.ts";
import type { Network } from "../config.ts";

/**
 * The web console paired with each deployment — where an owner signs a grant.
 *
 * A lookup, never a default: a private or preview console is passed as a plain
 * string through `WATERX_CONSOLE_URL`. Guessing one is worse than having none,
 * because an owner sent to the wrong console will conclude the product is
 * broken rather than that the link was wrong — which is exactly what happened
 * here. An earlier revision of this file pointed at a page found by probing for
 * a 200, and that page does not grant anything.
 */
export const CONSOLE_ENDPOINTS: Readonly<Record<Network, string>> = {
  mainnet: "https://waterx.app",
  testnet: "https://testnet.waterx.app",
};

/** Where the authorization flow lives in the console. */
export const AUTHORIZE_PATH = "/agent/authorize";

/** The console for a deployment, or the one an operator named. */
export const consoleUrl = (network: Network): string =>
  process.env.WATERX_CONSOLE_URL?.trim() || CONSOLE_ENDPOINTS[network];

/**
 * The link an owner opens to grant this wallet.
 *
 * It carries the agent wallet, and optionally a label and an account id. It
 * confers **no authority** — it is a page to visit, not a credential — so it is
 * safe to paste into a chat in a way a token never would be. That is why
 * nothing else rides along: a link that carried a bearer token would turn every
 * paste into a leak.
 */
export function authorizeUrl(input: {
  network: Network;
  agentWallet: string;
  label?: string;
  accountId?: string;
}): string {
  const base = consoleUrl(input.network).replace(/\/+$/, "");
  const url = new URL(AUTHORIZE_PATH, `${base}/`);
  url.searchParams.set("agent", input.agentWallet);
  if (input.label !== undefined) url.searchParams.set("label", input.label);
  if (input.accountId !== undefined) url.searchParams.set("account", input.accountId);
  return url.toString();
}

/**
 * What the agent asks for: trading, and nothing else.
 *
 * `PERM_ALL_TRADING` covers opening, closing, sizing and orders. It does not
 * include `PERM_DEPOSIT_COLLATERAL` or `PERM_WITHDRAW_COLLATERAL`, and it must
 * not: moving funds is the owner's, and an agent that could do it would remove
 * the only guarantee this arrangement rests on.
 */
export const REQUESTED_PERP_PERMISSIONS = PERM_ALL_TRADING;

/** The bits, named, so a person can read what they are being asked to sign. */
export const REQUESTED_PERMISSION_NAMES: Readonly<Record<string, number>> = {
  OPEN_POSITION: PERM_OPEN_POSITION,
  CLOSE_POSITION: PERM_CLOSE_POSITION,
  INCREASE_POSITION: PERM_INCREASE_POSITION,
  DECREASE_POSITION: PERM_DECREASE_POSITION,
  PLACE_ORDER: PERM_PLACE_ORDER,
  CANCEL_ORDER: PERM_CANCEL_ORDER,
};

/** Where the handshake has got to. */
export type DelegationState =
  /** No key at all — nothing to grant to yet. */
  | "no-wallet"
  /** A wallet exists; the owner has not been told about it. */
  | "awaiting-grant"
  /** Owner and account named, but the chain does not show this wallet as a delegate. */
  | "not-granted"
  /**
   * Granted, but into the superseded authority slot — reads as permissioned and
   * aborts `EUnauthorized` on every order.
   */
  | "stale-grant"
  /** Granted, in the slot the chain enforces, with trading permissions. */
  | "granted"
  /** Granted, but missing permissions the agent needs. */
  | "insufficient"
  /** This process holds the OWNER's key, not a delegate's. */
  | "owner-key";

export interface DelegationStatus {
  state: DelegationState;
  /** One sentence naming what is true and what to do about it. */
  headline: string;
  delegateAddress?: string;
  ownerAddress?: string;
  accountId?: string;
  /** The permissions the chain actually records, when there is a grant. */
  granted?: string[];
  /** Requested permissions the grant does not carry. */
  missing?: string[];
  grantUrl: string;
}

/**
 * Read the handshake's state from facts rather than from configuration.
 *
 * `delegates` is the chain's answer, through the backend. A wallet that is not
 * in it has not been granted anything, whatever the environment says — which is
 * the point of checking rather than trusting `WATERX_OWNER_ADDRESS` being set.
 */
export function delegationStatus(input: {
  network: Network;
  delegateAddress?: string;
  ownerAddress?: string;
  accountId?: string;
  /** A name for this agent, shown to the owner on the authorization screen. */
  label?: string;
  /** `undefined` when the lookup has not been made; an empty array means none. */
  delegates?: readonly DelegateData[];
}): DelegationStatus {
  const grantUrl =
    input.delegateAddress === undefined
      ? consoleUrl(input.network)
      : authorizeUrl({
          network: input.network,
          agentWallet: input.delegateAddress,
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
        });
  const { delegateAddress, ownerAddress, accountId } = input;

  if (delegateAddress === undefined) {
    return {
      state: "no-wallet",
      headline: "No agent wallet yet. `bootstrap` makes one; it signs nothing.",
      grantUrl,
    };
  }

  const base = { delegateAddress, grantUrl };

  if (ownerAddress === undefined) {
    return {
      ...base,
      state: "awaiting-grant",
      headline:
        `Give ${delegateAddress} to the account owner. They grant it trading permission at ` +
        `${grantUrl} from the wallet that owns the account, then tell you their address and ` +
        `account id.`,
    };
  }

  if (ownerAddress.toLowerCase() === delegateAddress.toLowerCase()) {
    return {
      ...base,
      ownerAddress,
      state: "owner-key",
      headline:
        "This process holds the account OWNER's key, not a delegate's. That works, and it means " +
        "the safety this arrangement rests on — that a delegate cannot withdraw — does not apply.",
    };
  }

  if (accountId === undefined) {
    return {
      ...base,
      ownerAddress,
      state: "awaiting-grant",
      headline:
        `The owner is ${ownerAddress} but no account id is set, and there is no way to look one ` +
        `up from a delegate key. Ask them for the account id and set WATERX_ACCOUNT_ID.`,
    };
  }

  if (input.delegates === undefined) {
    return {
      ...base,
      ownerAddress,
      accountId,
      state: "not-granted",
      headline: `Could not read the delegates of ${accountId}, so the grant is unconfirmed.`,
    };
  }

  const mine = input.delegates.find(
    (d) => d.delegateAddress.toLowerCase() === delegateAddress.toLowerCase(),
  );
  if (mine === undefined) {
    return {
      ...base,
      ownerAddress,
      accountId,
      state: "not-granted",
      headline:
        `${delegateAddress} is not a delegate of ${accountId}. The owner grants it at ` +
        `${grantUrl}; until they do, every write refuses on chain.`,
    };
  }

  // A grant can land in the superseded `TradingRequest<CREDIT>` slot, where it
  // reads as fully permissioned here and aborts `EUnauthorized` on every order.
  // Absence of the flag is an older backend that cannot tell, which is not the
  // same as a healthy grant.
  if (mine.stale === true) {
    return {
      ...base,
      ownerAddress,
      accountId,
      granted: mine.permissionList,
      state: "stale-grant",
      headline:
        "The grant is in the superseded authority slot, so every perp action aborts on chain " +
        `(EUnauthorized, surfaced as 6002). The owner must re-grant it at ${grantUrl}.`,
    };
  }

  const granted = new Set<string>(mine.permissionList);
  const missing = Object.keys(REQUESTED_PERMISSION_NAMES).filter((name) => !granted.has(name));
  if (missing.length > 0) {
    return {
      ...base,
      ownerAddress,
      accountId,
      granted: mine.permissionList,
      missing,
      state: "insufficient",
      headline:
        `Granted, but without ${missing.join(", ")}. Those actions will refuse on chain; the ` +
        `owner can widen the grant at ${grantUrl}.`,
    };
  }

  return {
    ...base,
    ownerAddress,
    accountId,
    granted: mine.permissionList,
    state: "granted",
    headline:
      `${delegateAddress} may trade ${accountId} on behalf of ${ownerAddress}. It cannot ` +
      `withdraw or grant authority — those stayed owner-only on chain.`,
  };
}
