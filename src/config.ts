/**
 * Runtime configuration for the agent: network, backend base URL, gRPC endpoint,
 * and the execution policy that gates every signing path.
 *
 * Read once at startup via `loadConfig()`. Everything downstream takes the
 * resolved `AgentConfig` rather than reaching into `process.env`, so a script
 * can override the network without mutating the environment.
 */

import { readFileSync } from "node:fs";

import { corpusFor } from "./chain/corpus.ts";
import { ACTION_RULES } from "./chain/verify.ts";
import { manifestGraceMs } from "./chain/deployment.ts";
import { ConfigError, ExecutionPolicyError } from "./errors.ts";
import type { PolicyMode, PolicyScope } from "./policy.ts";

export type Network = "testnet" | "mainnet";

/**
 * What this process is allowed to sign.
 *
 * - `read-only`      — every write throws before a signature is produced.
 * - `interactive`    — a write needs an explicit per-call `confirm: true`, so an
 *                      LLM-driven caller cannot trade by omitting a field.
 * - `delegated-auto` — unattended signing inside a scope an operator wrote down.
 *                      For a delegate wallet; never for an owner key.
 *
 * Mainnet defaults to `read-only`: on mainnet a wrong default costs real money,
 * so writing there has to be a decision someone typed, not one they inherited.
 */
export type ExecutionPolicy = PolicyMode;

/** Names the earlier revision of this package used. Accepted, mapped, not documented. */
const POLICY_ALIASES: Record<string, PolicyMode> = {
  confirm: "interactive",
  auto: "delegated-auto",
};

/** Backend base URL per network. Override with `WATERX_API_URL`. */
const DEFAULT_API_URL: Record<Network, string> = {
  testnet: "https://api-testnet.waterx.app",
  mainnet: "https://api.waterx.app",
};

/** Public fullnode gRPC endpoint per network. Override with `SUI_GRPC_URL`. */
const DEFAULT_GRPC_URL: Record<Network, string> = {
  testnet: "https://fullnode.testnet.sui.io:443",
  mainnet: "https://fullnode.mainnet.sui.io:443",
};

/**
 * waterx-config deployment document — the single source of truth for package
 * and object ids. The agent reads it only to *report* what it is pointed at
 * (`pnpm run doctor`); it never builds a PTB from it, because the backend owns
 * PTB composition. Override with `WATERX_CONFIG_URL`.
 */
const DEFAULT_CONFIG_URL: Record<Network, string> = {
  testnet: "https://staging.waterx-config.pages.dev/testnet.json",
  mainnet: "https://config.waterx.app/mainnet.json",
};

/**
 * Package exceptions mainnet cannot trade without, shipped as a default.
 *
 * The mainnet config document does not list three packages the backend reaches:
 * the Pyth Lazer oracle, which **every order** calls, and two coin types that
 * appear only as type arguments. Without them the verifier refuses every
 * mainnet write — correctly, because a call from a package nobody can name is
 * exactly what it exists to stop.
 *
 * The alternative was to make each user paste a line `doctor` prints. That is
 * worse, not better: pasting three opaque ids you cannot evaluate is not
 * informed consent, and it puts the exception somewhere nobody reviews. Here it
 * is version-controlled, diffable, explained, and `doctor` reports it as a
 * standing exception in force rather than passing silently.
 *
 * `=*` on the Lazer package grants its calls with nothing holding them to a
 * shape — see `deployment.ts` for why no narrower form can express a
 * third-party package. The other two are bare ids, which cover a type argument
 * and no call at all.
 *
 * These come out the day the config document lists them. `pnpm run doctor`
 * says so every time it runs.
 */
