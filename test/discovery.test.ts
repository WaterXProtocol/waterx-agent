/**
 * Discovery finds candidates anywhere and believes only the chain.
 */
import { describe, expect, it, vi } from "vitest";

import {
  awaitGrants,
  DISCOVERY_LIMIT,
  discoverGrants,
  type DiscoveryDeps,
} from "../src/agent/discovery.ts";
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
      readAccount: vi.fn().mockResolvedValue(account(acct(1), [{ address: ME, expiresAtMs: null, protocolPermissions: new Map() }])),
    });

    const result = await discoverGrants(ME, d);

    expect(result.source).toBe("backend");
    expect(result.grants).toEqual([{ accountId: acct(1), ownerAddress: OWNER, expiresAtMs: null }]);
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
          : account(id, [{ address: ME, expiresAtMs: 999_999, protocolPermissions: new Map() }]),
      ),
    });

    expect((await discoverGrants(ME, d)).grants).toEqual([]);
  });

  it("falls back to recent chain events when the backend cannot answer, and says why", async () => {
    const d = deps({
      delegatedAccounts: vi.fn().mockRejectedValue(new Error("GET /account/delegated → HTTP 404")),
      recentGrantEvents: vi.fn().mockResolvedValue([acct(7)]),
      readAccount: vi.fn().mockResolvedValue(account(acct(7), [{ address: ME, expiresAtMs: null, protocolPermissions: new Map() }])),
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
      readAccount: vi.fn(async (id: string) => account(id, [{ address: ME, expiresAtMs: null, protocolPermissions: new Map() }])),
    });

    expect((await discoverGrants(ME, d)).grants).toHaveLength(2);
  });

  it("matches addresses however either source spelled them, and de-duplicates", async () => {
    const upper = (a: string): string => `0x${a.slice(2).toUpperCase()}`;
    const d = deps({
      delegatedAccounts: vi.fn().mockRejectedValue(new Error("down")),
      recentGrantEvents: vi.fn().mockResolvedValue([acct(5), upper(acct(5))]),
      readAccount: vi.fn().mockResolvedValue(account(acct(5), [{ address: ME, expiresAtMs: null, protocolPermissions: new Map() }])),
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

/**
 * Waiting for a grant somebody is making in a browser right now.
 *
 * This replaced a person typing "I signed it" into a chat window — while the
 * console's own completion screen was already telling them the agent would pick
 * it up within seconds. What it may not do is give up early, or sit on an
 * answer it already has.
 */
describe("awaitGrants", () => {
  const granted = (id: string): DiscoveryDeps["delegatedAccounts"] =>
    vi.fn().mockResolvedValue({
      accounts: [{ accountId: id, ownerAddress: null, delegate: {} }],
      unverifiedAccounts: [],
      truncated: false,
    });
  const nothing = (): DiscoveryDeps["delegatedAccounts"] =>
    vi.fn().mockResolvedValue({ accounts: [], unverifiedAccounts: [], truncated: false });

  /** A clock that only moves when something sleeps. */
  const fake = (): { clock: () => number; sleep: (ms: number) => Promise<void>; at: () => number } => {
    let now = 0;
    return {
      clock: () => now,
      sleep: (ms: number) => {
        now += ms;
        return Promise.resolve();
      },
      at: () => now,
    };
  };

  it("looks once when no wait was asked for", async () => {
    const delegatedAccounts = nothing();
    const d = deps({ delegatedAccounts });

    const attempt = await awaitGrants(ME, d);

    expect(attempt.discovery?.grants).toEqual([]);
    expect(delegatedAccounts).toHaveBeenCalledTimes(1);
  });

  it("stops the moment a grant appears", async () => {
    const time = fake();
    const delegatedAccounts = vi
      .fn()
      .mockResolvedValueOnce({ accounts: [], unverifiedAccounts: [], truncated: false })
      .mockResolvedValue({
        accounts: [{ accountId: acct(1), ownerAddress: null, delegate: {} }],
        unverifiedAccounts: [],
        truncated: false,
      });
    const d = deps({
      delegatedAccounts,
      readAccount: vi.fn().mockResolvedValue(
        account(acct(1), [{ address: ME, expiresAtMs: null, protocolPermissions: new Map() }]),
      ),
    });

    const attempt = await awaitGrants(ME, d, {
      waitMs: 300_000,
      intervalMs: 10_000,
      sleep: time.sleep,
      clock: time.clock,
    });

    expect(attempt.discovery?.grants.map((g) => g.accountId)).toEqual([acct(1)]);
    expect(delegatedAccounts).toHaveBeenCalledTimes(2);
    expect(time.at(), "waited one interval, not the whole window").toBe(10_000);
  });

  it("treats an unreadable candidate as an answer rather than waiting it out", async () => {
    // An account may grant this wallet and could not be read. That is a fact to
    // report now — it is not the same as "nothing granted", and sitting on it
    // for five minutes tells the caller nothing it did not already know.
    const time = fake();
    const delegatedAccounts = vi
      .fn()
      .mockResolvedValue({ accounts: [], unverifiedAccounts: [acct(3)], truncated: false });
    const d = deps({ delegatedAccounts, readAccount: vi.fn().mockRejectedValue(new Error("rpc down")) });

    const attempt = await awaitGrants(ME, d, {
      waitMs: 300_000,
      intervalMs: 10_000,
      sleep: time.sleep,
      clock: time.clock,
    });

    expect(attempt.discovery?.unverified).toEqual([acct(3)]);
    expect(delegatedAccounts).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting through a look that failed, instead of calling an outage an answer", async () => {
    // Both sources can be down at once, and a wait is exactly the situation
    // where that fixes itself. Looking once — no wait — still hands the failure
    // straight back.
    const time = fake();
    const delegatedAccounts = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 502"))
      .mockResolvedValue({
        accounts: [{ accountId: acct(9), ownerAddress: null, delegate: {} }],
        unverifiedAccounts: [],
        truncated: false,
      });
    const d = deps({
      delegatedAccounts,
      recentGrantEvents: vi.fn().mockRejectedValue(new Error("graphql refused")),
      readAccount: vi.fn().mockResolvedValue(
        account(acct(9), [{ address: ME, expiresAtMs: null, protocolPermissions: new Map() }]),
      ),
    });

    const attempt = await awaitGrants(ME, d, {
      waitMs: 60_000,
      intervalMs: 10_000,
      sleep: time.sleep,
      clock: time.clock,
    });

    expect(attempt.failure).toBeUndefined();
    expect(attempt.discovery?.grants.map((g) => g.accountId)).toEqual([acct(9)]);
  });

  it("reports the last failure when the clock beats the outage", async () => {
    const time = fake();
    const d = deps({
      delegatedAccounts: vi.fn().mockRejectedValue(new Error("HTTP 502")),
      recentGrantEvents: vi.fn().mockRejectedValue(new Error("graphql refused")),
    });

    const attempt = await awaitGrants(ME, d, {
      waitMs: 25_000,
      intervalMs: 10_000,
      sleep: time.sleep,
      clock: time.clock,
    });

    expect(attempt.discovery).toBeUndefined();
    expect(attempt.failure).toContain("graphql refused");
  });

  it("never sleeps past the deadline the caller allowed", async () => {
    // `+ interval <= deadline`, not `< deadline`: overrunning the window is not
    // waiting, and a caller that said 15 seconds has something else to do at 15.
    const time = fake();
    const delegatedAccounts = nothing();
    const d = deps({ delegatedAccounts });

    await awaitGrants(ME, d, {
      waitMs: 15_000,
      intervalMs: 10_000,
      sleep: time.sleep,
      clock: time.clock,
    });

    expect(delegatedAccounts).toHaveBeenCalledTimes(2);
    expect(time.at()).toBeLessThanOrEqual(15_000);
  });

  it("uses the backend index when it answers, which is what makes this quick", async () => {
    const d = deps({ delegatedAccounts: granted(acct(4)), readAccount: vi.fn().mockResolvedValue(
      account(acct(4), [{ address: ME, expiresAtMs: null, protocolPermissions: new Map() }]),
    ) });

    const attempt = await awaitGrants(ME, d);

    expect(attempt.discovery?.source).toBe("backend");
  });
});
