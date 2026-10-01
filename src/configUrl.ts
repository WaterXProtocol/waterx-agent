/**
 * The waterx-config source: `WATERX_CONFIG_URL` is a CDN ROOT (no filename) and
 * the document read is `{root}/{network}.json`, with `network` taken from the
 * agent's own network setting (`WATERX_NETWORK` / `SUI_NETWORK` / the
 * `network` override). The fleet-wide convention: one root serves both
 * networks, so switching network can never leave the agent reading the other
 * network's document.
 *
 * The single source of truth for that URL — `loadConfig`, every
 * `loadDeployment` caller, `doctor` and the corpus capture script all resolve
 * it here, so a value is validated once, the same way, everywhere.
 *
 * The URL rules themselves — https only, no GitHub host, no `….json` document
 * URL, no query or fragment, refused rather than rewritten — are the SDK's
 * `waterxConfigUrlFromRoot`, the fleet's one implementation. What stays here is
 * this repo's policy around it: a developer CLI, so an unset value defaults to
 * the per-network v2 root rather than failing, and a retired alias refuses.
 */

import { waterxConfigUrlFromRoot } from "@waterx/sdk/config";

import { ConfigError } from "./errors.ts";

/** Kept local rather than imported from `config.ts`, which imports this module. */
type Network = "testnet" | "mainnet";

/**
 * Default root per network: the consolidated `schema_version: 2` documents.
 * The legacy hosts — `config.waterx.app` and `staging.waterx-config.pages.dev`
 * — still serve the pre-v2 per-package shape while they are retired, and
 * `deployment.ts` refuses that shape outright.
 */
export const DEFAULT_CONFIG_ROOT: Readonly<Record<Network, string>> = {
  testnet: "https://staging-v2.waterx-config.pages.dev",
  mainnet: "https://main-v2.waterx-config.pages.dev",
};

/**
 * Names other WaterX repos (or earlier setups) used for the same setting. One
 * set in an environment that also runs this agent means someone expected it to
 * take effect; ignoring it would quietly read the default instead.
 */
export const RETIRED_CONFIG_URL_ALIASES = [
  "E2E_CONFIG_URL",
  "PREDICT_CONFIG_URL",
  "CONFIG_URL",
  "WATERX_CONFIG_ROOT",
  "WATERX_CONFIG_REF",
] as const;

const EXAMPLE = DEFAULT_CONFIG_ROOT.mainnet;

/** Refuse a retired alias for `WATERX_CONFIG_URL` that is still set. */
export function assertNoRetiredConfigAliases(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  for (const name of RETIRED_CONFIG_URL_ALIASES) {
    if ((env[name]?.trim() ?? "") === "") continue;
    throw new ConfigError(
      `${name} is retired — set WATERX_CONFIG_URL instead, to a waterx-config CDN ROOT with ` +
        `no filename (e.g. ${EXAMPLE}; <network>.json is appended), and unset ${name}.`,
    );
  }
}

/**
 * The deployment document URL for a config: `{root}/{network}.json`, composed
 * and validated by the SDK's `waterxConfigUrlFromRoot`. Validated on every
 * call, so a hand-built `AgentConfig` that skipped `loadConfig` cannot slip a
 * document URL through.
 */
export function configDocumentUrl(config: { configUrl: string; network: Network }): string {
  try {
    return waterxConfigUrlFromRoot(config.configUrl, config.network);
  } catch (error) {
    throw new ConfigError(`WATERX_CONFIG_URL: ${(error as Error).message}`, { cause: error });
  }
}

/**
 * The root to store in `AgentConfig.configUrl`: trimmed, without trailing
 * slashes, and validated (see `configDocumentUrl`). Unset or blank falls back
 * to the default root for `network`.
 */
export function resolveConfigRoot(raw: string | undefined, network: Network): string {
  const value = raw?.trim() ?? "";
  if (value === "") return DEFAULT_CONFIG_ROOT[network];
  const root = value.replace(/\/+$/, "");
  configDocumentUrl({ configUrl: root, network });
  return root;
}