const DEFAULT_EXTRA_PACKAGES: Readonly<Record<Network, readonly string[]>> = {
  testnet: [],
  mainnet: [
    // pyth_lazer::parse_and_verify_le_ecdsa_update_v2 — reached by every order.
    "0xefbfd064480777699fd9c557a5804d72ace7bc82661fdc8d1f1a44ea6d92ee10=*",
    // USDC, as a type argument on deposit, withdraw and WLP mint.
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7",
    // The WLP reward coin, as a type argument on a mint.
    "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270",
  ],
};

/** Whether an exception is one this package ships rather than one an operator named. */
export const isDefaultExtraPackage = (network: Network, entry: string): boolean =>
  DEFAULT_EXTRA_PACKAGES[network].includes(entry);

export interface AgentConfig {
  network: Network;
  /** Backend REST base URL, no trailing slash. */
  apiUrl: string;
  /** Sui fullnode gRPC endpoint used to submit unsponsored transactions. */
  grpcUrl: string;
  /** waterx-config deployment document URL. */
  configUrl: string;
  /**
   * Package ids to accept in a transaction on top of the ones the deployment
   * document lists.
   *
   * A stopgap with a deliberate shape: every Move call a transaction makes must
   * belong to a package this agent can name, and today the backend calls at
   * least one package no published config document lists. Rather than accept
   * every unknown package silently, the operator names the exception — so the
   * risk is written down, visible in the process environment, and removed the
   * day the config catches up. `pnpm run doctor` prints exactly what to set.
   */
  extraPackages: readonly string[];
  /**
   * Entrypoints whose argument layout may go unconfirmed against the running
   * deployment, by exact name. Empty unless the operator listed some.
   *
   * There is no boolean beside this. One lived here, and an embedding caller
   * could pass `requireConfirmedLayouts: false` to switch off every
   * confirmation at once — the blanket escape removed from the environment
   * variable, still reachable through the exported config. A list of exact
   * names is the only lever, in code and in the environment alike.
   */
  allowUnconfirmed: readonly string[];
  executionPolicy: ExecutionPolicy;
  /** Ceilings for `delegated-auto`. Required in that mode, ignored otherwise. */
  policyScope?: PolicyScope;
  /** WaterX account object id, when one has been created. */
  accountId?: string;
  /**
   * Owner address on whose behalf a delegate signs. Set only when this process
   * signs as a *delegate*: `sender` stays the owner (the auth subject the
   * backend authorises against) while `delegateSender` is this wallet.
   */
  ownerAddress?: string;
  /**
   * argv of an external `SIGNER_PROTOCOL` v1 provider. When set, no key is
   * loaded into this process and `agentWallet` must state the address the child
   * holds.
   */
  signerCommand?: string[];
  /** The address an external signer holds. Required with `signerCommand`. */
  agentWallet?: string;
  /** How long to wait for an external signer. */
  signerTimeoutMs?: number;
}

/**
 * Whether to accept an argument layout this deployment has never been seen to
 * emit. **Refused unless the operator says otherwise.**
 *
 * The layouts come from `@waterx/sdk`, which is authoritative, so accepting
 * them is defensible — but "defensible" is the operator's call to make, not a
 * default to inherit. The strict behaviour was opt-in for two rounds and read
 * as a way of deferring the question.
 *
 * An unrecognised value is an error rather than a quiet "no": `" true "` and a
 * misspelling both used to disable strictness silently, which is the worst way
 * for a safety setting to fail.
 */
/** The same rule the string form is held to, applied to a list from any source. */
function checkAllowUnconfirmed(named: readonly string[], network: Network): readonly string[] {
  // A repeat is a typo or a merge artifact, not an instruction. Silently
  // collapsing it would hide the mistake; this is a set, so say so.
  const repeated = named.filter((e, i) => named.indexOf(e) !== i);
  if (repeated.length > 0) {
    throw new Error(
      `allowUnconfirmed names ${[...new Set(repeated)].join(", ")} more than once. It is a set ` +
        `of entrypoints; a repeat means something was pasted twice.`,
    );
  }
  const unusable = named.filter((e) => !isRefusableEntrypoint(e, network));
  if (unusable.length === 0) return named;
  throw new Error(
    `allowUnconfirmed names ${unusable.join(", ")}, which no allowance can apply to — each is ` +
      `either misspelt, already confirmed against this deployment, or reached by no action.`,
  );
}

