/**
 * Show open positions for a specific market.
 * Usage: npx tsx scripts/query/positions.ts --base BTC [--price 65000]
 * If --price is omitted, fetches the latest price from Pyth oracle.
 */
import { initSigner, requireAccountId, parseArgs, fmtPrice, fmtUsdc, fmtSize } from "../lib/init.ts";
import { getPositions } from "../../src/agent/index.ts";
import type { BaseAsset } from "../../src/agent/index.ts";
import { PYTH_HERMES_ENDPOINT, PYTH_TESTNET_FEED_IDS } from "@waterx/perp-sdk";

async function fetchPythPrice(base: string): Promise<number> {
  const feedId = PYTH_TESTNET_FEED_IDS[`${base}/USD`];
  if (!feedId) throw new Error(`No Pyth feed for ${base}/USD`);
  const url = `${PYTH_HERMES_ENDPOINT.TESTNET}/v2/updates/price/latest?ids[]=${feedId}&parsed=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Pyth fetch failed: ${res.status}`);
  const json = await res.json() as { parsed?: Array<{ price: { price: string; expo: number } }> };
  const p = json.parsed?.[0]?.price;
  if (!p) throw new Error("No parsed price from Pyth");
  return Number(p.price) * Math.pow(10, p.expo);
}

const signer = initSigner();
const accountId = requireAccountId();
const args = parseArgs(
  {
    base: { required: true, desc: "Market: BTC, ETH, SOL, SUI, etc." },
    price: { desc: "Current base price in USD (auto-fetched from Pyth if omitted)" },
  },
  "scripts/query/positions.ts",
);

let price: number;
if (args.price) {
  price = Number(args.price);
} else {
  price = Math.round(await fetchPythPrice(args.base));
  console.log(`Fetched ${args.base} price: $${price.toLocaleString()}\n`);
}

const positions = await getPositions(
  signer,
  accountId,
  args.base as BaseAsset,
  price,
);

if (positions.length === 0) {
  console.log(`No open positions on ${args.base}.`);
} else {
  console.log(`=== ${args.base} Positions (${positions.length}) ===\n`);
  for (const p of positions) {
    console.log(`  #${p.positionId} ${p.isLong ? "LONG" : "SHORT"}`);
    console.log(`    Size:       ${fmtSize(p.size)}`);
    console.log(`    Collateral: ${fmtUsdc(p.collateralAmount)}`);
    console.log(`    Entry:      ${fmtPrice(p.averagePrice)}`);
    console.log(`    Liq:        ${fmtPrice(p.estLiqPrice)}`);
    const pnlVal = Number(p.pnl) / 1e6;
    const sign = p.pnlPositive ? "+" : "-";
    console.log(`    PnL:        ${sign}${Math.abs(pnlVal).toFixed(2)} USDC`);
    console.log("");
  }
}
