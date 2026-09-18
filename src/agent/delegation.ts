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
 * What this module does NOT do is find the account or choose it. `discover`
 * finds the accounts that granted this wallet — the backend's delegate index
 * where it is deployed, recent grant events where it is not — and `adopt`
 * writes down the one it takes. This module reads where the handshake has
 * got to, and what it reports is checked against the chain rather than believed.
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
import { invoke } from "../cli/contract.ts";
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
 * The console page where an owner grants PERP trading, per deployment.
 *
 * Mind the `/perp`. The sibling route `/agent/authorize` is the PREDICT page
 * and states on itself that it does not grant perps, so the two are different
 * routes rather than different copy, and an owner sent to the wrong one signs
 * and has granted nothing this package can use.
 *
 * A lookup, never a guess, for the reason {@link CONSOLE_ENDPOINTS} gives —
 * read off the console's own source rather than inferred from its URL: the page
 * takes the agent address as `?agent=`, refuses anything that is not a 32-byte
 * address, lets the owner choose which of their accounts to grant, and grants
 * exactly the bits {@link REQUESTED_PERMISSION_NAMES} names.
 *
 * This returned `undefined` for four days after that page shipped, because the
 * fact lived here as a constant about somebody else's product and nothing goes
 * stale more quietly. Every install in that window told owners to paste a
 * private key into a CLI while the browser page they wanted was live. A wrong
 * default gets reported; a missing one just costs everyone the safer path. So
 * there IS a default now — and it is narrow: a console this package cannot name
 * still gets no guess.
 */
const PERP_AUTHORIZE_PATH = "/en/agent/authorize/perp";

export const perpAuthorizeUrl = (network: Network): string | undefined => {
  // A named page wins: a preview deployment, or a route that moves before this
  // constant catches up. That escape hatch is what made the stale default
  // survivable, and it stays the first thing consulted.
  const named = process.env.WATERX_PERP_AUTHORIZE_URL?.trim();
  if (named !== undefined && named !== "") return named;

  // A private console's routes are its own. Appending a path this package knows
  // to a host it does not would send an owner to a 404, and an owner at a 404
  // concludes the product is broken rather than that the link was wrong.
  const base = consoleUrl(network).replace(/\/+$/, "");
  return base === CONSOLE_ENDPOINTS[network] ? `${base}${PERP_AUTHORIZE_PATH}` : undefined;
};

/**
 * That page with this agent's address already in it.
 *
 * One place, because two surfaces need the link — the handshake's status and
 * the first thing `next` says to a fresh install — and because an override may
 * arrive carrying a query string of its own, which a bare `?agent=` would
 * truncate.
 */
export const perpAuthorizeLink = (network: Network, agentWallet: string): string | undefined => {
  const page = perpAuthorizeUrl(network);
  if (page === undefined) return undefined;
  return `${page}${page.includes("?") ? "&" : "?"}agent=${encodeURIComponent(agentWallet)}`;
};

/**
 * How an owner grants perp trading without a browser: with their own key,
 * through this package.
 *
 * `account::add_delegate` and `account::set_delegate_protocol_permission` are
 * both confirmed against both deployments, so this is a path that demonstrably
 * works. It is no longer the only one — {@link perpAuthorizeUrl} has the page —
 * and it is the second choice wherever that page exists, because this one asks
 * an owner to put a private key in a terminal. It stays for the consoles this
 * package can name no page for, and for owners who would rather not use a
 * browser at all.
 */
export const perpGrantCommand = (input: {
  agentWallet: string;
  accountId?: string;
  invoke: (command: string, ...args: string[]) => string;
}): string =>
  input.invoke("add-delegate", "--delegate", input.agentWallet, "--yes", "--json");

/**
 * Where the owner goes, in one sentence — the sentence that gets relayed.
 *
 * This used to be one paragraph carrying the link, the CLI alternative, the
 * review page and what a delegate cannot do, and `next` put all of it in
 * `headline`, which SKILL.md tells an agent to relay verbatim. The reader is an
 * operator whose whole job at that moment is to send someone a link, and the
 * link sat about three-quarters of the way through 850 characters of prose
 * addressed to somebody else. Nobody reads that to the end.
 *
 * So the sentence carries the link and stops. What the grant means is
 * {@link grantDetail}, which rides beside it in the JSON and is addressed to
 * the person who signs — who reads it on the page, where they are signing.
 *
 * `perpAuthorizeUrl()` used to change only the REVIEW link while every headline
 * went on prescribing the command. So the escape hatch existed and did not
 * escape: an operator who pointed the agent at a working authorize page was
 * still told to hand their private key to a CLI. A real install report caught
 * it, which is the only reason it was found — the env var is exercised by
 * nobody until the page ships.
 *
 * `authorizeUrl` is the FULL link, agent address included. It used to be the
 * bare page with `?agent=` appended here, which put the query-string building
 * in two places — and only one of them learned that an override may already
 * carry one.
 */