function parseAllowUnconfirmed(raw: string | undefined, network: Network): string[] {
  const value = (raw ?? "").trim();
  // Unset means strict: an action whose layout this deployment has never been
  // seen to emit is refused until someone names it.
  if (value === "") return [];
  const parts = value.split(",").map((e) => e.trim());
  const named = parts.filter((e) => e.length > 0);
  // `",,,"` used to parse as "nothing named" and pass silently — a value that
  // looks like a setting and is not one. Same for a name that is merely
  // misspelt: it validated, matched no entrypoint, and quietly allowed nothing.
  if (
    named.length > 0 &&
    named.length === parts.length &&
    named.every((e) => isRefusableEntrypoint(e, network))
  ) {
    return named;
  }
  // No boolean form. `=1` read as "accept every unconfirmed layout", which put
  // back the entrypoints whose objects have never been observed alongside the
  // ones that are merely uncaptured — an escape hatch far wider than the thing
  // it was opened for. Naming them keeps the exception the size of the problem,
  // and `pnpm run doctor` prints the list to paste.
  const unknown = named.filter((e) => !isRefusableEntrypoint(e, network));
  throw new Error(
    `Invalid WATERX_ALLOW_UNCONFIRMED_ABI "${raw}". ` +
      (unknown.length > 0
        ? `${unknown.join(", ")} is not an entrypoint this allowance can apply to — it is ` +
          `either misspelt, already confirmed against this deployment, or reached by no ` +
          `action. Any of those is a setting that reads as meaningful and does nothing. Names ` +
          `are case-sensitive, as they are on chain. `
        : `Expected a comma-separated list of \`module::function\` entrypoints with no empty ` +
          `entries. `) +
      `There is no blanket form: accepting every unconfirmed layout at once is wider than any ` +
      `reason for wanting one. \`doctor\` prints the exact line.`,
  );
}

/**
 * Is this an entrypoint the allowance could actually apply to?
 *
 * Not merely "the verifier knows it". Naming one that IS captured, or that no
 * action reaches, produced a setting that reads as meaningful and does nothing
 * — the same silent no-op as a misspelling, wearing a valid name.
 */
function isRefusableEntrypoint(name: string, network: Network): boolean {
  // Per network, because the answer is. An entrypoint confirmed on testnet and
  // never measured on mainnet is refusable on one and a no-op setting on the
  // other, and a check that answered for the wrong deployment would accept a
  // line that does nothing.
  if (!Object.hasOwn(corpusFor(network).uncaptured, name)) return false;
  return Object.values(ACTION_RULES).some((rule) => rule.entrypoint === name);
}

/**
 * The network to use when nobody said.
 *
 * Mainnet, which reverses the usual default and is the safer answer here for a
 * reason worth stating: testnet does not work. Its gas faucet is rate-limited
 * to the point of refusing most first attempts, its collateral faucet is
 * whitelist-gated so no amount of retrying produces trading funds, and its
 * keeper has not been filling orders — so a correct order rests forever and
 * nothing becomes a position. Defaulting to it sent every new user down a road
 * with three walls across it.
 *
 * This is not a decision to trade with real money. Mainnet's execution policy
 * still defaults to `read-only`: what works out of the box is READING a live
 * deployment, and writing there stays something a person types.
 */
const DEFAULT_NETWORK: Network = "mainnet";

function parseNetwork(raw: string | undefined): Network {
  const value = (raw ?? DEFAULT_NETWORK).trim().toLowerCase();
  if (value === "testnet" || value === "mainnet") return value;
  throw new Error(
    `Invalid network "${raw}". Expected "testnet" or "mainnet" (WATERX_NETWORK / SUI_NETWORK).`,
  );
}

