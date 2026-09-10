/**
 * The deployment's own metadata: network, collateral, backing assets, markets.
 * Prefer this over any list compiled into a client.
 */
import { initAgent, run, show } from "../lib/cli.ts";

await run(async () => {
  const agent = initAgent();
  show(await agent.read.info());
});
