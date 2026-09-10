/** WLP pool state: overview, APY, and this account's stake. */
import type { WlpPeriod } from "../../src/api/types.ts";
import { initAgent, parseArgs, run, show } from "../lib/cli.ts";

const PERIODS: readonly WlpPeriod[] = ["1d", "7d", "30d", "all"];

const args = parseArgs(
  { period: { desc: `APY window: ${PERIODS.join(" | ")}`, default: "7d" } },
  "wlp-info",
);

// The backend refuses anything else, and refuses an absent period too — so a
// bad value is caught here, where the message can say what is allowed, rather
// than coming back as "Invalid period" with no list.
const period = args.period as WlpPeriod;
if (!PERIODS.includes(period)) {
  throw new Error(`--period must be one of ${PERIODS.join(", ")}, not "${String(args.period)}"`);
}

await run(async () => {
  const agent = initAgent();
  show({
    overview: await agent.read.wlpOverview(),
    apy: await agent.read.wlpApy(period),
    navHistory: await agent.read.wlpNavHistory(period),
    perpVolume: await agent.read.wlpPerpVolume(period),
    stake: await agent.read.wlpStakeInfo(agent.accountId),
    pendingWithdrawals: await agent.read.wlpWithdrawals(agent.accountId),
  });
});