function parsePolicy(raw: string | undefined, network: Network): ExecutionPolicy {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === "") {
    // Unset means "the safe thing for this network", not "the convenient one".
    return network === "mainnet" ? "read-only" : "interactive";
  }
  if (value === "read-only" || value === "interactive" || value === "delegated-auto") return value;
  const alias = POLICY_ALIASES[value];
  if (alias !== undefined) return alias;
  throw new Error(
    `Invalid WATERX_EXECUTION_POLICY "${raw}". ` +
      `Expected "read-only", "interactive" or "delegated-auto".`,
  );
}

/**
 * Load the `delegated-auto` scope from the file named by
 * `WATERX_POLICY_SCOPE_FILE`.
 *
 * A file rather than environment variables, for the same reason the ceilings are
 * mandatory: a scope is a document an operator writes, reviews and can read back
 * later. Assembling one from six env vars makes a missing ceiling look like a
 * deployment detail instead of the hole it is.
 */
function loadScope(): PolicyScope | undefined {
  const path = process.env.WATERX_POLICY_SCOPE_FILE?.trim();
  if (path === undefined || path === "") return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new ExecutionPolicyError(
      `Cannot read WATERX_POLICY_SCOPE_FILE (${path}): ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  try {
    return JSON.parse(raw) as PolicyScope;
  } catch (cause) {
    throw new ExecutionPolicyError(
      `WATERX_POLICY_SCOPE_FILE (${path}) is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

const trimTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

/**
 * An environment variable's value, or `undefined` when it says nothing.
 *
 * Empty is not a value. `.env.example` ships these commented out, and the
 * obvious way to "turn one off" is to uncomment it and delete the text — which
 * left `WATERX_API_URL=""`, and `?? DEFAULT` does not catch an empty string. The
 * result was `Invalid URL` from deep inside a fetch, reported as an unreachable
 * backend: a configuration mistake wearing the costume of an outage.
 */
const stated = (raw: string | undefined): string | undefined => {
  const value = raw?.trim();
  return value === undefined || value === "" ? undefined : value;
};

export function loadConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const network =
    overrides.network ??
    parseNetwork(stated(process.env.WATERX_NETWORK) ?? stated(process.env.SUI_NETWORK));

  const config: AgentConfig = {
    network,
    apiUrl: trimTrailingSlash(
      overrides.apiUrl ?? stated(process.env.WATERX_API_URL) ?? DEFAULT_API_URL[network],
    ),
    grpcUrl: overrides.grpcUrl ?? stated(process.env.SUI_GRPC_URL) ?? DEFAULT_GRPC_URL[network],
    configUrl:
      overrides.configUrl ?? stated(process.env.WATERX_CONFIG_URL) ?? DEFAULT_CONFIG_URL[network],
    // Named exceptions REPLACE the shipped ones rather than adding to them: an
    // operator who writes the variable is stating the whole set deliberately,
    // and silently unioning would make it impossible to narrow a default.
    extraPackages:
      overrides.extraPackages ??
      (stated(process.env.WATERX_EXTRA_PACKAGES) === undefined
        ? DEFAULT_EXTRA_PACKAGES[network]
        : (process.env.WATERX_EXTRA_PACKAGES ?? "")
            .split(",")
            .map((id) => id.trim())
            .filter((id) => id.length > 0)),
    // Validated whichever way it arrives. An override skipped the parser
    // entirely, so a programmatic caller could name an entrypoint that is
    // captured, unreachable or misspelt and get a setting that reads as
    // meaningful and does nothing — the same silent no-op the environment form
    // was hardened against, reachable one layer in.
    allowUnconfirmed: checkAllowUnconfirmed(
      overrides.allowUnconfirmed ??
        parseAllowUnconfirmed(process.env.WATERX_ALLOW_UNCONFIRMED_ABI, network),
      network,
    ),
    executionPolicy: overrides.executionPolicy ?? parsePolicy(process.env.WATERX_EXECUTION_POLICY, network),
  };

  // Read at startup, not at the moment it first matters. A value this cannot
  // parse used to surface only when a manifest refresh failed — which is to say
  // during an outage, hours after the process started, in the one situation
  // where the setting decides whether to keep signing.
  manifestGraceMs();

  const policyScope = overrides.policyScope ?? loadScope();
  if (policyScope !== undefined) config.policyScope = policyScope;

  const accountId = overrides.accountId ?? process.env.WATERX_ACCOUNT_ID?.trim();
  if (accountId !== undefined && accountId !== "") config.accountId = accountId;

  const ownerAddress = overrides.ownerAddress ?? process.env.WATERX_OWNER_ADDRESS?.trim();
  if (ownerAddress !== undefined && ownerAddress !== "") config.ownerAddress = ownerAddress;

  const signerCommand = overrides.signerCommand ?? parseSignerCommand();
  if (signerCommand !== undefined) config.signerCommand = signerCommand;

  const agentWallet = overrides.agentWallet ?? process.env.WATERX_AGENT_WALLET?.trim();
  if (agentWallet !== undefined && agentWallet !== "") config.agentWallet = agentWallet;

  const timeout = overrides.signerTimeoutMs ?? parsePositiveInt(process.env.WATERX_SIGNER_TIMEOUT_MS);
  if (timeout !== undefined) config.signerTimeoutMs = timeout;

  return config;
}

/**
 * `WATERX_SIGNER_COMMAND` as a JSON array — `["waterx-predict-keystore","sign"]`.
 *
 * An array rather than a shell string, so a path containing a space stays one
 * argument and nothing in it is interpreted. A bare string is accepted for the
 * single-word case and split on nothing, not on whitespace, for the same reason.
 */
function parseSignerCommand(): string[] | undefined {
  const raw = process.env.WATERX_SIGNER_COMMAND?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!raw.startsWith("[")) return [raw];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `WATERX_SIGNER_COMMAND is not valid JSON. Expected an argv array, e.g. ["waterx-predict-keystore","sign"].`,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string") || parsed.length === 0) {
    throw new Error(`WATERX_SIGNER_COMMAND must be a non-empty array of strings.`);
  }
  return parsed as string[];
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer, got "${raw}".`);
  }
  return value;
}

/** Read `WATERX_ACCOUNT_ID`, failing with an actionable message when unset. */
export function requireAccountId(config: AgentConfig): string {
  if (config.accountId === undefined) {
    throw new ConfigError(
      // The delegate path first, because it is the usual one — and because the
      // old advice ("create an account, then copy its id into .env") was the
      // owner path spelled as if it were the only one, in a checkout's syntax.
      "No WaterX account configured. A delegate gets one from its owner: `onboard` says what to " +
        "ask them for, `discover` finds the account once they have granted this wallet, and " +
        "`adopt` records which one a person chose — no id to copy. A wallet that should hold an " +
        "account of its own creates it with `bootstrap --create-account --yes`, which writes " +
        "WATERX_ACCOUNT_ID itself.",
    );
  }
  return config.accountId;
}

/**
 * Is this process signing as a delegate of someone else?
 *
 * The comparison, not the mere presence of `ownerAddress`: setting it to the
 * signer's own address would otherwise satisfy every "is a delegate configured?"
 * check while the process still holds owner authority — which is precisely the
 * combination `delegated-auto` exists to exclude.
 */
export function signsAsDelegate(config: AgentConfig, signerAddress: string): boolean {
  if (config.ownerAddress === undefined) return false;
  return config.ownerAddress.toLowerCase() !== signerAddress.toLowerCase();
}

/** Suiscan link for a digest, for human-readable script output. */
export const explorerTxUrl = (network: Network, digest: string): string =>
  `https://suiscan.xyz/${network}/tx/${digest}`;
