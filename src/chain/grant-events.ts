/**
 * Account ids from RECENT on-chain grant events that name a delegate.
 *
 * The fallback for discovery when the backend cannot answer. Public GraphQL
 * keeps a limited window of events (measured on mainnet: about four weeks),
 * so this finds a grant made recently — the case that matters right after an
 * owner signs — and cannot find an old one. Candidates only: removals and
 * expiry are settled by reading the account from chain.
 */
import { normalizeSuiAddress } from "@mysten/sui/utils";

import type { Network } from "../config.ts";

export const GRAPHQL_URL: Readonly<Record<Network, string>> = {
  mainnet: "https://graphql.mainnet.sui.io/graphql",
  testnet: "https://graphql.testnet.sui.io/graphql",
};

const QUERY = `query($type: String!) {
  events(filter: { type: $type }, last: 50) {
    nodes { contents { json } }
  }
}`;

type Fetch = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * @param accountPackage the ORIGINAL id of `waterx_account` — event types are
 * named by the package that first defined them, not by its latest upgrade.
 * Accepted with or without `0x`: `Deployment.idsFor` hands ids back bare
 * (normalised for set membership), and Sui GraphQL rejects a type written that
 * way as an invalid filter. That shipped once — discover crashed on testnet —
 * so the normalisation lives here, where no caller can forget it.
 */
export function grantEventCandidates(
  network: Network,
  accountPackage: string,
  fetchImpl: Fetch = fetch as unknown as Fetch,
  url: string = process.env.SUI_GRAPHQL_URL?.trim() || GRAPHQL_URL[network],
): (delegate: string) => Promise<string[]> {
  const pkg = normalizeSuiAddress(accountPackage);
  const types = ["DelegateAdded", "DelegateUpdated"].map((e) => `${pkg}::events::${e}`);
  return async (delegate) => {
    const me = normalizeSuiAddress(delegate);
    const found = new Set<string>();
    for (const type of types) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { type } }),
      });
      if (!response.ok) throw new Error(`Sui GraphQL ${url} → HTTP ${String(response.status)}`);
      const body = (await response.json()) as {
        errors?: { message: string }[];
        data?: { events?: { nodes?: { contents?: { json?: Record<string, unknown> } }[] } };
      };
      if (body.errors?.length) throw new Error(`Sui GraphQL: ${body.errors[0]?.message ?? "error"}`);
      for (const node of body.data?.events?.nodes ?? []) {
        const json = node.contents?.json;
        if (typeof json?.delegate !== "string" || typeof json.account_object_address !== "string") continue;
        if (normalizeSuiAddress(json.delegate) === me) found.add(normalizeSuiAddress(json.account_object_address));
      }
    }
    return [...found];
  };
}
