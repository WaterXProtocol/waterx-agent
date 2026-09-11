/**
 * Shared CLI harness: argument parsing, agent bootstrap, and output.
 *
 * Scripts are thin on purpose — every one of them shapes arguments and calls a
 * `WaterXAgent` method. Anything that looks like protocol logic belongs in
 * `src/`, where it is reachable from a program that is not a shell.
 */
import dotenv from "dotenv";
dotenv.config();

import { WaterXAgent } from "../../src/agent/agent.ts";
import { explorerTxUrl, loadConfig } from "../../src/config.ts";
import { narrowOnly, type PolicyMode } from "../../src/policy.ts";
import type { ExecuteResult } from "../../src/chain/executor.ts";
import { ExecutionPolicyError, WaterXApiError } from "../../src/errors.ts";

export interface ArgDef {
  desc: string;
  required?: boolean;
  default?: string;
  /** Presence-only flag: `--long` yields `"true"`. */
  flag?: boolean;
}

export type ParsedArgs<T extends Record<string, ArgDef>> = Record<keyof T, string | undefined>;

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
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage(defs, scriptName);
    process.exit(0);
  }

  const result: Record<string, string | undefined> = {};
  for (const [key, def] of Object.entries(defs)) {
    if (def.flag === true) result[key] = "false";
    if (def.default !== undefined) result[key] = def.default;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const def = defs[key];
    if (def === undefined) {
      console.error(`Unknown argument: ${arg}`);
      printUsage(defs, scriptName);
      process.exit(1);
    }
    if (def.flag === true) {
      result[key] = "true";
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      console.error(`Missing value for ${arg}`);
      process.exit(1);
    }
    result[key] = value;
  }

  const missing = Object.entries(defs)
    .filter(([key, def]) => def.required === true && result[key] === undefined)
    .map(([key]) => `--${toKebab(key)}`);
  if (missing.length > 0) {
    console.error(`Missing required arguments: ${missing.join(", ")}`);
    printUsage(defs, scriptName);
    process.exit(1);
  }

  return result as ParsedArgs<T>;
}

function printUsage(defs: Record<string, ArgDef>, scriptName: string): void {
  console.log(`\nUsage: npm run ${scriptName} -- [options]\n`);
  console.log("Options:");
  for (const [key, def] of Object.entries(defs)) {
    const value = def.flag === true ? "" : " <value>";
    const required = def.required === true ? " (required)" : "";
    const fallback = def.default === undefined ? "" : ` [default: ${def.default}]`;
    console.log(`  --${toKebab(key)}${value}  ${def.desc}${required}${fallback}`);
  }
  console.log("  --help  Show this message");
}

const toKebab = (s: string): string => s.replace(/([A-Z])/g, "-$1").toLowerCase();

export const asNumber = (value: string | undefined): number | undefined =>
  value === undefined ? undefined : Number(value);

export const asBool = (value: string | undefined): boolean => value === "true";

/**
 * Build the agent for a script run.
 *
 * `--yes` maps to the `confirm: true` an interactive policy demands, so a human
 * at a terminal opts in per invocation while an unattended run needs the
 * policy set to `auto` deliberately.
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
  console.error(`--policy expects read-only | interactive | delegated-auto (got ${String(value)})`);
  process.exit(1);
}

/** Whether this invocation carries the explicit go-ahead a `confirm` policy needs. */
export const confirmed = (): boolean =>
  process.argv.includes("--yes") || process.argv.includes("-y");

/** Print a transaction result with a clickable explorer link. */
export function reportTx(agent: WaterXAgent, label: string, result: ExecuteResult): void {
  const paidBy = result.sponsored ? "sponsored" : "self-paid";
  console.log(`${label} ✓  ${paidBy}`);
  console.log(`  ${explorerTxUrl(agent.config.network, result.digest)}`);
}

/**
 * Run a script body, turning the three failure kinds into messages a caller can
 * act on instead of a stack trace.
 */
export async function run(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    if (error instanceof ExecutionPolicyError) {
      console.error(`\nRefused: ${error.message}`);
      // Only the interactive-confirm refusal is fixable with a flag. Suggesting
      // `--yes` for a scope refusal would point at the one thing that cannot help.
      if (error.message.includes("confirm: true")) {
        console.error("Pass --yes to confirm this invocation.");
      }
      process.exit(2);
    }
    if (error instanceof WaterXApiError) {
      console.error(`\nBackend error ${String(error.code)}: ${error.message}`);
      if (error.details !== undefined) console.error(JSON.stringify(error.details, null, 2));
      process.exit(3);
    }
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/** Pretty-print any read result. */
export const show = (value: unknown): void => {
  console.log(JSON.stringify(value, null, 2));
};
