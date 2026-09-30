/**
 * WATERX_CONFIG_URL is a CDN ROOT; the document is `{root}/{network}.json`.
 *
 * Every refusal here is a value that used to be valid (a full document URL) or
 * one that would appear to work and then fail far from the setting — a 404 on
 * `…/mainnet.json/testnet.json`, a 429 from GitHub under load.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.ts";
import {
  assertNoRetiredConfigAliases,
  configDocumentUrl,
  DEFAULT_CONFIG_ROOT,
  resolveConfigRoot,
  RETIRED_CONFIG_URL_ALIASES,
} from "../src/configUrl.ts";
import { ConfigError } from "../src/errors.ts";

const MAIN = "https://main-v2.waterx-config.pages.dev";
const STAGING = "https://staging-v2.waterx-config.pages.dev";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("WATERX_CONFIG_URL", () => {
  it("appends <network>.json to the root, for both networks", () => {
    expect(configDocumentUrl({ configUrl: MAIN, network: "mainnet" })).toBe(`${MAIN}/mainnet.json`);
    expect(configDocumentUrl({ configUrl: STAGING, network: "testnet" })).toBe(
      `${STAGING}/testnet.json`,
    );
  });

  it("strips trailing slashes from the root", () => {
    expect(resolveConfigRoot(`${MAIN}//`, "mainnet")).toBe(MAIN);
    expect(configDocumentUrl({ configUrl: `${STAGING}/`, network: "testnet" })).toBe(
      `${STAGING}/testnet.json`,
    );
  });

  it("defaults to the per-network v2 root when unset or blank", () => {
    expect(resolveConfigRoot(undefined, "mainnet")).toBe(MAIN);
    expect(resolveConfigRoot("  ", "testnet")).toBe(STAGING);
    expect(DEFAULT_CONFIG_ROOT).toEqual({ mainnet: MAIN, testnet: STAGING });
    expect(configDocumentUrl(loadConfig({ network: "mainnet" }))).toBe(`${MAIN}/mainnet.json`);
    expect(configDocumentUrl(loadConfig({ network: "testnet" }))).toBe(`${STAGING}/testnet.json`);
  });

  it("reads the root from the environment, and the network from the network setting", () => {
    vi.stubEnv("WATERX_CONFIG_URL", `${STAGING}/`);
    vi.stubEnv("WATERX_NETWORK", "mainnet");
    const config = loadConfig();
    expect(config.configUrl).toBe(STAGING);
    expect(configDocumentUrl(config)).toBe(`${STAGING}/mainnet.json`);
  });

  it("takes the programmatic override as a root too", () => {
    const config = loadConfig({ network: "testnet", configUrl: MAIN });
    expect(configDocumentUrl(config)).toBe(`${MAIN}/testnet.json`);
  });

  it.each([
    `${MAIN}/mainnet.json`,
    `${MAIN}/mainnet.json/`,
    `${MAIN}/MAINNET.JSON`,
  ])("refuses a document URL (%s) rather than rewriting it", (value) => {
    expect(() => resolveConfigRoot(value, "mainnet")).toThrow(ConfigError);
    expect(() => resolveConfigRoot(value, "mainnet")).toThrow(/CDN ROOT with no filename/);
    vi.stubEnv("WATERX_CONFIG_URL", value);
    expect(() => loadConfig({ network: "mainnet" })).toThrow(/<network>\.json is appended/);
  });

  it("refuses a document URL on a hand-built config that skipped loadConfig", () => {
    expect(() =>
      configDocumentUrl({ configUrl: `${STAGING}/testnet.json`, network: "testnet" }),
    ).toThrow(/no filename/);
  });

  it.each([
    "https://raw.githubusercontent.com/WaterXProtocol/waterx-config/main-v2",
    "https://github.com/WaterXProtocol/waterx-config",
    "https://codeload.github.com/WaterXProtocol/waterx-config",
  ])("refuses a GitHub host (%s)", (value) => {
    expect(() => resolveConfigRoot(value, "mainnet")).toThrow(/must not point at .*github/);
  });

  it("refuses a non-https scheme", () => {
    expect(() => resolveConfigRoot("http://main-v2.waterx-config.pages.dev", "mainnet")).toThrow(
      /must use https/,
    );
    expect(() => resolveConfigRoot("file:///tmp/config", "mainnet")).toThrow(/must use https/);
  });

  it("refuses something that is not a URL", () => {
    expect(() => resolveConfigRoot("main-v2.waterx-config.pages.dev", "mainnet")).toThrow(
      /WATERX_CONFIG_URL is not a URL/,
    );
  });

  it("refuses a query or fragment, which appending would break", () => {
    expect(() => resolveConfigRoot(`${MAIN}?ref=main`, "mainnet")).toThrow(/no query or fragment/);
    expect(() => resolveConfigRoot(`${MAIN}#top`, "mainnet")).toThrow(/no query or fragment/);
  });
});

describe("retired WATERX_CONFIG_URL aliases", () => {
  it.each(RETIRED_CONFIG_URL_ALIASES)("refuse loudly when %s is set", (name) => {
    vi.stubEnv(name, `${MAIN}/mainnet.json`);
    expect(() => assertNoRetiredConfigAliases()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(new RegExp(`${name} is retired — set WATERX_CONFIG_URL`));
  });

  it("are ignored when blank", () => {
    vi.stubEnv("CONFIG_URL", " ");
    expect(() => loadConfig()).not.toThrow();
  });
});
