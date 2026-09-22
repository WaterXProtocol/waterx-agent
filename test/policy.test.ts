/**
 * The scope is the only ceiling a perp delegate has — nothing enforces a
 * per-order or per-hour limit server-side — so its edges are tested rather than
 * assumed.
 */
import { describe, expect, it } from "vitest";

import { nextAfterAdoption, policyChoices } from "../src/policy.ts";

import { ExecutionPolicyError } from "../src/errors.ts";
import { loadConfig, signsAsDelegate } from "../src/config.ts";
import { narrowOnly, PolicyGate, type PolicyScope, type WriteIntent } from "../src/policy.ts";

const ACCOUNT = `0x${"a".repeat(64)}`;
const OTHER = `0x${"b".repeat(64)}`;

const scope = (overrides: Partial<PolicyScope> = {}): PolicyScope => ({
  accounts: [ACCOUNT],
  maxCollateralPerOrder: 50,
  maxOpenCollateral: 1000,
  maxCumulativeCollateral: 200,
  maxLeverage: 5,
  maxSlippagePercent: 1,
  notAfter: "2099-01-01T00:00:00Z",
  ...overrides,
});

/**
 * A world with no open positions. The gate refuses a write it cannot measure
 * against the concurrent ceiling, so tests about every *other* rule have to
 * state this rather than leave it out — a default of "assume nothing is open"
 * living in the gate is exactly the hole this ceiling closes.
 */