export const grantHeadline = (input: {
  agentWallet: string;
  authorizeUrl?: string;
  grantCommand?: string;
}): string => {
  const command =
    input.grantCommand ?? invoke("add-delegate", "--delegate", input.agentWallet, "--yes", "--json");
  return input.authorizeUrl === undefined
    ? `the owner grants it with their own key: ${command}`
    : `the owner opens ${input.authorizeUrl} and signs with their wallet`;
};

/**
 * What the grant means, and what else it could be made with — read once, by the
 * person deciding, rather than reprinted every time the state is reported.
 *
 * The CLI path is not deprecated by the page existing. It is the one that works
 * when this package can name no page, and it is honest about its cost: the
 * owner puts their key in a terminal instead of keeping it in a browser wallet.
 * That cost is the reason the page exists, not an argument that the CLI is
 * fine.
 *
 * It carries {@link DELEGATE_BOUNDARY} in full. A surface that says what a
 * delegate cannot do in its own words is how one of them ended up saying "this
 * wallet cannot withdraw" beside a list containing WITHDRAW_COLLATERAL.
 */
export const grantDetail = (input: {
  agentWallet: string;
  authorizeUrl?: string;
  grantCommand?: string;
  reviewUrl?: string;
}): string => {
  const command =
    input.grantCommand ?? invoke("add-delegate", "--delegate", input.agentWallet, "--yes", "--json");
  const review =
    input.reviewUrl === undefined
      ? ""
      : ` They review and revoke it at ${input.reviewUrl} (Account → Delegates).`;
  if (input.authorizeUrl === undefined) {
    return (
      `There is no browser page to send them to: this deployment's console is not one this ` +
      `package knows a perp authorize page for — name it in WATERX_PERP_AUTHORIZE_URL if it has ` +
      `one. ${DELEGATE_BOUNDARY}${review}`
    );
  }
  return (
    `Their key never leaves the browser. If they would rather not use one, ${command} does the ` +
    `same thing with their key in a terminal. ${DELEGATE_BOUNDARY}${review}`
  );
};

/** The command that completes the handshake: hand over the link, wait, adopt. */
export const completeHandshakeCommand = (): string =>
  invoke("onboard", "--wait", "300", "--json");

/** The command that prints the full consent account rather than the next move. */
export const handshakeDetailsCommand = (): string => invoke("onboard", "--details");

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
 * being absent: {@link DELEGATE_BOUNDARY} says what enforces it.
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

/**
 * What each requested bit lets the agent do, in the words a consent screen needs.
 *
 * The names alone read as a contradiction: `WITHDRAW_COLLATERAL` in the list,
 * "cannot withdraw" in the sentence beside it. A real install relayed exactly
 * that to the person about to sign — "I'd get that reconciled before the owner
 * signs anything on a mainnet account" — which is the right reaction to the
 * words and the wrong conclusion about the grant. So wherever the list is shown
 * it carries what each bit does, and the two margin bits say where money goes.
 *
 * Read off `waterx_perp::trading`: every order — an opening one included — and
 * every re-price checks PLACE_ORDER; cancelling an order or an attached leg
 * checks CANCEL_ORDER; the margin requests check the two collateral bits, and a
 * margin withdrawal puts the funds back into the account's own balance
 * (`return_to_user`), never at an address.
 */
export const PERMISSION_MEANINGS: Readonly<Record<string, string>> = {
  OPEN_POSITION: "open positions",
  CLOSE_POSITION: "close a position",
  INCREASE_POSITION: "add size to an open position",
  DECREASE_POSITION: "reduce an open position",
  PLACE_ORDER:
    "place market, limit and stop orders, attach take-profit and stop-loss, and re-price a resting order",
  CANCEL_ORDER: "cancel a resting order or an attached take-profit or stop-loss",
  DEPOSIT_COLLATERAL: "move margin from the account's balance into an open position",
  WITHDRAW_COLLATERAL:
    "move margin out of an open position, back into the account's balance — never out of the account",
};

