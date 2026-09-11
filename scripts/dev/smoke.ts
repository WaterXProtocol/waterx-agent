/**
 * Run every read-only command for real, and check what comes back.
 *
 * The gap this closes: `pnpm run balance` shipped with a top-level
 * `Cannot access 'fmt' before initialization`. It typechecked, the unit suite
 * was green, and the command failed on every invocation — because nothing had
 * ever *run* it. A contract that promises "one JSON document on stdout" is a
 * promise about a process, and only starting the process tests it.
 *
 * So this spawns each command exactly as an agent would, and asserts the three
 * things an agent depends on:
 *
 *   1. stdout parses as a single JSON document, with nothing else in it;
 *   2. the envelope carries the contract's fields;
 *   3. the exit code matches the status.
 *
 * Read-only by construction: the list below contains no command that can sign.
 * It needs the network and a configured account, so it runs beside
 * `check-corpus` in CI rather than in the hermetic suite.
 */
import { spawnSync } from "node:child_process";

import { EXIT, type Status } from "../../src/cli/contract.ts";

/** Commands an agent may call freely. Nothing here can produce a signature. */
const READS: [string, string[]][] = [
  ["doctor", []],
  // `--skip-faucet` makes it read-only: without `--create-account --yes` it
  // signs nothing, and this is the command the recommended prompt runs first.
  ["bootstrap", ["--skip-faucet"]],
  ["limits", []],
  ["balance", []],
  ["markets", []],
  ["info", []],
  ["ticker", ["--ticker", "SUI"]],
  ["positions", []],
  ["orders", []],
  ["accounts", []],
  ["delegates", []],
  ["funds", []],
  ["pnl", []],
  ["history", []],
  ["approvals", []],
  ["market-data", []],
  ["wlp-info", []],
];

/** Every field the contract promises, on every envelope. */
const REQUIRED = [
  "ok",
  "status",
  "command",
  "network",
  "at",
  "message",
  "submitted",
  "retryable",
  "reconcileRequired",
  "awaitingApproval",
] as const;

let failures = 0;
const fail = (command: string, why: string): void => {
  failures += 1;
  console.log(`  ✗  ${command}\n     ${why}`);
};

for (const [command, args] of READS) {
  const run = spawnSync("pnpm", ["--silent", "run", command, "--", ...args, "--json"], {
    encoding: "utf8",
    timeout: 60_000,
  });

  if (run.error !== undefined) {
    fail(command, `could not be started: ${run.error.message}`);
    continue;
  }

  let envelope: Record<string, unknown>;
  try {
    // `JSON.parse` on the WHOLE of stdout, not a search for the first `{`.
    // Tolerating a preamble would defeat the guarantee being tested.
    envelope = JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    fail(
      command,
      `stdout is not a single JSON document. First 200 bytes: ${JSON.stringify(run.stdout.slice(0, 200))}` +
        (run.stderr === "" ? "" : `\n     stderr: ${run.stderr.trim().split("\n").slice(-2).join(" / ")}`),
    );
    continue;
  }

  const missing = REQUIRED.filter((field) => !(field in envelope));
  if (missing.length > 0) {
    fail(command, `envelope is missing ${missing.join(", ")}`);
    continue;
  }

  const status = envelope["status"] as Status;
  const expected = EXIT[status];
  if (expected === undefined) {
    fail(command, `unknown status "${String(status)}"`);
    continue;
  }
  if (run.status !== expected) {
    fail(
      command,
      `status "${status}" should exit ${String(expected)} but exited ${String(run.status)}`,
    );
    continue;
  }
  // A read that reports `submitted` is either lying or is not a read.
  if (envelope["submitted"] === true) {
    fail(command, `a read-only command reported submitted: true`);
    continue;
  }

  console.log(`  ${envelope["ok"] === true ? "✓" : "!"}  ${command.padEnd(12)} ${status}`);
}

console.log("");
if (failures > 0) {
  console.error(`${String(failures)} command(s) did not behave as the contract promises.`);
  process.exit(1);
}
console.log(`all ${String(READS.length)} read commands answered with a valid envelope.`);
