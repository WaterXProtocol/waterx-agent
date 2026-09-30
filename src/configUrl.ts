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
 * A developer CLI, so an unset value defaults to the per-network v2 root rather
 * than failing. Pointing it anywhere else is a decision someone typed.
 */

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
] as const;

const EXAMPLE = DEFAULT_CONFIG_ROOT.mainnet;

/**
 * GitHub host SUFFIXES the config repo forbids. Suffixes, not exact names:
 * GitHub serves raw bytes from several hosts (`raw.githubusercontent.com`,
 * `objects.githubusercontent.com`, `codeload.github.com`), all rate-limited.
 */
const FORBIDDEN_HOST_SUFFIXES = ["github.com", "githubusercontent.com"];

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
 * Validate a configured root and return it without trailing slashes. Unset or
 * blank falls back to the default root for `network`.
 *
 * Refuses, never rewrites: a document URL (`….json`, the old format), a
 * non-https scheme, a GitHub host, and a query or fragment (appending
 * `/<network>.json` to either would break it).
 */
export function resolveConfigRoot(raw: string | undefined, network: Network): string {
  const value = raw?.trim() ?? "";
  if (value === "") return DEFAULT_CONFIG_ROOT[network];

  // Normalised BEFORE the filename test: `…/mainnet.json/` does not end in
  // `.json`, so a trailing slash would otherwise smuggle a document URL past it.
  const root = value.replace(/\/+$/, "");

  let url: URL;
  try {
    url = new URL(root);
  } catch {
    throw new ConfigError(
      `WATERX_CONFIG_URL is not a URL — got "${value}". Set it to a waterx-config CDN ROOT, ` +
        `e.g. ${EXAMPLE}.`,
    );
  }
  if (url.protocol !== "https:") {
    throw new ConfigError(
      `WATERX_CONFIG_URL must use https — got "${value}". Set it to a waterx-config CDN ROOT, ` +
        `e.g. ${EXAMPLE}.`,
    );
  }
  const host = url.hostname.toLowerCase();
  if (FORBIDDEN_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    throw new ConfigError(
      `WATERX_CONFIG_URL must not point at ${host} — got "${value}". GitHub is rate-limited ` +
        `and forbidden by the config repo; use the waterx-config CDN, e.g. ${EXAMPLE}.`,
    );
  }
  if (url.pathname.replace(/\/+$/, "").toLowerCase().endsWith(".json")) {
    throw new ConfigError(
      `WATERX_CONFIG_URL must be a CDN ROOT with no filename — got "${value}". Set it to ` +
        `e.g. ${EXAMPLE}; <network>.json is appended.`,
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigError(
      `WATERX_CONFIG_URL must be a CDN ROOT with no query or fragment — got "${value}". ` +
        `Set it to e.g. ${EXAMPLE}; <network>.json is appended.`,
    );
  }
  return root;
}

/**
 * The deployment document URL for a config: `{root}/{network}.json`. The root
 * is re-validated, so a hand-built `AgentConfig` that skipped `loadConfig`
 * cannot slip a document URL through.
 */
export function configDocumentUrl(config: { configUrl: string; network: Network }): string {
  return `${resolveConfigRoot(config.configUrl, config.network)}/${config.network}.json`;
}
