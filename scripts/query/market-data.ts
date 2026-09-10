/** Off-protocol market intelligence: coin prices, trending, fear & greed. */
import { asNumber, initAgent, parseArgs, run, show } from "../lib/cli.ts";

const args = parseArgs(
  {
    coins: { desc: "Symbols, comma-separated, e.g. BTC,ETH", default: "BTC,ETH,SUI" },
    days: { desc: "Fear & Greed history in days", default: "7" },
  },
  "market-data",
);

await run(async () => {
  const agent = initAgent();
  show({
    prices: await agent.read.coinPrices(args.coins ?? "BTC"),
    trending: await agent.read.trending(),
    fearGreed: await agent.read.fearGreed(asNumber(args.days)),
  });
});
