/**
 * Deposit and withdrawal history.
 *
 * Both are keyed on the **wallet**, not the account id — funds arrive at a
 * wallet before there is an account to attribute them to.
 */
import { asNumber, initAgent, parseArgs, run, show } from "../lib/cli.ts";

const args = parseArgs({ limit: { desc: "Page size", default: "10" } }, "funds");

await run(async () => {
  const agent = initAgent();
  const wallet = agent.executor.senderAddress;
  const limit = asNumber(args.limit) ?? 10;
  show({
    deposits: await agent.read.deposits(wallet, { limit }),
    withdraws: await agent.read.withdraws(wallet, { limit }),
  });
});
