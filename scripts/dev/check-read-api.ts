/**
 * Call every read method against the live backend and report which ones work.
 *
 * Unit tests cannot catch what this catches. Every failure it has found so far
 * was the backend renaming a query parameter or making an optional one
 * required — `user` becoming `owner`, `coinIds` becoming `symbols`, `period`
 * becoming mandatory. The types still compiled and the tests still passed; the
 * calls just started coming back as errors, and two of them read as "no data"
 * rather than as a broken request.
 *
 * Run it after a backend release. It signs nothing and writes nothing.
 */
import { initAgent, run } from "../lib/cli.ts";

await run(async () => {
  const agent = initAgent();
  const read = agent.read;
  const account = agent.accountId;
  const owner = agent.executor.senderAddress;

  const checks: [string, () => Promise<unknown>][] = [
    ["health", () => read.health()],
    ["info", () => read.info()],
    ["markets", () => read.markets()],
    ["tickers", () => read.tickers()],
    ["ticker", () => read.ticker("SUIUSD")],
    ["marketParams", () => read.marketParams("SUIUSD")],
    ["borrowRate", () => read.borrowRate()],
    ["candles", () => read.candles("SUIUSD", { tf: "1h", limit: 3 })],
    ["trades", () => read.trades("SUIUSD", 3)],
    ["fundingHistory", () => read.fundingHistory("SUIUSD", 3)],
    ["accounts", () => read.accounts(owner)],
    ["delegates", () => read.delegates(account)],
    ["overview", () => read.overview(account)],
    ["pnlSummary", () => read.pnlSummary(account)],
    ["equityHistory", () => read.equityHistory(account)],
    ["pnlHistory", () => read.pnlHistory(account)],
    ["history", () => read.history({ account, limit: 2 })],
    ["deposits", () => read.deposits(owner, { limit: 2 })],
    ["withdraws", () => read.withdraws(owner, { limit: 2 })],
    ["positions", () => read.positions(account)],
    ["orders", () => read.orders({ account })],
    ["wlpOverview", () => read.wlpOverview()],
    ["wlpApy", () => read.wlpApy("7d")],
    ["wlpNavHistory", () => read.wlpNavHistory("7d")],
    ["wlpPerpVolume", () => read.wlpPerpVolume("7d")],
    ["wlpStakeInfo", () => read.wlpStakeInfo(account)],
    ["wlpWithdrawals", () => read.wlpWithdrawals(account)],
    ["coinPrices", () => read.coinPrices("BTC,ETH")],
    ["coin", () => read.coin("BTC")],
    ["trending", () => read.trending()],
    ["marketOverview", () => read.marketOverview(3)],
    ["fearGreed", () => read.fearGreed(7)],
    ["referralCodes", () => read.referralCodes(owner)],
    ["referrer", () => read.referrer(owner)],
    ["referralStats", () => read.referralStats(owner)],
    ["referralOverview", () => read.referralOverview(owner)],
  ];

  const broken: string[] = [];
  for (const [name, call] of checks) {
    try {
      await call();
      console.log(`  ✓ ${name}`);
    } catch (cause) {
      broken.push(name);
      console.log(`  ✗ ${name} — ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  console.log(`\n${String(checks.length - broken.length)}/${String(checks.length)} reachable`);
  if (broken.length > 0) {
    // A non-zero exit, because a drifted parameter is a broken build even
    // though every test passed.
    throw new Error(`unreachable: ${broken.join(", ")}`);
  }
});
