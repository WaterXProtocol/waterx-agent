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

const URL = "https://example.invalid/testnet.json";

const document = (perp: string) =>
  JSON.stringify({ packages: { waterx_perp: { published_at: perp, original_id: perp, version: 1 } } });

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
    const first = await loadDeployment(URL);
    expect(first.byName.get("waterx_perp")).toBe("1".repeat(64));

    // The deployment upgrades while the process keeps running.
    served = ok(document(`0x${"2".repeat(64)}`));
    expect((await loadDeployment(URL)).byName.get("waterx_perp")).toBe("1".repeat(64));

    vi.advanceTimersByTime(6 * 60_000);
    expect((await loadDeployment(URL)).byName.get("waterx_perp")).toBe("2".repeat(64));
  });

  it("refuses rather than trade on a copy it cannot confirm", async () => {
    // An upgrade DURING an outage is exactly when the held manifest is wrong
    // and exactly when it cannot be corrected, so the default does not trade
    // through one.
    served = ok(document(`0x${"1".repeat(64)}`));
    await loadDeployment(URL);
    served = dead;
    vi.advanceTimersByTime(6 * 60_000);
    await expect(loadDeployment(URL)).rejects.toThrow(/could not be re-read/);
  });

  it("keeps serving the copy it has only for an allowance the operator set", async () => {
    vi.stubEnv("WATERX_MANIFEST_GRACE_MINUTES", "30");
    served = ok(document(`0x${"1".repeat(64)}`));
    await loadDeployment(URL);
    served = dead;
    vi.advanceTimersByTime(6 * 60_000);
    expect((await loadDeployment(URL)).byName.get("waterx_perp")).toBe("1".repeat(64));

    // And not past it.
    vi.advanceTimersByTime(40 * 60_000);
    await expect(loadDeployment(URL)).rejects.toThrow(/could not be re-read/);
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
      loadDeployment(URL),
      loadDeployment(URL),
      loadDeployment(URL),
    ]);
    expect(opened).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("lets a later cold start retry after one fails", async () => {
    // The shared request has to be released on failure, or one unlucky start
    // would poison every attempt for the life of the process.
    served = dead;
    await expect(loadDeployment(URL)).rejects.toThrow(/network down/);
    served = ok(document(`0x${"3".repeat(64)}`));
    expect((await loadDeployment(URL)).byName.get("waterx_perp")).toBe("3".repeat(64));
  });

  it("propagates the failure when there is no copy to fall back on", async () => {
    served = dead;
    await expect(loadDeployment(URL)).rejects.toThrow(/network down/);
    expect(manifestAgeMs(URL)).toBeUndefined();
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
