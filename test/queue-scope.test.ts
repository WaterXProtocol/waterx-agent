/**
 * Whether a queued intent is one the scope could ever permit.
 *
 * `queue` accepted everything. A 10x intent under a 3x ceiling, an ETH intent
 * under a SUI-only scope, a short under a long-only scope, an expired scope, the
 * wrong account — all were written to the inbox and answered `ok`, and the
 * refusal arrived later from a runner, one pass at a time, if a runner was up at
 * all. An operator who reads `ok` believes the queue has been validated.
 *
 * This was declined twice before shipping, for a reason that still holds: a
 * SECOND copy of a ceiling is worse than no check, because it drifts, and a
 * drifted copy of an authority rule refuses work that is fine and admits work
 * that is not. What made it shippable is the split — the rules whose answer
 * cannot change between queueing and signing are hoisted into one function that
 * both callers use, and the two that read live state are left where they are and
 * said out loud.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isOwnerOnlyAction, PolicyGate, type PolicyScope, type WriteIntent } from "../src/policy.ts";
import { actionOfIntent, admissible } from "../src/runner/scope.ts";
import type { Intent } from "../src/runner/types.ts";

const ACCOUNT = `0x${"a".repeat(64)}`;
const NOW = Date.parse("2026-10-02T00:00:00Z");

const SCOPE: PolicyScope = {
  accounts: [ACCOUNT],
  markets: ["SUIUSD", "BTCUSD"],
  sides: ["long"],
  maxCollateralPerOrder: 5,
  maxOpenCollateral: 10,
  maxCumulativeCollateral: 50,
  maxLeverage: 3,
  maxSlippagePercent: 1,
  notAfter: "2027-01-01T00:00:00Z",
};

const opening = (over: Partial<Extract<Intent, { kind: "open" }>> = {}): Intent => ({
  kind: "open",
  ticker: "SUIUSD",
  side: "long",
  collateral: "2",
  leverage: 2,
  slippagePercent: 0.5,
  ...over,
});

const check = (intent: Intent, at = NOW) => admissible(intent, SCOPE, ACCOUNT, at);

describe("the action a queued intent becomes", () => {
  /**
   * The load-bearing test of this whole module.
   *
   * `EXITS` and the owner-only set are keyed on the action NAME, so a name that
   * drifted from what the agent method actually declares would check a different
   * rule here than the gate applies there — and a check that silently applies the
   * wrong rule is the "validated" illusion this module exists to remove, not a fix
   * for it. Read out of the agent's own source rather than restated.
   */
  it("is a name the agent itself uses", () => {
    const source = readFileSync("src/agent/agent.ts", "utf8");
    const declared = new Set(
      [...source.matchAll(/action:\s*"([A-Za-z]+)"/gu)].map((m) => m[1] as string),
    );
    // `openLong`/`openShort` are built as a ternary rather than written as a
    // literal, so they are added from the line that builds them — found, not
    // assumed, or this test would pass on a file that no longer has them.
    expect(source, "openLong/openShort are no longer derived here").toMatch(
      /const action = params\.isLong \? "openLong" : "openShort";/u,
    );
    declared.add("openLong").add("openShort");

    const kinds: Intent[] = [
      opening(),
      opening({ side: "short" }),
      { kind: "limit", ticker: "SUIUSD", side: "long", collateral: "1", triggerPrice: "1" },
      { kind: "close", ticker: "SUIUSD", positionId: 1 },
      { kind: "cancel", ticker: "SUIUSD", orderId: 1 },
      { kind: "reduce", ticker: "SUIUSD", positionId: 1, percent: 50 },
      { kind: "increase", ticker: "SUIUSD", positionId: 1, collateral: "1" },
      { kind: "add-margin", ticker: "SUIUSD", positionId: 1, amount: "1" },
      { kind: "remove-margin", ticker: "SUIUSD", positionId: 1, amount: "1" },
      { kind: "wlp-mint", amount: "1" },
      { kind: "wlp-burn", amount: "1" },
      { kind: "wlp-cancel-burn", requestId: "r" },
      { kind: "wlp-claim" },
    ];
    expect(kinds).toHaveLength(13);
    for (const intent of kinds) {
      expect(declared, `${intent.kind} maps to a name the agent does not declare`).toContain(
        actionOfIntent(intent),
      );
    }
  });
});

