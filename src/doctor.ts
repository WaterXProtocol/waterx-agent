/**
 * Preflight: prove the agent is pointed at a live, matching deployment before
 * it is asked to trade.
 *
 * The failure this exists to prevent is the one that just happened to this
 * repo: package ids, market lists and route names moved underneath a pinned
 * client, and nothing said so until a transaction aborted on chain with a code
 * that described the symptom rather than the cause. Every check below turns one
 * of those into a named, up-front failure.
 *
 * It is read-only and signs nothing, so it is safe to run under any execution
 * policy — including on mainnet.
 */
import { HttpClient } from "./api/http.ts";
import { ReadApi } from "./api/read.ts";
import { TxApi } from "./api/tx.ts";
import type { AppInfo } from "./api/types.ts";
import { type AgentConfig, isDefaultExtraPackage, loadConfig, signsAsDelegate } from "./config.ts";
import { ExecutionPolicyError } from "./errors.ts";
import { createSigner, signerReadiness } from "./chain/create-signer.ts";
import type { SignerProvider } from "./chain/signer.ts";
import {
  type Deployment,
  exceptionCovers,
  loadDeployment,
  manifestAgeMs,
  manifestGraceMs,
  normalizePackage,
  parseExceptions,
} from "./chain/deployment.ts";
import { ACTION_RULES, NEEDS_A_WAY_BACK, usesByPackage } from "./chain/verify.ts";
import { KNOWN_FUNCTIONS } from "./chain/abi.generated.ts";
import { CAPTURING_LAYOUTS, corpusFor, hasCorpusFor, measuredNetworks } from "./chain/corpus.ts";
import { PolicyGate } from "./policy.ts";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { accountObjectReader } from "./chain/account-object.ts";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface DoctorReport {
  config: AgentConfig;
  checks: DoctorCheck[];
  /** False when any check failed — the caller should not proceed to trade. */
  healthy: boolean;
  /**
   * Can this process read the deployment — markets, tickers, positions, orders?
   *
   * Separate from `writeReady` because the two have almost nothing in common.
   * A single `healthy` boolean told an agent with no key that everything was
   * broken, when in fact every read it was about to make would have worked;
   * and it told an agent whose backend was fine but whose account id was stale
   * that it could trade. Two questions, two answers.
   */
  readReady: boolean;
  /** Can this process sign and submit? Needs a signer, a policy that permits it, and an account. */
  writeReady: boolean;
  /** Could a signer be constructed? Reported without constructing one. */
  signerReady: boolean;
}

/**
 * The sampled transaction shapes an external user's first hour depends on.
 *
 * Onboarding and perp trading. A WLP mint is deliberately absent: it is a
 * separate product surface, it is the one shape that reaches a reward-coin type
 * the testnet config does not list, and treating its blockage as a failure of
 * the whole agent sent people to fix a setting the trading path never needed.
 */
const CORE_SHAPES: ReadonlySet<string> = new Set(["an order", "a withdrawal", "a deposit"]);

/**
 * The actions that must work under default settings for the quick start to run
 * end to end: create an account, fund it, place and manage a position.
 *
 * Used to decide whether an unconfirmed argument layout is a failure or a
 * caveat. WLP and staking are outside it — `pnpm run doctor` names them either
 * way, but an agent that only trades perps should not be told it is broken.
 */
const CORE_ACTIONS: ReadonlySet<string> = new Set([
  "createAccount",
  "deposit",
  "withdraw",
  "openLong",
  "openShort",
  "placeLimitOrder",
  "placeTpSl",
  "closePosition",
  "reducePosition",
  "increasePosition",
  "addMargin",
  "removeMargin",
  "cancelOrder",
  "updateOrder",
  "addDelegate",
  "removeDelegate",
]);

const ok = (name: string, detail: string): DoctorCheck => ({ name, status: "ok", detail });
const warn = (name: string, detail: string): DoctorCheck => ({ name, status: "warn", detail });
const fail = (name: string, detail: string): DoctorCheck => ({ name, status: "fail", detail });

