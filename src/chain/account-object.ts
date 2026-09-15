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
import { normalizePackage } from "./deployment.ts";

export interface AccountDelegateEntry {
  address: string;
  /** Unix ms after which the delegation confers nothing; `null` for never. */
  expiresAtMs: number | null;
  /**
   * The per-protocol permission masks the chain holds for this delegate, keyed by
   * protocol type name with its package address normalised (see
   * {@link normalizeTypeName}).
   *
   * These are what the contracts consult. The backend reports a digest of them —
   * a `stale` flag present only when something is wrong — and a missing flag
   * cannot tell a healthy grant from a backend too old to say, so anything that
   * needs to KNOW where a grant sits reads these.
   */
  protocolPermissions: ReadonlyMap<string, number>;
}

/**
 * `0x44da…::account_data::WaterXPerp` and `44da…::account_data::WaterXPerp` name
 * the same type — Move's `TypeName` carries the address unprefixed, callers
 * usually do not — so keys are compared with the leading address normalised.
 */
export const normalizeTypeName = (name: string): string => {
  const at = name.indexOf("::");
  return at <= 0 ? name : `${normalizePackage(name.slice(0, at))}${name.slice(at)}`;
};

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
        expiresAtMs: d.expires_at_ms === null ? null : Number(d.expires_at_ms),
        protocolPermissions: new Map(
          d.protocol_permissions.contents.map((entry) => [normalizeTypeName(entry.key.name), entry.value]),
        ),
      })),
    };
  };
}
