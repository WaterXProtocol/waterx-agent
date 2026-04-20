import dotenv from "dotenv";
dotenv.config();

import { loadWallet, AgentSigner, WaterXApiClient } from "../../src/agent/index.ts";

// ─── Signer ───────────────────────────────────────────────────────────────────

/** Load wallet from .env and create an AgentSigner. */
export function initSigner(): AgentSigner {
  const { keypair } = loadWallet();
  return new AgentSigner(keypair, "TESTNET");
}

/** Read WATERX_ACCOUNT_ID from env. Throws if not set. */
export function requireAccountId(): string {
  const id = process.env.WATERX_ACCOUNT_ID?.trim();
  if (!id) {
    throw new Error(
      "WATERX_ACCOUNT_ID not set. Run `npm run create-account` first.",
    );
  }
  return id;
}

// ─── Arg Parsing ──────────────────────────────────────────────────────────────

interface ArgDef {
  required?: boolean;
  default?: string;
  desc: string;
  /** If true, arg is a boolean flag (no value needed) */
  flag?: boolean;
}

/**
 * Parse CLI arguments in `--key value` format.
 * Boolean flags: `--long` (presence = "true").
 * Prints usage and exits on `--help` or missing required args.
 */
export function parseArgs<T extends Record<string, ArgDef>>(
  defs: T,
  scriptName?: string,
): Record<keyof T, string> {
  const argv = process.argv.slice(2);

  // --help
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage(defs, scriptName);
    process.exit(0);
  }

  const result: Record<string, string> = {};

  // Set defaults
  for (const [key, def] of Object.entries(defs)) {
    if (def.default !== undefined) {
      result[key] = def.default;
    }
    if (def.flag) {
      result[key] = "false";
    }
  }

  // Parse argv
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const rawKey = arg.slice(2);
    // Convert kebab-case to camelCase for matching
    const camelKey = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

    const defEntry = Object.entries(defs).find(
      ([k]) => k === camelKey || k === rawKey,
    );
    if (!defEntry) {
      console.error(`Unknown argument: ${arg}`);
      printUsage(defs, scriptName);
      process.exit(1);
    }

    const [key, def] = defEntry;
    if (def.flag) {
      result[key] = "true";
    } else {
      const val = argv[++i];
      if (!val || val.startsWith("--")) {
        console.error(`Missing value for ${arg}`);
        process.exit(1);
      }
      result[key] = val;
    }
  }

  // Check required
  const missing: string[] = [];
  for (const [key, def] of Object.entries(defs)) {
    if (def.required && !result[key]) {
      missing.push(toKebab(key));
    }
  }
  if (missing.length > 0) {
    console.error(`Missing required arguments: ${missing.map((k) => `--${k}`).join(", ")}`);
    printUsage(defs, scriptName);
    process.exit(1);
  }

  return result as Record<keyof T, string>;
}

function printUsage(defs: Record<string, ArgDef>, scriptName?: string) {
  console.log(`\nUsage: npx tsx ${scriptName ?? "scripts/..."} [options]\n`);
  console.log("Options:");
  for (const [key, def] of Object.entries(defs)) {
    const flag = `--${toKebab(key)}`;
    const req = def.required ? " (required)" : "";
    const dflt = def.default !== undefined ? ` [default: ${def.default}]` : "";
    const valHint = def.flag ? "" : " <value>";
    console.log(`  ${flag}${valHint}  ${def.desc}${req}${dflt}`);
  }
  console.log("  --help          Show this help message");
}

function toKebab(s: string): string {
  return s.replace(/([A-Z])/g, "-$1").toLowerCase();
}

// ─── API Client ──────────────────────────────────────────────────────────────

/** Create a WaterXApiClient from WATERX_API_URL env var. */
export function initApiClient(): WaterXApiClient {
  return new WaterXApiClient();
}

// ─── Formatters ───────────────────────────────────────────────────────────────

export function fmtUsdc(raw: bigint | number): string {
  return `${(Number(raw) / 1e6).toFixed(2)} USDC`;
}

export function fmtSui(raw: bigint | number): string {
  return `${(Number(raw) / 1e9).toFixed(4)} SUI`;
}

export function fmtSize(raw: bigint | number): string {
  return `${(Number(raw) / 1e9).toFixed(6)}`;
}

export function fmtPrice(raw: bigint | number): string {
  return `$${(Number(raw) / 1e9).toFixed(2)}`;
}

/** Format a transaction digest as a Suiscan link */
export function fmtTx(digest: string): string {
  return `https://suiscan.xyz/testnet/tx/${digest}`;
}

/** Convert human-readable USDC amount (e.g. 10) to raw units (10_000_000) */
export function usdcToRaw(amount: string | number): bigint {
  return BigInt(Math.round(Number(amount) * 1e6));
}

/** Convert human-readable SUI amount to MIST */
export function suiToRaw(amount: string | number): bigint {
  return BigInt(Math.round(Number(amount) * 1e9));
}
