/**
 * An Account object read straight from chain: who owns it, and who it delegates to.
 *
 * The one source neither the backend nor the indexer can be wrong about. It is
 * what turns "the backend says account X granted me" into "account X grants me"
 * — and what supplies the owner, which is a field on the object rather than
 * something a person should have to type.
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { wxaAccountCalls } from "@waterx/sdk";

import type { AgentConfig } from "../config.ts";

export interface AccountDelegateEntry {
  address: string;
  /**
   * The label the owner's grant wrote. It carries no authority — and it is where
   * a grant made through this agent's link carries the pairing code back.
   */
  alias: string;
  /** Unix ms after which the delegation confers nothing; `null` for never. */
  expiresAtMs: number | null;
}

export interface AccountObject {
  accountId: string;
  owner: string;
  delegates: AccountDelegateEntry[];
}

/** The id names no account object on this network — a wrong id, not an outage. */
export class AccountNotFoundError extends Error {
  readonly name = "AccountNotFoundError";
}

export type AccountObjectReader = (accountId: string) => Promise<AccountObject>;

/** The narrow slice of a gRPC client this needs, so tests can supply one. */
export interface ObjectContentSource {
  core: {
    getObject(input: {
      objectId: string;
      include: { content: true };
    }): Promise<{ object?: { content?: Uint8Array } | null }>;
  };
}

/**
 * A reader bound to one network.
 *
 * A missing object resolves rather than throwing, so it is checked explicitly:
 * reported as an unreadable account it would send someone to retry an id that
 * will never exist.
 */
export function accountObjectReader(
  config: Pick<AgentConfig, "network" | "grpcUrl">,
  source?: ObjectContentSource,
): AccountObjectReader {
  let client = source;
  return async (accountId) => {
    client ??= new SuiGrpcClient({
      network: config.network,
      baseUrl: config.grpcUrl,
    }) as unknown as ObjectContentSource;
    const { object } = await client.core.getObject({ objectId: accountId, include: { content: true } });
    if (object?.content === undefined) {
      throw new AccountNotFoundError(`No account object at ${accountId} on ${config.network}.`);
    }
    const parsed = wxaAccountCalls.Account.parse(object.content);
    return {
      accountId: normalizeSuiAddress(accountId),
      owner: normalizeSuiAddress(parsed.owner_address),
      delegates: parsed.delegates.map((d) => ({
        address: normalizeSuiAddress(d.delegate_address),
        alias: d.alias,
        expiresAtMs: d.expires_at_ms === null ? null : Number(d.expires_at_ms),
      })),
    };
  };
}
