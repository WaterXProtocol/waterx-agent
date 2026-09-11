/**
 * The scope is the only ceiling a perp delegate has — nothing enforces a
 * per-order or per-hour limit server-side — so its edges are tested rather than
 * assumed.
 */
import { describe, expect, it } from "vitest";

import { ExecutionPolicyError } from "../src/errors.ts";
import { loadConfig, signsAsDelegate } from "../src/config.ts";
import { narrowOnly, PolicyGate, type PolicyScope, type WriteIntent } from "../src/policy.ts";

const ACCOUNT = `0x${"a".repeat(64)}`;
const OTHER = `0x${"b".repeat(64)}`;

const scope = (overrides: Partial<PolicyScope> = {}): PolicyScope => ({
  accounts: [ACCOUNT],
  maxCollateralPerOrder: 50,
  maxCumulativeCollateral: 200,
  maxLeverage: 5,
  maxSlippagePercent: 1,
  notAfter: "2099-01-01T00:00:00Z",
  ...overrides,
});

const open = (overrides: Partial<WriteIntent> = {}): WriteIntent => ({
  action: "openLong",
  accountId: ACCOUNT,
  increasesExposure: true,
  ticker: "BTCUSD",
  side: "long",
  collateral: 10,
  leverage: 3,
  slippagePercent: 0.5,
  ...overrides,
});

describe("scope completeness", () => {
  it("refuses delegated-auto with no scope at all", () => {
    expect(() => new PolicyGate("delegated-auto", undefined, true)).toThrow(/not a policy/);
  });

  it("refuses a scope missing a mandatory ceiling", () => {
    for (const key of [
      "maxCollateralPerOrder",
      "maxCumulativeCollateral",
      "maxLeverage",
      "maxSlippagePercent",
    ] as const) {
      const incomplete = scope();
      delete (incomplete as Partial<PolicyScope>)[key];
      expect(() => new PolicyGate("delegated-auto", incomplete, true)).toThrow(key);
    }
  });

  it("refuses an empty account list — 'any account' is not a scope", () => {
    expect(() => new PolicyGate("delegated-auto", scope({ accounts: [] }), true)).toThrow(/accounts/);
  });

  it("refuses a malformed notAfter", () => {
    expect(() => new PolicyGate("delegated-auto", scope({ notAfter: "soon" }), true)).toThrow(/notAfter/);
  });

  it("refuses a cumulative ceiling below the per-order one — nothing could pass", () => {
    expect(() =>
      new PolicyGate("delegated-auto", scope({ maxCollateralPerOrder: 100, maxCumulativeCollateral: 50 }), true),
    ).toThrow(/no order could ever be placed/);
  });
});

