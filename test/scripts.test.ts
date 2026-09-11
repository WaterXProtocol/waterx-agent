/**
 * A structural trap in the CLI scripts, caught statically.
 *
 * Every script ends with a top-level `await run(async () => { … })`. Top-level
 * await *suspends the module*, so any `const` declared after that line does not
 * exist while the body is running — referencing one throws
 * `Cannot access 'X' before initialization` at runtime, on every invocation.
 *
 * TypeScript accepts it. The unit suite does not exercise it. It shipped twice
 * in one afternoon (`balance`'s formatter, `bootstrap`'s gas threshold), which
 * makes it a property of the file layout rather than two mistakes: helpers
 * belong at the bottom, and `const` helpers at the bottom are landmines.
 *
 * `function` declarations are hoisted and are therefore fine — which is why the
 * rule below is about `const`/`let`/`var`, not about helpers in general.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

function scriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return scriptFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("CLI scripts", () => {
  it("declare nothing after the top-level `await run(`", () => {
    const offenders: string[] = [];
    for (const path of scriptFiles("scripts")) {
      const lines = readFileSync(path, "utf8").split("\n");
      const start = lines.findIndex((line) => line.startsWith("await run("));
      if (start === -1) continue;
      lines.slice(start).forEach((line, offset) => {
        // Top-level only: an indented declaration is inside something and is
        // evaluated when that something runs.
        if (/^(const|let|var)\s/.test(line)) {
          offenders.push(
            `${path}:${String(start + offset + 1)} — ${line.slice(0, 60)}… is declared after ` +
              `\`await run(\`, so it does not exist while the script body runs`,
          );
        }
      });
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

/**
 * Configuration belongs to the caller, not to this package.
 *
 * `dotenv` reads `.env` from the working directory; the wallet used to *write*
 * it relative to its own source file. Those name the same path in exactly one
 * situation — a checkout driven from its root — and diverge everywhere else: a
 * key written from a subdirectory is never loaded, and an installed package
 * would write one inside `node_modules`, to be wiped by the next install.
 */
describe("the .env this package writes", () => {
  it("follows the working directory, like the one it reads", async () => {
    const { envPath } = await import("../src/chain/wallet.ts");
    expect(envPath()).toBe(join(process.cwd(), ".env"));
  });

  it("can be pointed elsewhere, for a caller that keeps configuration apart", async () => {
    const { envPath } = await import("../src/chain/wallet.ts");
    vi.stubEnv("WATERX_ENV_FILE", "/somewhere/else/.env");
    expect(envPath()).toBe("/somewhere/else/.env");
    vi.unstubAllEnvs();
  });

  it("is never resolved against this file's own location", () => {
    // The shape of the old bug, so it cannot come back by refactor.
    const source = readFileSync("src/chain/wallet.ts", "utf8");
    expect(source).not.toMatch(/import\.meta\.url/);
  });
});
