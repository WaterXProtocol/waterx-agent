/**
 * Open a long position.
 * Usage: npx tsx scripts/trading/open-long.ts --base BTC --collateral 10 --leverage 5 [--tp 70000] [--sl 60000]
 */
import { initSigner, requireAccountId, parseArgs, usdcToRaw, fmtTx } from "../lib/init.ts";
import { openLong } from "../../src/agent/index.ts";
import type { BaseAsset } from "../../src/agent/index.ts";

const signer = initSigner();
const accountId = requireAccountId();
const args = parseArgs(
  {
    base: { required: true, desc: "Market: BTC, ETH, SOL, SUI, etc." },
    collateral: { required: true, desc: "Collateral amount in USDC (e.g. 10)" },
    leverage: { default: "1", desc: "Leverage multiplier (e.g. 5)" },
    tp: { desc: "Take-profit price in USD" },
    sl: { desc: "Stop-loss price in USD" },
  },
  "scripts/trading/open-long.ts",
);

console.log(`Opening LONG ${args.base} | ${args.collateral} USDC @ ${args.leverage}x...`);

const result = await openLong(signer, {
  accountId,
  base: args.base as BaseAsset,
  collateralAmount: usdcToRaw(args.collateral),
  leverage: Number(args.leverage),
  takeProfitPrice: args.tp ? Number(args.tp) : undefined,
  stopLossPrice: args.sl ? Number(args.sl) : undefined,
});

console.log(`Long opened: ${fmtTx(result.digest)}`);
