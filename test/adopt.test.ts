import { describe, expect, it } from "vitest";

import { NotAGrantError, verifyAdoptable } from "../src/agent/adopt.ts";
import type { AccountObject } from "../src/chain/account-object.ts";

const ME = `0x${"a".repeat(64)}`;
const OWNER = `0x${"0".repeat(63)}9`;
const ID = `0x${"1".repeat(64)}`;

const reader = (account: Partial<AccountObject>) => async (): Promise<AccountObject> => ({
  accountId: ID,
  owner: OWNER,
  delegates: [],
  ...account,
});

describe("verifyAdoptable", () => {
  it("returns the owner from chain for a live grant", async () => {
    const result = await verifyAdoptable({
      accountId: ID,
      delegate: ME,
      readAccount: reader({ delegates: [{ address: ME, alias: "", expiresAtMs: null }] }),
    });

    expect(result).toEqual({ accountId: ID, ownerAddress: OWNER, alias: "", expiresAtMs: null });
  });

  it("refuses an account that does not grant this wallet", async () => {
    // The id came from a command line. Writing it down unchecked would make
    // the agent act on an account it has no authority over.
    await expect(
      verifyAdoptable({ accountId: ID, delegate: ME, readAccount: reader({ delegates: [] }) }),
    ).rejects.toBeInstanceOf(NotAGrantError);
  });

  it("refuses a grant that has expired since discovery", async () => {
    await expect(
      verifyAdoptable({
        accountId: ID,
        delegate: ME,
        readAccount: reader({ delegates: [{ address: ME, alias: "", expiresAtMs: 5 }] }),
        now: 10,
      }),
    ).rejects.toThrow(/expired/);
  });

  it("refuses to adopt an account this wallet owns", async () => {
    await expect(
      verifyAdoptable({ accountId: ID, delegate: OWNER, readAccount: reader({}) }),
    ).rejects.toThrow(/OWNS/);
  });

  it("hands back the alias the grant wrote, read now rather than at discovery", async () => {
    // Pairing is judged on this value, so it comes from the same chain read as
    // the grant itself — not from whatever discovery saw minutes earlier.
    const result = await verifyAdoptable({
      accountId: ID,
      delegate: ME,
      readAccount: reader({ delegates: [{ address: ME, alias: "waterx-agent:K7Q2M9XDP4R8", expiresAtMs: null }] }),
    });

    expect(result.alias).toBe("waterx-agent:K7Q2M9XDP4R8");
  });

  it("matches the wallet however it was spelled", async () => {
    const upper = `0x${ME.slice(2).toUpperCase()}`;
    const result = await verifyAdoptable({
      accountId: ID,
      delegate: upper,
      readAccount: reader({ delegates: [{ address: ME, alias: "", expiresAtMs: null }] }),
    });

    expect(result.ownerAddress).toBe(OWNER);
  });
});
