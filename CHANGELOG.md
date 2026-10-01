# Changelog

## Unreleased

### BREAKING

- **`WATERX_CONFIG_URL` and `AgentConfig.configUrl` are now a waterx-config CDN ROOT, not a
  document URL.** The document read is `{root}/{network}.json`, with the network taken from
  `WATERX_NETWORK` / `SUI_NETWORK` / the `network` override. This applies to the environment
  variable, to `loadConfig({ configUrl })`, `runDoctor({ configUrl })` and
  `new WaterXAgent({ config: { configUrl } })`, and to `AgentConfig.configUrl` as returned by
  `loadConfig()`.
  - Defaults: mainnet `https://main-v2.waterx-config.pages.dev`, testnet
    `https://staging-v2.waterx-config.pages.dev`.
  - Refused at `loadConfig` (a `ConfigError` prefixed `WATERX_CONFIG_URL:`, never a silent
    rewrite): a value ending in `.json` (the old format), a non-https URL, a GitHub host
    (`github.com`, `*.githubusercontent.com`), and a root carrying a query or fragment. These
    rules are `@waterx/sdk`'s `waterxConfigUrlFromRoot`, the fleet's one implementation, so the
    error text is the SDK's.
  - Retired aliases `E2E_CONFIG_URL`, `PREDICT_CONFIG_URL`, `CONFIG_URL`, `WATERX_CONFIG_ROOT`
    and `WATERX_CONFIG_REF` refuse if set.
  - Migrate: `WATERX_CONFIG_URL=https://main-v2.waterx-config.pages.dev/mainnet.json` becomes
    `WATERX_CONFIG_URL=https://main-v2.waterx-config.pages.dev`.

### Changed

- `@waterx/sdk` 4.3.3 → 6.1.0 (waterx-config v2 documents; `waterxConfigUrlFromRoot`).

### Added

- `configDocumentUrl(config)`, `resolveConfigRoot(raw, network)`, `assertNoRetiredConfigAliases()`
  and `DEFAULT_CONFIG_ROOT`, exported from the package entry — the single place the document URL
  is resolved (`loadConfig`, `doctor`, every `loadDeployment` caller and the corpus capture script,
  which goes through `loadConfig`). `configDocumentUrl` composes with the SDK's
  `waterxConfigUrlFromRoot`; the default roots and the retired-alias check are this package's.
