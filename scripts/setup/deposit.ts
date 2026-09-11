/**
 * Mint wxUSD credit against a backing asset.
 *
 * Deposit is a credit mint now, not a collateral transfer, so it names the Move
 * type of the coin being deposited. `GET /info` lists what the deployment
 * accepts; pass `--asset-type` to pick one, or omit it to use the first.
 */
import { confirmed, initAgent, parseArgs, reportTx, run } from "../lib/cli.ts";

const args = parseArgs(
  {
    amount: { desc: "Amount in display units, e.g. 50", required: true },
    assetType: { desc: "Fully-qualified Move coin type (defaults to the first backing asset)" },
    yes: { desc: "Confirm this write", flag: true },
    policy: { desc: "Narrow the execution policy for this invocation" },
  },
  "deposit",
);

await run(async () => {
  const agent = initAgent();

  let assetType = args.assetType;
  if (assetType === undefined) {
    const info = await agent.read.info();
    const first = info.backingAssets[0];
    if (first === undefined) {
      throw new Error("This deployment registers no backing assets; nothing can be deposited.");
    }
    assetType = first.coinType;
    console.log(`Using backing asset ${first.symbol} (${first.coinType})`);
    if (info.backingAssets.length > 1) {
      console.log(`Others: ${info.backingAssets.slice(1).map((a) => a.symbol).join(", ")}`);
    }
  }

  const result = await agent.deposit({
    assetType,
    amount: args.amount ?? "0",
    confirm: confirmed(),
  });
  reportTx(agent, "deposit", result);
});
