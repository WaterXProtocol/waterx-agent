/**
 * The manifest has to keep describing the deployment that is running.
 *
 * Holding it for the life of the process was worse than it sounds. The
 * corpus-freshness check asserts that the recorded argument layouts still
 * describe the deployment — but it compares them against the manifest this
 * module holds, so a runner started before an upgrade kept the old ids, agreed
 * with itself, and signed against a contract that had moved. The check was
 * defeated by the cache for exactly the long-running process it was written to
 * protect.
 */
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  exceptionCovers,
  forgetDeployments,
  loadDeployment,
  manifestAgeMs,
  normalizePackage,
  type PackageException,
  parseExceptions,
} from "../src/chain/deployment.ts";

const SOURCE = { configUrl: "https://example.invalid", network: "testnet" } as const;

/**
 * A real testnet `schema_version: 2` document (the SDK's own fixture), so it
 * passes the SDK's `parseConfigDocument`, which validates every document read.
 */
const FIXTURE = readFileSync(new URL("./fixtures/waterx-config-v2-testnet.json", import.meta.url), "utf8");

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The fixture, edited. */
const v2Document = (edit: (doc: Doc) => void = () => {}): string => {
  const doc = JSON.parse(FIXTURE) as Doc;
  edit(doc);
  return JSON.stringify(doc);
};

/** The fixture with `waterx_perp` at `perp`. */
const document = (perp: string) =>
  v2Document((doc) => {
    doc.packages.waterx_perp = { published_at: perp, original_id: perp, version: 1 };
  });

let served: () => Promise<Response>;

beforeEach(() => {
  forgetDeployments();
  vi.useFakeTimers();
  vi.stubGlobal("fetch", () => served());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  forgetDeployments();
});

const ok = (body: string) => () =>
  Promise.resolve(new Response(body, { status: 200 }) as unknown as Response);
const dead = () => Promise.reject(new Error("network down"));

