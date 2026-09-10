/** List the WaterX accounts this wallet owns. */
import { initAgent, run, show } from "../lib/cli.ts";

await run(async () => {
  const agent = initAgent();
  show(await agent.accounts());
});
