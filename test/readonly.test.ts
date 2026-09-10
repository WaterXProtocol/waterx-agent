/**
 * A read must never need a key.
 *
 * The signer used to be built in `WaterXAgent`'s constructor, so every
 * invocation — `markets`, `ticker`, `positions` — loaded `SUI_PRIVATE_KEY`. Two
 * things were wrong with that. An external user's first command failed on a
 * fresh clone with a message about wallets, and an operator could not hand an
 * agent read access without handing it the ability to sign.
 *
 * These tests hold the seam in place. The property is not "reads happen to
 * work without a key" but "reaching the write plane is the only thing that
 * loads one", which is why `signerLoaded` is asserted alongside every read.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { WaterXAgent } from "../src/agent/agent.ts";
import { signerReadiness } from "../src/chain/create-signer.ts";
import { loadConfig } from "../src/config.ts";
import type { MarketInfo, TickerData } from "../src/api/types.ts";

const MARKETS: MarketInfo[] = [
  { ticker: "SUIUSD", category: "crypto", tradingHours: null, status: "open" } as MarketInfo,
];
const TICKER = { spotPrice: 2, stale: false } as TickerData;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("an agent with no key", () => {
  it("constructs, and has not loaded a signer", () => {
    const agent = new WaterXAgent();
    expect(agent.signerLoaded).toBe(false);
    expect(agent.signerReady).toBe(false);
  });

  it("resolves markets and prices without loading one", async () => {
    const agent = new WaterXAgent();
    vi.spyOn(agent.read, "markets").mockResolvedValue(MARKETS);
    vi.spyOn(agent.read, "ticker").mockResolvedValue(TICKER);

    expect(await agent.markets.resolveTicker("SUI")).toBe("SUIUSD");
    expect(await agent.markets.spotPrice("SUIUSD")).toBe(2);
    expect(agent.signerLoaded, "a read reached the key").toBe(false);
  });

  it("plans a write without loading one — deriving is not signing", async () => {
    // The whole point of the preview path. Everything about the order is
    // decided here, and none of it needs a key: the key is for the signature,
    // which is a different command in a different process.
    vi.stubEnv("WATERX_ACCOUNT_ID", `0x${"a".repeat(64)}`);
    const agent = new WaterXAgent();
    vi.spyOn(agent.read, "markets").mockResolvedValue(MARKETS);
    vi.spyOn(agent.read, "ticker").mockResolvedValue(TICKER);

    const plan = await agent.planOpenPosition({
      isLong: true,
      ticker: "SUI",
      collateral: 10,
      leverage: 2,
      slippagePercent: 0.5,
    });

    expect(plan.action).toBe("openLong");
    expect(plan.intent.sizeRaw).toBe("10000000000");
    expect(plan.request.kind).toBe("marketOrder");
    expect(agent.signerLoaded, "planning reached the key").toBe(false);
  });

  it("refuses at the write plane, naming what to do about it", () => {
    const agent = new WaterXAgent();
    expect(() => agent.executor).toThrow(/SUI_PRIVATE_KEY/);
    expect(() => agent.gate).toThrow(/generate-wallet|SUI_PRIVATE_KEY/);
  });

  it("answers 'could this process sign?' without loading anything", () => {
    expect(signerReadiness(loadConfig()).ready).toBe(false);
    vi.stubEnv("SUI_PRIVATE_KEY", "suiprivkey1-not-a-real-key");
    // Configuration only. A malformed key still reads as "configured" here and
    // fails at the first write, which is the honest place for it: that is a
    // failure of the key, not of the arrangement.
    expect(signerReadiness(loadConfig()).ready).toBe(true);
  });

  it("looks up accounts for a stated owner, no key involved", async () => {
    const agent = new WaterXAgent();
    const accounts = vi.spyOn(agent.read, "accounts").mockResolvedValue([]);
    await agent.accounts(`0x${"b".repeat(64)}`);
    expect(accounts).toHaveBeenCalledWith(`0x${"b".repeat(64)}`);
    expect(agent.signerLoaded).toBe(false);
  });
});
