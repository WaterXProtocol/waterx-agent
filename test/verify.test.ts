/**
 * Checking what a transaction does, rather than trusting where it came from.
 *
 * Three review rounds established the limit of provenance: the gate was handed
 * bytes, then a builder returning bytes, and each time the caller still supplied
 * the thing being vouched for. These tests cover the escape from that regress —
 * reading the transaction's own entrypoints — using entrypoint sets taken from
 * real transactions built by the live backend.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import ts from "typescript";

import { normalizePackage } from "../src/chain/deployment.ts";
import { beforeAll, describe, expect, it } from "vitest";

import { ABI } from "../src/chain/abi.generated.ts";
import {
  ACTION_RULES,
  TYPE_ROLES,
  BINDABLE_INTENT_FIELDS,
  BINDINGS,
  LEG_ARG_HANDLING,
  ORDER_ARG_BINDINGS,
  TYPE_BINDINGS,
  assertLayoutConfirmed,
  assertTransactionMatches,
  entrypointsOf,
} from "../src/chain/verify.ts";
import { corpusFor, type NetworkCorpus } from "../src/chain/corpus.ts";
import { ExecutionPolicyError } from "../src/errors.ts";
import {
  UNBINDABLE_INTENT_FIELDS,
  fingerprintIntent,
  type WriteIntent,
} from "../src/policy.ts";

const SIGNER = `0x${"b".repeat(64)}`;
/**
 * The deployment these fixtures pretend to be. `PKG` is the only package the
 * test transactions call, so a call anywhere else is a foreign one — which is
 * exactly what the package check is for.
 */
/**
 * A distinct object for every role the bindings name.
 *
 * Distinct because the point of pinning roles is that they are not
 * interchangeable: if every role shared one object, a fixture handing the
 * market registry where the global config belongs would still pass.
 */
const ROLE_OBJECTS = new Map<string, string>(
  [
    ...new Set(
      Object.values(BINDINGS)
        .flatMap((e) => Object.values(e))
        .flatMap((b) => (typeof b === "object" && "object" in b ? [b.object] : [])),
    ),
  ]
    .sort()
    .map((role, i) => [role, `0x${(i + 16).toString(16).padStart(64, "0")}`]),
);
/**
 * The type arguments a checked call must carry.
 *
 * An absent one is now a refusal — a call that simply omits a type argument was
 * previously indistinguishable from one naming the right coin — so the fixtures
 * have to name them, as the deployment does.
 */
const typeArgsFor = (entrypoint: string): string[] => {
  const roles = TYPE_ROLES[entrypoint];
  if (roles === undefined) return [];
  const out: string[] = [];
  for (const [position, role] of Object.entries(roles)) out[Number(position)] = `${PKG}::${role.type}`;
  return out;
};

const roleRef = (tx: Transaction, role: string) =>
  tx.sharedObjectRef({
    objectId: ROLE_OBJECTS.get(role) ?? `0x${"0".repeat(64)}`,
    initialSharedVersion: "1",
    mutable: false,
  });

const DEPLOYMENT = {
  // The layouts are recorded per network, so the verifier has to be told which
  // deployment these bytes are for. The fixtures describe testnet.
  network: "testnet" as const,
  deployment: {
    callable: new Set([normalizePackage(`0x${"c".repeat(64)}`), normalizePackage("0x2")]),
    typeable: new Set([normalizePackage(`0x${"c".repeat(64)}`), normalizePackage("0x2")]),
    // Every package key the ABI names, all pointing at the one package these
    // fixtures build against. A key missing here is now a refusal rather than a
    // skipped check, which is the point.
    byName: new Map(
      [...new Set(Object.values(ABI).map((e) => e.pkg))].map((pkg) => [
        pkg,
        normalizePackage(`0x${"c".repeat(64)}`),
      ]),
    ),
    idsFor: () => [normalizePackage(`0x${"c".repeat(64)}`)],
    // Every role the bindings name, each a distinct object — roles are pinned
    // precisely because they are not interchangeable.
    objects: new Set([...ROLE_OBJECTS.values()].map(normalizePackage)),
    objectFor: (role: string) => {
      const id = ROLE_OBJECTS.get(role);
      return id === undefined ? undefined : normalizePackage(id);
    },
  },
  sponsored: false,
  // Fixtures whose entrypoint the corpus has captured need no allowance; the
  // ones that do name it, which is the only lever there is.
  allowUnconfirmed: [] as readonly string[],
};
const ACCOUNT = `0x${"a".repeat(64)}`;
const PKG = `0x${"c".repeat(64)}`;
/** The coin these fixtures move. Named in a type argument, never in a value. */
const ASSET = `0x${"c".repeat(64)}::mock::COIN`;


/**
 * Values a bound argument may be filled with. Absent ones get a filler, which
 * is what makes a test that omits a field fail the way production would.
 */
type Values = Record<string, string | bigint | boolean | null | undefined>;

/**
 * Build one Move call with the arity and argument layout the generated ABI
 * declares for it.
 *
 * Reading the shape from the ABI keeps these tests about the COMPARISON — does
 * a wrong value get caught — rather than about the layout. Whether the ABI
 * itself matches the deployed contract is a different question, answered in
 * `test/abi.test.ts` against values captured from real transactions.
 */
/**
 * Calls already built in a transaction, so an argument that must be the result
 * of one points at the existing call rather than a fresh copy.
 *
 * Without this the withdrawal fixture grew a second `request_withdraw` — the
 * one the queue consumes — and tripped the multiplicity check instead of the
 * rule under test.
 */
const built = new WeakMap<Transaction, Map<string, unknown>>();
const remember = (tx: Transaction, entrypoint: string, result: unknown): unknown => {
  const forTx = built.get(tx) ?? new Map<string, unknown>();
  if (!forTx.has(entrypoint)) forTx.set(entrypoint, result);
  built.set(tx, forTx);
  return result;
};

/**
 * Build the call an argument must be the result of.
 *
 * Several positions are not opaque objects but the output of one specific
 * entrypoint — the authority handle above all — so a fixture that passes a
 * filler there is now refused, as production would refuse it.
 */
function producerCall(tx: Transaction, entrypoint: string, values: Values): unknown {
  const existing = built.get(tx)?.get(entrypoint);
  if (existing !== undefined) return existing;
  // The order constructor has its own binding table, not an entry in BINDINGS.
  if (entrypoint === "request::new_place_order_argument") {
    return remember(
      tx,
      entrypoint,
      tx.moveCall({
        target: `${PKG}::${entrypoint}`,
        arguments: [
          tx.pure.bool(true), tx.pure.bool(false), tx.pure.bool(false), tx.pure.u128(0n),
          tx.pure.option("u128", null), tx.pure.option("u64", null),
          tx.pure.option("u64", null), tx.pure.u64(0n),
        ],
      }),
    );
  }
  const abi = ABI[entrypoint];
  // `account::request` is the authority handle: the ABI names its package so
  // that can be pinned, but it has no bindings — nothing constrains its
  // arguments, only its identity as a producer.
  if (abi === undefined || !Object.hasOwn(BINDINGS, entrypoint)) {
    return remember(tx, entrypoint, tx.moveCall({ target: `${PKG}::${entrypoint}`, arguments: [] }));
  }
  return remember(
    tx,
    entrypoint,
    tx.moveCall({
      target: `${PKG}::${entrypoint}`,
      ...(entrypoint in TYPE_BINDINGS ? { typeArguments: [ASSET] } : {}),
      arguments: callArgs(tx, entrypoint, values) as never,
    }),
  );
}

function callArgs(
  tx: Transaction,
  entrypoint: string,
  values: Values,
  overrides: Record<number, unknown> = {},
): unknown[] {
  const abi = ABI[entrypoint];
  const bindings = BINDINGS[entrypoint];
  if (abi === undefined || bindings === undefined) throw new Error(`no ABI for ${entrypoint}`);
  // `types` is one longer than `params` when the contract takes a Clock.
  return abi.types.map((type, index) => {
    if (index in overrides) return overrides[index];
    const name = abi.params[index];
    const binding = name === undefined ? undefined : bindings[name];
    if (binding === undefined) return tx.pure.u8(0);
    if (typeof binding === "object" && "producedBy" in binding) {
      return producerCall(tx, binding.producedBy, values);
    }
    if (typeof binding === "object" && "object" in binding) return roleRef(tx, binding.object);
    // The deployment passes a vector here even when an order has no legs, so a
    // filler would be a shape it never emits.
    if (typeof binding === "object" && "vectorOf" in binding) {
      return tx.makeMoveVec({ type: `${PKG}::request::PlaceOrderArgument`, elements: [] });
    }
    // A subset binding still occupies a real argument of a real width; only the
    // comparison differs.
    const field =
      typeof binding === "object"
        ? "protocolMask" in binding
          ? "delegatePermissions"
          : undefined
        : binding;
    if (field === undefined) return tx.pure.u8(0);
    const value = values[field];
    switch (type) {
      case "address":
      case "0x2::object::ID":
        return tx.pure.address((value as string | undefined) ?? `0x${"0".repeat(64)}`);
      case "0x1::string::String":
        return tx.pure.string((value as string | undefined) ?? "SUIUSD");
      case "bool":
        return tx.pure.bool(value === undefined ? false : Boolean(value));
      case "u8":
        return tx.pure.u8(Number(value ?? 0));
      case "u32":
        return tx.pure.u32(Number(value ?? 0));
      case "u64":
        return tx.pure.u64(BigInt((value as bigint | undefined) ?? 0n));
      case "u128":
        return tx.pure.u128(BigInt((value as bigint | undefined) ?? 0n));
      case "0x1::option::Option<u64>":
        return tx.pure.option("u64", value == null ? null : BigInt(value as bigint));
      case "0x1::option::Option<u128>":
        return tx.pure.option("u128", value == null ? null : BigInt(value as bigint));
      default:
        return tx.pure.u8(0);
    }
  });
}

function newTx(sender = SIGNER): Transaction {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasBudget(10_000_000);
  tx.setGasPrice(1000);
  tx.setGasPayment([
    { objectId: `0x${"1".repeat(64)}`, version: "1", digest: "11111111111111111111111111111111" },
  ]);
  return tx;
}

/**
 * Build a transaction with the given `module::function` calls. The real ones
 * carry oracle and pool legs too; those are irrelevant to the check and omitted.
 *
 * Calls with a spec get their declared layout; the surrounding legs, which the
 * verifier never inspects, get a token argument.
 */
async function txWith(targets: string[], sender = SIGNER, values: Values = {}): Promise<string> {
  const tx = newTx(sender);
  const filled: Values = { accountId: ACCOUNT, ...values };
  let orderArg: unknown;
  for (const t of targets) {
    if (t === "request::new_place_order_argument") {
      orderArg = tx.moveCall({
        target: `${PKG}::${t}`,
        arguments: [
          tx.pure.bool(filled.side === undefined ? true : Boolean(filled.side)),
          tx.pure.bool(Boolean(filled.isStopOrder)),
          tx.pure.bool(Boolean(filled.reduceOnly)),
          tx.pure.u128(BigInt((filled.sizeRaw as bigint | undefined) ?? 0n)),
          tx.pure.option("u128", filled.triggerPriceRaw == null ? null : BigInt(filled.triggerPriceRaw as bigint)),
          tx.pure.option("u64", filled.positionId == null ? null : BigInt(filled.positionId as bigint)),
          tx.pure.option("u64", filled.acceptablePriceRaw == null ? null : BigInt(filled.acceptablePriceRaw as bigint)),
          tx.pure.u64(BigInt((filled.collateralRaw as bigint | undefined) ?? 0n)),
        ],
      });
      continue;
    }
    remember(tx, t, tx.moveCall({
      target: `${PKG}::${t}`,
      // A permission grant names the protocol it applies to in its type
      // argument; a route names the coin it pays out. Neither is a value, so a
      // builder that omits them produces a transaction the verifier rightly
      // refuses.
      ...(t === "account::set_delegate_protocol_permission"
        ? { typeArguments: [`${PKG}::account_data::WaterXPerp`] }
        : t in TYPE_BINDINGS
          ? { typeArguments: [ASSET] }
          : typeArgsFor(t).length > 0
            ? { typeArguments: typeArgsFor(t) }
            : {}),
      // Both, and by own-property: `account::request` has an ABI entry so its
      // package can be pinned, but no bindings — it is a producer, not a
      // checked call, and putting it in BINDINGS would make it a foreign call
      // in every action that does not declare it a companion.
      arguments: (Object.hasOwn(ABI, t) && Object.hasOwn(BINDINGS, t)
        ? callArgs(tx, t, filled, orderArg === undefined ? {} : { 6: orderArg })
        : [tx.pure.u8(0)]) as never,
    }));
  }
  return toBase64(await tx.build());
}

/**
 * A transaction shaped like a real order: an 8-argument constructor whose result
 * feeds `place_order_request`. `orders` may name several, which is how a
 * bracketed order looks — and how the two-orders attack looks.
 */
