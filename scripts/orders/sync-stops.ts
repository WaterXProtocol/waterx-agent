/**
 * Resize a position's protective orders to the position they protect.
 *
 * After a partial close the linked stop and take-profit keep their original size:
 * a position reduced to 5.93 was still showing a stop for 11.87. Both are
 * reduce-only, so neither can close more than exists — this is a clarity bug, not
 * a money one — but an operator reading 11.87 is reading protection that is not
 * there, and an agent relaying it says something false.
 *
 * **This is a separate command and not a step inside `reduce-position`, for two
 * reasons that both matter.**
 *
 * One: a reduce returns when the request is on chain and a keeper fills it
 * afterwards, so at the moment `reduce-position` returns the position is usually
 * still its original size. There is no correct resize to make at that instant —
 * shrinking a stop to the size the position is ABOUT to be leaves it
 * under-protected until the fill lands, which is the expensive direction to be
 * wrong in.
 *
 * Two: one approval binds one intent. Sending a second write on the back of the
 * approval somebody gave for the first is precisely what the approval model
 * exists to prevent, so this is authorized on its own terms like every other
 * write — `--yes` under `interactive`, the scope under `delegated-auto`.
 *
 * Idempotent by construction: it compares what each leg is sized for against what
 * the chain says the position holds, so running it before a fill does nothing and
 * running it twice afterwards does nothing the second time. It tracks no state.
 */
import { describeOversized, oversizedStops } from "../../src/agent/stops.ts";
import { confirmed, demand, initAgent, note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";
import { succeeded } from "../../src/cli/contract.ts";

const args = parseArgs(
  {
    ticker: { desc: "Market, e.g. BTC", required: true },
    positionId: { desc: "Position id (see `positions`)", required: true },
    yes: { desc: "Confirm these writes", flag: true },
    policy: { desc: "Narrow the execution policy for this invocation" },
  },
  "sync-stops",
);

await run(async () => {
  const agent = initAgent();
  const ticker = await agent.markets.resolveTicker(
    demand(args.ticker, "--ticker", "which market the position is in"),
  );
  const positionId = demand(args.positionId, "--position-id", "which position to tidy up");

  const positions = await agent.read.positions(agent.config.accountId ?? "");
  const position = positions.find((p) => p.ticker === ticker && p.id === String(Number(positionId)));
  if (position === undefined) {
    const open = positions.map((p) => `${p.ticker}#${p.id}`).join(", ") || "none";
    setOutcome({
      status: "usage",
      message: `No position ${ticker}#${positionId}. Open positions: ${open}.`,
      submitted: false,
      retryable: false,
      reconcileRequired: false,
      awaitingApproval: false,
    });
    return;
  }

  const oversized = oversizedStops(position);
  if (oversized.length === 0) {
    // Not a failure and not a no-op to hide: "already correct" is the answer most
    // of the time, including every time this runs before a keeper has filled.
    note(`\n${ticker}#${positionId} holds ${String(position.sizeInAsset)}; every protective leg fits.`);
    show({ ticker, positionId: Number(positionId), holds: position.sizeInAsset, resized: [], oversized: [] });
    setOutcome(succeeded(`nothing to resize on ${ticker}#${positionId}`));
    return;
  }

  note("");
  for (const stop of oversized) note(`  ${describeOversized(stop)}`);
  note("");

  // Each leg is its own write, its own authorization and its own signature. One
  // may land and the next be refused, so each is reported separately rather than
  // collapsed into a single success or failure.
  const resized: { orderId: number; digest: string }[] = [];
  const failed: { orderId: number; error: string }[] = [];
  for (const stop of oversized) {
    try {
      const result = await agent.updateOrder({
        ticker: stop.ticker,
        orderId: stop.orderId,
        // Unchanged. Resizing must not reprice: where a stop sits is the
        // trader's decision and nothing here is entitled to move it.
        newTriggerPrice: stop.triggerPrice,
        newSize: stop.shouldBe,
        confirm: confirmed(),
      });
      resized.push({ orderId: stop.orderId, digest: result.digest });
      note(`  resized ${stop.ticker}#${String(stop.orderId)} to ${String(stop.shouldBe)}  ${result.digest}`);
    } catch (error) {
      // Thrown only when nothing landed at all. A partial run is reported, not
      // raised: the legs that were resized stay resized.
      if (resized.length === 0) throw error;
      failed.push({ orderId: stop.orderId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  show({
    ticker,
    positionId: Number(positionId),
    holds: position.sizeInAsset,
    oversized,
    resized,
    ...(failed.length === 0 ? {} : { failed }),
  });
  setOutcome(
    failed.length === 0
      ? succeeded(
          `resized ${String(resized.length)} protective leg(s) on ${ticker}#${positionId} to ${String(position.sizeInAsset)}`,
          { submitted: true },
        )
      : {
          status: "rejected",
          message:
            `resized ${String(resized.length)} of ${String(oversized.length)} protective leg(s) on ` +
            `${ticker}#${positionId}. Still oversized: ${failed.map((f) => `#${String(f.orderId)} (${f.error})`).join("; ")}. ` +
            `Re-running is safe — it compares sizes rather than applying a change.`,
          submitted: true,
          retryable: false,
          reconcileRequired: false,
          awaitingApproval: false,
        },
  );
});
