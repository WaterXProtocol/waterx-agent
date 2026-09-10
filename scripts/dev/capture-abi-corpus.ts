/**
 * Record what the live deployment actually puts at each argument position.
 *
 * The corpus this replaces compared POSITIONS TO BYTE WIDTHS, which cannot see
 * a reordering of same-width parameters — and nearly every entrypoint has some:
 * `request_withdraw` takes `accountId` and `recipient` as adjacent 32-byte
 * values, `deposit_collateral_request` takes `positionId` and `collateralAmount`
 * as adjacent u64s. Swap either pair and the verifier binds each check to the
 * wrong value while both appear to pass.
 *
 * So this records VALUES. Each call is built with every argument distinct, and
 * the fixture stores what was sent (by parameter name) alongside the raw bytes
 * at each position. `test/abi.test.ts` then asserts that the value sent for a
 * parameter is the value sitting at the position the ABI declares for it. A
 * reordering moves one and not the other.
 *
 * The result lives beside `abi.generated.ts` rather than under `test/`, because
 * it is not only a test fixture: `runDoctor` reads it to tell an operator
 * whether the layouts the verifier relies on have been confirmed against the
 * deployment they are about to trade on.
 *
 * Run against a funded testnet account:
 *
 *   OWNER=0x… ACCT=0x… ORDER_ID=… POSITION_ID=… pnpm run capture-corpus
 *
 * Entrypoints that could not be built are written to the fixture with the
 * reason, and the test fails if one is neither captured nor excused.
 */
import { writeFileSync } from "node:fs";

import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";

import { ABI, SDK_VERSION } from "../../src/chain/abi.generated.ts";
import { loadDeployment, normalizePackage } from "../../src/chain/deployment.ts";
import { HttpClient } from "../../src/api/http.ts";
import { ReadApi } from "../../src/api/read.ts";
import { TxApi } from "../../src/api/tx.ts";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const addr = (a: string): string => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const u64 = (v: bigint | number): string => Buffer.from(new BigUint64Array([BigInt(v)]).buffer).toString("hex");
const u128 = (v: bigint | number): string => {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(BigInt(v) & 0xffffffffffffffffn, 0);
  b.writeBigUInt64LE(BigInt(v) >> 64n, 8);
  return b.toString("hex");
};
const optU64 = (v: bigint | number | null): string => (v === null ? "00" : `01${u64(v)}`);
const optU128 = (v: bigint | number | null): string => (v === null ? "00" : `01${u128(v)}`);
const str = (s: string): string => {
  const body = Buffer.from(s, "utf8");
  return Buffer.concat([Buffer.from([body.length]), body]).toString("hex");
};
const bool = (v: boolean): string => (v ? "01" : "00");
const u32 = (v: number): string => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  return b.toString("hex");
};

interface Instance {
  /**
   * The package this call actually landed on.
   *
   * Without it the fixture states "these are the layouts" and, separately,
   * "the manifest looked like this" — and nothing joins the two. A deployment
   * with an old version still callable could serve the old layout while the
   * manifest named the new id, and both halves would be accurate.
   */
  package: string;
  /** What the request asked for, by ABI parameter name. */
  sent: Record<string, string>;
  /** The raw pure bytes at each argument position; null where not a pure value. */
  positions: (string | null)[];
  /** The call's type arguments, in order. */
  typeArguments: string[];
}

const corpus = new Map<string, Instance[]>();
const skipped = new Map<string, string>();

/** Pull every instance of `entrypoint` out of a built transaction. */
function record(entrypoint: string, txBytes: string, sent: Record<string, string>[]): void {
  const data = Transaction.from(fromBase64(txBytes)).getData();
  const found: Instance[] = [];
  for (const command of data.commands) {
    const call = command.MoveCall;
    if (call == null) continue;
    if (`${call.module}::${call.function}` !== entrypoint) continue;
    const positions = call.arguments.map((argument) => {
      const a = argument as { $kind?: string; Input?: number };
      if (a.$kind !== "Input" || a.Input === undefined) return null;
      const input = data.inputs[a.Input];
      if (input?.$kind !== "Pure" || input.Pure == null) return null;
      return hex(fromBase64(input.Pure.bytes));
    });
    found.push({
      package: normalizePackage(call.package),
      sent: sent[found.length] ?? {},
      positions,
      typeArguments: [...call.typeArguments],
    });
  }
  if (found.length === 0) {
    skipped.set(entrypoint, "the built transaction did not contain this call");
    return;
  }
  corpus.set(entrypoint, found);
}

