#!/usr/bin/env node
/**
 * `waterx <command> [args]` — the same commands, without a package manager in
 * the way.
 *
 * The JSON contract promises exactly one document on stdout and nothing else,
 * and `pnpm run <command>` breaks that promise by writing its own banner there
 * first. `--silent` suppresses it, so every instruction in this repo says
 * `pnpm --silent run` — a footgun that is one forgotten word away from an
 * unparseable response, and one an automated caller cannot detect except by
 * failing.
 *
 * This removes the package manager from the path. It writes nothing itself,
 * forwards stdio untouched, and exits with the child's code, so the contract
 * holds without anyone having to remember a flag.
 *
 * The command table is `package.json`'s own `scripts`, so there is one source
 * of truth: a command that exists as a script exists here, and one that does
 * not cannot be invented.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const scripts = pkg.scripts ?? {};

const [command, ...args] = process.argv.slice(2);

/** Scripts that are not agent commands: build plumbing and capture tools. */
const INTERNAL = new Set(["typecheck", "test", "generate-abi", "capture-corpus", "smoke"]);

if (command === undefined || command === "--help" || command === "-h") {
  // Usage goes to stderr. Even the help text must not put anything on stdout,
  // or a caller that pipes stdout gets a surprise on its first mistake.
  process.stderr.write(
    `\nwaterx <command> [options]\n\n` +
      `Commands:\n` +
      Object.keys(scripts)
        .filter((name) => !INTERNAL.has(name))
        .map((name) => `  ${name}`)
        .join("\n") +
      `\n\nEvery command takes --json (one JSON document on stdout) and --help.\n` +
      `See SKILL.md for the read -> preview -> approve -> execute loop.\n\n`,
  );
  process.exit(command === undefined ? 2 : 0);
}

const script = scripts[command];
if (typeof script !== "string") {
  process.stderr.write(
    `waterx: unknown command "${command}". Run \`waterx --help\` for the list.\n`,
  );
  process.exit(2);
}

// Every script is `tsx <path>`; anything else is plumbing this should not run.
const target = script.startsWith("tsx ") ? script.slice(4).trim() : undefined;
if (target === undefined) {
  process.stderr.write(`waterx: "${command}" is not an agent command.\n`);
  process.exit(2);
}

/**
 * Compiled output when there is some, the TypeScript sources otherwise.
 *
 * A checkout runs straight from source through `tsx`, which is what makes the
 * repo pleasant to work in — no build step between an edit and a run. An
 * installed tarball carries `dist/` and no `tsx` at all, because a consumer
 * should not have to install a TypeScript runtime to place an order. One shim
 * covers both by asking which one is present rather than being told.
 */
const built = join(root, "dist", target.replace(/\.ts$/, ".js"));
const useBuilt = existsSync(built);

/**
 * How a caller would type this command themselves.
 *
 * Passed down so the commands this package hands back are runnable where they
 * were printed: a consumer who installed the tarball has no `bin/waterx.mjs`
 * path, and a checkout has no `waterx` on its PATH.
 */
const invokedAs = root.includes(`${sep}node_modules${sep}`) ? "npx waterx" : "node bin/waterx.mjs";
const env = { ...process.env, WATERX_INVOKED_AS: invokedAs };

const child = useBuilt
  ? spawnSync(process.execPath, [built, ...args], { stdio: "inherit", env })
  : spawnSync(
      process.execPath,
      [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, target), ...args],
      { stdio: "inherit", env },
    );

if (child.error !== undefined) {
  process.stderr.write(
    `waterx: could not start "${command}": ${child.error.message}\n` +
      (useBuilt ? "" : "The sources need `tsx`. Run `pnpm install`, or `pnpm run build` first.\n"),
  );
  process.exit(3);
}

process.exit(child.status ?? 1);
