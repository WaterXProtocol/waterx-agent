/**
 * Shared CLI harness: argument parsing, agent bootstrap, and — the part that
 * matters to an automated caller — the output contract.
 *
 * Scripts stay thin on purpose. Every one of them shapes arguments and calls a
 * `WaterXAgent` method; anything that looks like protocol logic belongs in
 * `src/`, where it is reachable from a program that is not a shell.
 *
 * ## What `--json` guarantees
 *
 * Exactly one JSON document on **stdout**, and nothing else on stdout ever.
 * That is stronger than "we print JSON at the end", and it has to be: an agent
 * parsing stdout has no way to skip a dotenv banner, a progress line, or a
 * deprecation warning that landed in the middle of its document. So in JSON
 * mode `console.log` is rebound to stderr for the life of the process, the
 * envelope is written with `process.stdout.write`, and it is written once.
 *
 * The envelope answers the five questions in `src/cli/contract.ts` without any
 * English being parsed, and the exit code carries the same answer for a caller
 * that only has `$?`.
 */
import { basename } from "node:path";

import dotenv from "dotenv";

import { inStateRoot } from "../../src/state-root.ts";

// From the state root, not from the working directory.
//
// `stateRoot()` anchored where `.env` is WRITTEN and where the ledgers live, and
// left this line — where `.env` is READ — still resolving against `cwd`. So
// `next` found the install from a subdirectory and every command that needs a
// configured account did not: `balance` answered "no WaterX account configured"
// two directories below the one that had configured it.
//
// `quiet` suppresses dotenv's own "injecting env" tip, which is written to
// stdout and would otherwise be the first thing an agent's JSON parser sees.
dotenv.config({ path: inStateRoot(".env"), quiet: true });

import { WaterXAgent } from "../../src/agent/agent.ts";
import { explorerTxUrl, loadConfig } from "../../src/config.ts";
import { narrowOnly, type PolicyMode } from "../../src/policy.ts";
import type { ExecuteResult } from "../../src/chain/executor.ts";
import { classify } from "../../src/cli/classify.ts";
import { type Envelope, EXIT, invoke, type Outcome, type Status, succeeded } from "../../src/cli/contract.ts";
import { UsageError } from "../../src/errors.ts";

export interface ArgDef {
  desc: string;
  required?: boolean;
  default?: string;
  /** Presence-only flag: `--long` yields `"true"`. */
  flag?: boolean;
}

/**
 * The parsed arguments, including the global flags every command accepts —
 * declaring them in the type is what lets a script read `args.yes` without
 * re-declaring `--yes` itself.
 */
export type GlobalFlag = "json" | "policy" | "yes";

export type ParsedArgs<T extends Record<string, ArgDef>> = Record<
  keyof T | GlobalFlag,
  string | undefined
>;

/**
 * Flags every command accepts.
 *
 * Declared once rather than repeated per script: a script that forgot `--json`
 * would reject it as an unknown argument, and "this one command cannot be
 * driven by an agent" is exactly the kind of gap a contract is supposed to
 * close.
 */
const GLOBAL: Record<string, ArgDef> = {
  json: { desc: "Emit one JSON document on stdout and nothing else", flag: true },
  policy: { desc: "Narrow the execution policy for this invocation" },
  yes: { desc: "Confirm this write (humans; agents use preview → approve → execute)", flag: true },
};

// ─── Output plane ─────────────────────────────────────────────────────────────

const jsonMode = process.argv.includes("--json");

/** Human-readable lines. Stdout normally; stderr under `--json`, where stdout is reserved. */
export const note = (...parts: unknown[]): void => {
  const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  (jsonMode ? process.stderr : process.stdout).write(`${line}\n`);
};

if (jsonMode) {
  // Belt and braces. `note` covers this file's own output; this covers a
  // `console.log` anywhere else in the process — a script, a dependency, a
  // future addition that forgets. One stray line on stdout breaks the caller.
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
}

/**
 * The command's name, for the envelope.
 *
 * `pnpm run <name>` exports it, which is the name a caller would type back —
 * preferable to the filename when the two differ (`queue` runs `submit.ts`).
 * The package-manager wrappers export their own name too, so those are ignored
 * rather than reported as the command.
 */
const WRAPPERS = new Set(["npx", "pnpx", "dlx", "exec", "tsx"]);

const commandName = (): string => {
  const lifecycle = process.env.npm_lifecycle_event?.trim();
  if (lifecycle !== undefined && lifecycle !== "" && !WRAPPERS.has(lifecycle)) return lifecycle;
  return basename(process.argv[1] ?? "waterx").replace(/\.ts$/, "");
};