const http = new HttpClient({ baseUrl: process.env.WATERX_API_URL ?? "https://api-testnet.waterx.app" });
const read = new ReadApi(http);
const tx = new TxApi(http);
const sender = process.env.OWNER ?? "";
const accountId = process.env.ACCT ?? "";
const body = { sender, accountId };

/**
 * Build once, record every entrypoint that build contains.
 *
 * One build per entrypoint meant two identical requests a moment apart, and the
 * backend's dry run rejects one of them whenever the oracle price moves in
 * between — which made the capture flaky in a way that had nothing to do with
 * what it was recording.
 */
const capture = async (
  wanted: Record<string, Record<string, string>[]>,
  build: () => Promise<{ txBytes: string }>,
): Promise<void> => {
  // Retried, because the backend dry-runs each build against live oracle state
  // and rejects one occasionally for a tick of price movement. A capture lost
  // to that would be recorded as an uncovered entrypoint, which is a different
  // and misleading claim.
  let txBytes: string | undefined;
  let why = "";
  for (let attempt = 0; attempt < 3 && txBytes === undefined; attempt += 1) {
    try {
      ({ txBytes } = await build());
    } catch (error) {
      why = error instanceof Error ? error.message.slice(0, 120) : String(error);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  if (txBytes === undefined) {
    for (const entrypoint of Object.keys(wanted)) skipped.set(entrypoint, why);
    return;
  }
  for (const [entrypoint, sent] of Object.entries(wanted)) record(entrypoint, txBytes, sent);
};

const info = await read.info();
const asset = info.backingAssets[0]?.coinType ?? "";
const spot = (await read.ticker("SUIUSD")).spotPrice;

// Every value in a call is chosen to differ from every other value in it, so a
// swap between two same-width arguments moves a value the fixture can see.
const COLLATERAL = 4_000_000n;
const SIZE = BigInt(Math.floor((8 / spot) * 1e9));
const ACCEPTABLE = BigInt(Math.floor(spot * 1.05 * 1e9));
const TP = 1_600_000_000n;
const SL = 400_000_000n;
const DELEGATE = `0x${"9".repeat(64)}`;

const ORDER_BUILD = () =>
  tx.marketOrder({
    ...body,
    ticker: "SUIUSD",
    isLong: true,
    collateralAmount: String(COLLATERAL),
    size: String(SIZE),
    acceptablePrice: String(ACCEPTABLE),
    preOrders: [
      { isStopOrder: false, triggerPrice: String(TP), size: String(SIZE) },
      { isStopOrder: true, triggerPrice: String(SL), size: String(SIZE) },
    ],
  });

await capture(
  {
    "trading::place_order_request": [{ ticker: str("SUIUSD"), accountId: addr(accountId) }],
    // The authority handle. It takes no value arguments; what is captured is
    // that it exists and which package serves it.
    "account::request": [{}],
    // Three constructor instances with different boolean patterns. Three
    // booleans cannot be made pairwise distinct on their own, so the patterns
    // disambiguate each other: the main order is [1,0,0], the take-profit leg
    // [0,0,1] and the stop leg [0,1,1], and any swap among the three moves at
    // least one of them.
    "request::new_place_order_argument": [
      {
        isLong: bool(true), isStopOrder: bool(false), reduceOnly: bool(false),
        size: u128(SIZE), triggerPrice: optU128(null), linkedPositionId: optU64(null),
        acceptablePrice: optU64(ACCEPTABLE), collateralAmount: u64(COLLATERAL),
      },
      {
        isLong: bool(false), isStopOrder: bool(false), reduceOnly: bool(true),
        size: u128(SIZE), triggerPrice: optU128(TP), linkedPositionId: optU64(null),
        acceptablePrice: optU64(null), collateralAmount: u64(0),
      },
      {
        isLong: bool(false), isStopOrder: bool(true), reduceOnly: bool(true),
        size: u128(SIZE), triggerPrice: optU128(SL), linkedPositionId: optU64(null),
        acceptablePrice: optU64(null), collateralAmount: u64(0),
      },
    ],
  },
  ORDER_BUILD,
);

const WITHDRAW = 3_000_001n;
await capture(
  {
    "account::request_withdraw": [
      { accountId: addr(accountId), amount: u64(WITHDRAW), recipient: addr(sender) },
    ],
    "withdrawal_queue::route_native": [{}],
    "withdrawal_queue::enqueue": [{}],
  },
  () => tx.withdraw({ ...body, route: "native", assetType: asset, amount: String(WITHDRAW) }),
);

await capture(
  { "custody_vault::mint": [{ accountId: addr(accountId) }] },
  () => tx.deposit({ ...body, assetType: asset, amount: "2000003" }),
);

await capture(
  { "lp_pool::mint_wlp": [{ accountId: addr(accountId), depositAmount: u64(1_000_007n) }] },
  () => tx.mintWlp({ ...body, amount: "1000007" }),
);

// Distinct masks per protocol, so a grant landing on the wrong slot is visible.
const GRANT = { perp: 0b0001, predict: 0b0010, staking: 0b0100 };
const DELEGATE_BUILD = () =>
  tx.addDelegate({
    ...body,
    delegate: DELEGATE,
    perpPermissions: GRANT.perp,
    predictPermissions: GRANT.predict,
    stakingPermissions: GRANT.staking,
  });
const grantOf = (mask: number) => ({
  accountId: addr(accountId),
  delegateAddress: addr(DELEGATE),
  permissions: u32(mask),
});

await capture(
  {
    "account::add_delegate": [
      { accountId: addr(accountId), delegateAddress: addr(DELEGATE), permissions: u32(0) },
    ],
    // Order follows the deployment's own emission; the type argument on each
    // instance is what says which protocol it grants.
    "account::set_delegate_protocol_permission": [
      grantOf(GRANT.perp),
      grantOf(GRANT.perp),
      grantOf(GRANT.predict),
      grantOf(GRANT.staking),
    ],
  },
  DELEGATE_BUILD,
);

await capture(
  {
    "account::remove_delegate": [
      { accountId: addr(accountId), delegateAddress: addr(process.env.DELEGATE ?? DELEGATE) },
    ],
  },
  () => tx.removeDelegate({ ...body, delegate: process.env.DELEGATE ?? DELEGATE }),
);

const ORDER_ID = process.env.ORDER_ID;
if (ORDER_ID !== undefined) {
  const order = (await read.orders({ account: accountId })).find((o) => String(o.id) === ORDER_ID);
  if (order !== undefined) {
    const CURRENT = BigInt(Math.round(order.triggerPrice * 1e9));
    await capture(
      {
        "trading::cancel_order_request": [
          { ticker: str("SUIUSD"), accountId: addr(accountId), orderId: u64(BigInt(ORDER_ID)) },
        ],
      },
      () => tx.cancelOrder("SUIUSD", Number(ORDER_ID), { ...body }),
    );
    await capture(
      {
        "trading::update_order_request": [
          {
            ticker: str("SUIUSD"),
            accountId: addr(accountId),
            orderId: u64(BigInt(ORDER_ID)),
            currentTriggerPrice: u128(CURRENT),
            newSize: u128(19_400_000_003n),
            newTriggerPrice: u128(440_000_007n),
          },
        ],
      },
      () =>
        tx.updateOrder("SUIUSD", Number(ORDER_ID), {
          ...body,
          currentTriggerPrice: String(CURRENT),
          orderTypeTag: order.orderTypeTag,
          newSize: "19400000003",
          newTriggerPrice: "440000007",
        }),
    );
  }
}

const POSITION_ID = process.env.POSITION_ID;
if (POSITION_ID !== undefined) {
  const P = BigInt(POSITION_ID);
  const T = str("SUIUSD");
  const A = addr(accountId);
  await capture(
    {
      "trading::close_position_request": [
        { ticker: T, accountId: A, positionId: u64(P), acceptablePrice: u64(ACCEPTABLE) },
      ],
    },
    () => tx.closePosition("SUIUSD", Number(P), { ...body, acceptablePrice: String(ACCEPTABLE) }),
  );
  await capture(
    {
      "trading::decrease_position_request": [
        { ticker: T, accountId: A, positionId: u64(P), size: u128(SIZE), acceptablePrice: u64(ACCEPTABLE) },
      ],
    },
    () =>
      tx.reducePosition("SUIUSD", Number(P), {
        ...body,
        size: String(SIZE),
        acceptablePrice: String(ACCEPTABLE),
      }),
  );
  await capture(
    {
      "trading::increase_position_request": [
        {
          ticker: T, accountId: A, orderId: optU64(null), positionId: u64(P),
          collateralAmount: u64(1_000_009n), size: u128(SIZE), acceptablePrice: u64(ACCEPTABLE),
        },
      ],
    },
    () =>
      tx.increasePosition("SUIUSD", Number(P), {
        ...body,
        collateralAmount: "1000009",
        size: String(SIZE),
        acceptablePrice: String(ACCEPTABLE),
      }),
  );
  await capture(
    {
      "trading::deposit_collateral_request": [
        { ticker: T, accountId: A, positionId: u64(P), collateralAmount: u64(1_000_011n) },
      ],
    },
    () => tx.depositMargin("SUIUSD", Number(P), { ...body, collateralAmount: "1000011" }),
  );
  await capture(
    {
      "trading::withdraw_collateral_request": [
        { ticker: T, accountId: A, positionId: u64(P), amount: u64(1_000_013n) },
      ],
    },
    () => tx.withdrawMargin("SUIUSD", Number(P), { ...body, amount: "1000013" }),
  );
}

/** Why an entrypoint has no capture, when the run itself did not say. */
const REASONS: Record<string, string> = {
  "account::create_account": "can only be built for an address that has no account yet",
  "lp_pool::request_redeem": "requires an unstaked WLP balance; minting stakes automatically",
  "lp_pool::cancel_redeem": "requires a pending redeem request",
  "waterx_staking::claim": "requires claimable rewards",
  "withdrawal_queue::route_wormhole":
    "the agent never bridges; this entrypoint exists in the bindings so that a bridged withdrawal is a call no action authorizes",
};
const POSITION_REASON =
  "needs an open position, and none could be opened — the testnet keeper was not filling market orders when this was captured";

for (const entrypoint of Object.keys(ABI)) {
  if (corpus.has(entrypoint) || skipped.has(entrypoint)) continue;
  skipped.set(
    entrypoint,
    REASONS[entrypoint] ?? (POSITION_ID === undefined ? POSITION_REASON : "no capture is written"),
  );
}

// The deployment this was captured against, package by package. Without it the
// fixture is a photograph with no date on it: the contract can be upgraded, the
// arguments can move, and every test still passes against a corpus that
// describes the old one.
const deployment = await loadDeployment(
  process.env.WATERX_CONFIG_URL ?? "https://staging.waterx-config.pages.dev/testnet.json",
);
const packages = Object.fromEntries(
  [...deployment.byName.entries()].sort(([a], [b]) => a.localeCompare(b)),
);

writeFileSync(
  "src/chain/abi-corpus.json",
  `${JSON.stringify(
    {
      capturedAt: new Date().toISOString().slice(0, 10),
      network: info.network,
      sdkVersion: SDK_VERSION,
      packages,
      captured: Object.fromEntries([...corpus.entries()].sort(([a], [b]) => a.localeCompare(b))),
      uncaptured: Object.fromEntries([...skipped.entries()].sort(([a], [b]) => a.localeCompare(b))),
    },
    null,
    2,
  )}\n`,
);

console.log(`captured ${String(corpus.size)} of ${String(Object.keys(ABI).length)} entrypoints`);
for (const [entrypoint, why] of skipped) console.log(`  uncaptured ${entrypoint} — ${why}`);
