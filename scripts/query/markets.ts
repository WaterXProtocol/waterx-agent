/** Every market the deployment lists, and which of them are tradeable. */
import { initAgent, run, show } from "../lib/cli.ts";

await run(async () => {
  const agent = initAgent();
  const markets = await agent.read.markets();
  console.log(`Tradeable: ${(await agent.markets.tradeableTickers()).join(", ")}\n`);
  show(markets);
});
