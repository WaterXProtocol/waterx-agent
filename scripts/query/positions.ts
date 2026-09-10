/**
 * Open positions, with PnL and liquidation estimates.
 *
 * `estLiqPrice: 0` means "cannot estimate" — never "no liquidation risk" — and
 * `priceStale: true` means every price-derived field below it is stale too.
 */
import { initAgent, run, show } from "../lib/cli.ts";

await run(async () => {
  const agent = initAgent();
  show(await agent.positions());
});
