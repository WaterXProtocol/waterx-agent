/**
 * What the account is worth, and how much of it is free.
 *
 * The question an agent asks before sizing anything, and the one there was no
 * command for: `funds` is deposit and withdrawal *history*, `positions` is
 * exposure, and equity lived only inside `doctor`'s prose. An agent asked "how
 * much can I commit?" had nothing to run.
 *
 * `freeMargin` is the answer to that question. `totalEquity` includes margin
 * already committed to open positions and to resting orders, so sizing from it
 * is how an account ends up trying to commit collateral it does not have.
 */
import { initAgent, note, parseArgs, run, show } from "../lib/cli.ts";

parseArgs({}, "balance");

await run(async () => {
  const agent = initAgent();
  const overview = (await agent.read.overview(agent.accountId)) as Record<string, unknown>;

  const num = (key: string): number | undefined =>
    typeof overview[key] === "number" ? (overview[key] as number) : undefined;

  note("");
  note(`  free margin     ${fmt(num("freeMargin"))}   ← what a new order may commit`);
  note(`  in positions    ${fmt(num("collateral"))}`);
  note(`  in open orders  ${fmt(num("orderEscrowValue"))}`);
  note(`  unrealised pnl  ${fmt(num("pricePnl"))}`);
  note(`  total equity    ${fmt(num("totalEquity"))}`);
  note("");
  // `degraded` means the backend could not price everything it summed. Every
  // figure above inherits that, so it is reported rather than smoothed over.
  if (overview["degraded"] === true) {
    note("  ⚠ the backend reports this summary as degraded — some prices were unavailable.");
    note("");
  }

  show(overview, { rendered: true });
});

const fmt = (value: number | undefined): string =>
  value === undefined ? "—" : `$${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
