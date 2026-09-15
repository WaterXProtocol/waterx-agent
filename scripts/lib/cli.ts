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
// `quiet` suppresses dotenv's own "injecting env" tip, which is written to
// stdout and would otherwise be the first thing an agent's JSON parser sees.
dotenv.config({ quiet: true });

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
function usage(message: string, defs: Record<string, ArgDef>, scriptName: string): never {
  const options = Object.entries(defs).map(([key, def]) => ({
    flag: `--${toKebab(key)}`,
    description: def.desc,
    required: def.required === true,
    ...(def.default === undefined ? {} : { default: def.default }),
  }));
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
  note(`${label} ✓  ${result.sponsored ? "sponsored" : "self-paid"}`);
  note(`  ${url}`);
  show({ digest: result.digest, sponsored: result.sponsored, explorer: url });
  setOutcome(succeeded(`${label} submitted and executed`, { submitted: true }));
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
  try {
    await main();
    emit(outcome ?? succeeded(`${commandName()} completed`), payload);
  } catch (error) {
    emit(classify(error), payload);
  }
}

export type { Outcome, Status };