describe("who may sign unattended", () => {
  it("refuses delegated-auto with the account owner's key", () => {
    // The escalation this closes. `delegated-auto`'s bound is that a delegate
    // cannot withdraw or grant authority — an owner key has both, so the scope
    // file would be the only thing between a bug and the balance.
    expect(() => new PolicyGate("delegated-auto", scope(), false)).toThrow(/OWNER's key/);
  });

  it("treats a configured owner address as proof of a delegate key", () => {
    // Regression: doctor built the gate with two arguments and got the default
    // `false`, so preflight told a correctly-configured delegate runner that it
    // was using an owner key. A guard that misfires on the valid configuration
    // gets switched off.
    const config = loadConfig({
      network: "testnet",
      apiUrl: "https://example.invalid",
      executionPolicy: "delegated-auto",
      policyScope: scope(),
      ownerAddress: OTHER,
    });
    expect(
      () =>
        new PolicyGate(
          config.executionPolicy,
          config.policyScope,
          config.ownerAddress !== undefined,
        ),
    ).not.toThrow();
  });

  it("accepts delegated-auto with a delegate key", () => {
    expect(() => new PolicyGate("delegated-auto", scope(), true)).not.toThrow();
  });

  it("is not satisfied by pointing the owner address at the signer itself", () => {
    // `ownerAddress !== undefined` was the old test, and it passes when the
    // owner IS the signer — leaving an owner key in an unattended process while
    // every "is a delegate configured?" check reads as satisfied.
    const signer = `0x${"d".repeat(64)}`;
    const config = loadConfig({
      network: "testnet",
      apiUrl: "https://example.invalid",
      executionPolicy: "delegated-auto",
      policyScope: scope(),
      ownerAddress: signer,
    });
    expect(signsAsDelegate(config, signer)).toBe(false);
    expect(signsAsDelegate(config, `0x${"e".repeat(64)}`)).toBe(true);
    // Case is not a way around it either.
    expect(signsAsDelegate(config, signer.toUpperCase().replace("0X", "0x"))).toBe(false);
  });

  it("refuses funds-out and authority changes under delegated-auto regardless", () => {
    // Braces to the belt above: the on-chain "a delegate cannot do this"
    // guarantee holds only while the key IS a delegate, and no scope file can
    // establish that. So the policy refuses these itself.
    const g = new PolicyGate("delegated-auto", scope(), true);
    for (const action of [
      "withdraw",
      "deposit",
      "createAccount",
      "addDelegate",
      "removeDelegate",
      "removeAllDelegates",
    ]) {
      expect(() =>
        g.authorize({ action, accountId: ACCOUNT, increasesExposure: false }),
      ).toThrow(/refused under delegated-auto/);
    }
  });

  it("still allows them under interactive, with confirmation", () => {
    const g = new PolicyGate("interactive");
    expect(() =>
      g.authorize(
        { action: "withdraw", accountId: ACCOUNT, increasesExposure: false },
        { confirm: true },
      ),
    ).not.toThrow();
  });
});

describe("unmeasurable amounts", () => {
  const g = (): PolicyGate => new PolicyGate("delegated-auto", scope(), true);

  it("refuses NaN rather than letting it through every comparison", () => {
    // NaN > x is false for all x, so an unchecked NaN passes each ceiling AND
    // poisons the running total, after which the cumulative ceiling can never
    // fire again. It arrives easily: Number(undefined), Number("10 USDC").
    const gate = g();
    expect(() => gate.authorize(open({ collateral: Number.NaN }))).toThrow(/no ceiling can bound/);
    expect(gate.spentCollateral).toBe(0);
    // The gate must still work afterwards.
    expect(() => gate.authorize(open({ collateral: 10 }))).not.toThrow();
    expect(gate.spentCollateral).toBe(10);
  });

  it("refuses negatives, which would credit the cumulative ceiling", () => {
    expect(() => g().authorize(open({ collateral: -100 }))).toThrow(/no ceiling can bound/);
  });

  it("refuses Infinity and non-numbers", () => {
    expect(() => g().authorize(open({ collateral: Number.POSITIVE_INFINITY }))).toThrow();
    expect(() =>
      g().authorize(open({ collateral: "10" as unknown as number })),
    ).toThrow(/no ceiling can bound/);
  });

  it("checks leverage and slippage the same way", () => {
    expect(() => g().authorize(open({ leverage: Number.NaN }))).toThrow(/leverage/);
    expect(() => g().authorize(open({ slippagePercent: Number.NaN }))).toThrow(/slippagePercent/);
  });
});

describe("scope enforcement", () => {
  const gate = (overrides: Partial<PolicyScope> = {}): PolicyGate =>
    new PolicyGate("delegated-auto", scope(overrides), true);

  it("allows an in-scope order", () => {
    expect(() => gate().authorize(open())).not.toThrow();
  });

  it("refuses an account the scope does not name", () => {
    expect(() => gate().authorize(open({ accountId: OTHER }))).toThrow(/not in the scope/);
  });

  it("refuses a market outside an allowlist, and allows one inside it", () => {
    const g = gate({ markets: ["BTCUSD"] });
    expect(() => g.authorize(open({ ticker: "ETHUSD" }))).toThrow(/ETHUSD/);
    expect(() => g.authorize(open({ ticker: "BTCUSD" }))).not.toThrow();
  });

  it("refuses a side the scope excludes", () => {
    expect(() => gate({ sides: ["long"] }).authorize(open({ side: "short" }))).toThrow(/short/);
  });

  it("refuses collateral over the per-order ceiling", () => {
    expect(() => gate().authorize(open({ collateral: 51 }))).toThrow(/per-order ceiling/);
  });

  it("refuses leverage over the ceiling", () => {
    expect(() => gate().authorize(open({ leverage: 6 }))).toThrow(/leverage/);
  });

  it("refuses slippage over the ceiling", () => {
    expect(() => gate().authorize(open({ slippagePercent: 2 }))).toThrow(/slippage/);
  });

  it("refuses an expired scope", () => {
    expect(() => gate({ notAfter: "2020-01-01T00:00:00Z" }).authorize(open())).toThrow(/ended at/);
  });
});

describe("the cumulative ceiling", () => {
  it("accrues across orders and refuses the one that would cross it", () => {
    const g = new PolicyGate("delegated-auto", scope({ maxCumulativeCollateral: 100 }), true);
    g.authorize(open({ collateral: 50 }));
    g.authorize(open({ collateral: 40 }));
    expect(g.spentCollateral).toBe(90);
    expect(() => g.authorize(open({ collateral: 20 }))).toThrow(/cumulative collateral/);
    // The refused order must not have been counted.
    expect(g.spentCollateral).toBe(90);
  });

  it("does not meter actions that reduce exposure", () => {
    const g = new PolicyGate(
      "delegated-auto",
      scope({ maxCollateralPerOrder: 100, maxCumulativeCollateral: 100 }),
      true,
    );
    g.authorize(open({ collateral: 100 }));
    // Closing must stay available at the ceiling: a risk limit that trapped a
    // position open would be worse than none.
    expect(() =>
      g.authorize({ action: "closePosition", accountId: ACCOUNT, increasesExposure: false, ticker: "BTCUSD" }),
    ).not.toThrow();
    expect(g.spentCollateral).toBe(100);
  });

  it("ignores the per-order ceilings for a reducing action", () => {
    const g = new PolicyGate("delegated-auto", scope({ maxLeverage: 2 }), true);
    expect(() =>
      g.authorize({
        action: "reducePosition",
        accountId: ACCOUNT,
        increasesExposure: false,
        ticker: "BTCUSD",
        leverage: 50,
      }),
    ).not.toThrow();
  });
});

describe("narrowOnly", () => {
  it("allows narrowing", () => {
    expect(narrowOnly("delegated-auto", "read-only")).toBe("read-only");
    expect(narrowOnly("interactive", "read-only")).toBe("read-only");
  });

  it("refuses widening — that is a configuration change, made in one place", () => {
    expect(() => narrowOnly("interactive", "delegated-auto")).toThrow(ExecutionPolicyError);
    expect(() => narrowOnly("read-only", "interactive")).toThrow(/Cannot widen/);
  });
});

describe("the ceilings never trap a position", () => {
  /**
   * The rule `EXITS` exists for, and now its only job: a risk LIMIT that
   * trapped a position open would be worse than none.
   *
   * It was briefly borrowed to decide which argument layouts could go
   * unverified, which is a different question with a different answer — so
   * this pins what the set is actually for, and that a caller cannot reach it
   * with a flag.
   */
  const scope: PolicyScope = {
    accounts: [`0x${"a".repeat(64)}`],
    maxCollateralPerOrder: 10,
    maxCumulativeCollateral: 20,
    maxLeverage: 3,
    maxSlippagePercent: 1,
    notAfter: "2099-01-01T00:00:00Z",
  };
  const exiting = (action: string): WriteIntent => ({
    action,
    accountId: `0x${"a".repeat(64)}`,
    increasesExposure: false,
    // Far past every ceiling: an exit is not metered against them at all.
    collateral: 1_000_000,
    leverage: 99,
  });

  for (const action of ["closePosition", "reducePosition", "addMargin", "cancelOrder"]) {
    it(`lets ${action} through a scope it would otherwise exceed`, async () => {
      const gate = new PolicyGate("delegated-auto", scope, true);
      await expect(
        gate.authorizeAndBuild(exiting(action), {}, () => Promise.resolve({ txBytes: "AA==" })),
      ).resolves.toBeDefined();
    });
  }

  it("meters an action outside that set however the caller flags it", async () => {
    // `increasesExposure` is supplied by the caller and bound to nothing in the
    // transaction. Claiming false on an opening order used to skip every
    // ceiling below.
    const gate = new PolicyGate("delegated-auto", scope, true);
    await expect(
      gate.authorizeAndBuild(exiting("openLong"), {}, () => Promise.resolve({ txBytes: "AA==" })),
    ).rejects.toThrow(/exceeds the ceiling/);
  });
});
