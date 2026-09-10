/** Resting orders across every market, with their TP/SL legs nested. */
import { initAgent, run, show } from "../lib/cli.ts";

await run(async () => {
  const agent = initAgent();
  show(await agent.orders());
});