describe("what queueing refuses", () => {
  const cases: [string, Intent, RegExp][] = [
    ["leverage past the ceiling", opening({ leverage: 10 }), /leverage 10x exceeds/u],
    ["a market the scope does not name", opening({ ticker: "ETHUSD" }), /market ETHUSD is not in/u],
    ["a side the scope does not allow", opening({ side: "short" }), /short is not an allowed side/u],
    ["slippage past the ceiling", opening({ slippagePercent: 5 }), /slippage 5% exceeds/u],
    ["collateral past the per-order ceiling", opening({ collateral: "50" }), /collateral 50 exceeds/u],
  ];

  for (const [label, intent, expected] of cases) {
    it(`refuses ${label}`, () => {
      expect(check(intent).violations.join("; ")).toMatch(expected);
    });
  }

  it("admits an intent every settled rule allows", () => {
    expect(check(opening()).violations).toEqual([]);
  });

  it("refuses an account the scope does not name, whatever else is right", () => {
    expect(admissible(opening(), SCOPE, `0x${"b".repeat(64)}`, NOW).violations.join("; ")).toMatch(
      /is not in the scope's account list/u,
    );
  });

  it("has no queueable kind that is an owner-only action", () => {
    // The real property, and the one worth pinning: these are refused under
    // delegated-auto whatever a scope says, and no `--kind` reaches one today. A
    // kind that did would be a way to queue a withdrawal, so this fails when one
    // is added rather than when somebody notices.
    //
    // The first version of this test asserted `violations` was EMPTY while being
    // named for a refusal — it passed, said the opposite of its name, and proved
    // nothing. Left noted because an assertion that cannot fail is the failure
    // mode this file is most exposed to.
    const everyKind: Intent[] = [
      opening(),
      opening({ side: "short" }),
      { kind: "limit", ticker: "SUIUSD", side: "long", collateral: "1", triggerPrice: "1" },
      { kind: "close", ticker: "SUIUSD", positionId: 1 },
      { kind: "cancel", ticker: "SUIUSD", orderId: 1 },
      { kind: "reduce", ticker: "SUIUSD", positionId: 1, percent: 50 },
      { kind: "increase", ticker: "SUIUSD", positionId: 1, collateral: "1" },
      { kind: "add-margin", ticker: "SUIUSD", positionId: 1, amount: "1" },
      { kind: "remove-margin", ticker: "SUIUSD", positionId: 1, amount: "1" },
      { kind: "wlp-mint", amount: "1" },
      { kind: "wlp-burn", amount: "1" },
      { kind: "wlp-cancel-burn", requestId: "r" },
      { kind: "wlp-claim" },
    ];
    for (const intent of everyKind) {
      expect(isOwnerOnlyAction(actionOfIntent(intent)), intent.kind).toBe(false);
    }
  });

  it("and refuses one outright if it ever appears", () => {
    // The guard asserted where it lives, so the property above has something to
    // rest on. A scope cannot widen this: it is checked before any ceiling.
    expect(isOwnerOnlyAction("withdraw")).toBe(true);
    expect(isOwnerOnlyAction("deposit")).toBe(true);
    expect(isOwnerOnlyAction("openLong")).toBe(false);
  });

  it("lists every violation, not just the first", () => {
    // A caller fixing a queued intent wants the list. The gate still refuses on
    // the first, because its message is a refusal rather than a report.
    const verdict = check(opening({ leverage: 10, ticker: "ETHUSD", side: "short" }));
    expect(verdict.violations.length).toBeGreaterThanOrEqual(3);
  });
});

describe("what only queueing can catch", () => {
  /**
   * An intent deferred past the scope's own end. At execution the refusal is
   * correct and useless: the work waited, the window closed, and the reason was
   * knowable when it was queued. The gate cannot catch it — at the moment it
   * runs, "now" is already past the expiry and it is just an expired scope.
   */
  it("refuses work scheduled past the delegation's expiry", () => {
    const afterTheEnd = Date.parse("2027-06-01T00:00:00Z");
    expect(check(opening(), afterTheEnd).violations.join("; ")).toMatch(/scope ended at/u);
    // And the same intent starting now is fine, so the refusal is about WHEN.
    expect(check(opening(), NOW).violations).toEqual([]);
  });
});