/**
 * What a delegate cannot do, said once, in terms of what enforces it.
 *
 * Every surface that tells someone what the grant means — `bootstrap`, `next`,
 * `onboard`, a confirmed grant — uses this sentence. Each used to say it in its
 * own words, and a correction to one (what the margin bits are) never reached
 * the others: an installed agent read "this wallet cannot withdraw" from one
 * command and `WITHDRAW_COLLATERAL` from the next, and stopped.
 *
 * The guarantee is on chain, not a promise about this package.
 * `waterx_account::request_withdraw` aborts for any sender that is not the
 * account's owner, whatever bits a delegate holds, and granting — `add_delegate`,
 * `set_delegate_protocol_permission` — is owner-only the same way. That is why
 * the margin bits are not a funds-out path.
 */
export const DELEGATE_BOUNDARY =
  "It cannot take money OUT of the account or grant anyone access: withdrawing and granting are " +
  "owner-only on chain, whatever permissions a delegate holds. WITHDRAW_COLLATERAL only moves " +
  "margin from an open position back into the account.";

/** The requested bits with what each lets the agent do — the list a consent screen shows. */
export const requestedPermissions = (): { name: string; meaning: string }[] =>
  Object.keys(REQUESTED_PERMISSION_NAMES).map((name) => ({
    name,
    meaning: PERMISSION_MEANINGS[name] ?? name,
  }));

/**
 * The setup step a would-be delegate cannot take for itself: the owner's grant.
 *
 * Built here rather than in `bootstrap` so its words are the ones every other
 * surface uses. It went on saying "set WATERX_OWNER_ADDRESS and WATERX_ACCOUNT_ID
 * to what they give you" after `discover` made that unnecessary, and it filed
 * the step under "an operator" — a human at the venue, who cannot grant anything
 * on someone else's account.
 */
export function ownerGrantStep(agentWallet: string): {
  what: string;
  why: string;
  who: "the account owner";
  command: string;
} {
  return {
    what: "the owner's grant",
    why:
      `nothing has been granted to ${agentWallet} yet. The account owner grants it trading ` +
      `permission from their own wallet; they keep the funds, and it needs no SUI of its own. ` +
      `${DELEGATE_BOUNDARY} Once they have granted it, \`onboard --wait\` finds the account and ` +
      `adopts it — nobody copies an id.`,
    who: "the account owner",
    command: invoke("onboard", "--json"),
  };
}

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
  /**
   * What the grant means, for the person who will sign it.
   *
   * Kept out of the headline because the two have different readers. The
   * headline is relayed on every turn to an operator who has to hand over a
   * link; this is read once, by the account owner, who is looking at the page.
   */
  detail?: string;
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
   * Where the owner GRANTS — the console's perp authorize page, with the agent
   * address already in the query string once there is a wallet. Absent only
   * when this package can name no page for the console in force: a private
   * `WATERX_CONSOLE_URL` with no `WATERX_PERP_AUTHORIZE_URL` beside it.
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
  // `authorizePage` is where an owner GRANTS: `/agent/authorize/perp` on a
  // console this package knows, whatever `WATERX_PERP_AUTHORIZE_URL` names
  // otherwise, and nothing at all for a private console. `delegatesUrl` is
  // where they REVIEW and revoke (verified from the console's own copy: "Revoke
  // any time from Account → Delegates") — a different page, and it stays one.
  const authorizePage = perpAuthorizeUrl(input.network);
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

  // The link, not the page: every headline below hands this to the owner, and
  // building the query string at each of them is how one of them kept an
  // override's own parameters and the others dropped them.
  const authorizeLink = perpAuthorizeLink(input.network, delegateAddress);

  // Built once. Spelling these out at each headline is how one of them kept an
  // override's own query parameters and the others dropped them.
  const grantArgs = {
    agentWallet: delegateAddress,
    ...(authorizeLink === undefined ? {} : { authorizeUrl: authorizeLink }),
    ...(input.grantCommand === undefined ? {} : { grantCommand: input.grantCommand }),
  };
  const detail = grantDetail({ ...grantArgs, reviewUrl });

  const base = {
    delegateAddress,
    reviewUrl,
    grantUrl: reviewUrl,
    ...(authorizeLink === undefined ? {} : { authorizeUrl: authorizeLink }),
    ...(input.grantCommand === undefined ? {} : { grantCommand: input.grantCommand }),
  };

  if (ownerAddress === undefined) {
    return {
      ...base,
      state: "awaiting-grant",
      headline:
        `Nothing is granted to ${delegateAddress} yet. To grant perp trading, ` +
        `${grantHeadline(grantArgs)}. Then \`onboard --wait\` finds the account and adopts ` +
        `it — no id to copy.`,
      detail,
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
        `The owner is ${ownerAddress} but no account has been adopted. Once they have granted ` +
        `${delegateAddress}, \`onboard --wait\` finds the account and adopts it — no id to copy.`,
      detail,
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
        `${grantHeadline(grantArgs)}. ` +
        `Until they do, every write refuses on chain.`,
      detail,
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
        `${grantHeadline(grantArgs)}.`,
      detail,
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
        `owner widens it by granting again: ${grantHeadline(grantArgs)}.`,
      detail:
        `If they used the console's PREDICT page (\`/agent/authorize\`), that is why: it grants ` +
        `prediction markets, not perps. The perp page is \`/agent/authorize/perp\`. ${detail}`,
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
      `margin on open positions. ${DELEGATE_BOUNDARY}`,
  };
}

