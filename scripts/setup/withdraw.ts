/**
 * Withdraw wxUSD to a backing stablecoin on Sui.
 *
 * Owner-only on chain: a delegate signature cannot move funds out, whatever
 * its permission mask says.
 */
import { confirmed, initAgent, parseArgs, reportTx, run } from "../lib/cli.ts";

const args = parseArgs(
  {
    amount: { desc: "Amount in display units", required: true },
    assetType: { desc: "Backing asset Move type to receive (defaults to the first)" },
    toAddress: { desc: "Recipient wallet (defaults to the sender)" },
    yes: { desc: "Confirm this write", flag: true },
    policy: { desc: "Narrow the execution policy for this invocation" },
  },
  "withdraw",
);

await run(async () => {
  const agent = initAgent();

  let assetType = args.assetType;
  if (assetType === undefined) {
    const info = await agent.read.info();
    const first = info.backingAssets[0];
    if (first === undefined) throw new Error("This deployment registers no backing assets.");
    assetType = first.coinType;
    console.log(`Withdrawing as ${first.symbol}`);
  }

  const result = await agent.withdraw({
    assetType,
    amount: args.amount ?? "0",
    ...(args.toAddress !== undefined ? { toAddress: args.toAddress } : {}),
    confirm: confirmed(),
  });
  reportTx(agent, "withdraw", result);
});
