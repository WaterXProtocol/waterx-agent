/**
 * Open a position at the oracle price, bounded by `--slippage`.
 *
 * Shared by `open-long` and `open-short`; the side comes from `--short`.
 */
import { asNumber, confirmed, initAgent, parseArgs, reportTx, run } from "../lib/cli.ts";

export async function openPosition(isLong: boolean, scriptName: string): Promise<void> {
  const args = parseArgs(
    {
      ticker: { desc: "Market, e.g. BTC or BTCUSD", required: true },
      collateral: { desc: "Collateral in display USD, e.g. 10", required: true },
      leverage: { desc: "Leverage multiplier (or pass --size)" },
      size: { desc: "Base-asset size, e.g. 0.15 — overrides --leverage" },
      slippage: { desc: "Slippage bound in percent", default: "0.5" },
      tp: { desc: "Take-profit trigger price in USD" },
      sl: { desc: "Stop-loss trigger price in USD" },
      yes: { desc: "Confirm this write", flag: true },
    policy: { desc: "Narrow the execution policy for this invocation" },
    },
    scriptName,
  );

  await run(async () => {
    const agent = initAgent();
    const result = await agent.openPosition({
      isLong,
      ticker: args.ticker ?? "",
      collateral: args.collateral ?? "0",
      ...(args.leverage !== undefined ? { leverage: Number(args.leverage) } : {}),
      ...(args.size !== undefined ? { size: args.size } : {}),
      slippagePercent: asNumber(args.slippage) ?? 0.5,
      ...(args.tp !== undefined ? { takeProfitPrice: args.tp } : {}),
      ...(args.sl !== undefined ? { stopLossPrice: args.sl } : {}),
      confirm: confirmed(),
    });
    reportTx(agent, scriptName, result);
  });
}
