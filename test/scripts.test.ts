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

import { describe, expect, it } from "vitest";

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