export async function runDoctor(overrides: Partial<AgentConfig> = {}): Promise<DoctorReport> {
  const config = loadConfig(overrides);
  const read = new ReadApi(new HttpClient({ baseUrl: config.apiUrl }));
  const checks: DoctorCheck[] = [];

  // ── Signer ────────────────────────────────────────────────────────────
  // Two steps, because they answer different questions. `signerReadiness`
  // inspects configuration and loads nothing — so a preflight on a machine
  // with no key stays a preflight rather than becoming the first thing that
  // demands one. Only when a key IS configured is the signer built, because
  // then constructing it IS the check: a misconfigured external signer must
  // fail here and not at the first order.
  //
  // A missing key is a `warn`, not a `fail`. Every read below still works, and
  // reporting a fresh clone as broken sent people looking for a fault that was
  // just an empty `.env`.
  // ── Owner ─────────────────────────────────────────────────────────────
  // Before the signer check, which labels the key "owner" or "delegate" by
  // comparing it with this. WATERX_ACCOUNT_ID alone is enough: the owner is on
  // the account object. A configured owner that disagrees with the chain is the
  // failure worth naming — every delegate write would claim the wrong principal.
  if (config.accountId !== undefined) {
    try {
      const account = await accountObjectReader(config)(config.accountId);
      if (config.ownerAddress === undefined) {
        config.ownerAddress = account.owner;
        checks.push(ok("owner", `${account.owner} — read from ${config.accountId}`));
      } else if (normalizeSuiAddress(config.ownerAddress) !== account.owner) {
        checks.push(
          fail(
            "owner",
            `WATERX_OWNER_ADDRESS is ${config.ownerAddress}, but ${config.accountId} is owned by ` +
              `${account.owner} on chain. Remove WATERX_OWNER_ADDRESS — the owner is read from the account.`,
          ),
        );
      } else {
        checks.push(ok("owner", `${account.owner} — matches ${config.accountId} on chain`));
      }
    } catch (error) {
      checks.push(warn("owner", `could not read ${config.accountId} from chain — ${describe(error)}`));
    }
  }

  const readiness = signerReadiness(config);
  let signer: SignerProvider | undefined;
  let ownerAddress: string | undefined = config.ownerAddress;
  try {
    if (!readiness.ready) {
      checks.push(
        warn(
          "signer",
          `no key loaded — ${readiness.reason ?? "not configured"} ` +
            `Reads work without one; writes do not.`,
        ),
      );
    } else {
    signer = createSigner(config);
    ownerAddress = config.ownerAddress ?? signer.address;
    checks.push(ok("signer", `${signer.address} — ${signer.describe}, ${signerRole(config, signer.address)}`));
    // An unattended policy with the key in this address space is the
    // combination the signer boundary exists to avoid. It is legal, and it is
    // not what anyone should reach for on purpose.
    if (config.executionPolicy === "delegated-auto" && signer.kind === "in-process-keypair") {
      checks.push(
        warn(
          "signer boundary",
          "delegated-auto is signing from a key held in this process. Point " +
            "WATERX_SIGNER_COMMAND at a SIGNER_PROTOCOL provider so an exploited agent can " +
            "ask for a signature but never read the key.",
        ),
      );
    }
    }
  } catch (error) {
    checks.push(fail("signer", describe(error)));
  }

  // ── Execution policy ──────────────────────────────────────────────────
  // Built AFTER the signer, because whether this is a delegate is a comparison
  // against the signer's address — not a question about which variables are
  // set. Constructing the gate is also the scope check: an incomplete
  // delegated-auto scope throws here rather than at the first trigger.
  try {
    new PolicyGate(
      config.executionPolicy,
      config.policyScope,
      signer !== undefined && signsAsDelegate(config, signer.address),
    );
    const scope = config.policyScope;
    checks.push(
      ok(
        "execution policy",
        `${config.executionPolicy} on ${config.network} (${config.apiUrl})` +
          (config.executionPolicy === "delegated-auto" && scope !== undefined
            ? ` — max ${String(scope.maxCollateralPerOrder)}/order, ` +
              `${String(scope.maxCumulativeCollateral)} cumulative, ${String(scope.maxLeverage)}x, ` +
              `until ${scope.notAfter}`
            : ""),
      ),
    );
  } catch (error) {
    checks.push(fail("execution policy", describe(error)));
  }

  // ── Backend ───────────────────────────────────────────────────────────
  let info: AppInfo | undefined;
  try {
    info = await read.info();
    const expected = config.network === "mainnet" ? "sui_mainnet" : "sui_testnet";
    checks.push(
      info.network === expected
        ? ok("backend", `${config.apiUrl} → ${info.network}`)
        : fail(
            "backend",
            `${config.apiUrl} serves ${info.network} but the agent is configured for ${config.network}. ` +
              `Trading against a network mismatch is how a testnet script reaches mainnet funds.`,
          ),
    );
    checks.push(
      ok(
        "markets",
        `${String(info.markets.length)} listed — ${info.markets.map((m) => m.base).slice(0, 8).join(", ")}` +
          (info.markets.length > 8 ? ", …" : ""),
      ),
    );
    checks.push(
      ok(
        "collateral",
        `${info.collateral.symbol} (${info.collateral.decimals} dp); backing assets: ` +
          (info.backingAssets.map((a) => a.symbol).join(", ") || "none"),
      ),
    );
  } catch (error) {
    checks.push(fail("backend", `${config.apiUrl} unreachable — ${describe(error)}`));
  }

  // ── Deployment config ─────────────────────────────────────────────────
  // Read only to report what the deployment is running. The agent builds no
  // PTB from these ids; the point is that a version bump is visible here rather
  // than surfacing later as an on-chain version-gate abort.
  try {
    const deployment = await fetchDeploymentConfig(config.configUrl);
    const summary = ["waterx_perp", "waterx_account", "waterx_oracle", "waterx_rule"]
      .map((name) => {
        const pkg = deployment.packages[name];
        return pkg === undefined ? `${name}=absent` : `${name}=v${String(pkg.version)}`;
      })
      .join(" ");
    checks.push(ok("deployment config", summary));
  } catch (error) {
    checks.push(warn("deployment config", `${config.configUrl} unreadable — ${describe(error)}`));
  }

  // ── The deployment manifest ───────────────────────────────────────────
  // Loaded once, here, because everything below rests on it and because a
  // failure to load is not a caveat: `execute()` refuses under the same
  // condition, so a preflight that passed would be reporting health for an
  // agent that cannot trade.
  let deployment: Deployment | undefined;
  try {
    deployment = await loadDeployment(config.configUrl);
    const age = manifestAgeMs(config.configUrl) ?? 0;
    checks.push(
      ok(
        "manifest",
        `${String(deployment.byName.size)} packages, ${String(deployment.objects.size)} objects, ` +
          `read ${age < 60_000 ? "just now" : `${String(Math.round(age / 60_000))} minute(s) ago`}` +
          (manifestGraceMs() > 0
            ? ` — WATERX_MANIFEST_GRACE_MINUTES allows signing on a copy up to ` +
              `${String(Math.round(manifestGraceMs() / 60_000))} minute(s) stale when the ` +
              `document cannot be re-read`
            : ""),
      ),
    );
  } catch (error) {
    checks.push(
      fail(
        "manifest",
        `${config.configUrl} could not be read — ${describe(error)}. Every package pin, object ` +
          `role and recorded layout is checked against it, so no write can be signed until it ` +
          `is readable.`,
      ),
    );
  }

  // ── Packages the backend actually calls ───────────────────────────────
  // The verifier pins the DEFINING call's package to this deployment, which is
  // what stops a lookalike package satisfying every argument check. It does not
  // pin the surrounding oracle and rule legs, because the published config does
  // not currently list every package the backend composes with — pinning them
  // would refuse every trade. That divergence is worth seeing rather than
  // living in a comment, so it is checked here against a real build.
  if (
    config.accountId !== undefined &&
    ownerAddress !== undefined &&
    info !== undefined &&
    deployment !== undefined
  ) {
    const live = deployment;
    try {
      const market = info.markets[0];
      if (market === undefined) throw new Error("the deployment lists no markets");
      const ticker = `${market.base}USD`;
      const txApi = new TxApi(new HttpClient({ baseUrl: config.apiUrl }));
      const body = { sender: ownerAddress, accountId: config.accountId };
      const spot = (await read.ticker(ticker)).spotPrice;
      const asset = info.backingAssets[0]?.coinType;

      // Several shapes, not one. Each reaches packages the others never touch —
      // an order pulls in the oracle and rule legs, a WLP mint pulls in staking
      // and the reward coin's type. Sampling only an order under-reported by a
      // package, which would have sent an operator away with a list that was
      // still short. Nothing is signed or submitted; these are built and read.
      // Labels must match CORE_SHAPES below for the severity split to work.
      const shapes: [string, () => Promise<{ txBytes: string }>][] = [
        [
          "an order",
          async () => {
            for (const collateral of [4, 10, 25]) {
              try {
                return await txApi.marketOrder({
                  ...body,
                  ticker,
                  isLong: true,
                  collateralAmount: String(collateral * 1_000_000),
                  size: String(Math.floor(((collateral * 2) / spot) * 1e9)),
                });
              } catch {
                continue;
              }
            }
            throw new Error("no order could be built");
          },
        ],
        ["a WLP mint", () => txApi.mintWlp({ ...body, amount: "1000000" })],
        ["a withdrawal", () => txApi.withdraw({ ...body, route: "native", assetType: asset ?? "", amount: "1000000" })],
        ["a deposit", () => txApi.deposit({ ...body, assetType: asset ?? "", amount: "1000000" })],
      ];

      const uses = new Map<string, Set<string>>();
      const called = new Set<string>();
      const sampled: string[] = [];
      const skipped: string[] = [];
      // Which shape reached which package, kept apart rather than unioned.
      // Unioned, one unlisted package anywhere made every action look blocked:
      // on testnet the WLP mint carries `mock_deep::MOCK_DEEP` as a reward-coin
      // type argument, the config document does not list it, and a fresh user
      // was told "signing will be refused" about a perp flow that was fine.
      const reachedBy = new Map<string, Set<string>>();
      for (const [label, build] of shapes) {
        try {
          for (const [id, modules] of usesByPackage((await build()).txBytes)) {
            called.add(id);
            const seen = uses.get(id) ?? new Set<string>();
            for (const m of modules) seen.add(m);
            uses.set(id, seen);
            const via = reachedBy.get(id) ?? new Set<string>();
            via.add(label);
            reachedBy.set(id, via);
          }
          sampled.push(label);
        } catch {
          skipped.push(label);
        }
      }
      if (sampled.length === 0) throw new Error("no sample transaction could be built");
      const via =
        sampled.join(", ") + (skipped.length > 0 ? ` (could not build ${skipped.join(", ")})` : "");

      // Parsed the same way the verifier parses it, not by normalising the raw
      // string as an address. An entry is `0xPKG=sdkPackage::module`, so
      // treating the whole thing as an id matched nothing — and this check then
      // told operators their correct configuration was wrong while the signing
      // path accepted it.
      // Per package AND module, because an exception is qualified. Comparing
      // addresses alone reported a package as accepted while the signer refused
      // a module the exception did not cover — a diagnostic disagreeing with
      // the thing it is diagnosing.
      const exceptions = parseExceptions(config.extraPackages);
      const coversEveryUse = (id: string): boolean => {
        const modules = uses.get(id);
        if (modules === undefined || modules.size === 0) {
          // Reached only through a type argument; a bare id is enough.
          return exceptions.some((e) => e.pkg === id);
        }
        return [...modules].every((call) => {
          const [module = "", fn = ""] = call.split("::");
          return exceptions.some((e) => exceptionCovers(e, id, module, fn));
        });
      };
      const outside = [...called].filter((id) => !live.typeable.has(id));
      const unlisted = outside.filter((id) => !coversEveryUse(id));
      const named = outside.filter((id) => coversEveryUse(id));
      // An unlisted package only blocks the shapes that actually reach it.
      // A failure is reserved for the ones the onboarding and perp flow need;
      // anything reached solely by a side path is a warning that names which
      // action will refuse, so the fix stays proportionate to the problem.
      const blocksCore = unlisted.some((id) =>
        [...(reachedBy.get(id) ?? [])].some((label) => CORE_SHAPES.has(label)),
      );
      const affected = [
        ...new Set(unlisted.flatMap((id) => [...(reachedBy.get(id) ?? [])])),
      ].sort();
      // Packages whose exception cannot be qualified, because the SDK declares
      // none of the modules they serve. Named so the widening is a stated fact
      // rather than something an operator infers from a missing `=`.
      // Which of the accepted exceptions this package ships, as opposed to ones
      // the operator wrote. A default nobody typed still deserves to be seen.
      const shipped = named.filter((id) =>
        config.extraPackages.some(
          (entry) => normalizePackage(entry.split("=")[0] ?? "") === id && isDefaultExtraPackage(config.network, entry),
        ),
      );
      const unqualified = unlisted.filter(
        (id) => (uses.get(id)?.size ?? 0) > 0 && sdkPackageFor(uses.get(id)) === undefined,
      );
      // Order matters: a standing exception stays visible even once nothing is
      // outright unlisted, because "accepted because someone said so" is not
      // the same state as "accounted for by the deployment".
      checks.push(
        unlisted.length > 0
          ? (blocksCore ? fail : warn)(
              "packages",
              `the backend calls ${String(unlisted.length)} package(s) the deployment config ` +
                `does not list, and every Move call must belong to a package this agent can ` +
                `name — so ${affected.join(" and ")} will be refused before signing` +
                (blocksCore
                  ? `. `
                  : `. Nothing in the onboarding or perp trading flow reaches them. `) +
                `Either the config is stale or the deployment is running an unpublished ` +
                `package; that is worth resolving at the source. To proceed meanwhile, accept ` +
                `them explicitly:\n` +
                `        WATERX_EXTRA_PACKAGES=` +
                `${[...unlisted, ...named]
                  .map((id) => narrowest(id, uses.get(id), sdkPackageFor(uses.get(id))))
                  .join(",")}` +
                (unqualified.length === 0
                  ? ""
                  : `\n        ${unqualified.map((id) => `0x${id.slice(0, 8)}…`).join(", ")} is ` +
                    `accepted with \`=*\`, which runs its calls with nothing holding them to a ` +
                    `shape. That is wider than the qualified form, and it is the only form ` +
                    `available: the modules it calls belong to no package @waterx/sdk ` +
                    `declares, so there is no declaration to check them against.`),
            )
          : named.length > 0
            ? warn(
                "packages",
                `${String(called.size)} packages reached by ${via}; ${String(named.length)} of ` +
                  `them are accepted only because they are named as exceptions ` +
                  `(${named.map((id) => `0x${id.slice(0, 8)}…`).join(", ")})` +
                  (shipped.length === 0
                    ? ""
                    : `, ${String(shipped.length)} of those shipped as a default by this package ` +
                      `rather than named by you`) +
                  `. That is a standing exception to "every call belongs to this deployment" — ` +
                  `drop it once the config document lists them.`,
              )
            : ok(
                "packages",
                `all ${String(called.size)} packages reached by ${via} are listed in the ` +
                  `deployment config`,
              ),
      );
    } catch (error) {
      // Not a warning. The same condition that stops this comparison stops
      // `execute()` — reporting it as a caveat would show a healthy preflight
      // for an agent that cannot trade.
      checks.push(
        error instanceof ExecutionPolicyError
          ? fail("packages", describe(error))
          : warn("packages", `could not be compared — ${describe(error)}`),
      );
    }
  }

  // ── The corpus this deployment was measured against ───────────────────
  // Every positional check in `verify.ts` rests on argument layouts captured
  // from a transaction the deployment built. Nothing in CI can notice when the
  // deployment moves on — the fixture is a file, and a file does not go stale
  // by itself. So the comparison happens here, where the live manifest is in
  // hand, and it FAILS rather than warns: a verifier reading positions that
  // have not been confirmed against the running contract is checking the wrong
  // slots while appearing to work.
  if (deployment !== undefined) {
    const live = deployment;
    const corpus = corpusFor(config.network);
    // Moved, gone and arrived — the same comparison `execute()` makes, so the
    // preflight and the signing path cannot disagree about whether the corpus
    // still describes the deployment.
    const moved: string[] = [];
    for (const [name, id] of Object.entries(corpus.packages)) {
      const current = live.byName.get(name);
      if (current === undefined) moved.push(`${name} (no longer published)`);
      else if (current !== normalizePackage(id)) moved.push(name);
    }
    for (const name of live.byName.keys()) {
      // `Object.hasOwn`, matching the signing path: `in` walks the prototype
      // chain, so a package named `toString` read as already captured — and a
      // diagnostic that disagrees with the check it mirrors is worse than none.
      if (!Object.hasOwn(corpus.packages, name)) moved.push(`${name} (newly published)`);
    }

    // What an operator needs is the list of ACTIONS that will refuse, not the
    // raw entrypoints — the previous line named three of ten, including
    // `withdrawal_queue::route_wormhole`, which no action reaches at all, and
    // omitted the five position paths that were actually blocked.
    const unconfirmed = (entrypoint: string): boolean =>
      Object.hasOwn(corpus.uncaptured, entrypoint) &&
      !config.allowUnconfirmed.includes(entrypoint);

    const blocked = Object.keys(ACTION_RULES).filter(
      (action) =>
        unconfirmed(ACTION_RULES[action]?.entrypoint ?? "") ||
        // Shared with the signing path rather than restated: an action that
        // leaves a resting order refuses when the call that takes it back is
        // unconfirmed, and a preflight that listed it as working would be
        // disagreeing with the check it exists to mirror.
        unconfirmed(NEEDS_A_WAY_BACK[action]?.entrypoint ?? ""),
    );
    // Every blocked action. Filtering by `EXITS` here mirrored a rule the
    // signer no longer applies — the layout requirement covers exits too — and
    // a diagnostic that models the check rather than sharing it drifts the
    // moment the check changes.
    const refused = blocked;
    // What a reader actually needs alongside a list of refusals: the list of
    // what still works. A bare refusal list reads as "this is broken" when the
    // truth is usually "these three of twenty are unavailable".
    const working = Object.keys(ACTION_RULES)
      .filter((action) => !blocked.includes(action))
      .filter((action) => CORE_ACTIONS.has(action))
      .sort();
    const unchecked = Object.keys(corpus.uncaptured).filter((entrypoint) =>
      Object.values(ACTION_RULES).some((rule) => rule.entrypoint === entrypoint),
    );
    checks.push(
      !hasCorpusFor(config.network)
        ? fail(
            "abi corpus",
            `no argument layouts have ever been captured on ${config.network}. Every positional ` +
              `check reads them, so no write can be signed here — this is "we have never ` +
              `measured this deployment", not "there is nothing to measure". Measured: ` +
              `${measuredNetworks().join(", ") || "none"}. ${CAPTURING_LAYOUTS}`,
          )
        : moved.length > 0
        ? fail(
            "abi corpus",
            `the argument layouts were captured on ${corpus.capturedAt} against a deployment ` +
              `that has since changed: ${moved.join(", ")}. Every positional check is now ` +
              `unverified against the running contract, so writes refuse until the layouts are ` +
              `captured again and someone has looked at what changed. ${CAPTURING_LAYOUTS}`,
          )
        : unchecked.length > 0
          ? // A caveat when unconfirmed layouts are accepted, a failure when
            // they are not — otherwise the preflight reports health for an
            // agent that will refuse these actions at the first attempt.
            (refused.some((action) => CORE_ACTIONS.has(action)) ? fail : warn)(
              "abi corpus",
              // Both counts are of entrypoints. They used to be mixed with a
              // count of *actions*, which read as an arithmetic error to
              // anyone who then counted the names in the list.
              `${String(Object.keys(corpus.captured).length)} entrypoints confirmed against this ` +
                `deployment on ${corpus.capturedAt}; ${String(unchecked.length)} never were ` +
                `(${String(refused.length)} actions reach them). ` +
                (refused.length > 0
                  ? // Order matters: the "none of which" clause qualifies the REFUSED
                    // list, and putting the working list between them attached it
                    // to the wrong one.
                    `These actions refuse until they are: ${refused.join(", ")}` +
                    (refused.some((action) => CORE_ACTIONS.has(action))
                      ? "."
                      : " — none of which is part of onboarding or perp trading.") +
                    (working.length === 0
                      ? " "
                      : ` Everything else works, including ${working.slice(0, 6).join(", ")}` +
                        (working.length > 6 ? ` and ${String(working.length - 6)} more. ` : ". ")) +
                    `${CAPTURING_LAYOUTS} Until then, accept them deliberately:\n` +
                    `        WATERX_ALLOW_UNCONFIRMED_ABI=` +
                    // De-duplicated, because several actions share an
                    // entrypoint — `openLong`, `openShort`, `placeLimitOrder`
                    // and `placeTpSl` are all `place_order_request` — and the
                    // setting is a SET. The line printed here was refused by
                    // the very parser it was meant to be pasted into, which is
                    // the worst kind of diagnostic: one that disagrees with the
                    // check it mirrors.
                    `${[...new Set(refused.map((a) => ACTION_RULES[a]?.entrypoint ?? a))].join(",")}`
                  : `No action refuses: every unconfirmed entrypoint is named in ` +
                    `WATERX_ALLOW_UNCONFIRMED_ABI.`),
            )
          : ok(
              "abi corpus",
              `all ${String(Object.keys(corpus.captured).length)} entrypoints confirmed against ` +
                `this deployment on ${corpus.capturedAt}`,
            ),
    );
  }

  // ── Account ───────────────────────────────────────────────────────────
  if (ownerAddress !== undefined) {
    try {
      const accounts = await read.accounts(ownerAddress);
      if (accounts.length === 0) {
        checks.push(
          config.accountId === undefined
            ? warn(
                "account",
                `no WaterX account owned by ${ownerAddress}. The usual setup is a delegate: the ` +
                  `owner grants this wallet (\`onboard\` says where) and \`discover\` finds their ` +
                  `account. Only if this wallet should own one: \`create-account\`.`,
              )
            : fail(
                "account",
                `WATERX_ACCOUNT_ID is set to ${config.accountId} but ${ownerAddress} owns no account ` +
                  `on this deployment. The id is stale — clear it, then \`discover\` the account this ` +
                  `wallet was granted, or \`bootstrap --create-account --yes\` if it should own one.`,
              ),
        );
      } else {
        const configured = config.accountId;
        const known = accounts.map((a) => a.accountId);
        checks.push(
          configured === undefined
            ? warn(
                "account",
                `${String(accounts.length)} account(s) found but WATERX_ACCOUNT_ID is unset. ` +
                  `Set it to one of: ${known.join(", ")}`,
              )
            : known.includes(configured)
              ? ok("account", `${configured} owned by ${ownerAddress}`)
              : fail(
                  "account",
                  `WATERX_ACCOUNT_ID ${configured} is not owned by ${ownerAddress}. ` +
                    `Owned: ${known.join(", ")}`,
                ),
        );
      }
    } catch (error) {
      checks.push(warn("account", `lookup failed — ${describe(error)}`));
    }
  }

  // ── Delegate ──────────────────────────────────────────────────────────
  // Only meaningful when this process holds a delegate key. The masks are the
  // difference between an agent that trades and one that fails every order.
  if (config.ownerAddress !== undefined && config.accountId !== undefined && signer !== undefined) {
    try {
      const delegates = await read.delegates(config.accountId);
      const wallet = (signer?.address ?? "").toLowerCase();
      const mine = delegates.find((d) => d.delegateAddress.toLowerCase() === wallet);
      if (mine === undefined) {
        checks.push(
          fail(
            "delegate",
            `${signer?.address ?? "this signer"} is not a registered delegate of ${config.accountId}. ` +
              `The owner must run add-delegate first.`,
          ),
        );
      } else {
        checks.push(
          ok(
            "delegate",
            `perp: ${mine.permissionList.join(" ") || "none"} · ` +
              `predict: ${mine.predictPermissionList.join(" ") || "none"} · ` +
              `staking: ${mine.stakingPermissionList.join(" ") || "none"}`,
          ),
        );
        // A delegate can hold authority only in the superseded
        // `TradingRequest<CREDIT>` slot: it reads as fully permissioned and
        // aborts `EUnauthorized` on every order, surfacing as a generic 6002.
        // A backend carrying the delegate-mask fix reports that as `stale`. An
        // older one cannot, and says nothing either way — so absence is not
        // proof of health, and that distinction is the whole check.
        checks.push(
          mine.stale === true
            ? fail(
                "delegate scope",
                `this delegate holds authority only in the superseded TradingRequest slot, so ` +
                  `every perp action aborts on chain (EUnauthorized, surfaced as 6002). ` +
                  `The owner must re-add it.`,
              )
            : "stale" in mine
              ? ok("delegate scope", "authority is in the enforced account_data::WaterXPerp slot")
              : warn(
                  "delegate scope",
                  `this backend predates the delegate-mask fix and does not report whether the ` +
                    `delegate's authority is in the slot the chain enforces. A delegate added ` +
                    `before the dual-scope grant reads as authorised here and still fails on ` +
                    `chain — re-add it to be sure.`,
                ),
        );
      }
    } catch (error) {
      checks.push(warn("delegate", `lookup failed — ${describe(error)}`));
    }
  }

  // ── Readiness ─────────────────────────────────────────────────────────
  // Last, because it summarises everything above. Two booleans rather than one,
  // for the reason given on `DoctorReport`: "can I read?" and "can I sign?"
  // fail independently and an agent needs to branch on them independently.
  const failed = (name: string): boolean =>
    checks.some((c) => c.name === name && c.status === "fail");

  const readReady = info !== undefined;
  checks.push(
    readReady
      ? ok("read readiness", `markets, tickers, positions and orders are available at ${config.apiUrl}`)
      : fail("read readiness", `${config.apiUrl} did not answer — every read will fail`),
  );

  // Everything that stands between a decision and a signature. Each of these
  // refuses a write at a different point, and naming them individually is what
  // turns "not ready" into something an operator can act on in one pass.
  const blockers: string[] = [];
  if (!readiness.ready) blockers.push(`no signer (${readiness.reason ?? "not configured"})`);
  if (config.executionPolicy === "read-only") {
    blockers.push(
      `policy is read-only${config.network === "mainnet" ? " — the default on mainnet" : ""}`,
    );
  }
  if (config.accountId === undefined) {
    blockers.push("WATERX_ACCOUNT_ID is unset, so every account-scoped write refuses");
  }
  // A failed gate is a refusal at signing time, not a caveat. These are the
  // checks `execute()` makes for itself.
  for (const name of ["signer", "execution policy", "manifest", "packages", "abi corpus", "account", "delegate", "delegate scope"]) {
    if (failed(name)) blockers.push(`the "${name}" check failed`);
  }

  const writeReady = blockers.length === 0;
  checks.push(
    writeReady
      ? ok("write readiness", `${config.executionPolicy} on ${config.network} — writes can be signed`)
      : warn("write readiness", `writes will refuse: ${blockers.join("; ")}`),
  );

  return {
    config,
    checks,
    healthy: !checks.some((c) => c.status === "fail"),
    readReady,
    writeReady,
    signerReady: readiness.ready,
  };
}

