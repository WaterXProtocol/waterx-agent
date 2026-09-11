/**
 * Pack the tarball, install it into a throwaway project, and assert what
 * actually arrived.
 *
 * The question this answers is not "does it build?" but "does a consumer who
 * has never seen this repository get something that works?" — and the two come
 * apart easily. A missing entry in `files` ships a package whose `bin` points
 * at nothing. A `devDependency` the runtime needs resolves fine in the checkout
 * and is absent in the install. A path resolved against the package's own
 * directory works in a repo and lands inside `node_modules` everywhere else.
 *
 * None of those are visible from inside the repository, so this leaves it.
 *
 * Read-only against the network: it runs `next`, which signs nothing and works
 * with no configuration at all.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

let failures = 0;
const fail = (why: string): void => {
  failures += 1;
  say(`  ✗  ${why}`);
};

// ── Pack ──────────────────────────────────────────────────────────────────
// `npm pack` runs `prepack`, which builds — so a stale `dist/` cannot be
// shipped by forgetting a step.
const packed = execFileSync("npm", ["pack", "--silent"], { cwd: root, encoding: "utf8" })
  .trim()
  .split("\n")
  .pop();
if (packed === undefined || !existsSync(join(root, packed))) {
  say("  ✗  npm pack produced nothing");
  process.exit(1);
}
say(`  ✓  packed ${packed}`);

// ── Install, somewhere that is not this repository ────────────────────────
const consumer = mkdtempSync(join(tmpdir(), "waterx-consumer-"));
writeFileSync(
  join(consumer, "package.json"),
  `${JSON.stringify({ name: "waterx-consumer-check", private: true, version: "0.0.0" }, null, 2)}\n`,
);
execFileSync("npm", ["install", join(root, packed), "--silent", "--no-audit", "--no-fund"], {
  cwd: consumer,
  stdio: "pipe",
});
say(`  ✓  installed into ${consumer}`);

// ── What arrived ──────────────────────────────────────────────────────────
const installed = join(consumer, "node_modules", "waterx-agent");
for (const required of [
  "dist/src/index.js",
  "dist/src/index.d.ts",
  "dist/src/chain/abi-corpus.json",
  "dist/scripts/agent/next.js",
  "bin/waterx.mjs",
  "SKILL.md",
  "AGENT_INSTRUCTIONS.md",
]) {
  if (!existsSync(join(installed, required))) fail(`${required} is missing from the tarball`);
}

// The built output must stand alone. `tsx` is a devDependency, so a consumer
// who needs it has been shipped sources that cannot run.
if (existsSync(join(consumer, "node_modules", "tsx"))) {
  fail("the consumer pulled in tsx — the tarball is shipping sources, not a build");
}
if (!existsSync(join(consumer, "node_modules", ".bin", "waterx"))) {
  fail("no `waterx` binary was linked");
}

// ── Does it run, and does it say the right thing about itself? ─────────────
let envelope: Record<string, unknown> = {};
try {
  const stdout = execFileSync("npx", ["waterx", "next", "--json"], {
    cwd: consumer,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  envelope = JSON.parse(stdout) as Record<string, unknown>;
  say(`  ✓  \`npx waterx next\` answered: ${String(envelope["status"])}`);
} catch (error) {
  fail(`\`npx waterx next\` did not run: ${error instanceof Error ? error.message.slice(0, 160) : ""}`);
}

// The commands it hands back have to be runnable *there*. `node bin/waterx.mjs`
// is a path that does not exist in a consumer's project.
const data = (envelope["data"] ?? {}) as { suggestions?: { command: string }[] };
for (const suggestion of data.suggestions ?? []) {
  if (!suggestion.command.startsWith("npx waterx ")) {
    fail(`a suggestion is not runnable from an install: ${suggestion.command}`);
  }
}

// Configuration belongs to the caller. A key written inside `node_modules` is
// invisible to the project that owns it and is wiped by the next install.
const before = readFileSync(join(root, "package.json"), "utf8");
if (before.includes('"private": true')) {
  say("  ✓  still marked private — `npm publish` stays a deliberate act");
}

say("");
if (failures > 0) {
  process.stderr.write(`${String(failures)} problem(s) with what a consumer receives.\n`);
  process.exit(1);
}
say(`the tarball installs and runs from a project that has never seen this repo.`);
