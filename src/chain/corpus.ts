/**
 * The recorded argument layouts, per network.
 *
 * Every positional check in `verify.ts` reads this fixture, and the executor
 * refuses to sign when the packages it names have moved. That comparison is
 * against a *specific deployment*, which is why the file is keyed by network:
 * testnet and mainnet publish different packages under the same names, so a
 * corpus captured on one describes the other as entirely changed.
 *
 * It held a single deployment until it had to hold two, and the failure mode
 * was quiet in the worst way. Pointing the agent at mainnet made every package
 * read as moved, `execute()` refused every write, and the message said "re-run
 * capture-corpus" — which would have overwritten the testnet record with a
 * mainnet one and moved the same failure to the other network. The two were
 * mutually exclusive and nothing said so.
 *
 * A network with no record is a refusal, not an empty allowance. "We have never
 * measured this deployment" and "this deployment has nothing to measure" are
 * different statements, and only one of them is a reason to sign.
 */
import type { Network } from "../config.ts";
import file from "./abi-corpus.json" with { type: "json" };

/** One deployment's measurements. */
export interface NetworkCorpus {
  /** ISO date, for reporting how old the measurement is. */
  capturedAt: string;
  /** The backend's own name for the network — `sui_testnet` / `sui_mainnet`. */
  network: string;
  /** The `@waterx/sdk` release the ABI was extracted from. */
  sdkVersion: string;
  /** The deployment's packages at capture time, by name. */
  packages: Record<string, string>;
  /** Per entrypoint, what a real transaction carried at each position. */
  captured: Record<
    string,
    { package: string; sent: Record<string, string>; positions: (string | null)[]; typeArguments: string[] }[]
  >;
  /** Entrypoints with no capture, and why — the reason is the useful half. */
  uncaptured: Record<string, string>;
}

interface CorpusFile {
  version: number;
  networks: Record<string, NetworkCorpus | undefined>;
}

const file2 = file as unknown as CorpusFile;

/** An empty record. Distinct from a missing one — see {@link corpusFor}. */
const NOTHING_MEASURED: NetworkCorpus = {
  capturedAt: "never",
  network: "unknown",
  sdkVersion: "unknown",
  packages: {},
  captured: {},
  uncaptured: {},
};

/** Which networks the committed fixture actually describes. */
export const measuredNetworks = (): string[] => Object.keys(file2.networks);

/**
 * The record for a network, or an empty one when there is none.
 *
 * Empty is safe here and is not an allowance: `packages: {}` makes
 * `assertCorpusDescribes` report every live package as newly published, so the
 * executor refuses — which is the correct answer to "we have never measured
 * this deployment". {@link hasCorpusFor} is how a caller tells the two apart in
 * order to say so in words.
 */
export function corpusFor(network: Network): NetworkCorpus {
  return file2.networks[network] ?? NOTHING_MEASURED;
}

/** Has this network ever been measured? */
export const hasCorpusFor = (network: Network): boolean =>
  file2.networks[network] !== undefined;
