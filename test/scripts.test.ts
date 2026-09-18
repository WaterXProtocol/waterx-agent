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
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * Every command the documentation tells someone to run has to exist.
 *
 * This is not hypothetical tidiness. A recommended prompt shipped naming
 * `waterx skill`, which existed only on an unmerged branch; the person who
 * followed it got "no such command" as the very first thing this package ever
 * said to them, and had to recover by guessing. Docs and `package.json` drift
 * silently in that direction — a command is easy to write about before it is
 * written, and nothing else notices.
 */
describe("commands named in the documentation", () => {
  const scripts = new Set(
    Object.keys(JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, unknown>),
  );

  it("all exist in package.json", () => {
    const missing: string[] = [];
    for (const doc of ["README.md", "SKILL.md", "AGENT_INSTRUCTIONS.md", "AGENT.md", ".env.example"]) {
      const text = readFileSync(doc, "utf8");
      // Both spellings this package uses for itself.
      const named = [
        ...text.matchAll(/(?:npx waterx|node bin\/waterx\.mjs)\s+([a-z][a-z0-9:-]*)/g),
        ...text.matchAll(/pnpm (?:--silent )?run ([a-z][a-z0-9:-]*)/g),
      ].map((m) => m[1] as string);
      for (const command of new Set(named)) {
        // Placeholders that stand in for a real name, not commands themselves.
        if (command === "build" || command === "install") continue;
        if (!scripts.has(command)) missing.push(`${doc} names \`${command}\`, which is not a script`);
      }
    }
    expect([...new Set(missing)], missing.join("\n")).toEqual([]);
  });
});

/**
 * A maintainer tool must not be one typo away from a consumer.
 *
 * `waterx capture-corpus --help` ran the capture: the script has no argument
 * parsing, so the flag was ignored, and it overwrote the committed fixture with
 * a one-entry capture from an unconfigured run. Hiding it from `--help` was not
 * enough, because hiding is not refusing.
 */
describe("the bin shim", () => {
  const shim = readFileSync("bin/waterx.mjs", "utf8");

  it("refuses the maintainer tools by name, not merely hides them", () => {
    expect(shim).toMatch(/if \(INTERNAL\.has\(command\)\)/);
    for (const tool of ["capture-corpus", "generate-abi", "build", "prepare"]) {
      expect(shim, tool).toContain(`"${tool}"`);
    }
  });

  it("names an install that has no build in it, in the contract's own terms", () => {
    // `prepare` compiles at install time; npm >= 11 warns about it, and where
    // that warning is a policy the package installs with no `dist/`. What the
    // caller used to get was a MODULE_NOT_FOUND stack naming a path inside
    // node_modules, empty stdout, and exit 1 — the code reserved for "this
    // process fell over" — because `spawnSync` succeeds at spawning Node with a
    // path that does not exist, which left the shim's own message unreachable.
    const dir = mkdtempSync(join(tmpdir(), "waterx-unbuilt-"));
    mkdirSync(join(dir, "bin"));
    copyFileSync("bin/waterx.mjs", join(dir, "bin", "waterx.mjs"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "waterx-agent", scripts: { next: "tsx scripts/agent/next.ts" } }),
    );

    const run = spawnSync(process.execPath, [join(dir, "bin", "waterx.mjs"), "next", "--json"], {
      encoding: "utf8",
    });

    // `config`, not 1: the environment is wrong, and that is a thing a caller
    // can act on.
    expect(run.status, run.stderr).toBe(3);
    expect(run.stderr).toContain("npm install github:WaterXProtocol/waterx-agent");
    // And warns off the obvious wrong move: `npm rebuild` reports success and
    // does not run `prepare`, so it leaves the package exactly as broken.
    expect(run.stderr).toMatch(/npm rebuild` does NOT/u);
    // And the one-document promise survives the failure it is most likely to
    // meet on a first install.
    const envelope = JSON.parse(run.stdout) as { ok: boolean; status: string; nextCommand: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.status).toBe("config");
    expect(envelope.nextCommand).toBe("npm install github:WaterXProtocol/waterx-agent");
  });

  it("does not ship them either", () => {
    // Belt and braces: the refusal is a behaviour, this is an absence. A
    // destructive tool that is not in the tarball cannot be reached by any
    // route, including ones nobody thought of.
    const files = JSON.parse(readFileSync("package.json", "utf8")).files as string[];
    expect(files).toContain("!dist/scripts/dev");
  });
});