describe("what queueing refuses to answer", () => {
  /**
   * The two ceilings that read live state. An answer about them at queue time is
   * an answer about a different moment, and a caller told "in scope" on a stale
   * measurement is worse off than one told nothing — so they are absent rather
   * than approximated, and the gate still decides them at the signature.
   */
  it("does not decide the concurrent ceiling", () => {
    // Collateral under the per-order ceiling and over the concurrent one once
    // something is already open. Admitted here; the gate's business there.
    expect(check(opening({ collateral: "5" })).violations).toEqual([]);
  });

  it("and the gate still refuses it at the moment of signing", () => {
    const gate = new PolicyGate("delegated-auto", SCOPE, true);
    const intent: WriteIntent = {
      action: "openLong",
      accountId: ACCOUNT,
      increasesExposure: true,
      ticker: "SUIUSD",
      side: "long",
      collateral: 5,
      leverage: 2,
    };
    // 8 already open plus 5 is past the ceiling of 10. The queue said nothing
    // about this and was right to.
    expect(() => gate.authorize(intent, { openCollateral: 8 })).toThrow(/open collateral would reach/u);
  });
});

describe("a refused intent leaves nothing behind", () => {
  /**
   * The point of checking at admission rather than at the runner. A refusal that
   * still wrote the file would be a worse bug than the one being fixed: the
   * operator reads a refusal, the runner finds work, and the two disagree about
   * what was asked for.
   *
   * Spawned, because "nothing was written" is a claim about the filesystem.
   */
  it("writes nothing to the inbox when the scope refuses it", () => {
    const home = mkdtempSync(join(tmpdir(), "waterx-queue-"));
    const scopeFile = join(home, "scope.json");
    writeFileSync(scopeFile, JSON.stringify(SCOPE));
    writeFileSync(
      join(home, ".env"),
      [
        `WATERX_ACCOUNT_ID=${ACCOUNT}`,
        "WATERX_NETWORK=testnet",
        "WATERX_EXECUTION_POLICY=delegated-auto",
        `WATERX_POLICY_SCOPE_FILE=${scopeFile}`,
        "WATERX_SIGNER_COMMAND=keystore",
        "",
      ].join("\n"),
    );

    const queue = (...argv: string[]) =>
      spawnSync(process.execPath, [join(process.cwd(), "bin", "waterx.mjs"), "queue", ...argv, "--json"], {
        cwd: home,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: home },
      });

    const refused = queue("--kind", "open", "--ticker", "SUIUSD", "--collateral", "2", "--leverage", "10");
    const document = JSON.parse(refused.stdout) as { status?: string; message?: string };
    expect(document.status, refused.stdout).toBe("policy");
    expect(document.message ?? "").toMatch(/Nothing was written to the inbox/u);

    const inbox = join(home, ".waterx", "jobs.inbox");
    // Either absent or empty. Both are "nothing queued"; neither is a file the
    // runner would find.
    expect(existsSync(inbox) ? readdirSync(inbox) : []).toEqual([]);

    // And the admitted one DOES write, so the assertion above is about the
    // refusal rather than about a command that never works.
    const admitted = queue("--kind", "open", "--ticker", "SUIUSD", "--collateral", "2", "--leverage", "2");
    const ok = JSON.parse(admitted.stdout) as { status?: string; data?: { id?: string } };
    expect(ok.status, admitted.stdout).toBe("ok");
    expect(ok.data?.id, "the id has to reach the caller or the work cannot be found again").toBeDefined();
    expect(readdirSync(inbox)).toHaveLength(1);
  }, 90_000);

  it("says in the document that admission is not authorization", () => {
    // `queued` must not read as `authorized`. The two live-state ceilings are
    // named, so a caller knows exactly what was and was not decided.
    const home = mkdtempSync(join(tmpdir(), "waterx-queue-said-"));
    const scopeFile = join(home, "scope.json");
    writeFileSync(scopeFile, JSON.stringify(SCOPE));
    writeFileSync(
      join(home, ".env"),
      [
        `WATERX_ACCOUNT_ID=${ACCOUNT}`,
        "WATERX_NETWORK=testnet",
        "WATERX_EXECUTION_POLICY=delegated-auto",
        `WATERX_POLICY_SCOPE_FILE=${scopeFile}`,
        "WATERX_SIGNER_COMMAND=keystore",
        "",
      ].join("\n"),
    );
    const run = spawnSync(
      process.execPath,
      [join(process.cwd(), "bin", "waterx.mjs"), "queue", "--kind", "close", "--ticker", "SUIUSD", "--position-id", "1", "--json"],
      { cwd: home, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home } },
    );
    const document = JSON.parse(run.stdout) as {
      data?: { scopeChecked?: { settledRulesChecked?: boolean; decidedAtExecution?: string[] } };
    };
    expect(document.data?.scopeChecked?.settledRulesChecked).toBe(true);
    expect(document.data?.scopeChecked?.decidedAtExecution).toEqual([
      "maxOpenCollateral",
      "maxCumulativeCollateral",
    ]);
  }, 90_000);
});