let payload: unknown;
let payloadIsRendered = false;
let outcome: Outcome | undefined;
let emitted = false;

/**
 * The command's result.
 *
 * Held rather than printed, so the single-document guarantee is structural: a
 * script cannot print twice because printing is not a thing a script does.
 *
 * `rendered` says the script has already shown this to a person in its own
 * words. The data still goes into the `--json` envelope — that is the contract
 * — but a human running `pnpm run doctor` gets the checklist rather than the
 * checklist followed by the same thing again as JSON.
 */
export const show = (value: unknown, options: { rendered?: boolean } = {}): void => {
  payload = value;
  payloadIsRendered = options.rendered === true;
};

/** Override the outcome for a command that ends somewhere other than plain success. */
export const setOutcome = (value: Outcome): void => {
  outcome = value;
};

function emit(final: Outcome, data: unknown): never {
  if (emitted) process.exit(EXIT[final.status]);
  emitted = true;

  if (jsonMode) {
    const envelope: Envelope = {
      ok: final.status === "ok",
      status: final.status,
      command: commandName(),
      network: safeNetwork(),
      at: new Date().toISOString(),
      message: final.message,
      submitted: final.submitted,
      retryable: final.retryable,
      reconcileRequired: final.reconcileRequired,
      awaitingApproval: final.awaitingApproval,
      ...(final.nextCommand === undefined ? {} : { nextCommand: final.nextCommand }),
      ...(standingWarnings().length === 0 ? {} : { warnings: standingWarnings() }),
      ...(data === undefined ? {} : { data }),
      // `error` is for things that went wrong. `needs-approval` did not go
      // wrong — it is the designed resting state of a preview, and labelling it
      // an error teaches a caller to treat the normal path as a fault.
      ...(final.status === "ok" || final.status === "needs-approval"
        ? final.details === undefined
          ? {}
          : { details: final.details }
        : {
            error: {
              kind: final.status,
              ...(final.details === undefined ? {} : { details: final.details }),
            },
          }),
    };
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    if (data !== undefined && !payloadIsRendered) {
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    }
    if (final.status !== "ok") {
      process.stderr.write(`\n${final.status}: ${final.message}\n`);
      if (final.details !== undefined) {
        process.stderr.write(`${JSON.stringify(final.details, null, 2)}\n`);
      }
      if (final.nextCommand !== undefined) process.stderr.write(`next: ${final.nextCommand}\n`);
    }
  }
  process.exit(EXIT[final.status]);
}

/**
 * The network, for the envelope, without letting a config problem become the
 * failure. A command that is *reporting* a bad configuration must still be able
 * to print its envelope.
 */
function safeNetwork(): string {
  try {
    return loadConfig().network;
  } catch {
    return process.env.WATERX_NETWORK?.trim() ?? "unknown";
  }
}

/**
 * What a caller must know about this runtime before reading anything else.
 *
 * Defensive for the same reason `safeNetwork` is: a command reporting a broken
 * configuration still has to print its envelope, so a config that will not load
 * yields no warnings rather than an unprintable document.
 */
function standingWarnings(): string[] {
  try {
    const config = loadConfig();
    const warnings: string[] = [];
    if (config.network === "mainnet") {
      warnings.push("MAINNET — writes from this runtime spend real money.");
    }
    if (config.executionPolicy === "read-only") {
      warnings.push("The execution policy is read-only, so nothing here can be signed.");
    }
    if (config.executionPolicy === "delegated-auto") {
      warnings.push(
        "The execution policy is delegated-auto: a write inside the configured scope proceeds " +
          "with no per-order approval.",
      );
    }
    return warnings;
  } catch {
    return [];
  }
}

// ─── Arguments ────────────────────────────────────────────────────────────────

/**
 * Parse `--kebab-case value` pairs into camelCase keys.
 *
 * An unknown flag is an error rather than a no-op: on a trading CLI, a typo
 * that is silently ignored is a trade placed with the default.
 */
