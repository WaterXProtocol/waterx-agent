/**
 * Delegates on this account.
 *
 * Four independent masks — perp, predict, staking, and (on chain) WLP. None of
 * them grants a funds-out path.
 */
import { initAgent, run, show } from "../lib/cli.ts";

await run(async () => {
  const agent = initAgent();
  show(await agent.delegates());
});
