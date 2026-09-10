/**
 * Grant a delegate authority over the account.
 *
 * The four masks key on different on-chain scopes and grant nothing to each
 * other. None of them opens a funds-out path — withdrawal stayed owner-only
 * after the delegate-phishing hardening — so a delegate can trade the account
 * but cannot drain it.
 */
import { PERM_ALL_TRADING } from "@waterx/sdk";

import { asNumber, confirmed, initAgent, parseArgs, reportTx, run } from "../lib/cli.ts";

const args = parseArgs(
  {
    delegate: { desc: "Delegate Sui address", required: true },
    perpPermissions: {
      desc: `Perp bitmask (PERM_* from @waterx/sdk); default PERM_ALL_TRADING=${String(PERM_ALL_TRADING)}`,
    },
    predictPermissions: { desc: "Predict bitmask" },
    stakingPermissions: { desc: "Staking bitmask" },
    yes: { desc: "Confirm this write", flag: true },
    policy: { desc: "Narrow the execution policy for this invocation" },
  },
  "add-delegate",
);

await run(async () => {
  const agent = initAgent();
  const result = await agent.addDelegate({
    delegate: args.delegate ?? "",
    perpPermissions: asNumber(args.perpPermissions) ?? PERM_ALL_TRADING,
    ...(args.predictPermissions !== undefined
      ? { predictPermissions: Number(args.predictPermissions) }
      : {}),
    ...(args.stakingPermissions !== undefined
      ? { stakingPermissions: Number(args.stakingPermissions) }
      : {}),
    confirm: confirmed(),
  });
  reportTx(agent, "add-delegate", result);
});
