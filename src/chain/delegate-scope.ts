/**
 * Whether a delegate's perp authority sits where the contract looks for it — read from chain.
 *
 * `trading::assert_protocol_perm` reads `effective_protocol_permissions<WaterXPerp>`:
 * one bitmap under `<waterx_perp original id>::account_data::WaterXPerp`,
 * covering trading and WLP alike. A delegate granted before that was fixed holds
 * its authority under `request::TradingRequest<CREDIT>` instead, which the
 * contract no longer reads — it looks fully permissioned in any list and aborts
 * `EUnauthorized` on every order.
 *
 * `doctor` used to ask the backend, which reports that case as `stale: true` and
 * says nothing when a grant is fine. So a missing flag meant either "fine" or "a
 * backend too old to say", and the check warned on every healthy grant it ever
 * saw — telling owners whose grants were correct that they might have to grant
 * again. The chain holds the answer itself, so this reads it.
 */
import type { AccountDelegateEntry } from "./account-object.ts";
import { normalizePackage } from "./deployment.ts";

export interface ScopeVerdict {
  status: "ok" | "warn" | "fail";
  detail: string;
}

/** The permission key the contract reads, for a given `waterx_perp` original id. */
export const enforcedPerpSlot = (perpOriginalId: string): string =>
  `${normalizePackage(perpOriginalId)}::account_data::WaterXPerp`;

export function delegateScope(input: {
  /** This wallet's entry on the Account object; `undefined` when it has none. */
  entry: AccountDelegateEntry | undefined;
  /** `waterx_perp`'s ORIGINAL id — type names key on it, not on the current version. */
  perpOriginalId: string;
  /** The bits the agent needs, by name. */
  requested: Readonly<Record<string, number>>;
  now: number;
}): ScopeVerdict {
  const { entry } = input;
  if (entry === undefined) {
    return {
      status: "fail",
      detail:
        "this wallet is not a delegate of the account on chain, so every perp action aborts. " +
        "The owner has to grant it.",
    };
  }
  if (entry.expiresAtMs !== null && input.now >= entry.expiresAtMs) {
    return {
      status: "fail",
      detail:
        `the grant expired at ${new Date(entry.expiresAtMs).toISOString()} and confers nothing ` +
        `on chain. The owner has to remove it and grant again.`,
    };
  }

  const perp = normalizePackage(input.perpOriginalId);
  const enforced = entry.protocolPermissions.get(enforcedPerpSlot(perp)) ?? 0;
  if (enforced === 0) {
    const superseded = [...entry.protocolPermissions].some(
      ([key, mask]) => key.startsWith(`${perp}::request::TradingRequest<`) && mask !== 0,
    );
    return {
      status: "fail",
      detail: superseded
        ? "the grant holds perp authority only in the superseded request::TradingRequest slot, " +
          "which the contract no longer reads, so every perp action aborts on chain " +
          "(EUnauthorized, surfaced as 6002). The owner has to re-add the delegate."
        : "the grant holds no perp authority in account_data::WaterXPerp, the slot the contract " +
          "reads, so every perp action aborts on chain. The owner has to grant perp trading.",
    };
  }

  const missing = Object.entries(input.requested)
    .filter(([, bit]) => (enforced & bit) !== bit)
    .map(([name]) => name);
  if (missing.length > 0) {
    return {
      status: "warn",
      detail:
        `the grant is in account_data::WaterXPerp, the slot the contract reads, but lacks ` +
        `${missing.join(", ")} — those actions abort on chain. The owner widens it by granting again.`,
    };
  }
  return {
    status: "ok",
    detail: "authority is in account_data::WaterXPerp, the slot the contract reads — confirmed on chain",
  };
}
