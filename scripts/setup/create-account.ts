/** Create a WaterX trading account. The account id is indexed asynchronously. */
import { confirmed, initAgent, note, parseArgs, reportTx, run, show } from "../lib/cli.ts";

const args = parseArgs(
  {
    name: { desc: "Account display name (max 32 chars)", default: "agent" },
    referralCode: { desc: "Referral code to bind at creation" },
    yes: { desc: "Confirm this write", flag: true },
    policy: { desc: "Narrow the execution policy for this invocation" },
  },
  "create-account",
);

await run(async () => {
  const agent = initAgent();
  const existing = await agent.accounts();
  if (existing.length > 0) {
    note("This wallet already owns:");
    show(existing);
  }

  const result = await agent.createAccount({
    name: args.name ?? "agent",
    ...(args.referralCode !== undefined ? { referralCode: args.referralCode } : {}),
    confirm: confirmed(),
  });
  reportTx(agent, "create-account", result);
  note("\nThe indexer assigns the account id; re-run `accounts` in a moment,");
  note("then set WATERX_ACCOUNT_ID in .env.");
});
