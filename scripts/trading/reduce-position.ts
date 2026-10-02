/** Partially close a position, by base-asset `--size` or by `--percent`. */
import { invoke } from "../../src/cli/contract.ts";
import { asNumber, confirmed, initAgent, note, parseArgs, reportTx, run } from "../lib/cli.ts";

const args = parseArgs(
  {
    ticker: { desc: "Market, e.g. BTC", required: true },
    positionId: { desc: "Position id", required: true },
    size: { desc: "Base-asset size to close" },
    percent: { desc: "Percent of the position to close (0–100)" },
    slippage: { desc: "Slippage bound in percent", default: "0.5" },
    yes: { desc: "Confirm this write", flag: true },
    policy: { desc: "Narrow the execution policy for this invocation" },
  },
  "reduce-position",
);

await run(async () => {
  const agent = initAgent();
  const result = await agent.reducePosition({
    ticker: args.ticker ?? "",
    positionId: Number(args.positionId),
    ...(args.size !== undefined ? { size: args.size } : {}),
    ...(args.percent !== undefined ? { percent: Number(args.percent) } : {}),
    slippagePercent: asNumber(args.slippage) ?? 0.5,
    confirm: confirmed(),
  });
  reportTx(agent, "reduce-position", result);

  // A keeper fills this afterwards, so the position is probably still its
  // original size right now and its protective legs still match it. Once the fill
  // lands they will be larger than what is left — reduce-only, so nothing can
  // over-close, but a stop showing 11.87 on a position of 5.93 is protection
  // somebody is reading that is not there.
  //
  // Said rather than done. There is no correct resize at this instant: shrinking a
  // stop to the size the position is ABOUT to be leaves it under-protected until
  // the keeper arrives, and that is the expensive direction to be wrong in. And a
  // second write here would be one nobody approved — an approval binds one intent.
  note("");
  note(`Once the keeper fills this, the position's stop and take-profit will be larger than`);
  note(`what is left. \`positions\` shows it, and this resizes them to match:`);
  note(`  ${invoke("sync-stops", "--ticker", args.ticker ?? "<ticker>", "--position-id", args.positionId ?? "<id>")}`);
});
