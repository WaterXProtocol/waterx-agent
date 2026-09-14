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
  PERM_DEPOSIT_COLLATERAL,
  PERM_INCREASE_POSITION,
  PERM_OPEN_POSITION,
  PERM_PLACE_ORDER,
  PERM_WITHDRAW_COLLATERAL,
} from "@waterx/sdk";

import type { DelegateData } from "../api/types.ts";
import type { Network } from "../config.ts";

/**
 * The web console paired with each deployment.
 *
 * A lookup, never a guess: a private or preview console goes in
 * `WATERX_CONSOLE_URL`. Guessing one is worse than having none, because an
 * owner sent to the wrong place concludes the product is broken rather than
 * that the link was wrong.
 */
export const CONSOLE_ENDPOINTS: Readonly<Record<Network, string>> = {
  mainnet: "https://waterx.app",
  testnet: "https://testnet.waterx.app",
};

export const consoleUrl = (network: Network): string =>
  process.env.WATERX_CONSOLE_URL?.trim() || CONSOLE_ENDPOINTS[network];

/** Where an owner reviews and revokes what they have granted: Account → Delegates. */
export const delegatesUrl = (network: Network): string =>
  `${consoleUrl(network).replace(/\/+$/, "")}/en/account`;

/**
 * The console's `/agent/authorize` page grants **prediction markets only**.
 *
 * This is not an inference. The page says so itself: "This grants — place and
 * close prediction-market orders"; "This does not grant — withdrawals,
 * transfers, **perps**, staking, or claiming settled winnings." It reads one
 * query parameter, `agent`, and there is no protocol to choose.
 *
 * So it is the wrong page for this agent, and sending an owner there is worse
 * than sending them nowhere: they connect a wallet, sign, and have granted
 * nothing this package can use — and the next thing they hear is that the
 * permissions are missing. An earlier revision of this file did exactly that.
 *
 * If WaterX ships a perp equivalent, name it here rather than changing code.
 */
export const perpAuthorizeUrl = (): string | undefined =>
  process.env.WATERX_PERP_AUTHORIZE_URL?.trim() || undefined;

/**
 * How an owner grants perp trading today: with their own key, through this
 * package.
 *
 * `account::add_delegate` and `account::set_delegate_protocol_permission` are
 * both confirmed against both deployments, so this is a path that demonstrably
 * works — which is more than can be said for a web page that does not cover
 * perps. It does mean the owner puts their key in a CLI rather than keeping it
 * in a browser wallet, and that is a real cost of the missing page, not a
 * design choice worth defending.
 */
export const perpGrantCommand = (input: {
  agentWallet: string;
  accountId?: string;
  invoke: (command: string, ...args: string[]) => string;
}): string =>
  input.invoke("add-delegate", "--delegate", input.agentWallet, "--yes", "--json");

/**
 * How to tell the owner to grant — a page when there is one, the CLI when there
 * is not.
 *
 * `perpAuthorizeUrl()` used to change only the REVIEW link while every headline
 * went on prescribing the command. So the escape hatch existed and did not
 * escape: an operator who pointed the agent at a working authorize page was
 * still told to hand their private key to a CLI. A real install report caught
 * it, which is the only reason it was found — the env var is exercised by
 * nobody until the page ships.
 *
 * The CLI path is not deprecated by this. It is the only one that works when no
 * page is configured, and it is honest about its cost: the owner puts their key
 * in a terminal instead of keeping it in a browser wallet. That cost is the
 * reason the page is being built, not an argument that the CLI is fine.
 */
export const grantInstruction = (input: {
  agentWallet: string;
  authorizeUrl?: string;
  grantCommand?: string;
}): string => {
  const command = input.grantCommand ?? "pnpm run add-delegate -- --delegate <agent> --yes";
  if (input.authorizeUrl === undefined) {
    return (
      `the owner grants it with their own key: ${command}. Granting PERP permission is not ` +
      `something the console does today — its \`/agent/authorize\` page covers prediction ` +
      `markets and states that it does not grant perps`
    );
  }
  return (
    `the owner opens ${input.authorizeUrl}?agent=${input.agentWallet} and signs with their ` +
    `wallet — the key never leaves the browser. If they would rather not use the ` +
    `browser, ${command} does the same thing with their key in a terminal`
  );
};

/**
 * What the agent asks for: the perp trading mask, and nothing outside perps.
 *
 * `PERM_ALL_TRADING` (255) covers opening, closing, sizing, orders **and
 * position margin** — `PERM_DEPOSIT_COLLATERAL` and `PERM_WITHDRAW_COLLATERAL`
 * are in it, and this used to claim they were not.
 *
 * That claim was wrong twice over. The agent does ask for them, because
 * `addMargin` and `removeMargin` are actions it offers; and those two bits move
 * collateral **between the account and an open position**, not out of the
 * account. Saying "we never ask for them" understated the grant on a consent
 * screen, which is the worst direction to be wrong in.
 *
 * What the agent cannot do is take money out, and that does not rest on a bit
 * being absent. Account deposit and withdrawal **refuse a `delegateSender`
 * outright** at the API, and the framework-level `Delegate.permissions` field —
 * which carries the withdraw/manage/receive bits — must stay `PERM_NONE` for a
 * delegate; perp authority is read from the per-protocol slot instead. A
 * delegate therefore cannot withdraw whatever mask it holds.
 */
