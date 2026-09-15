/**
 * Where a grant's perp authority sits, read from chain.
 *
 * The check this replaces asked the backend, which flags a grant only when it is
 * in the wrong slot — so a healthy grant and a backend too old to say looked the
 * same, and every healthy grant got a warning that it might need re-granting.
 */
import { describe, expect, it } from "vitest";

import type { AccountDelegateEntry } from "../src/chain/account-object.ts";
import { delegateScope, enforcedPerpSlot } from "../src/chain/delegate-scope.ts";
import { normalizePackage } from "../src/chain/deployment.ts";

const PERP = `0x${"4".repeat(64)}`;
const P = normalizePackage(PERP);
const ENFORCED = `${P}::account_data::WaterXPerp`;
const SUPERSEDED = `${P}::request::TradingRequest<${"c".repeat(64)}::usd::USD>`;
const REQUESTED = { OPEN_POSITION: 1, CLOSE_POSITION: 2, PLACE_ORDER: 16 };

const entry = (permissions: [string, number][], expiresAtMs: number | null = null): AccountDelegateEntry => ({
  address: `0x${"a".repeat(64)}`,
  expiresAtMs,
  protocolPermissions: new Map(permissions),
});

const judge = (e: AccountDelegateEntry | undefined, now = 1_000) =>
  delegateScope({ entry: e, perpOriginalId: PERP, requested: REQUESTED, now });

describe("delegateScope", () => {
  it("confirms a grant in the slot the contract reads — the case that used to warn", () => {
    // What the console writes today: both slots, so the contract finds it.
    const verdict = judge(entry([[ENFORCED, 255], [SUPERSEDED, 255]]));

    expect(verdict.status).toBe("ok");
    expect(verdict.detail).toContain("confirmed on chain");
  });

  it("fails a grant held only in the superseded slot, and says to re-add it", () => {
    const verdict = judge(entry([[SUPERSEDED, 255]]));

    expect(verdict.status).toBe("fail");
    expect(verdict.detail).toMatch(/superseded/u);
    expect(verdict.detail).toMatch(/re-add/u);
  });

  it("fails a delegate with no perp authority anywhere", () => {
    expect(judge(entry([])).status).toBe("fail");
  });

  it("names exactly the bits the enforced slot is missing", () => {
    const verdict = judge(entry([[ENFORCED, 1 | 2]]));

    expect(verdict.status).toBe("warn");
    expect(verdict.detail).toContain("PLACE_ORDER");
    expect(verdict.detail).not.toContain("OPEN_POSITION");
  });

  it("fails a grant that has expired, whatever it holds", () => {
    const verdict = judge(entry([[ENFORCED, 255]], 500), 1_000);

    expect(verdict.status).toBe("fail");
    expect(verdict.detail).toMatch(/expired/u);
  });

  it("fails when this wallet is not a delegate on chain at all", () => {
    expect(judge(undefined).status).toBe("fail");
  });

  it("builds the slot key the same way however the package id is written", () => {
    expect(enforcedPerpSlot(PERP)).toBe(enforcedPerpSlot("4".repeat(64)));
    expect(enforcedPerpSlot("0x2")).toBe(`${"0".repeat(63)}2::account_data::WaterXPerp`);
  });
});
