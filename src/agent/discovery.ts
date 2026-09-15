/**
 * Which accounts have granted this wallet — found, then confirmed on chain.
 *
 * An agent used to be told its account id (and its owner's address) by hand,
 * after the owner signed in a browser. The chain cannot answer the reverse
 * question directly: delegates live inside each Account object, so "who grants
 * me?" means knowing which accounts to read. Two ways to know, in order:
 *
 *  1. the backend's index (`GET /account/delegated`) — complete, cheap;
 *  2. the chain's recent grant events — only recent, but enough for a grant
 *     made minutes ago, and there when the backend is not.
 *
 * Neither is trusted for the answer. Every candidate is read from chain here,
 * so a removed or expired grant never counts and the owner comes from the
 * object itself rather than from an index.
 *
 * It never chooses: adopting is `adopt`'s job. When more than one grant is
 * found, which account the agent trades is a person's choice.
 */
import { normalizeSuiAddress } from "@mysten/sui/utils";

import type { DelegatedAccountsResponse } from "../api/types.ts";
import type { AccountObjectReader } from "../chain/account-object.ts";

/** How many candidate accounts one discovery will read from chain. */
export const DISCOVERY_LIMIT = 50;

export type DiscoverySource = "backend" | "chain-events";

export interface DiscoveredGrant {
  accountId: string;
  /** From the Account object on chain — authoritative. */
  ownerAddress: string;
  expiresAtMs: number | null;
}

export interface Discovery {
  source: DiscoverySource;
  /** Live grants to this wallet, confirmed on chain. */
  grants: DiscoveredGrant[];
  /** Candidates whose chain read failed. Not the same as "not granted". */
  unverified: string[];
  truncated: boolean;
  /** Why the backend was not the source, when it was not. */
  fallbackReason?: string;
}

export interface DiscoveryDeps {
  delegatedAccounts: (delegate: string) => Promise<DelegatedAccountsResponse>;
  /** Account ids from recent on-chain grant events naming `delegate`. */
  recentGrantEvents: (delegate: string) => Promise<string[]>;
  readAccount: AccountObjectReader;
  now?: () => number;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function discoverGrants(delegate: string, deps: DiscoveryDeps): Promise<Discovery> {
  const me = normalizeSuiAddress(delegate);
  let source: DiscoverySource = "backend";
  let fallbackReason: string | undefined;
  let candidates: string[];
  let truncated = false;

  try {
    const response = await deps.delegatedAccounts(me);
    candidates = [...response.accounts.map((a) => a.accountId), ...response.unverifiedAccounts];
    truncated = response.truncated;
  } catch (error) {
    // Not deployed yet (404), down, or refusing: the events still exist.
    source = "chain-events";
    fallbackReason = describe(error);
    candidates = await deps.recentGrantEvents(me);
  }

  const unique = [...new Set(candidates.map((id) => normalizeSuiAddress(id)))];
  if (unique.length > DISCOVERY_LIMIT) truncated = true;
  const bounded = unique.slice(0, DISCOVERY_LIMIT);

  const reads = await Promise.allSettled(bounded.map((id) => deps.readAccount(id)));
  const now = (deps.now ?? Date.now)();
  const grants: DiscoveredGrant[] = [];
  const unverified: string[] = [];

  bounded.forEach((accountId, i) => {
    const read = reads[i];
    if (read === undefined || read.status === "rejected") {
      unverified.push(accountId);
      return;
    }
    const entry = read.value.delegates.find((d) => d.address === me);
    // Absent: granted once and since removed. Expired: present, confers nothing.
    if (entry === undefined) return;
    if (entry.expiresAtMs !== null && now >= entry.expiresAtMs) return;
    grants.push({ accountId, ownerAddress: read.value.owner, expiresAtMs: entry.expiresAtMs });
  });

  return {
    source,
    grants,
    unverified,
    truncated,
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
  };
}