interface DeploymentConfig {
  network?: string;
  packages: Record<string, { version?: number; published_at?: string } | undefined>;
}

async function fetchDeploymentConfig(url: string): Promise<DeploymentConfig> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return (await response.json()) as DeploymentConfig;
}

/**
 * The narrowest standing exception that covers how a package is actually used.
 *
 * A bare package id authorises everything that package will ever export;
 * naming the module keeps the exception to what the backend is observed to
 * call. A package reached only through a type argument needs no module at all.
 */
const narrowest = (
  id: string,
  calls: ReadonlySet<string> | undefined,
  sdkPackage: string | undefined,
): string => {
  if (calls === undefined || calls.size === 0) {
    // Named only in a type argument, so there is no call to qualify.
    return `0x${id}`;
  }
  // A qualified exception holds the call to a package's *declared* functions,
  // which means the SDK has to declare them. Mainnet's order path calls
  // `pyth_lazer::parse_and_verify_le_ecdsa_update_v2` — Pyth's package, not
  // WaterX's, so no SDK package will ever name it. This used to print
  // `<sdk-package>` for that case: a placeholder nobody could fill, in a line
  // whose only purpose is to be pasted.
  //
  // The bare id is wider than the qualified form and it is the only form that
  // works here. `unqualified` below says so in words rather than leaving an
  // operator to notice.
  // `=*` rather than a bare id: a bare id covers no call at all, so suggesting
  // one for a package the backend CALLS produced a line that looked like a fix
  // and changed nothing. The starred form is the honest spelling of what is
  // actually being granted.
  if (sdkPackage === undefined) return `0x${id}=*`;
  const modules = new Set([...calls].map((c) => c.split("::")[0] ?? ""));
  return [...modules].map((m) => `0x${id}=${sdkPackage}::${m}`).join(",");
};