async function orderTx(
  orders: {
    account?: string;
    ticker?: string;
    isLong?: boolean;
    isStopOrder?: boolean;
    reduceOnly?: boolean;
    collateral?: bigint;
    size?: bigint;
    triggerPrice?: bigint | null;
    linkedPosition?: bigint | null;
    acceptablePrice?: bigint | null;
  }[],
  /** Build one defining call per order instead of one for all of them. */
  separateCalls = false,
  sender = SIGNER,
): Promise<string> {
  const tx = newTx(sender);
  // `Option<u128>` / `Option<u64>` as the contract declares them — a bare u128
  // here would be a different shape, and the reader would rightly refuse it.
  const ctor = (o: (typeof orders)[number]) =>
    tx.moveCall({
      target: `${PKG}::request::new_place_order_argument`,
      arguments: [
        tx.pure.bool(o.isLong ?? true),
        tx.pure.bool(o.isStopOrder ?? false),
        tx.pure.bool(o.reduceOnly ?? false),
        tx.pure.u128(o.size ?? 0n),
        tx.pure.option("u128", o.triggerPrice ?? null),
        tx.pure.option("u64", o.linkedPosition ?? null),
        tx.pure.option("u64", o.acceptablePrice ?? null),
        tx.pure.u64(o.collateral ?? 0n),
      ],
    });

  // The shape the deployment builds: the order at `main`, its legs collected
  // into a vector at `preOrder`. Both are now bound to the call that produced
  // them, so a constructor hung anywhere else is not a leg.
  const place = (o: (typeof orders)[number], args: unknown[]) =>
    tx.moveCall({
      target: `${PKG}::trading::place_order_request`,
      typeArguments: typeArgsFor("trading::place_order_request"),
      arguments: callArgs(
        tx,
        "trading::place_order_request",
        { accountId: o.account ?? ACCOUNT, ticker: o.ticker ?? "SUIUSD" },
        {
          6: args[0],
          ...(args.length > 1 ? { 7: tx.makeMoveVec({ elements: args.slice(1) as never }) } : {}),
        },
      ) as never,
    });

  if (separateCalls) for (const o of orders) place(o, [ctor(o)]);
  else if (orders[0] !== undefined) place(orders[0], orders.map(ctor));
  return toBase64(await tx.build());
}

/**
 * A complete intent for an action: every field its entrypoint binds, set to the
 * value the builders above default to.
 *
 * Derived from the spec rather than written out, so a newly bound argument
 * shows up here as a field the tests must supply — which is the same pressure
 * production puts on the agent.
 */
/**
 * A leg descriptor, spelled the way a bracket authorizes one.
 *
 * Sell-side by default, because every bracket in these fixtures protects a
 * long — a leg takes the opposite side of the position it closes.
 */
const tp = (triggerPriceRaw: string, isLong = false) => ({
  triggerPriceRaw,
  isStopOrder: false,
  isLong,
});
const sl = (triggerPriceRaw: string, isLong = false) => ({
  triggerPriceRaw,
  isStopOrder: true,
  isLong,
});

const intent = (action: string, overrides: Partial<WriteIntent> = {}): WriteIntent => {
  const base: Record<string, unknown> = {
    action,
    accountId: ACCOUNT,
    increasesExposure: action.startsWith("open"),
    ticker: "SUIUSD",
  };
  const entrypoint = ACTION_RULES[action]?.entrypoint;
  if (entrypoint === "trading::place_order_request") {
    Object.assign(base, {
      side: "long",
      reduceOnly: false,
      isStopOrder: false,
      sizeRaw: "0",
      collateralRaw: "0",
      legs: [],
    });
  } else if (entrypoint !== undefined) {
    // Companions too: a grant's authority is conferred by one of those, so an
    // intent that only covers the defining call is not a complete one.
    for (const target of [
      entrypoint,
      ...(ACTION_RULES[action]?.companions ?? []).map((c) => c.entrypoint),
    ]) {
    const abi = ABI[target];
    const bindings = BINDINGS[target] ?? {};
    // A type argument that names a choice is bound too, so the intent has to
    // state it — the fixtures build these calls with no type arguments at all.
    for (const field of Object.values(TYPE_BINDINGS[target] ?? {})) {
      if (!(field in base)) base[field] = ASSET;
    }
    for (const [index, name] of (abi?.params ?? []).entries()) {
      const binding = bindings[name];
      if (binding === undefined) continue;
      if (typeof binding === "object") {
        // A protocol mask is bounded per protocol, so the default ceiling is
        // "nothing anywhere" — a fixture that grants something must say so.
        if ("protocolMask" in binding && !("delegatePermissions" in base)) {
          base.delegatePermissions = { perp: 0, predict: 0, staking: 0 };
        }
        continue;
      }
      if (binding in base) continue;
      switch (abi?.types[index]) {
        case "address":
        case "0x2::object::ID":
          base[binding] = `0x${"0".repeat(64)}`;
          break;
        case "0x1::string::String":
          base[binding] = "SUIUSD";
          break;
        case "bool":
          base[binding] = false;
          break;
        case "0x1::option::Option<u64>":
        case "0x1::option::Option<u128>":
          break; // absent, which is what the builders emit
        case "u8":
        case "u32":
          base[binding] = 0;
          break;
        default:
          base[binding] =
            binding === "positionId" || binding === "orderId" || binding === "requestId" ? 0 : "0";
      }
    }
    }
  }
  return { ...base, ...overrides } as WriteIntent;
};

// Taken from transactions the live testnet backend actually produced.
const TRADING = [
  "oracle::new_collector",
  "waterx_rule::collect_single_with_proof",
  "oracle::aggregate",
  "lp_pool::update_token_value",
  "account::request",
  "request::new_place_order_argument",
  "trading::place_order_request",
  "trading::execute",
];
const WITHDRAWAL = [
  "withdrawal_queue::route_native",
  "account::request",
  "account::request_withdraw",
  "withdrawal_queue::enqueue",
];
const ADD_DELEGATE = [
  "account::request",
  "account::add_delegate",
  "account::set_delegate_protocol_permission",
];

let trading: string;
let withdrawal: string;
let addDelegate: string;

beforeAll(async () => {
  [trading, withdrawal, addDelegate] = await Promise.all([
    txWith(TRADING),
    txWith(WITHDRAWAL),
    txWith(ADD_DELEGATE),
  ]);
});