export const REQUESTED_PERP_PERMISSIONS = PERM_ALL_TRADING;

/**
 * The bits, named, so a person can read what they are being asked to sign.
 *
 * Every bit in the requested mask appears here. A list shorter than the mask is
 * a consent screen that undersells the grant, which is how this file described
 * itself until the two margin bits were counted.
 */
export const REQUESTED_PERMISSION_NAMES: Readonly<Record<string, number>> = {
  OPEN_POSITION: PERM_OPEN_POSITION,
  CLOSE_POSITION: PERM_CLOSE_POSITION,
  INCREASE_POSITION: PERM_INCREASE_POSITION,
  DECREASE_POSITION: PERM_DECREASE_POSITION,
  PLACE_ORDER: PERM_PLACE_ORDER,
  CANCEL_ORDER: PERM_CANCEL_ORDER,
  // Margin on an OPEN POSITION, not funds out of the account.
  DEPOSIT_COLLATERAL: PERM_DEPOSIT_COLLATERAL,
  WITHDRAW_COLLATERAL: PERM_WITHDRAW_COLLATERAL,
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
  /** Where to review and revoke — Account → Delegates. Always the delegates page. */
  reviewUrl: string;
  /**
   * Where the owner GRANTS, when a perp authorize page is configured — with the
   * agent address already in the query string once there is a wallet. Absent
   * otherwise: the console's own `/agent/authorize` grants prediction markets,
   * not perps, so there is no default to point at.
   */
  authorizeUrl?: string;
  /**
   * @deprecated Same value as `reviewUrl`. Kept because it is in the `--json`
   * output an external agent may already read. It briefly held the AUTHORIZE
   * page whenever one was configured — a field whose meaning changed with the
   * environment — and the onboard screen, trusting this comment, printed that
   * page under "review/revoke". Read `reviewUrl` or `authorizeUrl` instead.
   */
  grantUrl: string;
  /** The command the owner runs to grant, when there is a wallet to grant to. */
  grantCommand?: string;
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
  /** A name for this agent, for the caller's own records. */
  label?: string;
  /** The exact command the owner runs to grant, spelled for where they are. */
  grantCommand?: string;
  /** `undefined` when the lookup has not been made; an empty array means none. */
  delegates?: readonly DelegateData[];
}): DelegationStatus {
  // Two different places, and conflating them is what made the override inert.
  //
  // `authorizePage` is where an owner GRANTS, and it exists only once somebody
  // configures one — the console's own `/agent/authorize` covers prediction
  // markets and says outright that it does not grant perps, so there is no
  // default to fall back on. `delegatesUrl` is where they REVIEW and revoke,
  // which the console does have today (verified from its own copy: "Revoke any
  // time from Account → Delegates").
  const authorizePage = perpAuthorizeUrl();
  const reviewUrl = delegatesUrl(input.network);
  const { delegateAddress, ownerAddress, accountId } = input;

  if (delegateAddress === undefined) {
    return {
      state: "no-wallet",
      headline: "No agent wallet yet. `bootstrap` makes one; it signs nothing.",
      reviewUrl,
      grantUrl: reviewUrl,
      ...(authorizePage === undefined ? {} : { authorizeUrl: authorizePage }),
    };
  }

  const base = {
    delegateAddress,
    reviewUrl,
    grantUrl: reviewUrl,
    ...(authorizePage === undefined
      ? {}
      : { authorizeUrl: `${authorizePage}?agent=${delegateAddress}` }),
    ...(input.grantCommand === undefined ? {} : { grantCommand: input.grantCommand }),
  };

  if (ownerAddress === undefined) {
    return {
      ...base,
      state: "awaiting-grant",
      headline:
        `Give ${delegateAddress} to the account owner. To grant perp trading, ` +
        `${grantInstruction({ agentWallet: delegateAddress, authorizeUrl: authorizePage, ...(input.grantCommand === undefined ? {} : { grantCommand: input.grantCommand }) })}. ` +
        `They can review and revoke it at ${reviewUrl} (Account → Delegates). ` +
        `Once they have signed, \`discover\` finds the account — no id to copy.`,
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
        `${delegateAddress} is not a delegate of ${accountId}. To grant it, ` +
        `${grantInstruction({ agentWallet: delegateAddress, authorizeUrl: authorizePage, ...(input.grantCommand === undefined ? {} : { grantCommand: input.grantCommand }) })}. ` +
        `Until they do, every write refuses on chain.`,
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
        `(EUnauthorized, surfaced as 6002). It has to be granted again: ` +
        `${grantInstruction({ agentWallet: delegateAddress, authorizeUrl: authorizePage, ...(input.grantCommand === undefined ? {} : { grantCommand: input.grantCommand }) })}.`,
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
        `owner widens the grant by re-running it with a fuller perp mask. If they granted through ` +
        `the console's authorize page, that is why: it grants prediction markets, not perps.`,
    };
  }

  return {
    ...base,
    ownerAddress,
    accountId,
    granted: mine.permissionList,
    state: "granted",
    headline:
      `${delegateAddress} may trade ${accountId} on behalf of ${ownerAddress}, including moving ` +
      `margin on open positions. It cannot take money OUT of the account or grant authority: ` +
      `account deposit and withdrawal refuse a delegate outright, whatever mask it holds.`,
  };
}
