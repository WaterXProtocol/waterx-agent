/** Referral codes, referrer and stats for this wallet. */
import { initAgent, run, show } from "../lib/cli.ts";

await run(async () => {
  const agent = initAgent();
  const owner = agent.executor.senderAddress;
  show({
    codes: await agent.read.referralCodes(owner),
    referrer: await agent.read.referrer(owner),
    stats: await agent.read.referralStats(owner),
    overview: await agent.read.referralOverview(owner),
  });
});
