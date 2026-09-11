/**
 * The risk limits this process is bound by — and the command that writes them.
 *
 * Two things are called "limits" here and they are not the same:
 *
 *  - **The execution policy** decides whether a signature may be produced at
 *    all: never (`read-only`), only with an explicit confirmation
 *    (`interactive`), or unattended inside a written scope (`delegated-auto`).
 *  - **The scope file** is that written scope: per-order and cumulative
 *    collateral, leverage, slippage, which accounts, which markets, and when it
 *    lapses. Every ceiling in it is mandatory, because an optional ceiling is
 *    one somebody forgets and a forgotten ceiling in an auto-approving policy
 *    is an unbounded one.
 *
 * Reading is the default and needs no key. `--write` produces a scope file from
 * flags, which exists so that "set up the agent's risk limits" is a command
 * rather than an invitation to hand-edit JSON — the failure mode of the latter
 * being a file that parses and is missing a ceiling.
 *
 * Note what a scope does NOT do: nothing on the perp side enforces a per-order
 * amount ceiling server-side, so this file is the only amount bound a delegate
 * has. It binds this process. It does not bind the key.
 */
import { writeFileSync } from "node:fs";

import { PolicyGate, type PolicyScope } from "../../src/policy.ts";
import { signerReadiness } from "../../src/chain/create-signer.ts";
import { succeeded } from "../../src/cli/contract.ts";
import { UsageError } from "../../src/errors.ts";
import { demand, initAgent, note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";

const args = parseArgs(
  {
    write: { desc: "Write a scope file to this path instead of reading the current one" },
    accounts: { desc: "Comma-separated account ids the scope covers (--write)" },
    markets: { desc: "Comma-separated tickers to allow. Omit for every listed market (--write)" },
    sides: { desc: "long,short — omit for both (--write)" },
    maxCollateralPerOrder: { desc: "Display USD per opening order (--write)" },
    maxCumulativeCollateral: { desc: "Display USD across this process's lifetime (--write)" },
    maxLeverage: { desc: "Leverage ceiling (--write)" },
    maxSlippagePercent: { desc: "Slippage ceiling in percent (--write)" },
    notAfter: { desc: "ISO-8601 instant after which nothing is signed (--write)" },
  },
  "limits",
);

await run(async () => {
  if (args.write !== undefined) {
    writeScope(args.write);
    return;
  }

  const agent = initAgent();
  const config = agent.config;
  const scope = config.policyScope;
  const readiness = signerReadiness(config);

  note("");
  note(`  policy        ${config.executionPolicy} on ${config.network}`);
  note(`  signer        ${readiness.ready ? readiness.kind : `none — ${readiness.reason ?? ""}`}`);
  note(`  account       ${config.accountId ?? "unset"}`);
  if (scope === undefined) {
    note("  scope         none");
    note("");
    note("  A scope is required only by delegated-auto. Under interactive, every write needs an");
    note("  explicit confirmation instead, which is the ceiling.");
  } else {
    note(`  accounts      ${scope.accounts.join(", ")}`);
    note(`  markets       ${scope.markets?.join(", ") ?? "any listed"}`);
    note(`  sides         ${scope.sides?.join(", ") ?? "both"}`);
    note(`  per order     $${String(scope.maxCollateralPerOrder)}`);
    note(`  cumulative    $${String(scope.maxCumulativeCollateral)}`);
    note(`  max leverage  ${String(scope.maxLeverage)}x`);
    note(`  max slippage  ${String(scope.maxSlippagePercent)}%`);
    note(`  expires       ${scope.notAfter}`);
  }
  note("");

  // Constructing the gate IS the validation: an incomplete `delegated-auto`
  // scope throws here rather than at the first trade. Reported as a finding
  // rather than thrown, so `limits` can always describe what it found.
  let scopeError: string | undefined;
  if (config.executionPolicy === "delegated-auto") {
    try {
      // `false` for the delegate question: this is a description of the
      // ceilings, not a claim about which key is loaded — and asking would
      // load it.
      new PolicyGate("delegated-auto", scope, true);
    } catch (error) {
      scopeError = error instanceof Error ? error.message : String(error);
      note(`  ⚠ ${scopeError}`);
      note("");
    }
  }

  show({
    executionPolicy: config.executionPolicy,
    network: config.network,
    accountId: config.accountId ?? null,
    signerReady: readiness.ready,
    scopeFile: process.env.WATERX_POLICY_SCOPE_FILE ?? null,
    scope: scope ?? null,
    scopeError: scopeError ?? null,
    /** What a write would be refused for, before any request is built. */
    writesAllowed: config.executionPolicy !== "read-only" && scopeError === undefined,
  }, { rendered: true });

  setOutcome(
    scopeError === undefined
      ? succeeded(`policy ${config.executionPolicy} on ${config.network}`)
      : {
          status: "config",
          message: scopeError,
          submitted: false,
          retryable: false,
          reconcileRequired: false,
          awaitingApproval: false,
        },
  );
});

function writeScope(path: string): void {
  const numeric = (value: string | undefined, flag: string): number => {
    const parsed = Number(demand(value, flag, "every ceiling in a scope is mandatory"));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new UsageError(`${flag} must be a positive number (got "${String(value)}").`);
    }
    return parsed;
  };
  const listOf = (value: string | undefined): string[] | undefined =>
    value === undefined
      ? undefined
      : value.split(",").map((v) => v.trim()).filter((v) => v.length > 0);

  const accounts = listOf(demand(args.accounts, "--accounts", '"any account" is not a scope'));
  const sides = listOf(args.sides);
  if (sides !== undefined && sides.some((s) => s !== "long" && s !== "short")) {
    throw new UsageError(`--sides accepts long and short only (got "${String(args.sides)}").`);
  }
  const notAfter = demand(args.notAfter, "--not-after", "a delegation with no end is not a scope");
  if (Number.isNaN(Date.parse(notAfter))) {
    throw new UsageError(`--not-after must be an ISO-8601 instant (got "${notAfter}").`);
  }

  const scope: PolicyScope = {
    accounts: accounts ?? [],
    ...(listOf(args.markets) === undefined ? {} : { markets: listOf(args.markets) as string[] }),
    ...(sides === undefined ? {} : { sides: sides as ("long" | "short")[] }),
    maxCollateralPerOrder: numeric(args.maxCollateralPerOrder, "--max-collateral-per-order"),
    maxCumulativeCollateral: numeric(args.maxCumulativeCollateral, "--max-cumulative-collateral"),
    maxLeverage: numeric(args.maxLeverage, "--max-leverage"),
    maxSlippagePercent: numeric(args.maxSlippagePercent, "--max-slippage-percent"),
    notAfter,
  };

  // Validated before it is written, by the same object that will enforce it.
  // A scope file that only reveals its gaps when a runner starts is a scope
  // file that was never checked.
  new PolicyGate("delegated-auto", scope, true);

  writeFileSync(path, `${JSON.stringify(scope, null, 2)}\n`, "utf8");
  note(`Wrote ${path}. Point WATERX_POLICY_SCOPE_FILE at it.`);
  show({ path, scope }, { rendered: true });
  setOutcome(succeeded(`scope written to ${path}`));
}
