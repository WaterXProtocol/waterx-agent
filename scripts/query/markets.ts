/** Every market the deployment lists, and which of them are tradeable. */
import { initAgent, note, run, show } from "../lib/cli.ts";

await run(async () => {
  const agent = initAgent();
  const markets = await agent.read.markets();
  note(`Tradeable: ${(await agent.markets.tradeableTickers()).join(", ")}\n`);
  show(markets);
});
