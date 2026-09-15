/**
 * The account reader: owner and delegates from the object, and a missing
 * object reported as missing — not as an unreadable one.
 */
import { wxaAccountCalls } from "@waterx/sdk";
import { describe, expect, it } from "vitest";

import { accountObjectReader, AccountNotFoundError, normalizeTypeName } from "../src/chain/account-object.ts";

const ID = `0x${"1".repeat(64)}`;
const OWNER = `0x${"2".repeat(64)}`;
const DELEGATE = `0x${"3".repeat(64)}`;

const config = { network: "testnet" as const, grpcUrl: "http://unused" };

describe("accountObjectReader", () => {
  it("returns a nonexistent account as AccountNotFoundError", async () => {
    const read = accountObjectReader(config, { core: { getObject: async () => ({ object: null }) } });

    await expect(read(ID)).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it("decodes the owner and each delegate's expiry and protocol permissions from the object", async () => {
    // Round-trip through the SDK's own codec, so this tests the reader's
    // mapping and not a hand-encoded guess at the layout.
    const Account = wxaAccountCalls.Account as unknown as {
      serialize(value: unknown): { toBytes(): Uint8Array };
    };
    let bytes: Uint8Array | undefined;
    try {
      bytes = Account.serialize({
        id: ID,
        owner_address: OWNER,
        alias: "main",
        delegates: [
          {
            delegate_address: DELEGATE,
            alias: "",
            permissions: 0,
            // As the chain writes it: the type name's address carries no `0x`.
            protocol_permissions: {
              contents: [{ key: { name: `${"4".repeat(64)}::account_data::WaterXPerp` }, value: 255 }],
            },
            expires_at_ms: "1700000000000",
          },
        ],
        // VecMap<TypeName, u64>; empty is a valid account with no balances.
        balances: { contents: [] },
      }).toBytes();
    } catch (error) {
      // The struct carries more fields than this fixture names; say so rather
      // than skip silently.
      throw new Error(`fixture no longer matches the SDK's Account layout: ${String(error)}`);
    }
    const read = accountObjectReader(config, {
      core: { getObject: async () => ({ object: { content: bytes } }) },
    });

    const result = await read(ID);

    expect(result.owner).toBe(OWNER);
    expect(result.delegates).toEqual([
      {
        address: DELEGATE,
        expiresAtMs: 1_700_000_000_000,
        protocolPermissions: new Map([[`${"4".repeat(64)}::account_data::WaterXPerp`, 255]]),
      },
    ]);
  });

  it("compares type names however their address was written", () => {
    // Move's TypeName carries the address unprefixed and padded; a caller
    // building the key from a package id usually does neither.
    expect(normalizeTypeName("0x2::coin::Coin")).toBe(`${"0".repeat(63)}2::coin::Coin`);
    expect(normalizeTypeName(`0x${"4".repeat(64)}::account_data::WaterXPerp`)).toBe(
      normalizeTypeName(`${"4".repeat(64)}::account_data::WaterXPerp`),
    );
  });
});
