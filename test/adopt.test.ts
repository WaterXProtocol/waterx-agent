import { describe, expect, it } from "vitest";

import {
  adoptAccount,
  type AdoptionEffects,
  NotAGrantError,
  OwnerMismatchError,
  verifyAdoptable,
} from "../src/agent/adopt.ts";
import type { AdoptionRecord } from "../src/agent/adoptions.ts";
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
      readAccount: reader({ delegates: [{ address: ME, expiresAtMs: null, protocolPermissions: new Map() }] }),
    });

    expect(result).toEqual({ accountId: ID, ownerAddress: OWNER, expiresAtMs: null });
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
        readAccount: reader({ delegates: [{ address: ME, expiresAtMs: 5, protocolPermissions: new Map() }] }),
        now: 10,
      }),
    ).rejects.toThrow(/expired/);
  });

  it("refuses to adopt an account this wallet owns", async () => {
    await expect(
      verifyAdoptable({ accountId: ID, delegate: OWNER, readAccount: reader({}) }),
    ).rejects.toThrow(/OWNS/);
  });

  it("matches the wallet however it was spelled", async () => {
    const upper = `0x${ME.slice(2).toUpperCase()}`;
    const result = await verifyAdoptable({
      accountId: ID,
      delegate: upper,
      readAccount: reader({ delegates: [{ address: ME, expiresAtMs: null, protocolPermissions: new Map() }] }),
    });

    expect(result.ownerAddress).toBe(OWNER);
  });
});

/**
 * Taking the account: the same checks, and then the two marks it leaves.
 *
 * Shared by `adopt` and by `onboard --wait`, which is the reason it is here
 * rather than in a script — two commands writing someone's account id in two
 * places is two places to get the order wrong.
 */
describe("adoptAccount", () => {
  const live = (): AccountObject["delegates"] => [
    { address: ME, expiresAtMs: null, protocolPermissions: new Map() },
  ];

  const spy = (): {
    effects: AdoptionEffects;
    order: string[];
    env: Record<string, string>;
    ledger: AdoptionRecord[];
  } => {
    const order: string[] = [];
    const env: Record<string, string> = {};
    const ledger: AdoptionRecord[] = [];
    return {
      order,
      env,
      ledger,
      effects: {
        ensureEnvIgnored: () => {
          order.push("gitignore");
          return { kind: "not-a-repo" };
        },
        saveToEnv: (key, value) => {
          order.push("env");
          env[key] = value;
        },
        recordAdoption: (input) => {
          order.push("ledger");
          const record: AdoptionRecord = { v: 2, at: 0, ...input };
          ledger.push(record);
          return record;
        },
      },
    };
  };

  it("writes the account id and a ledger line once the chain has confirmed the grant", async () => {
    const watch = spy();

    const adopted = await adoptAccount({
      accountId: ID,
      delegate: ME,
      network: "testnet",
      readAccount: reader({ delegates: live() }),
      approver: "Mario",
      effects: watch.effects,
    });

    expect(adopted.ownerAddress).toBe(OWNER);
    expect(watch.env).toEqual({ WATERX_ACCOUNT_ID: ID });
    expect(watch.ledger[0]).toMatchObject({ accountId: ID, by: "Mario", generated: false });
  });

  it("puts the ignore rule in before the line that would otherwise be committed", async () => {
    // `.waterx/` holds the adoption ledger — which account this agent trades.
    // A project that ignored only `.env` committed it, so the rule goes in
    // first, not alongside.
    const watch = spy();

    await adoptAccount({
      accountId: ID,
      delegate: ME,
      network: "testnet",
      readAccount: reader({ delegates: live() }),
      effects: watch.effects,
    });

    expect(watch.order).toEqual(["gitignore", "env", "ledger"]);
  });

  it("records a generated id when nobody gave a name, and says it was generated", async () => {
    // Adoption does not stop to ask for one. The record still needs a handle,
    // and it must never read as somebody's sign-off.
    const watch = spy();

    const adopted = await adoptAccount({
      accountId: ID,
      delegate: ME,
      network: "testnet",
      readAccount: reader({ delegates: live() }),
      effects: watch.effects,
    });

    expect(adopted.generated).toBe(true);
    expect(adopted.by).toMatch(/^auto-[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(watch.ledger[0]?.generated).toBe(true);
  });

  it("writes nothing when the grant has gone since discovery", async () => {
    const watch = spy();

    await expect(
      adoptAccount({
        accountId: ID,
        delegate: ME,
        network: "testnet",
        readAccount: reader({ delegates: [] }),
        effects: watch.effects,
      }),
    ).rejects.toBeInstanceOf(NotAGrantError);
    expect(watch.order).toEqual([]);
  });

  it("refuses when a configured owner disagrees with the chain, and writes nothing", async () => {
    // A leftover WATERX_OWNER_ADDRESS would make every write claim the wrong
    // principal. Refusing is better than writing a contradiction down.
    const watch = spy();

    await expect(
      adoptAccount({
        accountId: ID,
        delegate: ME,
        network: "testnet",
        readAccount: reader({ delegates: live() }),
        configuredOwner: `0x${"7".repeat(64)}`,
        effects: watch.effects,
      }),
    ).rejects.toBeInstanceOf(OwnerMismatchError);
    expect(watch.order).toEqual([]);
  });
});
