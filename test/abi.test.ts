/**
 * The generated ABI must still describe the SDK that is installed.
 *
 * `src/chain/abi.generated.ts` is committed, and everything the verifier does
 * with argument positions reads from it. If a dependency bump moves an argument
 * and nobody re-runs the generator, the verifier keeps reading the old
 * positions — checking the right-looking values in the wrong slots, which is
 * strictly worse than not checking at all.
 *
 * So the extraction is re-run here and compared. A failure means
 * `pnpm run generate-abi`, then a look at what moved and why.
 */
import { describe, expect, it } from "vitest";

import { ABI, SDK_VERSION } from "../src/chain/abi.generated.ts";
import { SDK_VERSION_INSTALLED, extractAbi } from "../scripts/dev/generate-abi.ts";
import corpus from "../src/chain/abi-corpus.json" with { type: "json" };

describe("the generated ABI is current", () => {
  it("was generated from the installed @waterx/sdk", () => {
    expect(
      SDK_VERSION,
      `abi.generated.ts came from @waterx/sdk ${SDK_VERSION} but ${SDK_VERSION_INSTALLED} is ` +
        `installed. Run \`pnpm run generate-abi\`.`,
    ).toBe(SDK_VERSION_INSTALLED);
  });

  it("matches what the SDK declares today", () => {
    const { entrypoints: fresh, known } = extractAbi();
    expect([...fresh.keys()].sort()).toEqual(Object.keys(ABI).sort());
    // The identity set the standing exception is checked against: an excepted
    // call still has to be a function the SDK describes.
    expect(known.size, "no known functions were extracted").toBeGreaterThan(1000);
    for (const [entrypoint, entry] of fresh) {
      const committed = ABI[entrypoint];
      expect(committed?.pkg, `${entrypoint} package`).toBe(entry.pkg);
      expect(committed?.params, `${entrypoint} parameter names`).toEqual(entry.params);
      expect(committed?.types, `${entrypoint} argument types`).toEqual(entry.types);
    }
  });
});

describe("the generated ABI matches the deployment", () => {
  /**
   * The check that the previous corpus could not make.
   *
   * That one compared each position to a BYTE WIDTH, which cannot see a
   * reordering of two same-width arguments — and nearly every entrypoint has a
   * pair: `request_withdraw` takes `accountId` and `recipient` as adjacent
   * 32-byte values, `deposit_collateral_request` takes `positionId` and
   * `collateralAmount` as adjacent u64s. Swap either and the verifier binds
   * each check to the wrong value while both appear to pass.
   *
   * So this compares VALUES. Each captured call was built with every argument
   * distinct; the fixture records what was sent for each parameter NAME and the
   * raw bytes at each POSITION. A reordering moves one and not the other.
   *
   * Regenerate with `pnpm run capture-corpus` against a funded testnet account.
   */
  const captured = corpus.captured as Record<
    string,
    {
      package: string;
      sent: Record<string, string>;
      positions: (string | null)[];
      typeArguments: string[];
    }[]
  >;
  const packages = corpus.packages as Record<string, string>;

  it("puts every captured value at the position the ABI names for it", () => {
    const wrong: string[] = [];
    for (const [entrypoint, instances] of Object.entries(captured)) {
      const abi = ABI[entrypoint];
      expect(abi, `${entrypoint} is captured but missing from the ABI`).toBeDefined();
      instances.forEach((instance, n) => {
        expect(
          instance.positions.length,
          `${entrypoint} instance ${String(n)}: the deployment passes ` +
            `${String(instance.positions.length)} arguments, the ABI declares ` +
            `${String(abi?.types.length)}`,
        ).toBe(abi?.types.length);
        for (const [name, sent] of Object.entries(instance.sent)) {
          const index = abi?.params.indexOf(name) ?? -1;
          if (index === -1) {
            wrong.push(`${entrypoint}.${name} is captured but the ABI has no such parameter`);
            continue;
          }
          const found = instance.positions[index];
          if (found !== sent) {
            wrong.push(
              `${entrypoint}[${String(index)}] should be ${name}=${sent} but the deployment ` +
                `puts ${String(found)} there`,
            );
          }
        }
      });
    }
    expect(
      wrong,
      `the deployment does not lay these arguments out the way the ABI says. Re-run ` +
        `\`pnpm run generate-abi\` after bumping the SDK; if that does not resolve it, the ` +
        `deployment is running a contract the installed SDK does not describe and the verifier ` +
        `is reading the wrong slots.`,
    ).toEqual([]);
  });

  it("captured each call from the package the manifest names for it", () => {
    // What joins the two halves of the fixture. Recording the layouts and the
    // manifest separately leaves room for a capture taken from a superseded
    // package that the deployment still answers on — both halves accurate, the
    // conclusion wrong.
    const mismatched: string[] = [];
    for (const [entrypoint, instances] of Object.entries(captured)) {
      const expected = packages[ABI[entrypoint]?.pkg ?? ""];
      if (expected === undefined) {
        mismatched.push(`${entrypoint}: the manifest names no package for ${ABI[entrypoint]?.pkg}`);
        continue;
      }
      for (const instance of instances) {
        if (instance.package !== expected) {
          mismatched.push(
            `${entrypoint} was captured from 0x${instance.package} but the manifest's ` +
              `${String(ABI[entrypoint]?.pkg)} is 0x${expected}`,
          );
        }
      }
    }
    expect(
      [...new Set(mismatched)],
      `these layouts were read off a package the manifest does not name for them, so they do ` +
        `not describe the deployment the manifest describes`,
    ).toEqual([]);
  });

  it("accounts for every entrypoint, captured or not", () => {
    // A gap in coverage has to be a stated one. Silently checking 12 of 22 and
    // calling it a corpus is how the width-only version looked complete.
    const uncaptured = corpus.uncaptured as Record<string, string>;
    const unaccounted = Object.keys(ABI).filter(
      (entrypoint) => !(entrypoint in captured) && !(entrypoint in uncaptured),
    );
    expect(
      unaccounted,
      `these entrypoints are neither captured from the deployment nor recorded as uncapturable ` +
        `with a reason: ${unaccounted.join(", ")}`,
    ).toEqual([]);
    for (const [entrypoint, why] of Object.entries(uncaptured)) {
      expect(why.trim().length, `${entrypoint} is uncaptured with no reason given`).toBeGreaterThan(
        20,
      );
    }
  });

  it("captures the argument that decides a delegate's protocol", () => {
    // The mask is a value, but WHICH protocol it applies to is the type
    // argument — so a capture that recorded only values would miss the thing
    // that makes the per-protocol ceilings mean anything.
    const grants = captured["account::set_delegate_protocol_permission"] ?? [];
    expect(grants.length, "no delegate grant was captured").toBeGreaterThan(1);
    const protocols = grants.map((g) => g.typeArguments[0] ?? "");
    expect(new Set(protocols).size, "every grant named the same protocol").toBeGreaterThan(1);
    for (const p of protocols) expect(p).toMatch(/::/);
  });
});
