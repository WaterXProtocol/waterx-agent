/**
 * Settings that decide whether a check applies have to fail loudly when they
 * are wrong.
 *
 * Every one of these was a real defect: a value that parsed to "no limit" and
 * switched a guard off, a name that validated and matched nothing, a repeat
 * that read as an instruction. What they have in common is that the setting
 * looked present and did nothing, which is worse for an operator than a setting
 * that is absent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("WATERX_ALLOW_UNCONFIRMED_ABI", () => {
  const CLOSE = "trading::close_position_request";
  const REDEEM = "lp_pool::request_redeem";

  const fromEnv = (value: string) => {
    vi.stubEnv("WATERX_ALLOW_UNCONFIRMED_ABI", value);
    return loadConfig().allowUnconfirmed;
  };

  it("takes a list of entrypoints an allowance can apply to", () => {
    expect(fromEnv(`${CLOSE},${REDEEM}`)).toEqual([CLOSE, REDEEM]);
    expect(loadConfig({ allowUnconfirmed: [CLOSE] }).allowUnconfirmed).toEqual([CLOSE]);
  });

  it("refuses a repeat, from either direction", () => {
    // A set. A repeat is a typo or a merge artifact, and collapsing it silently
    // would hide the mistake rather than report it.
    expect(() => fromEnv(`${CLOSE},${CLOSE}`)).toThrow(/more than once/);
    expect(() => loadConfig({ allowUnconfirmed: [CLOSE, CLOSE] })).toThrow(/more than once/);
  });

  it("refuses a name no allowance could apply to, from either direction", () => {
    // Captured already, reached by no action, or misspelt: each is a setting
    // that reads as meaningful and does nothing.
    for (const name of ["trading::place_order_request", "withdrawal_queue::route_wormhole"]) {
      expect(() => fromEnv(name), name).toThrow(/no allowance can apply to|not an entrypoint/);
      expect(() => loadConfig({ allowUnconfirmed: [name] }), name).toThrow(
        /no allowance can apply to|not an entrypoint/,
      );
    }
  });

  it("refuses uppercase, empty entries and misspellings", () => {
    // Entrypoint names are case-sensitive on chain; one that validated and then
    // matched nothing was an allowance that silently was not one.
    expect(() => fromEnv(CLOSE.toUpperCase())).toThrow();
    expect(() => fromEnv(",,,")).toThrow();
    expect(() => fromEnv("trading::close_position_reqest")).toThrow();
  });

  it("has no blanket form", () => {
    for (const value of ["1", "true", "yes", "all"]) {
      expect(() => fromEnv(value), value).toThrow();
    }
  });

  it("is empty when unset, which means every unconfirmed action refuses", () => {
    expect(fromEnv("")).toEqual([]);
  });
});

describe("WATERX_MANIFEST_GRACE_MINUTES", () => {
  it("refuses values that would switch the stale-manifest guard off", () => {
    // `Number("abc")` is NaN and every comparison against NaN is false;
    // `Infinity` is false from the other end. Both meant an old manifest was
    // accepted indefinitely — the precise failure the guard exists to prevent.
    for (const value of ["abc", "Infinity", "-1"]) {
      vi.stubEnv("WATERX_MANIFEST_GRACE_MINUTES", value);
      expect(() => loadConfig(), value).toThrow(/not a number of minutes/);
    }
  });

  it("accepts a number of minutes", () => {
    vi.stubEnv("WATERX_MANIFEST_GRACE_MINUTES", "30");
    expect(() => loadConfig()).not.toThrow();
  });
});
