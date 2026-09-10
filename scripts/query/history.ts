/** Trade or order history for the account. */
import { asNumber, initAgent, parseArgs, run, show } from "../lib/cli.ts";

const args = parseArgs(
  {
    category: { desc: "trade | order", default: "trade" },
    limit: { desc: "Page size", default: "20" },
    cursor: { desc: "Opaque cursor from a previous page" },
  },
  "history",
);

await run(async () => {
  const agent = initAgent();
  show(
    await agent.read.history({
      account: agent.accountId,
      category: (args.category ?? "trade") as "trade" | "order",
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      limit: asNumber(args.limit) ?? 20,
    }),
  );
});
