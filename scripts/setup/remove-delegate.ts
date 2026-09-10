/** Revoke one delegate. Owner-only. */
import { confirmed, initAgent, parseArgs, reportTx, run } from "../lib/cli.ts";

const args = parseArgs(
  {
    delegate: { desc: "Delegate Sui address", required: true },
    all: { desc: "Revoke every delegate across all of the owner's accounts", flag: true },
    yes: { desc: "Confirm this write", flag: true },
    policy: { desc: "Narrow the execution policy for this invocation" },
  },
  "remove-delegate",
);

await run(async () => {
  const agent = initAgent();
  const result =
    args.all === "true"
      ? await agent.removeAllDelegates({ confirm: confirmed() })
      : await agent.removeDelegate({ delegate: args.delegate ?? "", confirm: confirmed() });
  reportTx(agent, args.all === "true" ? "remove-all-delegates" : "remove-delegate", result);
});