/** States in which the owner still has something to sign. */
const NEEDS_GRANT = new Set<DelegationState>([
  "awaiting-grant",
  "not-granted",
  "stale-grant",
  "insufficient",
]);

/**
 * The last characters of an address.
 *
 * What the owner checks the page against. The whole address is 66 characters
 * and nobody compares two of those by eye; six is a check a person will
 * actually make, and the page shows the address in full for anyone who wants
 * to make the real one.
 */
export const addressTail = (address: string, digits = 6): string => address.slice(-digits);

export interface ScreenOptions {
  /** Print the full consent account rather than the next move. */
  details?: boolean;
  /** The command to offer at the end, when the caller has one. */
  next?: string;
}

/**
 * What an operator is shown, and in what order.
 *
 * Lives here, with a return value, rather than as `note()` calls in the script,
 * because the order is the thing that was wrong and an order is only testable
 * if something returns it.
 *
 * What was wrong: the screen was 23 lines and the link was on line 3, competing
 * with a second copy of the agent address, a review URL that is no use until
 * after the grant, eight permission rows and a three-clause sentence about what
 * a delegate cannot do. All of that is addressed to the account OWNER — who is
 * not at this terminal, and who reads the same things on the page where they
 * sign. The person reading this has one job: send someone a link.
 *
 * So the link gets the screen, and the consent account moves behind
 * `--details`, where the reader who wants it can ask.
 */
/** One label column for the commands under the link, so they read as a pair. */
const row = (label: string, value: string): string => `  ${label.padEnd(40)}${value}`;

export function handshakeScreen(status: DelegationStatus, options: ScreenOptions = {}): string[] {
  const lines: string[] = [""];
  const link = NEEDS_GRANT.has(status.state) ? status.authorizeUrl : undefined;

  if (link !== undefined && status.delegateAddress !== undefined) {
    lines.push(
      "  Give this link to the account owner. They sign in their own wallet:",
      "",
      `  ${link}`,
      "",
      `  the page must show the agent address ending ${addressTail(status.delegateAddress)}`,
    );
  } else {
    // No page to send them to, or nothing left to sign: the sentence is the
    // screen. It already names the command an owner without a browser runs.
    lines.push(`  ${status.headline}`);
  }

  if (options.next !== undefined) {
    lines.push(row(NEEDS_GRANT.has(status.state) ? "when they have signed" : "next", options.next));
  }

  if (options.details === true) {
    lines.push("");
    if (status.delegateAddress !== undefined) lines.push(`  agent wallet   ${status.delegateAddress}`);
    if (status.ownerAddress !== undefined) lines.push(`  owner          ${status.ownerAddress}`);
    if (status.accountId !== undefined) lines.push(`  account        ${status.accountId}`);
    if (status.grantCommand !== undefined) {
      lines.push(
        `  or, terminal   ${status.grantCommand}`,
        "                 with THEIR OWN key, and WATERX_ACCOUNT_ID set to their account",
      );
    }
    // Where to review is not where to grant, whatever is configured. `grantUrl`
    // held this once, and its meaning changed with the environment.
    lines.push(`  review/revoke  ${status.reviewUrl}  (Account → Delegates)`);
    // Each bit with what it does. The bare names put WITHDRAW_COLLATERAL a line
    // above "cannot take money out", and a careful reader took that for a
    // contradiction to resolve before anyone signed.
    lines.push("  asks for");
    for (const { name, meaning } of requestedPermissions()) {
      lines.push(`    ${name.padEnd(20)} ${meaning}`);
    }
    lines.push(`  cannot         ${DELEGATE_BOUNDARY}`);
    if (status.granted !== undefined) {
      lines.push(`  granted        ${status.granted.join(", ") || "none"}`);
    }
  } else if (status.detail !== undefined) {
    lines.push(row("what it asks for, and where to revoke", handshakeDetailsCommand()));
  }

  lines.push("");
  return lines;
}