/**
 * Which of the SDK's packages declares the modules seen at an address.
 *
 * The exception has to name one, so that a call through the address can be held
 * to that package's declared functions. Guessing it here saves the operator the
 * lookup; an ambiguous or unknown module leaves a placeholder to fill in.
 */
const sdkPackageFor = (calls: ReadonlySet<string> | undefined): string | undefined => {
  if (calls === undefined || calls.size === 0) return undefined;
  const modules = new Set([...calls].map((c) => c.split("::")[0] ?? ""));
  const candidates = [...KNOWN_FUNCTIONS.keys()]
    .map((key) => key.split("::"))
    .filter(([, module]) => module !== undefined && modules.has(module))
    .map(([pkg]) => pkg ?? "");
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : undefined;
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * What this key is to the account it acts on — including that there is none yet.
 *
 * "Owner key" used to be the answer whenever the key was not a delegate, and that
 * included having no account at all: a wallet `bootstrap` had just generated for
 * the delegate path was labelled the owner's key, one command away from `next`
 * calling the same process undecided. With no account there is nothing to own
 * and nothing to be a delegate of, and saying so is the only label that is true.
 */
export function signerRole(config: AgentConfig, signerAddress: string): string {
  if (signsAsDelegate(config, signerAddress)) return `delegate of ${config.ownerAddress ?? "?"}`;
  if (config.ownerAddress !== undefined) return "owner key";
  return config.accountId === undefined
    ? "no account yet, so neither an owner's key nor a delegate's until one is adopted or created"
    : `owner not settled — ${config.accountId} could not be read, so whose key this is is unknown`;
}