const NOTHING_OPEN = { openCollateral: 0 };

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
      new PolicyGate("delegated-auto", scope({ maxCollateralPerOrder: 100,
  maxOpenCollateral: 1000, maxCumulativeCollateral: 50 }), true),
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
    expect(() => gate.authorize(open({ collateral: 10 }), NOTHING_OPEN)).not.toThrow();
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
    expect(() => gate().authorize(open(), NOTHING_OPEN)).not.toThrow();
  });

  it("refuses an account the scope does not name", () => {
    expect(() => gate().authorize(open({ accountId: OTHER }))).toThrow(/not in the scope/);
  });

  it("refuses a market outside an allowlist, and allows one inside it", () => {
    const g = gate({ markets: ["BTCUSD"] });
    expect(() => g.authorize(open({ ticker: "ETHUSD" }))).toThrow(/ETHUSD/);
    expect(() => g.authorize(open({ ticker: "BTCUSD" }), NOTHING_OPEN)).not.toThrow();
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
    g.authorize(open({ collateral: 50 }), NOTHING_OPEN);
    g.authorize(open({ collateral: 40 }), NOTHING_OPEN);
    expect(g.spentCollateral).toBe(90);
    expect(() => g.authorize(open({ collateral: 20 }), NOTHING_OPEN)).toThrow(
      /cumulative collateral/,
    );
    // The refused order must not have been counted.
    expect(g.spentCollateral).toBe(90);
  });

  it("does not meter actions that reduce exposure", () => {
    const g = new PolicyGate(
      "delegated-auto",
      scope({ maxCollateralPerOrder: 100, maxOpenCollateral: 1000, maxCumulativeCollateral: 100 }),
      true,
    );
    g.authorize(open({ collateral: 100 }), NOTHING_OPEN);
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
  maxOpenCollateral: 1000,
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

/**
 * Three modes, offered as three.
 *
 * Both surfaces that lead someone here named exactly one of them -- the middle
 * one -- and an install relayed that single command to its user as the next
 * step rather than as one of three. Which mode to run is the part that is
 * theirs; a decision needs all of its options in front of it.
 */
describe("policyChoices", () => {
  const invoke = (command: string, ...args: string[]): string =>
    ["npx waterx", command, ...args].join(" ");

  it("offers all three, in rank order, and marks the one in force", () => {
    const choices = policyChoices({ current: "read-only", hasScope: false, invoke });

    expect(choices.map((c) => c.mode)).toEqual(["read-only", "interactive", "delegated-auto"]);
    expect(choices.filter((c) => c.current).map((c) => c.mode)).toEqual(["read-only"]);
  });

  it("says what each one costs, not just what it is called", () => {
    const [readOnly, interactive, auto] = policyChoices({
      current: "read-only",
      hasScope: true,
      invoke,
    });

    expect(readOnly?.means).toMatch(/nothing can be signed/u);
    // The approval ceremony is the point of this one, and it is not `--yes`.
    expect(interactive?.means).toMatch(/preview → approve → execute/u);
    expect(interactive?.means).toMatch(/records their name/u);
    // And this one says out loud that nobody is watching.
    expect(auto?.means).toMatch(/nobody watching/u);
    expect(auto?.means).toMatch(/scope file/u);
  });

  it("asks for confirmation only where the choice widens what may be signed", () => {
    const fromReadOnly = policyChoices({ current: "read-only", hasScope: true, invoke });
    expect(fromReadOnly.find((c) => c.mode === "read-only")?.command).not.toContain("--yes");
    expect(fromReadOnly.find((c) => c.mode === "interactive")?.command).toContain("--yes");

    // Turning writes off is never something to confirm.
    const fromAuto = policyChoices({ current: "delegated-auto", hasScope: true, invoke });
    expect(fromAuto.find((c) => c.mode === "read-only")?.command).not.toContain("--yes");
    expect(fromAuto.find((c) => c.mode === "interactive")?.command).not.toContain("--yes");
    expect(fromAuto.map((c) => c.widens)).toEqual([false, false, false]);
  });

  it("names the prerequisite rather than letting someone walk into a refusal", () => {
    // `--set delegated-auto` is refused without a scope file. An option that
    // cannot be taken yet has to say so where it is offered.
    const without = policyChoices({ current: "read-only", hasScope: false, invoke });
    const auto = without.find((c) => c.mode === "delegated-auto");

    expect(auto?.requires).toMatch(/scope file/u);
    expect(auto?.requiresCommand).toMatch(/limits --write/u);

    const with_ = policyChoices({ current: "read-only", hasScope: true, invoke });
    const satisfied = with_.find((c) => c.mode === "delegated-auto");
    expect(satisfied?.requires).toBeUndefined();
    expect(satisfied?.requiresCommand).toBeUndefined();
  });

  it("keeps commands out of the prose, because the prose gets wrapped", () => {
    // The prerequisite read "a scope file first: npx waterx limits --write
    // policy.json …, then WATERX_POLICY_SCOPE_FILE pointing at it", and the
    // screen's wrapper broke that command across three lines. A wrapped command
    // is one nobody can copy -- the same rule the authorize link is under.
    for (const scope of [true, false]) {
      for (const choice of policyChoices({ current: "read-only", hasScope: scope, invoke })) {
        expect(choice.means, choice.mode).not.toMatch(/waterx /u);
        expect(choice.requires ?? "", choice.mode).not.toMatch(/waterx /u);
      }
    }
  });

  it("emits commands that can be run as printed", () => {
    for (const choice of policyChoices({ current: "read-only", hasScope: true, invoke })) {
      expect(choice.command).toMatch(/^npx waterx policy --set /u);
    }
  });
});

/**
 * Two locks, and the second one is a choice.
 *
 * Adoption is when the on-chain grant lands, and when it becomes obvious that a
 * grant is not permission to trade: the local policy is still `read-only`. An
 * install worked that out for itself and told its user. Sending them to `next`
 * from here costs a hop before they are shown the decision that is theirs.
 */
describe("nextAfterAdoption", () => {
  const invoke = (command: string, ...args: string[]): string =>
    ["npx waterx", command, ...args].join(" ");

  it("sends a read-only process to the choice, not to another status read", () => {
    expect(nextAfterAdoption("read-only", invoke)).toBe("npx waterx policy --json");
  });

  it("leaves a process that can already sign on the normal loop", () => {
    expect(nextAfterAdoption("interactive", invoke)).toBe("npx waterx next --json");
    expect(nextAfterAdoption("delegated-auto", invoke)).toBe("npx waterx next --json");
  });
});

describe("the concurrent ceiling", () => {
  const gate = (overrides: Partial<PolicyScope> = {}): PolicyGate =>
    new PolicyGate("delegated-auto", scope({ maxOpenCollateral: 100, ...overrides }), true);

  it("refuses a write it cannot measure", () => {
    // The gate performs no I/O, so the measurement arrives from the caller. If
    // a caller forgets it, the honest answer is no: treating "unmeasured" as
    // "nothing open" would silently disable the only ceiling that bounds how
    // much can be at risk at one time.
    expect(() => gate().authorize(open({ collateral: 10 }))).toThrow(/without a measurement/);
  });

  it("refuses a measurement that is not a usable number", () => {
    // NaN > x is false for every x, so an unchecked NaN measurement would pass
    // the ceiling below no matter how much was actually open.
    expect(() => gate().authorize(open({ collateral: 10 }), { openCollateral: Number.NaN })).toThrow(
      /not a usable number/,
    );
    expect(() => gate().authorize(open({ collateral: 10 }), { openCollateral: -1 })).toThrow(
      /not a usable number/,
    );
  });

  it("refuses the order that would carry open collateral past the ceiling", () => {
    expect(() => gate().authorize(open({ collateral: 20 }), { openCollateral: 95 })).toThrow(
      /open collateral would reach 115, past the ceiling 100/,
    );
  });

  it("allows the order that lands exactly on it", () => {
    // A ceiling is a bound, not a gap: refusing 100 of 100 would make the
    // configured number mean something other than what it says.
    expect(() => gate().authorize(open({ collateral: 20 }), { openCollateral: 80 })).not.toThrow();
  });

  it("frees up when positions close, where the cumulative one never does", () => {
    // The two ceilings answer different questions, and this is the case that
    // separates them. An agent that opens and closes the same $50 position is
    // never holding more than $50 at risk, but each open still spends $50 of
    // the cumulative budget, which only ever decays. So a $200 cumulative
    // ceiling stops the fifth round trip on an account whose risk never moved:
    const cumulativeOnly = new PolicyGate(
      "delegated-auto",
      scope({ maxOpenCollateral: 100, maxCumulativeCollateral: 200 }),
      true,
    );
    for (let i = 0; i < 4; i += 1) {
      cumulativeOnly.authorize(open({ collateral: 50 }), { openCollateral: 50 });
    }
    expect(() =>
      cumulativeOnly.authorize(open({ collateral: 50 }), { openCollateral: 50 }),
    ).toThrow(/cumulative collateral/);

    // The concurrent ceiling measures what is open NOW, so the same round trip
    // is unbounded in count and still bounded in risk.
    const g = gate({ maxCumulativeCollateral: 100_000 });
    for (let i = 0; i < 20; i += 1) {
      expect(() => g.authorize(open({ collateral: 50 }), { openCollateral: 50 })).not.toThrow();
    }
  });

  it("does not measure an action that reduces exposure", () => {
    // Closing must stay available with the book full, or the ceiling traps
    // positions open — worse than having no ceiling at all.
    expect(() =>
      gate().authorize({
        action: "closePosition",
        accountId: ACCOUNT,
        increasesExposure: false,
        ticker: "BTCUSD",
      }),
    ).not.toThrow();
  });
});

describe("the cumulative ceiling across restarts", () => {
  const meter = (spent: number): { spent: number; entries: unknown[]; record: (e: unknown) => void } => {
    const entries: unknown[] = [];
    return { spent, entries, record: (e) => entries.push(e) };
  };

  it("starts from what was already spent, not from zero", () => {
    // Before this, a runner that crashed and restarted got its whole budget
    // back — so the cumulative ceiling bounded a process, not an installation.
    const m = meter(150);
    const g = new PolicyGate("delegated-auto", scope({ maxCumulativeCollateral: 200 }), true, m);

    expect(g.spentCollateral).toBe(150);
    expect(() => g.authorize(open({ collateral: 40 }), NOTHING_OPEN)).not.toThrow();
    expect(() => g.authorize(open({ collateral: 40 }), NOTHING_OPEN)).toThrow(
      /cumulative collateral/,
    );
  });

  it("records what it commits, so the next process can read it back", () => {
    const m = meter(0);
    const g = new PolicyGate("delegated-auto", scope(), true, m);
    g.authorize(open({ collateral: 10 }), NOTHING_OPEN);

    expect(m.entries).toEqual([{ action: "openLong", accountId: ACCOUNT, collateral: 10 }]);
  });

  it("records nothing for a write it refused", () => {
    // A ledger that counted refused orders would ratchet the ceiling down on
    // trades that never happened.
    const m = meter(0);
    const g = new PolicyGate("delegated-auto", scope(), true, m);

    expect(() => g.authorize(open({ collateral: 51 }), NOTHING_OPEN)).toThrow(/per-order/);
    expect(m.entries).toEqual([]);
  });

  it("records nothing for an action that reduces exposure", () => {
    const m = meter(0);
    const g = new PolicyGate("delegated-auto", scope(), true, m);
    g.authorize({
      action: "closePosition",
      accountId: ACCOUNT,
      increasesExposure: false,
      ticker: "BTCUSD",
    });

    expect(m.entries).toEqual([]);
  });
});
