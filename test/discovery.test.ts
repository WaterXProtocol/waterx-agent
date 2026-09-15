/**
 * Discovery finds candidates anywhere and believes only the chain.
 */
import { describe, expect, it, vi } from "vitest";

import { DISCOVERY_LIMIT, discoverGrants, type DiscoveryDeps } from "../src/agent/discovery.ts";
import type { AccountObject } from "../src/chain/account-object.ts";

const ME = `0x${"a".repeat(64)}`;
const OWNER = `0x${"0".repeat(63)}9`;
const acct = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;

const account = (id: string, delegates: AccountObject["delegates"]): AccountObject => ({
  accountId: id,
  owner: OWNER,
  delegates,
});

const deps = (over: Partial<DiscoveryDeps> = {}): DiscoveryDeps => ({
  delegatedAccounts: vi.fn(),
  recentGrantEvents: vi.fn().mockResolvedValue([]),
  readAccount: vi.fn(),
  now: () => 1_000_000,
  ...over,
});

describe("discoverGrants", () => {
  it("confirms each backend candidate on chain and takes the owner from the object", async () => {
    const d = deps({
      delegatedAccounts: vi.fn().mockResolvedValue({
        accounts: [{ accountId: acct(1), ownerAddress: null, delegate: {} }],
        unverifiedAccounts: [],
        truncated: false,
      }),
      readAccount: vi.fn().mockResolvedValue(account(acct(1), [{ address: ME, alias: "", expiresAtMs: null }])),
    });

    const result = await discoverGrants(ME, d);

    expect(result.source).toBe("backend");
    expect(result.grants).toEqual([{ accountId: acct(1), ownerAddress: OWNER, alias: "", expiresAtMs: null }]);
  });

  it("reports the alias each grant wrote, which is where a pairing code comes back", async () => {
    const d = deps({
      delegatedAccounts: vi.fn().mockResolvedValue({
        accounts: [{ accountId: acct(1), ownerAddress: null, delegate: {} }],
        unverifiedAccounts: [],
        truncated: false,
      }),
      readAccount: vi.fn().mockResolvedValue(
        account(acct(1), [{ address: ME, alias: "waterx-agent:K7Q2M9XDP4R8", expiresAtMs: null }]),
      ),
    });

    expect((await discoverGrants(ME, d)).grants[0]?.alias).toBe("waterx-agent:K7Q2M9XDP4R8");
  });

  it("does not count a grant the chain no longer holds, or one that has expired", async () => {
    // The backend verified these; the chain is read again anyway, because
    // adoption decides whose money is traded.
    const d = deps({
      delegatedAccounts: vi.fn().mockResolvedValue({
        accounts: [acct(1), acct(2)].map((accountId) => ({ accountId, ownerAddress: null, delegate: {} })),
        unverifiedAccounts: [],
        truncated: false,
      }),
      readAccount: vi.fn(async (id: string) =>
        id === acct(1)
          ? account(id, [])
          : account(id, [{ address: ME, alias: "", expiresAtMs: 999_999 }]),
      ),
    });

    expect((await discoverGrants(ME, d)).grants).toEqual([]);
  });

  it("falls back to recent chain events when the backend cannot answer, and says why", async () => {
    const d = deps({
      delegatedAccounts: vi.fn().mockRejectedValue(new Error("GET /account/delegated → HTTP 404")),
      recentGrantEvents: vi.fn().mockResolvedValue([acct(7)]),
      readAccount: vi.fn().mockResolvedValue(account(acct(7), [{ address: ME, alias: "", expiresAtMs: null }])),
    });

    const result = await discoverGrants(ME, d);

    expect(result.source).toBe("chain-events");
    expect(result.fallbackReason).toContain("404");
    expect(result.grants.map((g) => g.accountId)).toEqual([acct(7)]);
  });

  it("lists an unreadable candidate as unverified instead of dropping it", async () => {
    const d = deps({
      delegatedAccounts: vi.fn().mockResolvedValue({
        accounts: [],
        unverifiedAccounts: [acct(3)],
        truncated: false,
      }),
      readAccount: vi.fn().mockRejectedValue(new Error("rpc down")),
    });

    const result = await discoverGrants(ME, d);

    expect(result.grants).toEqual([]);
    expect(result.unverified).toEqual([acct(3)]);
  });

  it("reports every live grant when there is more than one, and picks none", async () => {
    const d = deps({
      delegatedAccounts: vi.fn().mockResolvedValue({
        accounts: [acct(1), acct(2)].map((accountId) => ({ accountId, ownerAddress: null, delegate: {} })),
        unverifiedAccounts: [],
        truncated: false,
      }),
      readAccount: vi.fn(async (id: string) => account(id, [{ address: ME, alias: "", expiresAtMs: null }])),
    });

    expect((await discoverGrants(ME, d)).grants).toHaveLength(2);
  });

  it("matches addresses however either source spelled them, and de-duplicates", async () => {
    const upper = (a: string): string => `0x${a.slice(2).toUpperCase()}`;
    const d = deps({
      delegatedAccounts: vi.fn().mockRejectedValue(new Error("down")),
      recentGrantEvents: vi.fn().mockResolvedValue([acct(5), upper(acct(5))]),
      readAccount: vi.fn().mockResolvedValue(account(acct(5), [{ address: ME, alias: "", expiresAtMs: null }])),
    });

    const result = await discoverGrants(upper(ME), d);

    expect(result.grants.map((g) => g.accountId)).toEqual([acct(5)]);
    expect(d.readAccount).toHaveBeenCalledTimes(1);
  });

  it("reads at most the bound and says the answer was cut short", async () => {
    const d = deps({
      delegatedAccounts: vi.fn().mockRejectedValue(new Error("down")),
      recentGrantEvents: vi.fn().mockResolvedValue(
        Array.from({ length: DISCOVERY_LIMIT + 5 }, (_, i) => acct(i + 1)),
      ),
      readAccount: vi.fn(async (id: string) => account(id, [])),
    });

    const result = await discoverGrants(ME, d);

    expect(result.truncated).toBe(true);
    expect(d.readAccount).toHaveBeenCalledTimes(DISCOVERY_LIMIT);
  });
});
