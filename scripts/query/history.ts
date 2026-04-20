/**
 * Fetch trade/order history for the current account.
 * Usage: npx tsx scripts/query/history.ts [--category trade] [--limit 20] [--cursor ...]
 */
import { initApiClient, parseArgs, requireAccountId } from "../lib/init.ts";

const api = initApiClient();
const accountId = requireAccountId();
const args = parseArgs(
  {
    category: { desc: "Filter: trade or order" },
    limit: { default: "20", desc: "Number of entries (max 100)" },
    cursor: { desc: "Pagination cursor from previous response" },
  },
  "scripts/query/history.ts",
);

const result = await api.getHistory({
  account: accountId,
  category: args.category as "trade" | "order" | undefined,
  limit: Number(args.limit),
  cursor: args.cursor || undefined,
});

console.log(`\n=== History (${result.items.length} entries, hasMore=${result.hasMore}) ===\n`);
for (const e of result.items) {
  const pnl = e.realizedPnL !== undefined ? ` pnl=$${e.realizedPnL.toFixed(2)}` : "";
  console.log(`  ${e.timestamp}  ${e.action} ${e.symbol} ${e.side ?? ""} size=${e.size ?? "-"}${pnl}`);
}
if (result.cursor) {
  console.log(`\nNext cursor: ${result.cursor}`);
}
