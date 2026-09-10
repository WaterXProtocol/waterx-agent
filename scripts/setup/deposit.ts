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

  // The asset's own `decimals` has to travel with its
  // `coinType`: the amount is in base units of THAT asset, and this script used
  // to pick `backingAssets[0]` while `deposit()` scaled by a hardcoded 6.
  // Depositing a 9-decimal asset (SUI is one) sent a thousandth of the ask.
  const info = await agent.read.info();
  let assetType = args.assetType;
  let asset = info.backingAssets.find((a) => a.coinType === assetType);
  if (assetType === undefined) {
    asset = info.backingAssets[0];
    if (asset === undefined) {
      throw new Error("This deployment registers no backing assets; nothing can be deposited.");
    }
    assetType = asset.coinType;
    console.log(`Using backing asset ${asset.symbol} (${asset.coinType})`);
    if (info.backingAssets.length > 1) {
      console.log(`Others: ${info.backingAssets.slice(1).map((a) => a.symbol).join(", ")}`);
    }
  }
  if (asset === undefined) {
    throw new Error(
      `${assetType} is not a backing asset of this deployment, so its decimals are unknown. ` +
        `Registered: ${info.backingAssets.map((a) => a.coinType).join(", ") || "(none)"}.`,
    );
  }

  const result = await agent.deposit({
    assetType,
    amount: args.amount ?? "0",
    decimals: asset.decimals,
    confirm: confirmed(),
  });
  reportTx(agent, "deposit", result);
});