export function parseArgs<T extends Record<string, ArgDef>>(
  defs: T,
  scriptName: string,
): ParsedArgs<T> {
  // The script's own definitions win, so a command may document `--yes` in its
  // own words without losing the global one's behaviour.
  const all: Record<string, ArgDef> = { ...GLOBAL, ...defs };
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    // `--json` promises one document on stdout, and this path exempted itself:
    // `<cmd> --help --json` printed the options to the HUMAN stream and exited,
    // leaving stdout empty. Asking a tool to describe itself is the most likely
    // first thing an agent does, and it was the one call that broke the
    // contract. `ok`, not `usage` — being asked for help is not a misuse — and
    // the same `options` array a bad invocation already returned, so a caller
    // reads one shape whether it asked correctly or not.
    if (jsonMode) {
      emit(
        {
          status: "ok",
          message: `${scriptName}: ${String(Object.keys(all).length)} option(s).`,
          submitted: false,
          retryable: false,
          reconcileRequired: false,
          awaitingApproval: false,
          details: { usage: invoke(scriptName, "[options]"), options: optionsOf(all) },
        },
        undefined,
      );
    }
    printUsage(all, scriptName);
    process.exit(0);
  }

  const result: Record<string, string | undefined> = {};
  for (const [key, def] of Object.entries(all)) {
    if (def.flag === true) result[key] = "false";
    if (def.default !== undefined) result[key] = def.default;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) continue;
    // A bare `--` is the shell's end-of-options marker, and `pnpm run x -- …`
    // forwards it. It means "everything after this is an argument", which is
    // already true here — so it is skipped rather than read as a flag named "".
    if (arg === "--") continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const def = all[key];
    if (def === undefined) {
      usage(`Unknown argument: ${arg}`, all, scriptName);
    }
    if (def.flag === true) {
      result[key] = "true";
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      usage(`Missing value for ${arg}`, all, scriptName);
    }
    result[key] = value;
  }

  const missing = Object.entries(all)
    .filter(([key, def]) => def.required === true && result[key] === undefined)
    .map(([key]) => `--${toKebab(key)}`);
  if (missing.length > 0) {
    usage(`Missing required arguments: ${missing.join(", ")}`, all, scriptName);
  }

  return result as ParsedArgs<T>;
}

/**
 * A bad invocation, reported through the same envelope as everything else.
 *
 * It used to `console.error` and `exit(1)`, which an agent could not tell from
 * a crash — and 1 is what Node exits with when it dies of an unhandled throw.
 */
/** The options of a command, as data. One shape for `--help` and for a misuse. */
function optionsOf(defs: Record<string, ArgDef>): {
  flag: string;
  description: string;
  required: boolean;
  default?: string;
}[] {
  return Object.entries(defs).map(([key, def]) => ({
    flag: `--${toKebab(key)}`,
    description: def.desc,
    required: def.required === true,
    ...(def.default === undefined ? {} : { default: def.default }),
  }));
}

function usage(message: string, defs: Record<string, ArgDef>, scriptName: string): never {
  const options = optionsOf(defs);
  if (!jsonMode) printUsage(defs, scriptName);
  emit(
    {
      status: "usage",
      message,
      submitted: false,
      retryable: false,
      reconcileRequired: false,
      awaitingApproval: false,
      details: { options },
    },
    undefined,
  );
}

function printUsage(defs: Record<string, ArgDef>, scriptName: string): void {
  // Spelled for wherever this was run from. `pnpm run x -- [options]` is a
  // checkout's syntax, and `--help` is the first thing someone who installed
  // the package types.
  note(`\nUsage: ${invoke(scriptName, "[options]")}\n`);
  note("Options:");
  for (const [key, def] of Object.entries(defs)) {
    const value = def.flag === true ? "" : " <value>";
    const required = def.required === true ? " (required)" : "";
    const fallback = def.default === undefined ? "" : ` [default: ${def.default}]`;
    note(`  --${toKebab(key)}${value}  ${def.desc}${required}${fallback}`);
  }
  note("  --help  Show this message");
}

const toKebab = (s: string): string => s.replace(/([A-Z])/g, "-$1").toLowerCase();

export const asNumber = (value: string | undefined): number | undefined =>
  value === undefined ? undefined : Number(value);

export const asBool = (value: string | undefined): boolean => value === "true";

/**
 * A value the caller had to supply and did not.
 *
 * Separate from `parseArgs`'s `required` because some arguments are required
 * *conditionally* — `--leverage` unless `--size`, `--slippage` on the agent
 * path but not the human one. Refusing here, by name, is what "the agent must
 * stop and ask rather than guess" looks like in code: there is no default to
 * fall back to, so it cannot silently pick one.
 */
export function demand(value: string | undefined, flag: string, why: string): string {
  if (value === undefined || value.trim() === "") {
    throw new UsageError(`${flag} is required: ${why}`);
  }
  return value;
}

// ─── Agent ────────────────────────────────────────────────────────────────────

