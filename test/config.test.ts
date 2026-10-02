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
import { classify } from "../src/cli/classify.ts";
import { ConfigError } from "../src/errors.ts";

import { loadConfig } from "../src/config.ts";
import { ACTION_RULES } from "../src/chain/verify.ts";
import { corpusFor } from "../src/chain/corpus.ts";

/** The suite runs with no `WATERX_NETWORK`, which is testnet — the fixture the
 *  committed captures describe. Named rather than inferred, so a change to the
 *  default network fails here instead of silently testing the other one. */
const corpus = corpusFor("testnet");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the default network", () => {
  it("is mainnet, because testnet does not work", () => {
    // Testnet's gas faucet refuses most first attempts, its collateral faucet
    // is whitelist-gated so retrying never produces trading funds, and its
    // keeper has not been filling — a correct order rests forever. Defaulting
    // there sent every new user down a road with three walls across it.
    vi.stubEnv("WATERX_NETWORK", "");
    vi.stubEnv("SUI_NETWORK", "");
    expect(loadConfig().network).toBe("mainnet");
  });

  it("still refuses to write there without someone saying so", () => {
    // Defaulting to mainnet is a decision about which deployment to READ. The
    // policy default is what keeps it from being a decision about spending.
    vi.stubEnv("WATERX_NETWORK", "");
    expect(loadConfig().executionPolicy).toBe("read-only");
  });

  it("ships the package exceptions mainnet cannot trade without", () => {
    // The mainnet config document does not list the Pyth Lazer package every
    // order calls. Shipped rather than pasted: an opaque id a user cannot
    // evaluate is not informed consent, and it lands somewhere nobody reviews.
    vi.stubEnv("WATERX_NETWORK", "mainnet");
    const shipped = loadConfig().extraPackages;
    expect(shipped.some((e) => e.endsWith("=*"))).toBe(true);
    expect(shipped.length).toBeGreaterThan(0);
    // And testnet ships none, because its config document is complete.
    vi.stubEnv("WATERX_NETWORK", "testnet");
    expect(loadConfig().extraPackages).toEqual([]);
  });

  it("lets a named set REPLACE the shipped one, so a default can be narrowed", () => {
    vi.stubEnv("WATERX_NETWORK", "mainnet");
    vi.stubEnv("WATERX_EXTRA_PACKAGES", "0xabc");
    expect(loadConfig().extraPackages).toEqual(["0xabc"]);
  });
});

describe("WATERX_ALLOW_UNCONFIRMED_ABI", () => {
  // Taken from the corpus, not named. The set of unconfirmed entrypoints
  // shrinks every time `capture-corpus` finds conditions it could not build
  // before, and a test that hard-codes one of them starts failing on the day
  // the fixture gets better — which is the wrong day to be reading a red suite.
  const UNCONFIRMED = Object.keys(ACTION_RULES)
    .map((action) => ACTION_RULES[action]?.entrypoint ?? "")
    .filter((entrypoint) => Object.hasOwn(corpus.uncaptured, entrypoint));
  const [CLOSE, REDEEM] = [...new Set(UNCONFIRMED)];

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

describe("a configuration mistake is not an outage", () => {
  // `WATERX_NETWORK=devnet` answered `unavailable` — exit 7, which this
  // contract reserves for "retrying is safe". So an agent branching on the exit
  // code retried a typo, forever, and the one thing that would have fixed it is
  // the one thing retrying never does. Every refusal in this file is a value
  // somebody typed, and none of them gets better by being asked again.
  const refusals: [string, string, string][] = [
    ["an unknown network", "WATERX_NETWORK", "devnet"],
    ["an unknown execution policy", "WATERX_EXECUTION_POLICY", "yolo"],
    // A bare word is a command NAME and is accepted; a broken array is not.
    ["a signer command whose array is malformed", "WATERX_SIGNER_COMMAND", '["keystore",'],
  ];

  for (const [label, key, value] of refusals) {
    it(`reports ${label} as configuration, not as transient`, () => {
      vi.stubEnv(key, value);
      let thrown: unknown;
      try {
        loadConfig();
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${label} was accepted`).toBeInstanceOf(ConfigError);
      const outcome = classify(thrown);
      expect(outcome.status).toBe("config");
      expect(outcome.retryable, "an agent told to retry a typo retries it forever").toBe(false);
    });
  }
});