describe("what the transaction actually does", () => {
  it("refuses a withdrawal presented as a trade", () => {
    // The substitution the review demonstrated three times. No wrapper around
    // the gate stops it, because the caller always supplies the thing being
    // vouched for — reading the artifact does.
    expect(() => assertTransactionMatches(withdrawal, intent("openLong"), SIGNER, DEPLOYMENT)).toThrow(
      /does not call trading::place_order_request/,
    );
  });

  it("refuses an opening PTB presented as a cancel", () => {
    // `cancelOrder` commits nothing, so it clears every ceiling trivially —
    // which makes its permit the most valuable one to misuse. A denylist could
    // not see this: neither transaction is privileged.
    expect(() => assertTransactionMatches(trading, intent("cancelOrder"), SIGNER, DEPLOYMENT)).toThrow(
      /does not call trading::cancel_order_request/,
    );
  });

  it("refuses a withdrawal presented as a deposit", () => {
    // Both are privileged actions, so exempting privileged actions from the
    // check — which an early return used to do — left them substitutable for
    // each other. Money out dressed as money in.
    expect(() => assertTransactionMatches(withdrawal, intent("deposit"), SIGNER, DEPLOYMENT)).toThrow(
      /does not call custody_vault::mint/,
    );
  });

  it("refuses a transaction that also does something else's job", () => {
    // Check two: the right entrypoint present is not enough if a foreign one
    // rides along.
    const smuggled = TRADING.concat("account::add_delegate");
    return txWith(smuggled).then((bytes) => {
      expect(() => assertTransactionMatches(bytes, intent("openLong"), SIGNER, DEPLOYMENT)).toThrow(
        /is not part of openLong/,
      );
    });
  });

  it("refuses an action it has no entrypoint recorded for", () => {
    // An unverifiable signature is not a lesser problem than a wrong one, and
    // failing here is what keeps the map complete as actions are added.
    expect(() => assertTransactionMatches(trading, intent("someNewAction"), SIGNER, DEPLOYMENT)).toThrow(
      /no defining entrypoint is recorded/,
    );
  });

  it("refuses a delegate grant presented as a trade", () => {
    expect(() => assertTransactionMatches(addDelegate, intent("openLong"), SIGNER, DEPLOYMENT)).toThrow(
      ExecutionPolicyError,
    );
  });

  it("allows each action its own transaction", () => {
    for (const [action, bytes] of [
      ["openLong", trading],
      ["withdraw", withdrawal],
      ["addDelegate", addDelegate],
    ] as const) {
      expect(() => assertTransactionMatches(bytes, intent(action), SIGNER, DEPLOYMENT), action).not.toThrow();
    }
  });

  it("allows the trade it says it is", () => {
    expect(() => assertTransactionMatches(trading, intent("openLong"), SIGNER, DEPLOYMENT)).not.toThrow();
  });

  it("allows a withdrawal when that is the authorized action", () => {
    // The check is about the transaction matching its intent, not about
    // withdrawals being forbidden — the policy decides that separately.
    expect(() => assertTransactionMatches(withdrawal, intent("withdraw"), SIGNER, DEPLOYMENT)).not.toThrow();
  });

  it("refuses a transaction for a different account", async () => {
    // Several actions share a defining entrypoint — placing an order is placing
    // an order — so the entrypoint alone cannot tell an authorized order from a
    // substituted one. The subject can.
    const elsewhere = await txWith(TRADING, SIGNER, { accountId: `0x${"e".repeat(64)}` });
    expect(() => assertTransactionMatches(elsewhere, intent("openLong"), SIGNER, DEPLOYMENT)).toThrow(
      /argument accountId is e{64}/,
    );
  });

  it("refuses a decoy: the authorized value present, but not where it is used", async () => {
    // The check this replaces asked "does this value appear anywhere in the
    // transaction". A PTB can carry the authorized account as an unused input
    // while the defining call reads a different one — set membership cannot
    // tell those apart, so the walk starts at the defining call instead.
    const tx = new Transaction();
    tx.setSender(SIGNER);
    tx.setGasBudget(10_000_000);
    tx.setGasPrice(1000);
    tx.setGasPayment([
      { objectId: `0x${"1".repeat(64)}`, version: "1", digest: "11111111111111111111111111111111" },
    ]);
    // A harmless call carrying the AUTHORIZED account — the decoy.
    tx.moveCall({ target: `${PKG}::oracle::aggregate`, arguments: [tx.pure.address(ACCOUNT)] });
    // The call that actually acts, on someone else's account.
    tx.moveCall({
      target: `${PKG}::trading::place_order_request`,
      typeArguments: typeArgsFor("trading::place_order_request"),
      arguments: callArgs(tx, "trading::place_order_request", {
        accountId: `0x${"e".repeat(64)}`,
        ticker: "SUIUSD",
      }) as never,
    });
    const decoy = toBase64(await tx.build());

    expect(() => assertTransactionMatches(decoy, intent("openLong"), SIGNER, DEPLOYMENT)).toThrow(
      /argument accountId is e{64}/,
    );
  });

  it("refuses a transaction naming a different market", async () => {
    const bytes = await orderTx([{ ticker: "BTCUSD" }]);
    const withTicker: WriteIntent = { ...intent("openLong"), ticker: "SUIUSD" };
    expect(() => assertTransactionMatches(bytes, withTicker, SIGNER, DEPLOYMENT)).toThrow(
      /argument ticker is BTCUSD/,
    );
  });

  it("refuses a transaction carrying a different amount", async () => {
    const bytes = await orderTx([{ collateral: 999n }]);
    const withAmount: WriteIntent = { ...intent("openLong"), collateralRaw: "10000000" };
    expect(() => assertTransactionMatches(bytes, withAmount, SIGNER, DEPLOYMENT)).toThrow(
      /the order's collateralAmount is 999, but 10000000 was authorized/,
    );
  });

  it("accepts the market and amount it was authorized for", async () => {
    const bytes = await orderTx([{ collateral: 10_000_000n }]);
    const full: WriteIntent = {
      ...intent("openLong"), ticker: "SUIUSD", collateralRaw: "10000000", side: "long",
    };
    expect(() => assertTransactionMatches(bytes, full, SIGNER, DEPLOYMENT)).not.toThrow();
  });

  it("checks EVERY order, not just the first", async () => {
    // The attack: one order matching the permit exactly, and a second for a
    // different account. Both execute under one signature. Stopping at the
    // first — and a Set of entrypoints that collapsed the duplicate — made the
    // second invisible.
    const bytes = await orderTx(
      [
        { account: ACCOUNT, collateral: 10_000_000n },
        { account: `0x${"e".repeat(64)}`, collateral: 10_000_000n },
      ],
      true,
    );
    const authorized: WriteIntent = { ...intent("openLong"), collateralRaw: "10000000" };
    // Two defining calls: refused on multiplicity before the second is even
    // inspected. One authorization covers one operation, so a second is not
    // something to examine — it is something that should not be there.
    expect(() => assertTransactionMatches(bytes, authorized, SIGNER, DEPLOYMENT)).toThrow(
      /performs it 2 times/,
    );
  });

  it("catches a second order for a different amount", async () => {
    const bytes = await orderTx([
      { collateral: 10_000_000n },
      { collateral: 500_000_000n },
    ]);
    const authorized: WriteIntent = { ...intent("openLong"), collateralRaw: "10000000" };
    expect(() => assertTransactionMatches(bytes, authorized, SIGNER, DEPLOYMENT)).toThrow(
      /the order's collateralAmount is 500000000/,
    );
  });

  it("allows a bracketed order, whose legs commit nothing and face the other way", async () => {
    // The shape a real bracket has: the main order plus two reduce-only legs
    // with zero collateral and the opposite side. A rule that demanded every
    // order match the authorized side and amount would refuse this.
    const bytes = await orderTx([
      { isLong: true, collateral: 10_000_000n },
      { isLong: false, reduceOnly: true, collateral: 0n, triggerPrice: 1600n },
      { isLong: false, reduceOnly: true, collateral: 0n, triggerPrice: 400n, isStopOrder: true },
    ]);
    const authorized: WriteIntent = {
      ...intent("openLong"), ticker: "SUIUSD", side: "long", collateralRaw: "10000000",
      reduceOnly: false, legs: [tp("1600"), sl("400")],
    };
    expect(() => assertTransactionMatches(bytes, authorized, SIGNER, DEPLOYMENT)).not.toThrow();
  });

  it("refuses a limit order returned as a stop", async () => {
    // The flag was `free` for eleven rounds, on the reasoning that a leg's
    // trigger price says which leg it is. That reasoning never covered the MAIN
    // order, where the flag picks between two OPPOSITE instructions at one
    // price: a long limit at 900 fills at or below 900, a long stop at 900
    // fills at or above it.
    //
    // And the two interact. `assertNotCrossing` only lets a limit rest where it
    // will not fill immediately — for a long, at or below spot. That is exactly
    // the price at which the same order read as a stop is already triggered. So
    // the flip did not merely substitute an order: it turned a resting one into
    // an immediate market fill, at the one price the local guard had cleared.
    const flipped = await orderTx([
      { isLong: true, collateral: 10_000_000n, triggerPrice: 900n, isStopOrder: true },
    ]);
    const authorized: WriteIntent = {
      ...intent("placeLimitOrder"), collateralRaw: "10000000", triggerPriceRaw: "900",
      isStopOrder: false,
    };
    expect(() => assertTransactionMatches(flipped, authorized, SIGNER, DEPLOYMENT)).toThrow(
      /the order's isStopOrder is true, but false was authorized/,
    );

    // And the converse, so this is a comparison rather than a ban on stops: a
    // caller who asked for a stop is refused a limit.
    const asLimit = await orderTx([
      { isLong: true, collateral: 10_000_000n, triggerPrice: 900n, isStopOrder: false },
    ]);
    expect(() =>
      assertTransactionMatches(asLimit, { ...authorized, isStopOrder: true }, SIGNER, DEPLOYMENT),
    ).toThrow(/the order's isStopOrder is false, but true was authorized/);

    // The stop the caller actually asked for still signs.
    expect(() =>
      assertTransactionMatches(flipped, { ...authorized, isStopOrder: true }, SIGNER, DEPLOYMENT),
    ).not.toThrow();
  });

  it("refuses a bracket whose take-profit and stop have been swapped", async () => {
    // Prices alone were bound, so both legs could come back carrying the other
    // one's flag. Nothing moved and nothing was added — but a stop triggers
    // from the other side, so a "stop" at the take-profit price 1600 is already
    // through its trigger the moment a long is opened below it, and the bracket
    // meant to protect the position closes it instead.
    const swapped = await orderTx([
      { isLong: true, collateral: 10_000_000n },
      { isLong: false, reduceOnly: true, collateral: 0n, triggerPrice: 1600n, isStopOrder: true },
      { isLong: false, reduceOnly: true, collateral: 0n, triggerPrice: 400n, isStopOrder: false },
    ]);
    const authorized: WriteIntent = {
      ...intent("openLong"), collateralRaw: "10000000", reduceOnly: false,
      legs: [tp("1600"), sl("400")],
    };
    expect(() => assertTransactionMatches(swapped, authorized, SIGNER, DEPLOYMENT)).toThrow(
      /is a sell-side stop at 1600, which is not one of the 2 legs authorized \(sell-side take-profit at 1600, sell-side stop at 400\)/,
    );
  });

  it("refuses a bracket leg placed on the wrong side of the position it protects", async () => {
    // Every other field is the authorized one: reduce-only, zero collateral,
    // the right size, the right trigger, the right stop flag, the right count.
    // Only the side is flipped, and the side was the last field the leg walk
    // did not read.
    //
    // Reduce-only means it opens nothing, so this is not a way to take on
    // exposure. What it does is leave the position UNPROTECTED — a buy-side
    // order cannot close a long — while the transaction that was supposed to
    // protect it succeeds. Silent, and only visible at the moment the stop was
    // supposed to fire.
    const wrongSide = await orderTx([
      { isLong: true, collateral: 10_000_000n },
      { isLong: true, reduceOnly: true, collateral: 0n, triggerPrice: 1600n },
      { isLong: true, reduceOnly: true, collateral: 0n, triggerPrice: 400n, isStopOrder: true },
    ]);
    const authorized: WriteIntent = {
      ...intent("openLong"), collateralRaw: "10000000", reduceOnly: false,
      legs: [tp("1600"), sl("400")],
    };
    expect(() => assertTransactionMatches(wrongSide, authorized, SIGNER, DEPLOYMENT)).toThrow(
      /is a buy-side take-profit at 1600, which is not one of the 2 legs authorized/,
    );
  });

  it("refuses a wrong-side leg attached to a position that already exists", async () => {
    // The `placeTpSl` path, which has no main order and so no `side` on the
    // intent at all — the leg descriptor is the only place the direction is
    // written down, which is why it had to move there rather than be inferred.
    const bytes = await orderTx([
      { isLong: true, reduceOnly: true, collateral: 0n, triggerPrice: 1600n, linkedPosition: 42n },
    ]);
    const authorized: WriteIntent = {
      ...intent("placeTpSl"), ticker: "SUIUSD", reduceOnly: true, positionId: 42,
      sizeRaw: "0", legs: [tp("1600")],
    };
    expect(() => assertTransactionMatches(bytes, authorized, SIGNER, DEPLOYMENT)).toThrow(
      /is a buy-side take-profit at 1600, which is not one of the 1 legs authorized/,
    );
  });

  it("allows the correctly-sided bracket on a long and on a short", async () => {
    // Both directions, so this is a comparison against the position and not a
    // rule that legs are always sell-side.
    const onLong = await orderTx([
      { isLong: true, collateral: 10_000_000n },
      { isLong: false, reduceOnly: true, collateral: 0n, triggerPrice: 1600n },
      { isLong: false, reduceOnly: true, collateral: 0n, triggerPrice: 400n, isStopOrder: true },
    ]);
    expect(() =>
      assertTransactionMatches(
        onLong,
        {
          ...intent("openLong"), collateralRaw: "10000000", reduceOnly: false,
          legs: [tp("1600"), sl("400")],
        },
        SIGNER,
        DEPLOYMENT,
      ),
    ).not.toThrow();

    // A short's legs buy it back, so they are the side the long's legs are not.
    const onShort = await orderTx([
      { isLong: false, collateral: 10_000_000n },
      { isLong: true, reduceOnly: true, collateral: 0n, triggerPrice: 400n },
      { isLong: true, reduceOnly: true, collateral: 0n, triggerPrice: 1600n, isStopOrder: true },
    ]);
    expect(() =>
      assertTransactionMatches(
        onShort,
        {
          ...intent("openShort"), side: "short", collateralRaw: "10000000", reduceOnly: false,
          legs: [tp("400", true), sl("1600", true)],
        },
        SIGNER,
        DEPLOYMENT,
      ),
    ).not.toThrow();

    // And the short's bracket is refused against the long's authorization, so
    // the two positive cases are not passing for the same reason.
    expect(() =>
      assertTransactionMatches(
        onShort,
        {
          ...intent("openShort"), side: "short", collateralRaw: "10000000", reduceOnly: false,
          legs: [tp("400"), sl("1600")],
        },
        SIGNER,
        DEPLOYMENT,
      ),
    ).toThrow(/is a buy-side take-profit at 400, which is not one of the 2 legs authorized/);
  });

  it("refuses an opening order presented as a bracket", async () => {
    // `placeTpSl` shares an entrypoint, an account and a market with an open.
    // `reduce_only` is the only thing that separates them on chain.
    const opening = await orderTx([{ isLong: true, reduceOnly: false, collateral: 10_000_000n }]);
    const asBracket: WriteIntent = { ...intent("placeTpSl"), ticker: "SUIUSD", reduceOnly: true };
    expect(() => assertTransactionMatches(opening, asBracket, SIGNER, DEPLOYMENT)).toThrow(
      /not reduce-only/,
    );
  });

  it("refuses an oversized order even when the collateral is right", async () => {
    // The size is what turns collateral into exposure, so a correct collateral
    // with a substituted size is any leverage at all — `maxLeverage` bounds the
    // request and bounded nothing in the transaction.
    const bytes = await orderTx([{ collateral: 10_000_000n, size: 999_999n }]);
    const authorized: WriteIntent = {
      ...intent("openLong"), collateralRaw: "10000000", sizeRaw: "1000",
    };
    expect(() => assertTransactionMatches(bytes, authorized, SIGNER, DEPLOYMENT)).toThrow(
      /the order's size is 999999, but 1000 was authorized/,
    );
  });

  it("refuses a bracket attached to a different position", async () => {
    // Same entrypoint, same account, same market: the position id is the only
    // thing separating one position's bracket from another's.
    const bytes = await orderTx([
      { reduceOnly: true, collateral: 0n, linkedPosition: 77n },
    ]);
    const authorized: WriteIntent = {
      ...intent("placeTpSl"), ticker: "SUIUSD", reduceOnly: true, positionId: 42,
      sizeRaw: "0", legs: [tp("0")],
    };
    expect(() => assertTransactionMatches(bytes, authorized, SIGNER, DEPLOYMENT)).toThrow(
      /names position 77, but 42 was authorized/,
    );
  });

  it("refuses a resting order at a price it was not authorized for", async () => {
    const bytes = await orderTx([{ collateral: 10_000_000n, triggerPrice: 500n }]);
    const authorized: WriteIntent = {
      ...intent("placeLimitOrder"), collateralRaw: "10000000", triggerPriceRaw: "700",
    };
    expect(() => assertTransactionMatches(bytes, authorized, SIGNER, DEPLOYMENT)).toThrow(
      /the order's triggerPrice is 500, but 700 was authorized/,
    );
  });

  it("refuses a third leg even when it repeats an authorized price", async () => {
    // Every zero-collateral reduce-only order used to be waved through as a
    // legitimate leg, so an opening transaction could carry any number of them.
    // A count alone would not catch this: each price IS one of the authorized
    // two. The prices are consumed as they match, so the third finds none left.
    //
    // Built with the legs in a vector, as the deployment builds them — every
    // argument position of the call now names something, so there is nowhere
    // else to hang a third.
    const tx = newTx();
    const ctor = (
      trigger: bigint | null,
      collateral: bigint,
      reduceOnly: boolean,
      isStopOrder = false,
    ) =>
      tx.moveCall({
        target: `${PKG}::request::new_place_order_argument`,
        arguments: [
          tx.pure.bool(!reduceOnly),
          tx.pure.bool(isStopOrder),
          tx.pure.bool(reduceOnly),
          tx.pure.u128(0n),
          tx.pure.option("u128", trigger),
          tx.pure.option("u64", null),
          tx.pure.option("u64", null),
          tx.pure.u64(collateral),
        ],
      });
    const main = ctor(null, 10_000_000n, false);
    const legs = tx.makeMoveVec({
      elements: [ctor(1600n, 0n, true), ctor(400n, 0n, true, true), ctor(1600n, 0n, true)],
    });
    tx.moveCall({
      target: `${PKG}::trading::place_order_request`,
      typeArguments: typeArgsFor("trading::place_order_request"),
      arguments: callArgs(
        tx,
        "trading::place_order_request",
        { accountId: ACCOUNT, ticker: "SUIUSD" },
        { 6: main, 7: legs },
      ) as never,
    });
    const bytes = toBase64(await tx.build());

    const authorized: WriteIntent = {
      ...intent("openLong"), collateralRaw: "10000000", reduceOnly: false,
      legs: [tp("1600"), sl("400")],
    };
    expect(() => assertTransactionMatches(bytes, authorized, SIGNER, DEPLOYMENT)).toThrow(
      /is a sell-side take-profit at 1600, which is not one of the 2 legs authorized/,
    );
  });

  it("refuses legs attached to an order that authorized none", async () => {
    // The bug a leg *ceiling* left open: an intent with no bracket at all still
    // allowed two reduce-only orders, because two was the maximum rather than
    // the authorized number.
    const bytes = await orderTx([
      { collateral: 10_000_000n },
      { isLong: false, reduceOnly: true, collateral: 0n, triggerPrice: 1600n },
    ]);
    const authorized: WriteIntent = {
      ...intent("openLong"), collateralRaw: "10000000", legs: [],
    };
    expect(() => assertTransactionMatches(bytes, authorized, SIGNER, DEPLOYMENT)).toThrow(
      /is a sell-side take-profit at 1600, which is not one of the 0 legs authorized/,
    );
  });

  it("refuses a bracket with fewer legs than were authorized", async () => {
    const bytes = await orderTx([
      { collateral: 10_000_000n },
      { isLong: false, reduceOnly: true, collateral: 0n, triggerPrice: 1600n },
    ]);
    const authorized: WriteIntent = {
      ...intent("openLong"), collateralRaw: "10000000",
      legs: [tp("1600"), sl("400")],
    };
    expect(() => assertTransactionMatches(bytes, authorized, SIGNER, DEPLOYMENT)).toThrow(
      /attaches 1 reduce-only orders, but 2 were authorized/,
    );
  });

  it("refuses an order whose acceptable price is wider than authorized", async () => {
    // The finding that opened this round. `slippagePercent` bounded the request
    // and bounded nothing in the transaction: the percentage never appears on
    // chain, only the price derived from it, and that price went unread.
    const bytes = await orderTx([{ collateral: 10_000_000n, acceptablePrice: 900n }]);
    const authorized: WriteIntent = {
      ...intent("openLong"), collateralRaw: "10000000", acceptablePriceRaw: "760",
    };
    expect(() => assertTransactionMatches(bytes, authorized, SIGNER, DEPLOYMENT)).toThrow(
      /acceptablePrice is 900, but 760 was authorized/,
    );
  });

  it("refuses a bracket leg carrying an acceptable-price bound of its own", async () => {
    // A leg fills at its trigger. A bound here would be one nobody set.
    const bytes = await orderTx([
      { collateral: 10_000_000n, acceptablePrice: 760n },
      { reduceOnly: true, collateral: 0n, triggerPrice: 1600n, acceptablePrice: 5n },
    ]);
    const authorized: WriteIntent = {
      ...intent("openLong"), collateralRaw: "10000000", acceptablePriceRaw: "760",
      legs: [tp("1600")],
    };
    expect(() => assertTransactionMatches(bytes, authorized, SIGNER, DEPLOYMENT)).toThrow(
      /acceptable-price bound of 5/,
    );
  });

  it("finds legs passed through a vector, not just direct arguments", async () => {
    // The live backend collects a bracket's legs into a `MakeMoveVec` and passes
    // the vector to the order. A walk that followed only `MoveCall.arguments`
    // never reached them, so two rounds of leg checks ran against a set that was
    // always empty and passed everything. This is that shape.
    const tx = newTx();
    const ctor = (
      trigger: bigint | null,
      collateral: bigint,
      reduceOnly: boolean,
      isStopOrder = false,
    ) =>
      tx.moveCall({
        target: `${PKG}::request::new_place_order_argument`,
        arguments: [
          tx.pure.bool(!reduceOnly),
          tx.pure.bool(isStopOrder),
          tx.pure.bool(reduceOnly),
          tx.pure.u128(0n),
          tx.pure.option("u128", trigger),
          tx.pure.option("u64", null),
          tx.pure.option("u64", null),
          tx.pure.u64(collateral),
        ],
      });
    const main = ctor(null, 10_000_000n, false);
    const legs = tx.makeMoveVec({
      elements: [ctor(1600n, 0n, true), ctor(400n, 0n, true, true)],
    });
    tx.moveCall({
      target: `${PKG}::trading::place_order_request`,
      typeArguments: typeArgsFor("trading::place_order_request"),
      arguments: callArgs(
        tx,
        "trading::place_order_request",
        { accountId: ACCOUNT, ticker: "SUIUSD" },
        { 6: main, 7: legs },
      ) as never,
    });
    const bytes = toBase64(await tx.build());

    const declared: WriteIntent = {
      ...intent("openLong"), collateralRaw: "10000000",
      legs: [tp("1600"), sl("400")],
    };
    expect(() => assertTransactionMatches(bytes, declared, SIGNER, DEPLOYMENT)).not.toThrow();

    // And the legs are genuinely being read, not merely tolerated: the same
    // transaction against an intent authorizing different prices is refused.
    const elsewhere: WriteIntent = {
      ...intent("openLong"), collateralRaw: "10000000",
      legs: [tp("1600"), sl("999")],
    };
    expect(() => assertTransactionMatches(bytes, elsewhere, SIGNER, DEPLOYMENT)).toThrow(
      /is a sell-side stop at 400, which is not one of the 2 legs authorized/,
    );
  });

  it("refuses a withdrawal whose extraData is not the route's result", async () => {
    // Binding `extraData` to the route's output makes skipping the route
    // structurally impossible rather than merely forbidden: the argument that
    // carries the route IS the route call. A filler there is refused.
    const tx = newTx();
    remember(
      tx,
      "account::request_withdraw",
      tx.moveCall({
        target: `${PKG}::account::request_withdraw`,
        typeArguments: typeArgsFor("account::request_withdraw"),
        arguments: callArgs(
          tx,
          "account::request_withdraw",
          { accountId: ACCOUNT, collateralRaw: 0n, recipient: `0x${"0".repeat(64)}` },
          { 5: tx.pure.u8(0) },
        ) as never,
      }),
    );
    tx.moveCall({
      target: `${PKG}::withdrawal_queue::enqueue`,
      typeArguments: typeArgsFor("withdrawal_queue::enqueue"),
      arguments: callArgs(tx, "withdrawal_queue::enqueue", {}) as never,
    });
    const bytes = toBase64(await tx.build());
    expect(() => assertTransactionMatches(bytes, intent("withdraw"), SIGNER, DEPLOYMENT)).toThrow(
      /argument extraData must be the result of withdrawal_queue::route_native/,
    );
  });

  it("refuses a withdrawal that never reaches the queue", async () => {
    // `enqueue` is required on its own terms — the hole in "at least one
    // companion" — and nothing else in the transaction forces it to be there.
    const tx = newTx();
    tx.moveCall({
      target: `${PKG}::account::request_withdraw`,
      typeArguments: typeArgsFor("account::request_withdraw"),
      arguments: callArgs(tx, "account::request_withdraw", {
        accountId: ACCOUNT,
        collateralRaw: 0n,
        recipient: `0x${"0".repeat(64)}`,
        assetType: ASSET,
      }) as never,
    });
    const bytes = toBase64(await tx.build());
    expect(() => assertTransactionMatches(bytes, intent("withdraw"), SIGNER, DEPLOYMENT)).toThrow(
      /does not call withdrawal_queue::enqueue/,
    );
  });

  it("refuses a delegate change naming someone else", async () => {
    const tx = new Transaction();
    tx.setSender(SIGNER);
    tx.setGasBudget(10_000_000);
    tx.setGasPrice(1000);
    tx.setGasPayment([
      { objectId: `0x${"1".repeat(64)}`, version: "1", digest: "11111111111111111111111111111111" },
    ]);
    tx.moveCall({
      target: `${PKG}::account::remove_delegate`,
      arguments: callArgs(tx, "account::remove_delegate", {
        accountId: ACCOUNT,
        delegateAddress: `0x${"9".repeat(64)}`,
      }) as never,
    });
    const bytes = toBase64(await tx.build());

    const authorized: WriteIntent = {
      action: "removeDelegate", accountId: ACCOUNT, increasesExposure: false,
      delegateAddress: `0x${"7".repeat(64)}`,
    };
    expect(() => assertTransactionMatches(bytes, authorized, SIGNER, DEPLOYMENT)).toThrow(
      /argument delegateAddress is /,
    );
  });

  it("refuses a second delegate removal under a single-delegate authorization", async () => {
    const tx = new Transaction();
    tx.setSender(SIGNER);
    tx.setGasBudget(10_000_000);
    tx.setGasPrice(1000);
    tx.setGasPayment([
      { objectId: `0x${"1".repeat(64)}`, version: "1", digest: "11111111111111111111111111111111" },
    ]);
    const target = `0x${"7".repeat(64)}`;
    for (const who of [target, `0x${"9".repeat(64)}`]) {
      tx.moveCall({
        target: `${PKG}::account::remove_delegate`,
        arguments: callArgs(tx, "account::remove_delegate", {
          accountId: ACCOUNT,
          delegateAddress: who,
        }) as never,
      });
    }
    const bytes = toBase64(await tx.build());

    // `removeAllDelegates` is the plural action; `removeDelegate` is not.
    const authorized: WriteIntent = {
      action: "removeDelegate", accountId: ACCOUNT, increasesExposure: false,
      delegateAddress: target,
    };
    expect(() => assertTransactionMatches(bytes, authorized, SIGNER, DEPLOYMENT)).toThrow(
      /performs it 2 times/,
    );
  });

  it("refuses an order whose parameters cannot be read", async () => {
    // The guard that used to return undefined and let the transaction through,
    // contradicting its own comment. An unreadable constructor is a refusal.
    const tx = new Transaction();
    tx.setSender(SIGNER);
    tx.setGasBudget(10_000_000);
    tx.setGasPrice(1000);
    tx.setGasPayment([
      { objectId: `0x${"1".repeat(64)}`, version: "1", digest: "11111111111111111111111111111111" },
    ]);
    // Three arguments where the signature has eight.
    const arg = tx.moveCall({
      target: `${PKG}::request::new_place_order_argument`,
      arguments: [tx.pure.bool(true), tx.pure.bool(false), tx.pure.u64(1n)],
    });
    tx.moveCall({
      target: `${PKG}::trading::place_order_request`,
      typeArguments: typeArgsFor("trading::place_order_request"),
      arguments: [tx.pure.address(ACCOUNT), arg],
    });

    const bytes = toBase64(await tx.build());
    expect(() => assertTransactionMatches(bytes, intent("openLong"), SIGNER, DEPLOYMENT)).toThrow(
      /generated bindings declare/,
    );
  });

  it("refuses a transaction sent from another address", () => {
    expect(() => assertTransactionMatches(trading, intent("openLong"), `0x${"7".repeat(64)}`, DEPLOYMENT)).toThrow(
      /Refusing to sign for another address/,
    );
  });

  it("refuses bytes it cannot decode rather than assuming they are fine", () => {
    expect(() => assertTransactionMatches("bm90IGEgdHJhbnNhY3Rpb24=", intent("openLong"), SIGNER, DEPLOYMENT)).toThrow(
      /could not be decoded/,
    );
  });

  it("reads every entrypoint, so a foreign call cannot hide among many", async () => {
    // Appended to an otherwise ordinary trading PTB — the shape an attacker
    // would actually use, rather than a bare substitution.
    const smuggled = await txWith([...TRADING, "account::request_withdraw"]);
    expect(entrypointsOf(smuggled)).toContain("account::request_withdraw");
    expect(() => assertTransactionMatches(smuggled, intent("openLong"), SIGNER, DEPLOYMENT)).toThrow(
      /account::request_withdraw/,
    );
  });
});

describe("the shape of the transaction itself", () => {
  /**
   * These are the checks that make every parameter binding in `verify.ts` mean
   * something. Without them the file reasoned only about Move calls and their
   * arguments — so a command that was not a Move call, or an object the signer
   * owned, was invisible to all of it.
   */
  const orderCall = (tx: Transaction, pkg = PKG) => {
    const ctor = tx.moveCall({
      target: `${pkg}::request::new_place_order_argument`,
      arguments: [
        tx.pure.bool(true), tx.pure.bool(false), tx.pure.bool(false), tx.pure.u128(0n),
        tx.pure.option("u128", null), tx.pure.option("u64", null),
        tx.pure.option("u64", null), tx.pure.u64(0n),
      ],
    });
    tx.moveCall({
      target: `${pkg}::trading::place_order_request`,
      typeArguments: typeArgsFor("trading::place_order_request"),
      arguments: callArgs(
        tx, "trading::place_order_request",
        { accountId: ACCOUNT, ticker: "SUIUSD" }, { 6: ctor },
      ) as never,
    });
  };

  it("refuses a transfer riding along with a correct order", async () => {
    // The theft path. Every parameter binding in this file passed against it,
    // because a command that was not a Move call was never looked at.
    const tx = newTx();
    orderCall(tx);
    tx.transferObjects([tx.gas], `0x${"e".repeat(64)}`);
    const bytes = toBase64(await tx.build());
    expect(() => assertTransactionMatches(bytes, intent("openLong"), SIGNER, DEPLOYMENT)).toThrow(
      /contains a TransferObjects command/,
    );
  });

  it("refuses a shared object the deployment does not publish", async () => {
    // The state an operation reads is as much a part of what it does as the
    // values it carries. A registry, config or oracle that is not this
    // protocol's is state nobody vouched for — and two rounds left this open on
    // the belief that the deployment document listed no objects. It lists 63.
    const tx = newTx();
    tx.moveCall({
      target: `${PKG}::oracle::aggregate`,
      arguments: [
        tx.sharedObjectRef({
          objectId: `0x${"e".repeat(64)}`,
          initialSharedVersion: "1",
          mutable: false,
        }),
        tx.pure.u8(1),
        tx.pure.u8(2),
      ],
    });
    orderCall(tx);
    const bytes = toBase64(await tx.build());
    expect(() => assertTransactionMatches(bytes, intent("openLong"), SIGNER, DEPLOYMENT)).toThrow(
      /shared object 0xe{64} that this deployment does not publish/,
    );
  });

  it("accepts a shared object the deployment names", async () => {
    const OBJECT = `0x${"e".repeat(64)}`;
    const tx = newTx();
    tx.moveCall({
      target: `${PKG}::oracle::aggregate`,
      arguments: [
        tx.sharedObjectRef({ objectId: OBJECT, initialSharedVersion: "1", mutable: false }),
        tx.pure.u8(1),
        tx.pure.u8(2),
      ],
    });
    orderCall(tx);
    const bytes = toBase64(await tx.build());
    expect(() =>
      assertTransactionMatches(bytes, intent("openLong"), SIGNER, {
        ...DEPLOYMENT,
        deployment: {
          ...DEPLOYMENT.deployment,
          objects: new Set([...DEPLOYMENT.deployment.objects, normalizePackage(OBJECT)]),
        },
      }),
    ).not.toThrow();
  });

  it("refuses an owned object being handed to the transaction", async () => {
    // Every transaction the deployment builds reads pure values and SHARED
    // objects only. An owned object is the signer's own, and naming one is how
    // an appended call would get hold of something worth taking.
    const tx = newTx();
    tx.moveCall({
      target: `${PKG}::oracle::aggregate`,
      arguments: [
        tx.objectRef({
          objectId: `0x${"d".repeat(64)}`,
          version: "7",
          digest: "11111111111111111111111111111111",
        }),
      ],
    });
    orderCall(tx);
    const bytes = toBase64(await tx.build());
    expect(() => assertTransactionMatches(bytes, intent("openLong"), SIGNER, DEPLOYMENT)).toThrow(
      /is a ImmOrOwnedObject/,
    );
  });

  it("refuses a superseded version of the deployment's own package", async () => {
    // Sui packages are immutable and an upgrade publishes a NEW object, so
    // every previous version stays callable forever. Accepting a package's
    // original id therefore accepts a downgrade to code the deployment has
    // already replaced — which is what the allowlist used to do, because type
    // arguments legitimately name that id and both uses shared one set.
    const OLD = `0x${"1".repeat(64)}`;
    const tx = newTx();
    orderCall(tx, OLD);
    const bytes = toBase64(await tx.build());
    expect(() =>
      assertTransactionMatches(bytes, intent("openLong"), SIGNER, {
        ...DEPLOYMENT,
        deployment: {
          ...DEPLOYMENT.deployment,
          // Present as a type identity, absent as a call target: exactly how a
          // superseded version appears in the deployment manifest.
          typeable: new Set([...DEPLOYMENT.deployment.typeable, normalizePackage(OLD)]),
        },
      }),
    ).toThrow(/SUPERSEDED version/);
  });

  it("still allows a superseded id inside a type argument", async () => {
    // Move keys type identity by the ORIGINAL package id, so a live delegate
    // grant carries `<0x5056…::account_data::WaterXPerp>` while the deployment
    // runs a later version. Refusing that would refuse every delegate change.
    // The grant path is where this actually occurs, so it is tested there.
    const OLD = `0x${"1".repeat(64)}`;
    const delegate = `0x${"9".repeat(64)}`;
    const tx = newTx();
    tx.moveCall({
      target: `${PKG}::account::add_delegate`,
      arguments: callArgs(tx, "account::add_delegate", {
        accountId: ACCOUNT,
        delegateAddress: delegate,
        delegateBasePermissions: 0n,
      }) as never,
    });
    tx.moveCall({
      target: `${PKG}::account::set_delegate_protocol_permission`,
      typeArguments: [`${OLD}::account_data::WaterXPerp`],
      arguments: callArgs(tx, "account::set_delegate_protocol_permission", {
        accountId: ACCOUNT,
        delegateAddress: delegate,
        delegatePermissions: 3n,
      }) as never,
    });
    const bytes = toBase64(await tx.build());
    expect(() =>
      assertTransactionMatches(
        bytes,
        {
          ...intent("addDelegate"),
          delegateAddress: delegate,
          delegateBasePermissions: 0,
          delegatePermissions: { perp: 3, predict: 0, staking: 0 },
        },
        SIGNER,
        {
          ...DEPLOYMENT,
          deployment: {
            ...DEPLOYMENT.deployment,
            typeable: new Set([...DEPLOYMENT.deployment.typeable, normalizePackage(OLD)]),
            // Both ids, as a real manifest carries for an upgraded package.
            idsFor: (name: string) =>
              name === "waterx_perp"
                ? [normalizePackage(PKG), normalizePackage(OLD)]
                : [normalizePackage(PKG)],
          },
        },
      ),
    ).not.toThrow();
  });

  it("refuses an unconfirmed layout, and accepts the entrypoint by name", async () => {
    // `burnWlp` rather than a position action. The set of unconfirmed
    // entrypoints shrinks whenever `capture-corpus` finds conditions it could
    // not build before — these tests named `increasePosition`, it became
    // capturable, and three assertions about a refusal quietly stopped
    // exercising one. A redemption needs an unstaked WLP balance, which minting
    // never leaves, so it is the durable example.
    const tx = newTx();
    tx.moveCall({
      target: `${PKG}::lp_pool::request_redeem`,
      typeArguments: typeArgsFor("lp_pool::request_redeem"),
      arguments: callArgs(tx, "lp_pool::request_redeem", {
        accountId: ACCOUNT, amountRaw: 0n,
      }) as never,
    });
    const bytes = toBase64(await tx.build());
    const authorized: WriteIntent = { ...intent("burnWlp"), increasesExposure: true };
    // There is no switch to turn this off — only a list, and only of
    // entrypoints an allowance could actually apply to.
    expect(() => assertTransactionMatches(bytes, authorized, SIGNER, DEPLOYMENT)).toThrow(
      /never been confirmed against this deployment/,
    );
    expect(() =>
      assertTransactionMatches(bytes, authorized, SIGNER, {
        ...DEPLOYMENT,
        allowUnconfirmed: ["lp_pool::request_redeem"],
      }),
    ).not.toThrow();
  });

  it("does not let the caller's exposure flag open the gate", async () => {
    // The gate keyed on `intent.increasesExposure`, which the caller supplies
    // and nothing in the transaction binds — one unverifiable boolean switched
    // off both the layout requirement and the scope ceilings. It keys on the
    // action now, which the transaction has to match to be accepted as it.
    const tx = newTx();
    tx.moveCall({
      target: `${PKG}::lp_pool::request_redeem`,
      typeArguments: typeArgsFor("lp_pool::request_redeem"),
      arguments: callArgs(tx, "lp_pool::request_redeem", {
        accountId: ACCOUNT, amountRaw: 0n,
      }) as never,
    });
    const bytes = toBase64(await tx.build());
    const lying: WriteIntent = { ...intent("burnWlp"), increasesExposure: false };
    expect(() =>
      assertTransactionMatches(bytes, lying, SIGNER, {
        ...DEPLOYMENT,
      }),
    ).toThrow(/never been confirmed against this deployment/);
  });

  it("refuses an unconfirmed layout even for the way out", async () => {
    // The earlier version of this exempted exits, on the reasoning that a limit
    // trapping a position open is worse than none. That rule is about risk
    // LIMITS — it governs the ceilings — and borrowing it here made `EXITS` an
    // implicit allowlist: five uncaptured entrypoints proceeding on a layout
    // nobody had confirmed, with no operator having decided anything.
    //
    // Whether an argument can be read from the right slot has nothing to do
    // with whether the action reduces risk. An exit appearing in the refused
    // list is urgent, and the answer is to capture it or name it.
    // `cancelWlpBurn` is the exit that is still unconfirmed. `closePosition`
    // used to be, and stopped being one the day a capture could finally reach
    // an open position — which is the good outcome, and would have left this
    // test asserting nothing had it kept the old name.
    const tx = newTx();
    tx.moveCall({
      target: `${PKG}::lp_pool::cancel_redeem`,
      typeArguments: typeArgsFor("lp_pool::cancel_redeem"),
      arguments: callArgs(tx, "lp_pool::cancel_redeem", {
        accountId: ACCOUNT, requestId: 0n,
      }) as never,
    });
    const bytes = toBase64(await tx.build());
    expect(() =>
      assertTransactionMatches(bytes, intent("cancelWlpBurn"), SIGNER, {
        ...DEPLOYMENT,
      }),
    ).toThrow(/never been confirmed against this deployment/);
    expect(() =>
      assertTransactionMatches(bytes, intent("cancelWlpBurn"), SIGNER, {
        ...DEPLOYMENT,
        allowUnconfirmed: ["lp_pool::cancel_redeem"],
      }),
    ).not.toThrow();
  });

  it("refuses a call from a package the deployment does not publish", async () => {
    // Not only the defining call. A single Move call from an unknown package
    // can act on the shared objects with the sender's authority, and its inner
    // calls are not PTB commands — so nothing else here sees what it does.
    const tx = newTx();
    tx.moveCall({
      target: `0x${"f".repeat(64)}::oracle::aggregate`,
      arguments: [tx.pure.u8(0)],
    });
    orderCall(tx);
    const bytes = toBase64(await tx.build());
    expect(() => assertTransactionMatches(bytes, intent("openLong"), SIGNER, DEPLOYMENT)).toThrow(
      /calls oracle::aggregate in package 0xf{64}, which this deployment does not publish/,
    );
  });

  it("accepts an unlisted package only when the operator names it", async () => {
    // The escape hatch, and its shape: the deployment config does not currently
    // list every package the backend calls, so refusing outright would stop all
    // trading. Naming the exception keeps it written down rather than silent.
    const tx = newTx();
    tx.moveCall({
      target: `0x${"f".repeat(64)}::oracle::aggregate`,
      arguments: [tx.pure.u8(0), tx.pure.u8(1), tx.pure.u8(2)],
    });
    orderCall(tx);
    const bytes = toBase64(await tx.build());
    expect(() =>
      assertTransactionMatches(bytes, intent("openLong"), SIGNER, {
        ...DEPLOYMENT,
        extraPackages: [`0x${"f".repeat(64)}=waterx_oracle::oracle`],
      }),
    ).not.toThrow();
  });

  it("does not let a named exception serve a defining call", async () => {
    // The exception exists for the auxiliary legs the deployment document has
    // not caught up with. It must never stand in for the code the action IS:
    // that is pinned to the entrypoint's own package by name, which no
    // operator-supplied list can satisfy.
    const OTHER = `0x${"f".repeat(64)}`;
    const tx = newTx();
    orderCall(tx, OTHER);
    const bytes = toBase64(await tx.build());
    expect(() =>
      assertTransactionMatches(bytes, intent("openLong"), SIGNER, {
        ...DEPLOYMENT,
        extraPackages: [OTHER],
      }),
      // Refused because an exception naming `waterx_perp` does not cover the
      // order constructor, and the defining call would be refused on membership
      // anyway: it consults the deployment's own packages only.
    ).toThrow(/in package 0xf{64}, which this deployment does not publish/);
  });

  it("narrows an exception to the module it names", async () => {
    const OTHER = `0x${"f".repeat(64)}`;
    const build = async () => {
      const tx = newTx();
      tx.moveCall({
        target: `${OTHER}::oracle::aggregate`,
        arguments: [tx.pure.u8(0), tx.pure.u8(1), tx.pure.u8(2)],
      });
      orderCall(tx);
      return toBase64(await tx.build());
    };
    const bytes = await build();
    // The module the backend actually calls is covered…
    expect(() =>
      assertTransactionMatches(bytes, intent("openLong"), SIGNER, {
        ...DEPLOYMENT,
        extraPackages: [`${OTHER}=waterx_oracle::oracle`],
      }),
    ).not.toThrow();
    // …and a different module in the same package is not, which is the whole
    // point of naming one rather than the package id alone.
    expect(() =>
      assertTransactionMatches(bytes, intent("openLong"), SIGNER, {
        ...DEPLOYMENT,
        extraPackages: [`${OTHER}=waterx_oracle::something_else`],
      }),
    ).toThrow(/calls oracle::aggregate in package/);
  });

  it("does not let an exception admit a function the SDK never describes", async () => {
    // The exception exists for auxiliary legs the deployment document has not
    // caught up with. Naming a package must not turn into naming arbitrary
    // code: the call still has to be a function that exists in the SDK.
    const OTHER = `0x${"f".repeat(64)}`;
    const tx = newTx();
    tx.moveCall({ target: `${OTHER}::evil::drain`, arguments: [tx.pure.u8(0)] });
    orderCall(tx);
    const bytes = toBase64(await tx.build());
    expect(() =>
      assertTransactionMatches(bytes, intent("openLong"), SIGNER, {
        ...DEPLOYMENT,
        extraPackages: [`${OTHER}=waterx_oracle`],
      }),
    ).toThrow(/declares no such function in that package/);
  });

  it("refuses an order argument produced by something other than the constructor", async () => {
    // The walk that collects constructors matched on function name and stopped
    // there, so `main` and `preOrder` were free positions: a value of the right
    // shape from another call would have been read as the order.
    const tx = newTx();
    const impostor = tx.moveCall({
      target: `${PKG}::oracle::aggregate`,
      arguments: [tx.pure.u8(0), tx.pure.u8(1), tx.pure.u8(2)],
    });
    tx.moveCall({
      target: `${PKG}::trading::place_order_request`,
      typeArguments: typeArgsFor("trading::place_order_request"),
      arguments: callArgs(
        tx,
        "trading::place_order_request",
        { accountId: ACCOUNT, ticker: "SUIUSD" },
        { 6: impostor },
      ) as never,
    });
    const bytes = toBase64(await tx.build());
    expect(() => assertTransactionMatches(bytes, intent("openLong"), SIGNER, DEPLOYMENT)).toThrow(
      /argument main is the result of oracle::aggregate, but it must come from request::new_place_order_argument/,
    );
  });

  it("refuses a bare package id for a call", async () => {
    // A bare id says only "this address is fine" — there is nothing to hold a
    // call through it to. It is accepted for a package named in a type
    // argument, where there is no call to check, and refused for a call.
    const OTHER = `0x${"f".repeat(64)}`;
    const tx = newTx();
    tx.moveCall({
      target: `${OTHER}::oracle::aggregate`,
      arguments: [tx.pure.u8(0), tx.pure.u8(1), tx.pure.u8(2)],
    });
    orderCall(tx);
    const bytes = toBase64(await tx.build());
    expect(() =>
      assertTransactionMatches(bytes, intent("openLong"), SIGNER, {
        ...DEPLOYMENT,
        extraPackages: [OTHER],
      }),
    ).toThrow(/calls oracle::aggregate in package 0xf{64}/);
  });

  it("refuses a lookalike package exporting the same entrypoint", async () => {
    // `module::function` is owned by nobody. A package the attacker publishes
    // can export `trading::place_order_request`, satisfy every argument binding
    // above, and run a different body — which is what made those bindings
    // decorative until the package was pinned.
    const tx = newTx();
    orderCall(tx, `0x${"f".repeat(64)}`);
    const bytes = toBase64(await tx.build());
    expect(() => assertTransactionMatches(bytes, intent("openLong"), SIGNER, DEPLOYMENT)).toThrow(
      /which this deployment does not publish/,
    );
  });

  it("refuses a foreign type argument", async () => {
    // Type arguments choose which coin and balance the call operates on, so a
    // foreign type is foreign code reached by another route.
    const tx = newTx();
    const ctor = tx.moveCall({
      target: `${PKG}::request::new_place_order_argument`,
      arguments: [
        tx.pure.bool(true), tx.pure.bool(false), tx.pure.bool(false), tx.pure.u128(0n),
        tx.pure.option("u128", null), tx.pure.option("u64", null),
        tx.pure.option("u64", null), tx.pure.u64(0n),
      ],
    });
    tx.moveCall({
      target: `${PKG}::trading::place_order_request`,
      typeArguments: [`0x${"f".repeat(64)}::evil::COIN`],
      arguments: callArgs(
        tx, "trading::place_order_request",
        { accountId: ACCOUNT, ticker: "SUIUSD" }, { 6: ctor },
      ) as never,
    });
    const bytes = toBase64(await tx.build());
    expect(() => assertTransactionMatches(bytes, intent("openLong"), SIGNER, DEPLOYMENT)).toThrow(
      /parameterised with a type from package/,
    );
  });

  it("refuses self-pay bytes that name anyone else as gas owner", async () => {
    // The self-pay branch assembles its own envelope, so a different payer
    // there means the assembly did not do what it believes it did. Only the
    // sponsored half was checked, on the reasoning that we build the other
    // ourselves — which is an argument for expecting the check to pass, not for
    // leaving it out.
    const tx = newTx();
    orderCall(tx);
    tx.setGasOwner(`0x${"e".repeat(64)}`);
    const bytes = toBase64(await tx.build());
    expect(() => assertTransactionMatches(bytes, intent("openLong"), SIGNER, DEPLOYMENT)).toThrow(
      /pays gas from 0xe{64}, but it was assembled here/,
    );
  });

  it("refuses sponsored bytes that name the signer as gas owner", async () => {
    const tx = newTx();
    orderCall(tx);
    tx.setGasOwner(SIGNER);
    const bytes = toBase64(await tx.build());
    expect(() =>
      assertTransactionMatches(bytes, intent("openLong"), SIGNER, {
        ...DEPLOYMENT,
        sponsored: true,
      }),
    ).toThrow(/name the signer as gas owner/);
  });
});

describe("a real deposit, as the deployment built it", () => {
  /**
   * The only test here whose transaction did not come from `ENTRYPOINT_SPECS`.
   * Everything else builds its fixtures from the same table the verifier reads,
   * so it agrees by construction; this one was produced by the live backend on
   * 2026-08-26 and is checked against what the agent would have authorized.
   *
   * A deposit is also the one action that pays out of the signer's own balance,
   * and it does so through a `FundsWithdrawal` input rather than any call
   * argument — which is why the amount and asset went unbound for ten rounds.
   * The SDK exposes no builder for that input kind, so real bytes are the only
   * way to test it.
   */
  const DEPOSIT_TX =
    "AAAGAQHbNBDB0Lcg2Da3Nzl+LTc2Yeu4SOV1rv9yPGkm3nbgURWG6zQAAAAAAQEBN0UG2vLbGC1RX2ZpnN5QBfPOW7D/H8Ju" +
    "diTeuV6rOC0Shus0AAAAAAEBAfIbxagTY3mYof9AxtQSp5X665TPrSWzNw1Ri1Ww5exBJjLrNAAAAAABACCkpJyHeSMwOHCI" +
    "RwqnA9zCQnX8Fi8OKU8Kvvz3dWIK+AABAAIAwMYtAAAAAAAAB3zNR36ITsdPlgsjqLNLfYeZnk1+4N3nOKDCX0YgDyAaCW1v" +
    "Y2tfdXNkYwlNT0NLX1VTREMAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIEY29pbgxyZWRlZW1fZnVuZHMB" +
    "B3zNR36ITsdPlgsjqLNLfYeZnk1+4N3nOKDCX0YgDyAaCW1vY2tfdXNkYwlNT0NLX1VTREMAAQEFAABFkQ9MO6mULA5pvYH7" +
    "px0oopCVBpGkK6qW+CqBEq5EvQ1jdXN0b2R5X3ZhdWx0BG1pbnQCB3zNR36ITsdPlgsjqLNLfYeZnk1+4N3nOKDCX0YgDyAa" +
    "CW1vY2tfdXNkYwlNT0NLX1VTREMAB2MhtxJoXUxJIcFf9HkNeporK307RPixmiME5gyjrSbHA3VzZANVU0QABgEAAAEBAAEC" +
    "AAEDAAMAAAAAAQQAAPVIn1sxzhRHSdJ+8yk9MrIbJLXMm+J6utPSu5MlYJKhC2RpcmVjdF9ydWxlFmNvbnN1bWVfZGVwb3Np" +
    "dF9kaXJlY3QBB2MhtxJoXUxJIcFf9HkNeporK307RPixmiME5gyjrSbHA3VzZANVU0QAAgECAAMBAAAAsUKMdnxMEd8BlYGy" +
    "7G9wJUMkC+TdcO7ZHgl9K2bZ3mwBLGwbQnDLngHC2pukGSh50q3DLDLf+uUW1BXr/GuGiMrNVhE6AAAAACAlNeNO4QwSKSqg" +
    "BsjyhIjRC5kL0L0cd4Uc+LlNO0p5Gw3sTH0EGwfmVWN+DdD5AQvXcB92E8ZolNiYeVpUQxKQ6AMAAAAAAAAoiTIAAAAAAAG0" +
    "BAAAAAAAAA==";
  const ASSET = "0x7ccd477e884ec74f960b23a8b34b7d87999e4d7ee0dde738a0c25f46200f201a::mock_usdc::MOCK_USDC";
  const AMOUNT = "3000000";
  const ACCOUNT_ID = "0xa4a49c87792330387088470aa703dcc24275fc162f0e294f0abefcf775620af8";
  const DEPOSITOR = "0xb1428c767c4c11df019581b2ec6f702543240be4dd70eed91e097d2b66d9de6c";

  const depositIntent = (overrides: Partial<WriteIntent> = {}): WriteIntent => ({
    action: "deposit",
    accountId: ACCOUNT_ID,
    increasesExposure: false,
    movesFundsIn: true,
    collateralRaw: AMOUNT,
    assetType: ASSET,
    ...overrides,
  });

  // The packages this transaction actually calls, read from the deployment
  // config the doctor fetches.
  const live = () => {
    const data = Transaction.from(fromBase64(DEPOSIT_TX)).getData();
    const packages = new Set(
      data.commands.flatMap((c) => (c.MoveCall == null ? [] : [normalizePackage(c.MoveCall.package)])),
    );
    for (const t of data.commands.flatMap((c) => c.MoveCall?.typeArguments ?? [])) {
      for (const ref of t.match(/0x[0-9a-fA-F]+/g) ?? []) packages.add(normalizePackage(ref));
    }
    // The manifest these bytes imply: each entrypoint the ABI knows, mapped to
    // the package that actually served it here. Built from the transaction so
    // the fixture states a real deployment rather than an empty one — an empty
    // map is now a refusal, since an unpinnable call is not a checkable call.
    const byName = new Map<string, string>();
    const roleObjects = new Map<string, string>();
    for (const command of data.commands) {
      const call = command.MoveCall;
      if (call == null) continue;
      const entrypoint = `${call.module}::${call.function}`;
      const entry = ABI[entrypoint];
      if (entry === undefined) continue;
      byName.set(entry.pkg, normalizePackage(call.package));
      call.arguments.forEach((argument, index) => {
        const binding = BINDINGS[entrypoint]?.[entry.params[index] ?? ""];
        if (binding === undefined || typeof binding !== "object" || !("object" in binding)) return;
        const a = argument as { $kind?: string; Input?: number };
        if (a.$kind !== "Input" || a.Input === undefined) return;
        const id = (data.inputs[a.Input]?.Object as { SharedObject?: { objectId: string } } | null)
          ?.SharedObject?.objectId;
        if (id !== undefined) roleObjects.set(binding.object, normalizePackage(id));
      });
    }
    return {
      // Real sponsored bytes: the sponsor owns the gas, which is what the
      // sponsored branch requires and the self-pay branch forbids.
      sponsored: true,
      deployment: {
        callable: packages,
        typeable: packages,
        byName,
        // Taken from the transaction itself: this fixture exercises the deposit
        // VALUE bindings, and deriving the object set here keeps the object
        // allowlist — which has its own tests — out of what it is measuring.
        // Every role this transaction's calls declare, taken from the
        // transaction: this fixture measures the deposit's VALUE bindings, and
        // the object roles have their own tests.
        objectFor: (role: string) => roleObjects.get(role),
        objects: new Set(
          data.inputs.flatMap((i) =>
            i.$kind === "Object" && (i.Object as { SharedObject?: { objectId: string } })?.SharedObject
              ? [
                  normalizePackage(
                    (i.Object as { SharedObject: { objectId: string } }).SharedObject.objectId,
                  ),
                ]
              : [],
          ),
        ),
        idsFor: (name: string) => {
          const id = byName.get(name);
          return id === undefined ? [] : [id];
        },
      },
      allowUnconfirmed: [] as readonly string[],
      network: "testnet" as const,
    };
  };

  it("accepts it against the intent the agent would have built", () => {
    expect(() =>
      assertTransactionMatches(DEPOSIT_TX, depositIntent(), DEPOSITOR, live()),
    ).not.toThrow();
  });

  it("refuses it when the authorized amount is smaller", () => {
    expect(() =>
      assertTransactionMatches(DEPOSIT_TX, depositIntent({ collateralRaw: "1" }), DEPOSITOR, live()),
    ).toThrow(/reserves 3000000 from the signer's balance, but 1 was authorized/);
  });

  it("refuses it when the authorized asset is a different coin", () => {
    expect(() =>
      assertTransactionMatches(
        DEPOSIT_TX,
        depositIntent({ assetType: "0x2::sui::SUI" }),
        DEPOSITOR,
        live(),
      ),
    ).toThrow(/pays in 0x7ccd.*but 0x2::sui::SUI was authorized/);
  });

  it("refuses it under an action that pays nothing", () => {
    // A withdrawal reservation under an operation that authorized no payment is
    // the transaction spending the signer's balance for a reason nobody stated.
    expect(() =>
      assertTransactionMatches(
        DEPOSIT_TX,
        depositIntent({ movesFundsIn: false }),
        DEPOSITOR,
        live(),
      ),
    ).toThrow(/withdraws funds from the signer's balance, which this action does not do/);
  });
});

describe("a delegate grant", () => {
  /**
   * `add_delegate` names the delegate and grants almost nothing: in a live
   * grant of every trading permission its own `permissions` argument was ZERO,
   * and the authority arrived in a separate `set_delegate_protocol_permission`
   * call the verifier did not inspect at all. A delegate could be authorized
   * for one thing and granted another.
   */
  // The Move types the live deployment parameterises each grant with.
  const SLOT = {
    perp: `${PKG}::account_data::WaterXPerp`,
    perpLegacy: `${PKG}::request::TradingRequest<${PKG}::usd::USD>`,
    predict: `${PKG}::account_data::WaterXPrediction`,
    staking: `${PKG}::witness::WaterXStaking`,
  };

  const grant = async (
    grants: [keyof typeof SLOT | string, number][],
    delegate = `0x${"9".repeat(64)}`,
  ) => {
    const tx = newTx();
    tx.moveCall({
      target: `${PKG}::account::add_delegate`,
      arguments: callArgs(tx, "account::add_delegate", {
        accountId: ACCOUNT,
        delegateAddress: delegate,
        delegateBasePermissions: 0n,
      }) as never,
    });
    for (const [slot, mask] of grants) {
      tx.moveCall({
        target: `${PKG}::account::set_delegate_protocol_permission`,
        typeArguments: [SLOT[slot as keyof typeof SLOT] ?? slot],
        arguments: callArgs(tx, "account::set_delegate_protocol_permission", {
          accountId: ACCOUNT,
          delegateAddress: delegate,
          delegatePermissions: BigInt(mask),
        }) as never,
      });
    }
    return toBase64(await tx.build());
  };

  const authorizing = (
    permissions: { perp: number; predict: number; staking: number },
    overrides: Partial<WriteIntent> = {},
  ): WriteIntent => ({
    ...intent("addDelegate"),
    delegateAddress: `0x${"9".repeat(64)}`,
    delegateBasePermissions: 0,
    delegatePermissions: permissions,
    ...overrides,
  });

  const ONLY_PERP = { perp: 0b0011, predict: 0, staking: 0 };

  it("allows a grant split across the slots each protocol uses", async () => {
    // The backend emits one call per protocol slot — including both the
    // enforced perp slot and the superseded trading one. Each is held to its
    // own ceiling.
    const bytes = await grant([
      ["perp", 0b0011],
      ["perpLegacy", 0b0001],
      ["predict", 0b0100],
      ["staking", 0b1000],
    ]);
    expect(() =>
      assertTransactionMatches(
        bytes,
        authorizing({ perp: 0b0011, predict: 0b0100, staking: 0b1000 }),
        SIGNER,
        DEPLOYMENT,
      ),
    ).not.toThrow();
  });

  it("refuses a mask that grants a permission nobody asked for", async () => {
    const bytes = await grant([["perp", 0b0111]]);
    expect(() => assertTransactionMatches(bytes, authorizing(ONLY_PERP), SIGNER, DEPLOYMENT)).toThrow(
      /grants 7 on perp, which includes permissions outside the 3 authorized for it/,
    );
  });

  it("refuses a permission asked for on one protocol being granted on another", async () => {
    // The bug a single union ceiling produced: ask for perp OPEN_POSITION and
    // staking CLAIM, and a perp grant of BOTH cleared the union. Which protocol
    // a grant applies to is the call's type argument, so the ceilings have to
    // stay apart.
    const bytes = await grant([["perp", 0b0011 | 0b1000]]);
    expect(() =>
      assertTransactionMatches(
        bytes,
        authorizing({ perp: 0b0011, predict: 0, staking: 0b1000 }),
        SIGNER,
        DEPLOYMENT,
      ),
    ).toThrow(/grants 11 on perp.*extra bits: 8.*does not carry to another/s);
  });

  it("refuses a grant that sets only the superseded slot", async () => {
    // The client-side twin of the bug the backend delegate-mask fix addresses.
    // A delegate granted only in `TradingRequest` reads as fully permissioned
    // everywhere off chain and aborts EUnauthorized on every order — and a
    // check that merely asked whether SOME permission call was present signed
    // exactly that transaction.
    const bytes = await grant([["perpLegacy", 0b0011]]);
    expect(() => assertTransactionMatches(bytes, authorizing(ONLY_PERP), SIGNER, DEPLOYMENT)).toThrow(
      /never sets the slot the contract reads for it/,
    );
  });

  it("refuses two writes to the same enforced slot", async () => {
    // Each write passes the per-call subset test on its own, and keeping the
    // last of them made the verdict depend on emission order while discarding a
    // write that still reached the chain.
    const bytes = await grant([["perp", 0b0001], ["perp", 0b0011]]);
    expect(() => assertTransactionMatches(bytes, authorizing(ONLY_PERP), SIGNER, DEPLOYMENT)).toThrow(
      /writes the enforced perp slot more than once/,
    );
  });

  it("refuses a grant that confers less than was asked for", async () => {
    // Silently receiving less is a broken grant, not a safe one: the caller
    // believes the delegate can act and it cannot.
    const bytes = await grant([["perp", 0b0001], ["perpLegacy", 0b0011]]);
    expect(() => assertTransactionMatches(bytes, authorizing(ONLY_PERP), SIGNER, DEPLOYMENT)).toThrow(
      /enforced perp slot is granted 1, but 3 was authorized/,
    );
  });

  it("refuses a grant that skips one protocol's enforced slot", async () => {
    const bytes = await grant([["perp", 0b0011], ["predict", 0b0100]]);
    expect(() =>
      assertTransactionMatches(
        bytes,
        authorizing({ perp: 0b0011, predict: 0b0100, staking: 0b1000 }),
        SIGNER,
        DEPLOYMENT,
      ),
    ).toThrow(/grants 8 on staking, but the transaction never sets the slot/);
  });

  it("refuses the legacy slot over a coin the deployment does not settle in", async () => {
    // The superseded trading slot is parameterised by the account's collateral
    // coin, and accepting any `TradingRequest<T>` accepted a slot over a coin
    // this deployment has nothing to do with.
    const bytes = await grant([
      ["perp", 0b0011],
      [`${PKG}::request::TradingRequest<0x2::sui::SUI>`, 0b0011],
    ]);
    expect(() => assertTransactionMatches(bytes, authorizing(ONLY_PERP), SIGNER, DEPLOYMENT)).toThrow(
      /not a protocol slot this recognises/,
    );
  });

  it("refuses a wrapper type that merely contains the slot", async () => {
    // A substring test read `Wrapper<…::account_data::WaterXPerp>` as the perp
    // slot itself. The slot is the type, not a type that mentions it.
    const bytes = await grant([[`${PKG}::evil::Wrapper<${SLOT.perp}>`, 0b0011]]);
    expect(() => assertTransactionMatches(bytes, authorizing(ONLY_PERP), SIGNER, DEPLOYMENT)).toThrow(
      /not a protocol slot this recognises/,
    );
  });

  it("refuses the slot's own name exported by another of the deployment's packages", async () => {
    // The package was ignored entirely, so any package the deployment publishes
    // that exported the same module and struct names would have been taken for
    // the slot the contract reads. `0x2` is in this deployment's type set, so
    // it reaches the slot test rather than being stopped before it.
    const bytes = await grant([["0x2::account_data::WaterXPerp", 0b0011]]);
    expect(() => assertTransactionMatches(bytes, authorizing(ONLY_PERP), SIGNER, DEPLOYMENT)).toThrow(
      /not a protocol slot this recognises/,
    );
  });

  it("refuses a grant over a protocol slot it does not recognise", async () => {
    // An authority slot this cannot name is one whose scope it cannot bound.
    const bytes = await grant([[`${PKG}::witness::SomethingElse`, 0b0001]]);
    expect(() => assertTransactionMatches(bytes, authorizing(ONLY_PERP), SIGNER, DEPLOYMENT)).toThrow(
      /not a protocol slot this recognises/,
    );
  });

  it("refuses a grant to a delegate other than the one authorized", async () => {
    const bytes = await grant([["perp", 0b0001]], `0x${"e".repeat(64)}`);
    expect(() => assertTransactionMatches(bytes, authorizing(ONLY_PERP), SIGNER, DEPLOYMENT)).toThrow(
      /argument delegateAddress is e{64}/,
    );
  });

  it("refuses a grant whose authority is set nowhere it can see", async () => {
    // `add_delegate` alone confers almost nothing, so a transaction without the
    // companion call is one whose real mask is being set out of view.
    // Each required companion is checked on its own: asking only whether ANY
    // companion was present let a withdrawal skip the route call whose type
    // argument names the asset.
    const bytes = await grant([]);
    expect(() => assertTransactionMatches(bytes, authorizing(ONLY_PERP), SIGNER, DEPLOYMENT)).toThrow(
      /does not call account::set_delegate_protocol_permission/,
    );
  });

  it("refuses an authority grant riding along with an unrelated action", async () => {
    // `set_delegate_protocol_permission` defines no action of its own, so the
    // foreign-entrypoint test had to widen past defining calls to catch this.
    const tx = newTx();
    const ctor = tx.moveCall({
      target: `${PKG}::request::new_place_order_argument`,
      arguments: [
        tx.pure.bool(true), tx.pure.bool(false), tx.pure.bool(false), tx.pure.u128(0n),
        tx.pure.option("u128", null), tx.pure.option("u64", null),
        tx.pure.option("u64", null), tx.pure.u64(0n),
      ],
    });
    tx.moveCall({
      target: `${PKG}::trading::place_order_request`,
      typeArguments: typeArgsFor("trading::place_order_request"),
      arguments: callArgs(
        tx, "trading::place_order_request",
        { accountId: ACCOUNT, ticker: "SUIUSD" }, { 6: ctor },
      ) as never,
    });
    tx.moveCall({
      target: `${PKG}::account::set_delegate_protocol_permission`,
      arguments: callArgs(tx, "account::set_delegate_protocol_permission", {
        accountId: ACCOUNT,
        delegateAddress: `0x${"e".repeat(64)}`,
        delegatePermissions: 255n,
      }) as never,
    });
    const bytes = toBase64(await tx.build());
    expect(() => assertTransactionMatches(bytes, intent("openLong"), SIGNER, DEPLOYMENT)).toThrow(
      /also calls account::set_delegate_protocol_permission/,
    );
  });

  it("refuses an expiry the caller never set", async () => {
    // An authority meant to be short-lived can otherwise be made permanent
    // without changing anything else about the transaction.
    const delegate = `0x${"9".repeat(64)}`;
    const tx = newTx();
    tx.moveCall({
      target: `${PKG}::account::add_delegate`,
      arguments: callArgs(tx, "account::add_delegate", {
        accountId: ACCOUNT,
        delegateAddress: delegate,
        delegateBasePermissions: 0n,
        delegateExpiresAtMs: 9_999_999_999_999n,
      }) as never,
    });
    tx.moveCall({
      target: `${PKG}::account::set_delegate_protocol_permission`,
      arguments: callArgs(tx, "account::set_delegate_protocol_permission", {
        accountId: ACCOUNT, delegateAddress: delegate, delegatePermissions: 1n,
      }) as never,
      typeArguments: [SLOT.perp],
    });
    const bytes = toBase64(await tx.build());
    expect(() => assertTransactionMatches(bytes, authorizing(ONLY_PERP), SIGNER, DEPLOYMENT)).toThrow(
      /expiresAtMs carries 9999999999999 for delegateExpiresAtMs, but the intent authorized none/,
    );
  });
});

describe("the binding stays complete", () => {
  /**
   * Ten rounds of review found the same shape: a parameter the agent authorized
   * and the verifier never checked. Round nine added a test meant to close the
   * class — and it did not, because the list of fields it checked was written by
   * hand. Forgetting to add a field to the intent AND to that list left the test
   * green, which is the same hole one level up.
   *
   * So nothing here is hand-written. The fields come from the type, the bindings
   * come from the specs, and the actions come from the agent's own source. A
   * field, argument or action added anywhere fails one of these until it is
   * accounted for somewhere.
   */
  const sourceOf = (file: string) => {
    const path = fileURLToPath(new URL(file, import.meta.url));
    return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  };

  it("every field of WriteIntent is either bound or explicitly exempt", () => {
    // Read off the interface declaration, because TypeScript types do not
    // survive to runtime — which is exactly why a hand-copied list drifts.
    const fields: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === "WriteIntent") {
        for (const member of node.members) {
          if (ts.isPropertySignature(member) && member.name !== undefined) {
            fields.push(member.name.getText());
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceOf("../src/policy.ts"));

    expect(fields.length, "WriteIntent was not found, so this test proves nothing").toBeGreaterThan(
      5,
    );

    const accounted = new Set<string>([...BINDABLE_INTENT_FIELDS, ...UNBINDABLE_INTENT_FIELDS]);
    const unaccounted = fields.filter((f) => !accounted.has(f));
    expect(
      unaccounted,
      `these WriteIntent fields are neither bound to a transaction argument nor declared ` +
        `exempt: ${unaccounted.join(", ")}. A parameter the agent authorizes and never checks ` +
        `is the gap every round of this review has found — bind it in ENTRYPOINT_SPECS, or add ` +
        `it to UNBINDABLE_INTENT_FIELDS with the reason it has no counterpart.`,
    ).toEqual([]);
  });

  it("the permit fingerprint covers every field of the intent", () => {
    // Derived, not listed — but assert the derivation actually sees new fields,
    // since the whole failure this replaces was a list that stopped growing.
    const a: WriteIntent = { action: "openLong", accountId: ACCOUNT, increasesExposure: true };
    for (const field of [...BINDABLE_INTENT_FIELDS, ...UNBINDABLE_INTENT_FIELDS]) {
      if (field === "action" || field === "accountId" || field === "increasesExposure") continue;
      const b = { ...a, [field]: field.endsWith("Raw") ? "1" : 1 } as WriteIntent;
      expect(
        fingerprintIntent(b),
        `a permit issued for an intent without ${field} matches one that sets it`,
      ).not.toBe(fingerprintIntent(a));
    }
  });

  it("no field is claimed both bindable and exempt", () => {
    const both = BINDABLE_INTENT_FIELDS.filter((f) =>
      (UNBINDABLE_INTENT_FIELDS as readonly string[]).includes(f),
    );
    expect(both).toEqual([]);
  });

  it("every action the agent builds an intent for has a rule", () => {
    // Taken from the agent's source rather than a list kept beside it: an action
    // added to the agent and not to ACTION_RULES fails here, at the point the
    // gap is created.
    const actions = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText() === "action" &&
        ts.isStringLiteral(node.initializer)
      ) {
        actions.add(node.initializer.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceOf("../src/agent/agent.ts"));

    expect(actions.size, "no action literals were found, so this test proves nothing")
      .toBeGreaterThan(15);
    const missing = [...actions].filter((a) => !(a in ACTION_RULES));
    expect(missing, `these actions have no entry in ACTION_RULES: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("every rule's entrypoint has a generated ABI and a full set of bindings", () => {
    // The value-search tier this replaces existed only because layouts were
    // read off live transactions, so an entrypoint that could not be built at
    // that moment had no layout at all. The SDK ships every signature, so there
    // is no longer any such thing as an action whose arguments go unchecked.
    const unaccounted = Object.entries(ACTION_RULES)
      .flatMap(([, rule]) => [
        rule.entrypoint,
        ...(rule.companions ?? []).map((c) => c.entrypoint),
      ])
      .filter((entrypoint) => !(entrypoint in ABI) || !(entrypoint in BINDINGS));
    expect(
      [...new Set(unaccounted)],
      `these entrypoints have no generated ABI or no bindings, so their arguments cannot be ` +
        `checked at all`,
    ).toEqual([]);
  });

  it("every argument the ABI declares has a binding", () => {
    // The deny-by-default that replaces "checked whichever arguments someone
    // thought to name". An argument added by a contract upgrade arrives here
    // through the generated ABI and fails until someone decides what it means.
    const unbound: string[] = [];
    for (const [entrypoint, bindings] of Object.entries(BINDINGS)) {
      const abi = ABI[entrypoint];
      expect(abi, `${entrypoint} has bindings but no generated ABI`).toBeDefined();
      for (const name of abi?.params ?? []) {
        if (!(name in bindings)) unbound.push(`${entrypoint}.${name}`);
      }
    }
    for (const name of ABI["request::new_place_order_argument"]?.params ?? []) {
      if (!(name in ORDER_ARG_BINDINGS)) unbound.push(`order argument ${name}`);
    }
    expect(
      unbound,
      `these arguments are declared by the contract and constrained by nothing: ` +
        `${unbound.join(", ")}`,
    ).toEqual([]);
  });

  it("no binding names an argument the contract does not have", () => {
    // The other direction: a binding for a parameter that no longer exists is a
    // check that silently stopped applying.
    const orphans: string[] = [];
    for (const [entrypoint, bindings] of Object.entries(BINDINGS)) {
      const params = new Set(ABI[entrypoint]?.params ?? []);
      for (const name of Object.keys(bindings)) {
        if (!params.has(name)) orphans.push(`${entrypoint}.${name}`);
      }
    }
    const ctorParams = new Set(ABI["request::new_place_order_argument"]?.params ?? []);
    for (const name of Object.keys(ORDER_ARG_BINDINGS)) {
      if (!ctorParams.has(name)) orphans.push(`order argument ${name}`);
    }
    expect(orphans).toEqual([]);
  });

  it("every action rule's overrides name real parameters", () => {
    const orphans: string[] = [];
    for (const [action, rule] of Object.entries(ACTION_RULES)) {
      const params = new Set([
        ...(ABI[rule.entrypoint]?.params ?? []),
        ...(rule.companions ?? []).flatMap((c) => ABI[c.entrypoint]?.params ?? []),
      ]);
      for (const name of Object.keys(rule.overrides ?? {})) {
        if (!params.has(name)) orphans.push(`${action}.${name}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  it("every reason for leaving an argument unchecked actually says something", () => {
    // A `free` argument is a stated limit of the guarantee. An empty reason
    // would make it an oversight wearing the costume of a decision.
    const empty: string[] = [];
    const check = (label: string, bindings: Readonly<Record<string, unknown>>) => {
      for (const [name, binding] of Object.entries(bindings)) {
        if (
          typeof binding === "object" &&
          binding !== null &&
          "free" in binding &&
          String((binding as { free: string }).free).trim().length < 20
        ) {
          empty.push(`${label}.${name}`);
        }
      }
    };
    for (const [entrypoint, bindings] of Object.entries(BINDINGS)) check(entrypoint, bindings);
    check("order argument", ORDER_ARG_BINDINGS);
    for (const [action, rule] of Object.entries(ACTION_RULES)) check(action, rule.overrides ?? {});
    expect(empty).toEqual([]);
  });

  // Whether the ABI matches the contract the deployment is running is checked
  // in `test/abi.test.ts`, against VALUES captured from real transactions. It
  // cannot be checked here: everything in this file builds its fixtures FROM
  // the ABI and so agrees with it by construction.
});

describe("the documented list of unconstrained arguments", () => {
  /**
   * Every argument this file declares `free`, in the shape `README.md` prints.
   *
   * Derived rather than listed, because the drift is the whole point: the table
   * was hand-written for one round and named six of the twelve slots a signer
   * could actually reach. A reader counting the ones on the page concluded the
   * other six were bound.
   */
  const declared = (): string[] => {
    const rows: [string, string][] = [];
    const add = (key: string, binding: unknown): void => {
      if (binding !== null && typeof binding === "object" && "free" in binding) {
        rows.push([key, String((binding as { free: string }).free)]);
      }
    };
    for (const [entrypoint, args] of Object.entries(BINDINGS)) {
      for (const [name, binding] of Object.entries(args)) add(`${entrypoint}.${name}`, binding);
    }
    for (const [name, binding] of Object.entries(ORDER_ARG_BINDINGS)) {
      add(`request::new_place_order_argument.${name}`, binding);
    }
    for (const [action, rule] of Object.entries(ACTION_RULES)) {
      for (const [name, binding] of Object.entries(rule.overrides ?? {})) {
        add(`${action} (override) ${name}`, binding);
      }
    }
    return rows
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, why]) => `| \`${key}\` | ${why[0]?.toUpperCase() ?? ""}${why.slice(1)} |`);
  };

  it("is exactly what README.md prints — no slot omitted, none invented", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const between = /<!-- FREE-ARGUMENTS:BEGIN[^>]*-->([\s\S]*?)<!-- FREE-ARGUMENTS:END -->/.exec(
      readme,
    );
    expect(between, "README.md has lost its FREE-ARGUMENTS markers").not.toBeNull();
    const printed = (between?.[1] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("| `"));
    expect(printed).toStrictEqual(declared());
  });

  it("still names the two that carry money, in the prose beside the table", () => {
    // The table alone reads as a list of technicalities. These two are floors
    // on what the caller receives, so they are called out in words as well —
    // and a rename that quietly drops one from the prose fails here.
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    for (const argument of [
      "lp_pool::mint_wlp.minLpAmount",
      "withdrawal_queue::route_native.minOutput",
    ]) {
      expect(declared().join("\n")).toContain(argument);
      expect(readme).toContain(`**Two of these carry money.**`);
      expect(readme.split("**Two of these carry money.**")[1] ?? "").toContain(argument);
    }
  });
});

describe("the leg check accounts for every constructor argument", () => {
  it("names each one, so a new argument refuses brackets rather than being ignored", () => {
    // The main-order path gets this from enumerating the ABI. The leg path was
    // hand-written, and the stop flag and the side were each missed there while
    // every field beside them was bound. Reading the branch is what failed
    // twice; this is the check that does not depend on reading it.
    const params = ABI["request::new_place_order_argument"]?.params ?? [];
    expect(params.length).toBeGreaterThan(0);
    expect([...params].sort()).toStrictEqual(Object.keys(LEG_ARG_HANDLING).sort());
  });

  it("refuses a bracket outright when an argument has no entry", async () => {
    // Proof the table is load-bearing and not decoration: with one entry
    // removed, a bracket that is otherwise exactly the authorized one is
    // refused rather than checked against the remaining fields.
    const bytes = await orderTx([
      { isLong: true, collateral: 10_000_000n },
      { isLong: false, reduceOnly: true, collateral: 0n, triggerPrice: 1600n },
    ]);
    const authorized: WriteIntent = {
      ...intent("openLong"), collateralRaw: "10000000", reduceOnly: false,
      legs: [tp("1600")],
    };
    expect(() => assertTransactionMatches(bytes, authorized, SIGNER, DEPLOYMENT)).not.toThrow();

    const saved = LEG_ARG_HANDLING.isLong;
    try {
      delete (LEG_ARG_HANDLING as Record<string, string | undefined>).isLong;
      expect(() => assertTransactionMatches(bytes, authorized, SIGNER, DEPLOYMENT)).toThrow(
        /an argument named isLong that the leg check does not account for/,
      );
    } finally {
      (LEG_ARG_HANDLING as Record<string, string | undefined>).isLong = saved;
    }
    expect(() => assertTransactionMatches(bytes, authorized, SIGNER, DEPLOYMENT)).not.toThrow();
  });
});

/**
 * Do not place what you cannot take back.
 *
 * Every other check in `verify.ts` is about the transaction in hand. This one
 * is about the transaction you will need *next*: a resting order whose
 * cancellation cannot be signed sits on the book with no way off it except
 * filling. It surfaced on mainnet, where `cancel_order_request` is unconfirmed
 * while `place_order_request` is not, so the agent would have placed happily
 * and then been unable to retract.
 */
describe("an action that needs a way back", () => {
  const resting: WriteIntent = {
    action: "placeLimitOrder",
    accountId: `0x${"a".repeat(64)}`,
    increasesExposure: true,
    ticker: "SUIUSD",
  };

  /**
   * Deployments with and without the gap, built rather than borrowed.
   *
   * These tests used to lean on mainnet's committed record having the gap, so
   * the day its cancel was captured they would have failed for a reason that
   * had nothing to do with the rule. The rule is about the gap; the gap is
   * supplied here, on top of a real record so the siblings are real ones.
   */
  const CANCEL = "trading::cancel_order_request";
  const measured = corpusFor("mainnet");
  const noWayBack: NetworkCorpus = {
    ...measured,
    captured: Object.fromEntries(Object.entries(measured.captured).filter(([e]) => e !== CANCEL)),
    uncaptured: { ...measured.uncaptured, [CANCEL]: "needs a resting order, and ORDER_ID named none" },
  };
  const wayBack: NetworkCorpus = {
    ...measured,
    uncaptured: Object.fromEntries(Object.entries(measured.uncaptured).filter(([e]) => e !== CANCEL)),
  };

  it("refuses a resting order when the cancel is unconfirmed", () => {
    expect(() => assertLayoutConfirmed(resting, [], "mainnet", noWayBack)).toThrow(
      /the call that takes it back/,
    );
  });

  it("states the evidence rather than only the verdict", () => {
    // An operator deciding whether to accept this should be deciding with the
    // facts: sibling entrypoints in the same module are confirmed.
    expect(() => assertLayoutConfirmed(resting, [], "mainnet", noWayBack)).toThrow(
      /corroboration, not proof/,
    );
  });

  it("says who can capture it, not a command an installed package cannot run", () => {
    // "Re-run `pnpm run capture-corpus`" sent an installed reader after a
    // maintainer tool `waterx` refuses to run, leaving the allowance as the only
    // remedy anyone could act on.
    expect(() => assertLayoutConfirmed(resting, [], "mainnet", noWayBack)).toThrow(/maintainer step/);
  });

  it("allows it once the cancel is named deliberately", () => {
    expect(() => assertLayoutConfirmed(resting, [CANCEL], "mainnet", noWayBack)).not.toThrow();
  });

  it("costs nothing where the cancel is confirmed", () => {
    // A coupling that fired everywhere would just be an outage.
    expect(() => assertLayoutConfirmed(resting, [], "mainnet", wayBack)).not.toThrow();
  });

  it("does not restrain a market order, which needs no cancel", () => {
    expect(() =>
      assertLayoutConfirmed({ ...resting, action: "openLong" }, [], "mainnet", noWayBack),
    ).not.toThrow();
  });
});