describe("the deployment manifest", () => {
  it("re-reads it once the copy in hand is old enough to have missed an upgrade", async () => {
    served = ok(document(`0x${"1".repeat(64)}`));
    const first = await loadDeployment(SOURCE);
    expect(first.byName.get("waterx_perp")).toBe("1".repeat(64));

    // The deployment upgrades while the process keeps running.
    served = ok(document(`0x${"2".repeat(64)}`));
    expect((await loadDeployment(SOURCE)).byName.get("waterx_perp")).toBe("1".repeat(64));

    vi.advanceTimersByTime(6 * 60_000);
    expect((await loadDeployment(SOURCE)).byName.get("waterx_perp")).toBe("2".repeat(64));
  });

  it("refuses rather than trade on a copy it cannot confirm", async () => {
    // An upgrade DURING an outage is exactly when the held manifest is wrong
    // and exactly when it cannot be corrected, so the default does not trade
    // through one.
    served = ok(document(`0x${"1".repeat(64)}`));
    await loadDeployment(SOURCE);
    served = dead;
    vi.advanceTimersByTime(6 * 60_000);
    await expect(loadDeployment(SOURCE)).rejects.toThrow(/could not be re-read/);
  });

  it("keeps serving the copy it has only for an allowance the operator set", async () => {
    vi.stubEnv("WATERX_MANIFEST_GRACE_MINUTES", "30");
    served = ok(document(`0x${"1".repeat(64)}`));
    await loadDeployment(SOURCE);
    served = dead;
    vi.advanceTimersByTime(6 * 60_000);
    expect((await loadDeployment(SOURCE)).byName.get("waterx_perp")).toBe("1".repeat(64));

    // And not past it.
    vi.advanceTimersByTime(40 * 60_000);
    await expect(loadDeployment(SOURCE)).rejects.toThrow(/could not be re-read/);
  });

  it("opens one request for concurrent cold starts", async () => {
    // The in-flight promise used to be kept on the cached entry, which on a
    // cold start does not exist — so each first caller opened its own request,
    // and whichever resolved LAST wrote the cache rather than whichever was
    // issued last. Two requests spanning an upgrade could leave the older
    // manifest in place.
    let opened = 0;
    served = () => {
      opened += 1;
      return Promise.resolve(new Response(document(`0x${"1".repeat(64)}`), { status: 200 }));
    };
    const [a, b, c] = await Promise.all([
      loadDeployment(SOURCE),
      loadDeployment(SOURCE),
      loadDeployment(SOURCE),
    ]);
    expect(opened).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("lets a later cold start retry after one fails", async () => {
    // The shared request has to be released on failure, or one unlucky start
    // would poison every attempt for the life of the process.
    served = dead;
    await expect(loadDeployment(SOURCE)).rejects.toThrow(/network down/);
    served = ok(document(`0x${"3".repeat(64)}`));
    expect((await loadDeployment(SOURCE)).byName.get("waterx_perp")).toBe("3".repeat(64));
  });

  it("propagates the failure when there is no copy to fall back on", async () => {
    served = dead;
    await expect(loadDeployment(SOURCE)).rejects.toThrow(/network down/);
    expect(manifestAgeMs(SOURCE)).toBeUndefined();
  });
});

/**
 * The document is the consolidated `schema_version: 2` shape, and only that.
 *
 * The legacy hosts keep serving the pre-v2 per-package shape while they are
 * retired. Read with the v2 walker that document yields every package and NO
 * objects, so every shared-object argument would be refused with a message
 * blaming the transaction — the endpoint is the thing that is wrong, and the
 * refusal has to say so.
 */
describe("the document schema", () => {
  const PERP = `0x${"1".repeat(64)}`;

  it("refuses a pre-v2 per-package document and names the v2 endpoints", async () => {
    // Shaped like the legacy config.waterx.app document: no schema_version, ids
    // nested under each package entry.
    served = ok(
      JSON.stringify({
        network: "testnet",
        packages: {
          waterx_perp: { published_at: PERP, original_id: PERP, version: 1, global_config: `0x${"a".repeat(64)}` },
        },
        coin_registry: "0xc",
      }),
    );
    await expect(loadDeployment(SOURCE)).rejects.toThrow(/not a usable waterx-config v2 document/);
    await expect(loadDeployment(SOURCE)).rejects.toThrow(/pre-v2/);
    await expect(loadDeployment(SOURCE)).rejects.toThrow(/main-v2\.waterx-config\.pages\.dev/);
  });

  it("refuses any other schema_version", async () => {
    served = ok(v2Document((doc) => (doc.schema_version = 3)));
    await expect(loadDeployment(SOURCE)).rejects.toThrow(/schema_version/);
  });

  it("refuses a v2 document with no objects block", async () => {
    served = ok(v2Document((doc) => delete doc.objects));
    await expect(loadDeployment(SOURCE)).rejects.toThrow(/objects: Required/);
  });

  it("refuses the other network's document", async () => {
    served = ok(v2Document());
    await expect(loadDeployment({ ...SOURCE, network: "mainnet" })).rejects.toThrow(
      /network mismatch/,
    );
  });
});

/**
 * Shared objects are read from `objects.*` and `oracle_rules.*`, by document
 * path, and package identity from `packages.*` alone.
 */
describe("object roles in the v2 document", () => {
  const PERP = `0x${"1".repeat(64)}`;
  const GLOBAL_CONFIG = `0x${"a".repeat(64)}`;
  const REGISTRY = `0x${"b".repeat(64)}`;
  const POOL = `0x${"c".repeat(64)}`;
  const RULE_CONFIG = `0x${"d".repeat(64)}`;
  const ENCLAVE = `0x${"e".repeat(64)}`;
  const MARKET = `0x${"f".repeat(64)}`;

  it("pins each role to the object at its document path", async () => {
    served = ok(
      v2Document((doc) => {
        doc.packages.waterx_perp = { published_at: PERP, original_id: PERP, version: 1 };
        doc.packages.waterx_rule = { published_at: `0x${"2".repeat(64)}`, original_id: `0x${"2".repeat(64)}`, version: 1 };
        doc.objects.perp.global_config = GLOBAL_CONFIG;
        doc.objects.perp.markets.BTCUSD.market = MARKET;
        doc.objects.account.registry = REGISTRY;
        doc.objects.wlp.pool = POOL;
        doc.oracle_rules.waterx.rule_config_object = RULE_CONFIG;
        doc.oracle_rules.waterx.enclave.object = ENCLAVE;
      }),
    );

    const deployment = await loadDeployment(SOURCE);

    expect(deployment.objectFor("objects.perp.global_config")).toBe(normalizePackage(GLOBAL_CONFIG));
    expect(deployment.objectFor("objects.account.registry")).toBe(normalizePackage(REGISTRY));
    expect(deployment.objectFor("objects.wlp.pool")).toBe(normalizePackage(POOL));
    expect(deployment.objectFor("objects.perp.markets.BTCUSD.market")).toBe(normalizePackage(MARKET));
    expect(deployment.objectFor("oracle_rules.waterx.rule_config_object")).toBe(normalizePackage(RULE_CONFIG));
    expect(deployment.objectFor("oracle_rules.waterx.enclave.object")).toBe(normalizePackage(ENCLAVE));
    // The pre-v2 role names find nothing — a binding still spelling one is a
    // refusal, not a silent match.
    expect(deployment.objectFor("waterx_perp.global_config")).toBeUndefined();
    expect(deployment.objectFor("waterx_account.account_registry")).toBeUndefined();

    for (const id of [GLOBAL_CONFIG, REGISTRY, POOL, MARKET, RULE_CONFIG, ENCLAVE]) {
      expect(deployment.objects.has(normalizePackage(id)), id).toBe(true);
    }
    // Package ids are call targets, never shared objects.
    expect(deployment.objects.has(normalizePackage(PERP))).toBe(false);
    expect(deployment.byName.get("waterx_perp")).toBe(normalizePackage(PERP));
    expect(deployment.byName.get("waterx_rule")).toBe("2".repeat(64));
    expect(deployment.versionOf("waterx_perp")).toBe(1);
    expect(deployment.versionOf("not_a_package")).toBeUndefined();
  });
});

/**
 * Standing package exceptions, and the three things they can say.
 *
 * `WATERX_EXTRA_PACKAGES` is how an operator accepts a package the deployment
 * document does not list. The grammar matters because the forms grant
 * different amounts, and until mainnet there was no way to write down the one
 * mainnet needs.
 */
describe("coin types the document declares", () => {
  const USDC = `0x${"d".repeat(64)}`;
  const DEEP = `0x${"e".repeat(64)}`;

  it("lets a declared coin be named as a type argument, and never called", async () => {
    // Shaped like mainnet's document: custody assets and staking rewarders
    // declare their coins by full type under `objects.*`, outside the
    // `packages` ids.
    served = ok(
      v2Document((doc) => {
        doc.objects.custody.assets[0].type = `${USDC}::usdc::USDC`;
        doc.objects.staking.rewarders.WLP.MOCK_DEEP.coin_type = `${DEEP}::deep::DEEP`;
      }),
    );

    const deployment = await loadDeployment(SOURCE);

    for (const coin of [USDC, DEEP]) {
      expect(deployment.typeable.has(normalizePackage(coin)), coin).toBe(true);
      expect(deployment.callable.has(normalizePackage(coin)), coin).toBe(false);
    }
  });

  it("reads only struct tags under coin keys, not every string that mentions an address", async () => {
    served = ok(
      v2Document((doc) => {
        Object.assign(doc.objects.perp, {
          note: `${USDC}::usdc::USDC`,
          type: "shared",
          coin_type: `${DEEP}::deep::DEEP<${USDC}::usdc::USDC>`,
        });
      }),
    );

    const deployment = await loadDeployment(SOURCE);

    expect(deployment.typeable.has(normalizePackage(USDC))).toBe(false);
    expect(deployment.typeable.has(normalizePackage(DEEP))).toBe(false);
  });
});

describe("package exceptions", () => {
  const PKG = normalizePackage(`0x${"e".repeat(64)}`);

  it("covers no call when only the id is given", () => {
    // The type-argument form. A package named only as a type never executes,
    // so a bare id must not be readable as permission to run code.
    const [bare] = parseExceptions([`0x${"e".repeat(64)}`]);
    expect(bare).toBeDefined();
    expect(exceptionCovers(bare as PackageException, PKG, "oracle", "aggregate")).toBe(false);
  });

  it("covers the calls a qualified exception names, and no others", () => {
    const [scoped] = parseExceptions([`0x${"e".repeat(64)}=@waterx/perp::trading`]);
    expect(exceptionCovers(scoped as PackageException, PKG, "trading", "place_order_request")).toBe(
      true,
    );
    expect(exceptionCovers(scoped as PackageException, PKG, "lp_pool", "mint_wlp")).toBe(false);
  });

  it("covers every call when spelled `=*`, and says so in its own shape", () => {
    // The form mainnet needs. Its order path calls
    // `pyth_lazer::parse_and_verify_le_ecdsa_update_v2` — Pyth's code, which no
    // @waterx/sdk release declares — so a qualified exception would have to
    // name a package that does not exist, and a bare id covers no call. The
    // grammar could not express the case at all, which did not make it safer:
    // it made the only options "refuse every mainnet order" or "edit the check".
    const [star] = parseExceptions([`0x${"e".repeat(64)}=*`]);
    expect(star?.unchecked).toBe(true);
    expect(star?.sdkPackage, "nothing is claimed about what it is").toBeUndefined();
    expect(exceptionCovers(star as PackageException, PKG, "pyth_lazer", "parse_and_verify")).toBe(
      true,
    );
    // Still only that package. Wider about what a package may do, never about
    // which package it is.
    expect(
      exceptionCovers(star as PackageException, normalizePackage(`0x${"f".repeat(64)}`), "x", "y"),
    ).toBe(false);
  });
});