/**
 * Build the agent for a script run.
 *
 * No key is loaded here. `WaterXAgent` constructs its signer on first write, so
 * a read-only command runs in a process that never touches `SUI_PRIVATE_KEY`.
 */
export function initAgent(): WaterXAgent {
  const override = readPolicyOverride();
  if (override === undefined) return new WaterXAgent();
  const configured = loadConfig().executionPolicy;
  // Narrowing only: `--policy read-only` on an unattended machine is a useful
  // safety belt; the reverse would let an invocation grant itself authority.
  return new WaterXAgent({ config: { executionPolicy: narrowOnly(configured, override) } });
}

/** `--policy <mode>`, parsed before the per-script arg definitions run. */
function readPolicyOverride(): PolicyMode | undefined {
  const index = process.argv.indexOf("--policy");
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === "read-only" || value === "interactive" || value === "delegated-auto") return value;
  throw new UsageError(
    `--policy expects read-only | interactive | delegated-auto (got ${String(value)})`,
  );
}

/** Whether this invocation carries the explicit go-ahead a `confirm` policy needs. */
export const confirmed = (): boolean =>
  process.argv.includes("--yes") || process.argv.includes("-y");

/** Report a landed transaction: the result becomes the envelope's data. */
export function reportTx(agent: WaterXAgent, label: string, result: ExecuteResult): void {
  const url = explorerTxUrl(agent.config.network, result.digest);
  // "submitted and executed" was said unconditionally, on every DIRECT command.
  // The fix for this went into the approval path only: an abort throws, but a
  // sponsored submission whose status could not be read inside its budget comes
  // back `UNCONFIRMED`, and saying it executed is the same false success that
  // path was fixed for. One bug, two callers, and only one of them was mended.
  const confirmed = result.executed === "SUCCEEDED";
  note(`${label} ${confirmed ? "✓" : "…"}  ${result.sponsored ? "sponsored" : "self-paid"}`);
  note(`  ${url}`);
  show({ digest: result.digest, sponsored: result.sponsored, executed: result.executed, explorer: url });
  setOutcome(
    confirmed
      ? succeeded(`${label} submitted and executed`, { submitted: true })
      : {
          status: "ambiguous",
          message:
            `${label} was submitted as ${result.digest} and the chain has not yet confirmed what it ` +
            `did. It was not cancelled and must not be sent again — reconcile to find out.`,
          submitted: true,
          retryable: false,
          reconcileRequired: true,
          awaitingApproval: false,
          nextCommand: invoke("reconcile", "--all", "--json"),
        },
  );
}

// ─── The run loop ─────────────────────────────────────────────────────────────

/**
 * Run a script body and end the process through the output contract.
 *
 * Every exit goes through `emit`, including the failures: one document, one
 * exit code, and a `status` an automated caller can branch on without reading
 * the message. `classify` decides which — see `src/cli/classify.ts` for why the
 * ambiguous case is the one that may never be guessed.
 */
export async function run(main: () => Promise<void>): Promise<void> {
  // `--help` is answered here as well as in `parseArgs`, because eighteen scripts
  // never call `parseArgs` — they take no options of their own — and for those
  // the flag was silently ignored and the command RAN. `markets --help` performed
  // the read; `fund-sui --help` would ask a faucet for money and
  // `generate-wallet --help` would mint a key. The shim promises every command
  // takes `--help`, and a promise that executes the action instead of describing
  // it is worse than one that is merely unkept.
  //
  // Scripts that DO call `parseArgs` have already exited by now with their own
  // option list, so this never shadows a better answer.
  if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
    helpForAnOptionlessCommand();
  }
  try {
    await main();
    emit(outcome ?? succeeded(`${commandName()} completed`), payload);
  } catch (error) {
    emit(classify(error), payload);
  }
}

/**
 * `--help` for a command whose only options are the global ones.
 *
 * It says so explicitly rather than printing an empty list: "no options" and
 * "the options could not be determined" look identical in an empty array, and
 * only the first is true here.
 */
function helpForAnOptionlessCommand(): never {
  const name = commandName();
  if (jsonMode) {
    emit(
      {
        status: "ok",
        message: `${name} takes no options of its own.`,
        submitted: false,
        retryable: false,
        reconcileRequired: false,
        awaitingApproval: false,
        details: { usage: invoke(name), options: optionsOf(GLOBAL), takesNoOptionsOfItsOwn: true },
      },
      undefined,
    );
  }
  printUsage(GLOBAL, name);
  process.exit(0);
}

export type { Outcome, Status };
