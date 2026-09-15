/**
 * Where `discover` and `adopt` look for grants, wired once.
 *
 * `adopt` counts the grants that carry this agent's pairing code — one is proof,
 * a second is a copy — so it has to look in exactly the places `discover` does.
 * Two copies of this wiring would be two answers to "how many are there?".
 */
import type { DiscoveryDeps } from "../../src/agent/discovery.ts";
import { accountObjectReader } from "../../src/chain/account-object.ts";
import { loadDeployment } from "../../src/chain/deployment.ts";
import { grantEventCandidates } from "../../src/chain/grant-events.ts";
import type { initAgent } from "./cli.ts";

export async function discoveryDeps(agent: ReturnType<typeof initAgent>): Promise<DiscoveryDeps> {
  const deployment = await loadDeployment(agent.config.configUrl);
  // The ORIGINAL package id names event types; `idsFor` lists it last.
  const accountPackage = deployment.idsFor("waterx_account").at(-1);
  return {
    delegatedAccounts: (delegate) => agent.read.delegatedAccounts(delegate),
    recentGrantEvents:
      accountPackage === undefined
        ? () => Promise.reject(new Error("the deployment config names no waterx_account package"))
        : grantEventCandidates(agent.config.network, accountPackage),
    readAccount: accountObjectReader(agent.config),
  };
}
