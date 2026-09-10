/**
 * Verify the verifier, against real bytes rather than fixtures.
 *
 * Asks the live backend to compose a bracket order, checks that the correct one
 * passes, then asks it to compose variants that differ from what the intent
 * authorizes and checks that each is refused. The unit tests prove the same
 * things against transactions this repo builds; this proves the decode and the
 * bindings line up with what the deployment actually sends.
 *
 * Some variants the backend declines to build at all. That is its own
 * validation, not this one's, and it is reported as neither pass nor fail —
 * the verifier is what is under test here, so a request that never became
 * bytes tells us nothing about it.
 *
 * Signs nothing and submits nothing. Every call stops at verification.
 */
import { initAgent } from "../lib/cli.ts";
import { assertTransactionMatches } from "../../src/chain/verify.ts";
import { loadDeployment } from "../../src/chain/deployment.ts";
import type { WriteIntent } from "../../src/policy.ts";

const agent = initAgent();
const deployment = await loadDeployment(agent.config.configUrl);
const signer = agent.executor.senderAddress;
const account = agent.accountId;

const SIZE = "13000000000";      // 13 SUI, 1e9
const COLL = "5000000";          // 5 USD, 1e6
const TRIGGER = "600000000";     // 0.60
const TP = "1000000000";         // 1.00
const SL = "500000000";          // 0.50

/** What the agent authorizes: a long limit, with a sell-side TP and SL. */
const intent: WriteIntent = {
  action: "placeLimitOrder",
  accountId: account,
  increasesExposure: true,
  ticker: "SUIUSD",
  side: "long",
  reduceOnly: false,
  isStopOrder: false,
  collateral: 5,
  collateralRaw: COLL,
  sizeRaw: SIZE,
  triggerPriceRaw: TRIGGER,
  leverage: 2,
  legs: [
    { triggerPriceRaw: TP, isStopOrder: false, isLong: false },
    { triggerPriceRaw: SL, isStopOrder: true, isLong: false },
  ],
};

const build = async (over: Record<string, unknown>) => {
  const r: any = await (agent as any).tx.limitOrder({
    ...agent.executor.txBody(),
    accountId: account,
    ticker: "SUIUSD",
    isLong: true,
    collateralAmount: COLL,
    size: SIZE,
    triggerPrice: TRIGGER,
    preOrders: [
      { isStopOrder: false, triggerPrice: TP, size: SIZE },
      { isStopOrder: true, triggerPrice: SL, size: SIZE },
    ],
    ...over,
  });
  return r.txBytes ?? r.transactionBlockBytes ?? r.bytes;
};

const check = async (label: string, over: Record<string, unknown>, expectPass: boolean) => {
  let bytes: string;
  try {
    bytes = await build(over);
  } catch (e) {
    console.log(`  ?  ${label}\n     backend refused to build it: ${(e as Error).message.slice(0, 120)}`);
    return;
  }
  try {
    assertTransactionMatches(bytes, intent, signer, { deployment, sponsored: true });
    if (!expectPass) failures++;
    console.log(`  ${expectPass ? "✓" : "✗ NOT REFUSED"}  ${label}${expectPass ? "" : "  <-- would have been signed"}`);
  } catch (e) {
    if (expectPass) failures++;
    console.log(`  ${expectPass ? "✗ WRONGLY REFUSED" : "✓"}  ${label}`);
    console.log(`     ${(e as Error).message.slice(0, 190)}`);
  }
};

console.log("real backend bytes, verified against the authorized intent:\n");
let failures = 0;
await check("the bracket that was authorized", {}, true);
await check("main order flipped to a stop", { isStopOrder: true }, false);
await check("side flipped to short", { isLong: false }, false);
await check("legs' stop flags swapped", {
  preOrders: [
    { isStopOrder: true, triggerPrice: TP, size: SIZE },
    { isStopOrder: false, triggerPrice: SL, size: SIZE },
  ],
}, false);
await check("a third leg added", {
  preOrders: [
    { isStopOrder: false, triggerPrice: TP, size: SIZE },
    { isStopOrder: true, triggerPrice: SL, size: SIZE },
    { isStopOrder: true, triggerPrice: "550000000", size: SIZE },
  ],
}, false);
await check("a leg re-priced", {
  preOrders: [
    { isStopOrder: false, triggerPrice: "1200000000", size: SIZE },
    { isStopOrder: true, triggerPrice: SL, size: SIZE },
  ],
}, false);
await check("collateral doubled", { collateralAmount: "10000000" }, false);

if (failures > 0) {
  console.error(`\n${String(failures)} check(s) did not behave as required.`);
  process.exit(1);
}
console.log("\nevery tampered variant the backend would build was refused.");
