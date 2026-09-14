/**
 * The chain-events fallback for discovery.
 */
import { describe, expect, it, vi } from "vitest";

import { grantEventCandidates } from "../src/chain/grant-events.ts";

const PKG_BARE = "ff4afb7305886992843b700a363ebe4ae0dc6a727c4941043b565d0a3a7eb61d";
const ME = `0x${"a".repeat(64)}`;
const ACC = `0x${"1".repeat(64)}`;
const OTHER = `0x${"b".repeat(64)}`;

type Init = { method: string; headers: Record<string, string>; body: string };

const reply = (nodes: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: { events: { nodes } } }),
});

const event = (delegate: string, account: string) => ({
  contents: { json: { delegate, account_object_address: account } },
});

describe("grantEventCandidates", () => {
  it("names the event type with a 0x package id, even when handed a bare one", async () => {
    // Deployment.idsFor returns ids without 0x, and Sui GraphQL rejects that
    // as an invalid filter. Found by running discover against testnet.
    const fetchImpl = vi.fn(async (_url: string, _init: Init) => reply([]));

    await grantEventCandidates("testnet", PKG_BARE, fetchImpl as never, "http://gql")(ME);

    const types = fetchImpl.mock.calls.map((call) => (JSON.parse(call[1].body) as { variables: { type: string } }).variables.type);
    expect(types).toEqual([`0x${PKG_BARE}::events::DelegateAdded`, `0x${PKG_BARE}::events::DelegateUpdated`]);
  });

  it("returns each account whose events name this delegate once, however either was spelled", async () => {
    const upper = (a: string): string => `0x${a.slice(2).toUpperCase()}`;
    const fetchImpl = vi.fn(async () =>
      reply([event(ME, ACC), event(upper(ME), upper(ACC)), event(OTHER, `0x${"2".repeat(64)}`)]),
    );

    const found = await grantEventCandidates("testnet", PKG_BARE, fetchImpl as never, "http://gql")(upper(ME));

    expect(found).toEqual([ACC]);
  });

  it("throws on a GraphQL error instead of reporting that nothing was granted", async () => {
    // "Nothing found" would tell a person their grant did not land.
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: "Invalid filter format" }] }),
    }));

    await expect(
      grantEventCandidates("testnet", PKG_BARE, fetchImpl as never, "http://gql")(ME),
    ).rejects.toThrow("Invalid filter format");
  });

  it("throws on an HTTP failure", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));

    await expect(
      grantEventCandidates("testnet", PKG_BARE, fetchImpl as never, "http://gql")(ME),
    ).rejects.toThrow("503");
  });
});
