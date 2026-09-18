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

/**
 * Scripts that are not agent commands: build plumbing and capture tools.
 *
 * Hidden from `--help` AND refused when asked for by name. Hiding alone was not
 * enough: `waterx capture-corpus --help` ran the capture — it has no argument
 * parsing, so the flag was ignored — and overwrote the committed fixture with a
 * one-entry capture from an unconfigured run. A destructive maintainer tool
 * should not be one typo away from a consumer.
 */
const INTERNAL = new Set(["typecheck", "test", "build", "prepack", "prepare", "generate-abi", "capture-corpus", "check-corpus", "smoke", "pack:check"]);

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

if (INTERNAL.has(command)) {
  process.stderr.write(
    `waterx: "${command}" is a maintainer tool, not an agent command. It is run from a checkout ` +
      `of the repository with \`pnpm run ${command}\`.\n`,
  );
  process.exit(2);
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
 * The sources when they are there, the compiled output when they are not.
 *
 * The test is for the SOURCE, not for `dist/`, and the direction matters. A
 * checkout always has `scripts/`; a tarball never does, because `files` does
 * not ship it. So a checkout runs live through `tsx` — no build step between an
 * edit and a run — and an install runs the build, needing no TypeScript runtime
 * to place an order.
 *
 * Preferring `dist/` instead would have been quietly wrong the moment anything
 * created one in a checkout: `prepare` builds on install, and every edit
 * afterwards would have been ignored in favour of a stale compile.
 */
const source = join(root, target);
const built = join(root, "dist", target.replace(/\.ts$/, ".js"));
const useBuilt = !existsSync(source);

/**
 * How a caller would type this command themselves.
 *
 * Passed down so the commands this package hands back are runnable where they
 * were printed: a consumer who installed the tarball has no `bin/waterx.mjs`
 * path, and a checkout has no `waterx` on its PATH.
 */
const invokedAs = root.includes(`${sep}node_modules${sep}`) ? "npx waterx" : "node bin/waterx.mjs";
const env = { ...process.env, WATERX_INVOKED_AS: invokedAs };

/**
 * An install with no build in it, caught before Node is handed a path that is
 * not there.
 *
 * `prepare` compiles this package at install time, and npm >= 11 prints a
 * `npm warn allow-scripts` notice about it. That notice is bookkeeping, not a
 * refusal — but where it IS one (`ignore-scripts`, an approval policy, a
 * locked-down CI), the package installs "successfully" with no `dist/` and
 * nothing says so.
 *
 * The check exists because the message further down could never print it:
 * `spawnSync` SUCCEEDS at spawning Node with a path that does not exist, so
 * `child.error` is undefined and that branch is unreachable for this case. What
 * the caller actually got was a MODULE_NOT_FOUND stack naming a path inside
 * node_modules, empty stdout, and exit 1 — the code this contract reserves for
 * "this process fell over", so an automated caller could not tell an unbuilt
 * install from a crash.
 */
if (useBuilt && !existsSync(built)) {
  // The JSON promise is about stdout, and it is one this can still keep: a
  // caller that asked for JSON gets one document naming the fix, rather than
  // silence on stdout and a stack trace on stderr.
  if (args.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          status: "config",
          command,
          message:
            "waterx-agent installed without its build: the `prepare` script did not run, so " +
            "there is nothing to execute. Re-run the install — `npm install " +
            "github:WaterXProtocol/waterx-agent` — or install the tarball, which ships built. " +
            "`npm rebuild` does NOT fix this: it does not run `prepare`, and reports success.",
          submitted: false,
          retryable: false,
          reconcileRequired: false,
          awaitingApproval: false,
          nextCommand: "npm install github:WaterXProtocol/waterx-agent",
        },
        null,
        2,
      )}\n`,
    );
  }
  process.stderr.write(
    `waterx: this package installed without its build, so there is nothing to run.\n` +
      `  The compile happens in the \`prepare\` script at install time, and it did not run here.\n` +
      `  Either of these fixes it:\n` +
      `    npm install github:WaterXProtocol/waterx-agent  # re-run the install; prepare runs\n` +
      `    npm install <waterx-agent-0.1.0.tgz>            # a tarball ships built\n` +
      `  \`npm rebuild\` does NOT: it does not run \`prepare\`, and says "rebuilt successfully".\n` +
      `  If your npm holds install scripts for approval, \`npm approve-scripts waterx-agent\`\n` +
      `  first, then install again.\n`,
  );
  process.exit(3);
}

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
      // A missing build is caught above, where it can be named. What is left
      // here is the spawn itself failing — no Node on PATH, no tsx in a
      // checkout — which is a different sentence.
      (useBuilt
        ? "The build is there but could not be started.\n"
        : "The sources need `tsx`. Run `pnpm install` first.\n"),
  );
  process.exit(3);
}

process.exit(child.status ?? 1);
