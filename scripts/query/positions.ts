/**
 * Open positions, with PnL and liquidation estimates.
 *
 * `estLiqPrice: 0` means "cannot estimate" — never "no liquidation risk" — and
 * `priceStale: true` means every price-derived field below it is stale too.
 */
import { describeOversized, oversizedStops } from "../../src/agent/stops.ts";
import { invoke } from "../../src/cli/contract.ts";
import { initAgent, note, run, show } from "../lib/cli.ts";

await run(async () => {
  const agent = initAgent();
  const positions = await agent.positions();

  // A protective leg left larger than the position it protects, after a partial
  // close. Reported here because this is where somebody reads a position's size
  // next to its stop's: the two disagreeing silently is what made an operator
  // believe they held protection for 11.87 on a position of 5.93. Reduce-only, so
  // nothing can over-close — which is why it is said rather than refused.
  const stale = positions.flatMap((position) =>
    oversizedStops(position).map((stop) => ({
      positionId: Number(position.id),
      ...stop,
      fix: invoke("sync-stops", "--ticker", stop.ticker, "--position-id", position.id),
    })),
  );
  if (stale.length > 0) {
    note("");
    for (const stop of stale) note(`  ! ${describeOversized(stop)}`);
    note(`    ${stale[0]?.fix ?? ""}`);
    note("");
  }

  show({ positions, ...(stale.length === 0 ? {} : { oversizedStops: stale }) });
});
