/**
 * WLP operations.
 *
 * Minting stakes in the same step and burning redeems from the staked balance,
 * so there is no separate stake/unstake action any more. A burn is queued: the
 * withdrawal queue settles it, and `--cancel-burn` withdraws the request.
 */
import { confirmed, initAgent, parseArgs, reportTx, run } from "../lib/cli.ts";

const args = parseArgs(
  {
    action: { desc: "mint | burn | cancel-burn | claim", required: true },
    amount: { desc: "Amount in display units (mint / burn)" },
    requestId: { desc: "Redeem request id (cancel-burn)" },
    yes: { desc: "Confirm this write", flag: true },
    policy: { desc: "Narrow the execution policy for this invocation" },
  },
  "wlp",
);

await run(async () => {
  const agent = initAgent();
  const confirm = confirmed();
  const amount = args.amount;
  const action = args.action;

  const result = await (async () => {
    switch (action) {
      case "mint":
        return agent.mintWlp({ amount: requireAmount(amount, "mint"), confirm });
      case "burn":
        return agent.burnWlp({ amount: requireAmount(amount, "burn"), confirm });
      case "cancel-burn":
        if (args.requestId === undefined) throw new Error("cancel-burn needs --request-id.");
        return agent.cancelWlpBurn({ requestId: args.requestId, confirm });
      case "claim":
        return agent.claimWlpRewards({ confirm });
      default:
        throw new Error(`Unknown action "${String(action)}". Use mint, burn, cancel-burn or claim.`);
    }
  })();

  reportTx(agent, `wlp ${String(action)}`, result);
});

function requireAmount(amount: string | undefined, action: string): string {
  if (amount === undefined) throw new Error(`${action} needs --amount.`);
  return amount;
}
