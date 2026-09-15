/**
 * Check what a transaction actually does, rather than trusting where it came
 * from.
 *
 * **Why this file looks the way it does.** Earlier versions checked that a
 * transaction called the right Move entrypoint, and then checked whichever
 * arguments someone had thought to name. Four successive reviews found the same
 * defect in that design, and each time the fix was to name one more argument:
 * the collateral, then the size, then the trigger price, then the linked
 * position. That does not converge, because "the argument nobody named" is
 * invisible by construction — a reviewer finds it only by reading the contract
 * and noticing something absent.
 *
 * So the direction is inverted here. Every argument position of every defining
 * entrypoint is enumerated, and each one must be either **bound** to a field of
 * the intent or explicitly declared **free** with a stated reason. An argument
 * that is neither is a decode failure, not an omission — and a signature that
 * grows an argument fails the arity guard rather than silently shifting the
 * positions of the ones already checked.
 *
 * **What this proves.** The transaction performs the operation it is presented
 * as and carries no operation any OTHER action here defines; it is sent from
 * the address about to sign it; and every parameter that operation consumes is
 * either bound to what was authorized OR declared free here — which is a
 * weaker claim than the first reading of it, and worth stating as the weaker
 * one. Fourteen parameters are free. `README.md` prints all of them, and a
 * test fails if that table stops matching this file.
 *
 * Two of the fourteen carry money: `minLpAmount` on a WLP mint and `minOutput`
 * on a native withdrawal are slippage FLOORS the backend picks and the agent
 * never states, so nothing here stops either being zero.
 *
 * **What it does not prove — read this before relying on it.**
 *
 * This runs INSIDE the agent process, called by `executor.ts`. A process that
 * has been taken over controls that call site and can simply not make it, then
 * hand the bytes to the signer directly. So this is not a defence against a
 * compromised agent process, and earlier versions of this comment claimed it
 * was. Every check below is bypassable by deleting one line of the caller.
 *
 * What it does defend against, and what it is worth having for:
 *
 *  - **bugs** — the agent building a transaction that does not match what the
 *    caller asked for, which is the failure that actually happens;
 *  - **a wrong or hostile backend response** — the bytes arrive from the
 *    network and are checked against an intent formed locally before the
 *    request went out;
 *  - **partial compromise that reaches only the API layer** — a poisoned HTTP
 *    client, a dependency that can alter responses but not the signing path.
 *
 * Making the stronger claim true requires this to run where the key is: the
 * `SignerProvider` boundary already exists, so the check would ship as a
 * library the external signer calls before signing. That has been DECIDED
 * against for this package — the accountable owner accepted custody-only
 * isolation on the pull request, on the record — and deferred to protocol work,
 * because it couples `SIGNER_PROTOCOL`, which is deliberately domain-neutral,
 * to WaterX semantics and to a runtime that already speaks it. It is a known
 * gap with an owner, not an open question here.
 *
 * **The backend is the trust boundary for auxiliary composition, deliberately.**
 * The OPERATION a transaction is presented as is checked closely: its arguments
 * at the positions the deployed contract declares, every shared object against
 * the role the deployment names for it, every type against the coin the
 * deployment settles in, every produced value against the call and package it
 * must come from. What the backend arranges AROUND that operation is not.
 *
 * "Its arguments", not "every argument" — fourteen are declared free above, and
 * two of those are minimum-output floors the backend picks. Saying "closely"
 * without repeating that here is how the wider claim kept coming back: the
 * qualification lived in one paragraph and the absolute in another.
 *
 * And the gap is wider than prices, which an earlier version of this comment
 * understated. Inside the packages the deployment publishes, the backend
 * composes freely: a transaction may carry any auxiliary call no action claims
 * as its own, take any shared object the deployment document lists, and pass any
 * arguments, types, multiplicity or ordering to them. Their effects on shared
 * state are not modelled here at all. The price case is the consequence that
 * matters most — the oracle legs write into shared state and the trading call
 * reads it from there, with no argument joining them — but it is an instance of
 * the boundary, not the boundary itself.
 *
 * What the backend cannot do: reach outside the admitted packages, touch an
 * object the deployment does not name, hand the signer's own coins to anything,
 * or alter the operation the transaction is presented as.
 *
 * The acceptable-price bound does not cover the gap: the agent derives it from a
 * spot reading taken from the same backend, so a consistently misreported price
 * moves the bound with it. Closing this needs a commitment naming the feeds a
 * build used, signed by something other than the composer and bound to the final
 * digest and the deployment revision. A composer signing its own build would
 * prove nothing. None exists today, and `README.md` says so where an operator
 * will read it.
 *
 * **The ABI.** Argument layouts come from `@waterx/sdk`'s generated Move
 * bindings, which ship with the deployment — see `abi.generated.ts`. An earlier
 * version read them off live transactions instead, which left every entrypoint
 * that could not be built at that moment unchecked; that was a bad method, not
 * a limitation.
 */
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";

import { ExecutionPolicyError } from "../errors.ts";
import type { WriteIntent } from "../policy.ts";
import { ABI, KNOWN_FUNCTIONS, SDK_VERSION } from "./abi.generated.ts";
import { CAPTURING_LAYOUTS, corpusFor, corroborationNote, type NetworkCorpus } from "./corpus.ts";
import type { Network } from "../config.ts";
import {
  exceptionCovers,
  normalizePackage,
  parseExceptions,
  type Deployment,
} from "./deployment.ts";

/**
 * What the check needs to know beyond the transaction itself.
 *
 * `deployment` is what makes an entrypoint name mean something: `module::function`
 * is not owned by anyone, so without the package set behind it a lookalike
 * package satisfies every argument binding and does whatever it likes.
 */
export interface VerificationContext {
  deployment: Deployment;
  /**
   * Entrypoints an operator has accepted unconfirmed, by name.
   *
   * A single global switch turned the requirement off for everything at once —
   * including `waterx_staking::claim`, whose object arguments have never been
   * observed and so are pinned to nothing. Naming them keeps the exception the
   * size of the problem.
   */
  allowUnconfirmed?: readonly string[];
  /**
   * Package ids the operator has named as acceptable on top of the deployment
   * document's own. Empty unless `WATERX_EXTRA_PACKAGES` is set.
   */
  extraPackages?: readonly string[];
  /**
   * Whether these bytes carry a sponsor's gas. Decides who is allowed to be
   * paying — the one thing about gas worth checking, since a sponsored build
   * that names the signer as gas owner is the backend billing us.
   */
  sponsored: boolean;
  /**
   * Which deployment these bytes are for.
   *
   * Required, and not derived from `deployment`: the recorded argument layouts
   * are per network — testnet and mainnet publish different packages under the
   * same names — so "has this entrypoint ever been confirmed?" has a different
   * answer on each. A default here would answer for the wrong one silently.
   */
  network: Network;
}

/**
 * The PTB command kinds these transactions legitimately contain.
 *
 * Everything the live backend composes is a `MoveCall`, with `MakeMoveVec` to
 * collect a bracket's legs. Nothing else has any business here — and
 * `TransferObjects` in particular is a direct theft path that satisfied every
 * check this file made, because a command that was not a Move call was simply
 * never looked at.
 */
const ALLOWED_COMMANDS: ReadonlySet<string> = new Set(["MoveCall", "MakeMoveVec"]);

/**
 * The input kinds they legitimately contain.
 *
 * Deliberately excludes `ImmOrOwnedObject` and `Receiving`. Every transaction
 * the deployment builds — orders, deposits, withdrawals, delegate changes, WLP
 * — reads only pure values and SHARED objects. That is a strong property: an
 * appended call cannot be handed the signer's coins or owned objects, because
 * naming one requires an input kind that does not appear here.
 */
const ALLOWED_INPUTS: ReadonlySet<string> = new Set(["Pure", "SharedObject", "FundsWithdrawal"]);

// ─── Argument bindings ────────────────────────────────────────────────────────

/** BCS encodings this file knows how to read, with their expected byte widths. */
type Encoding =
  | "address"
  | "string"
  | "bool"
  | "u8"
  | "u32"
  | "u64"
  | "u128"
  | "optU64"
  | "optU128";

/**
 * The Move type of an argument decides how to read it, so the encoding is taken
 * from the generated ABI rather than restated here. A bound argument whose type
 * this cannot read is a refusal, not a guess.
 */
function encodingOf(moveType: string | null): Encoding | undefined {
  switch (moveType) {
    case "bool":
      return "bool";
    case "u8":
      return "u8";
    case "u32":
      return "u32";
    case "u64":
      return "u64";
    case "u128":
      return "u128";
    case "address":
      return "address";
    // An object id is 32 bytes on the wire, exactly like an address.
    case "0x2::object::ID":
      return "address";
    case "0x1::string::String":
      return "string";
    case "0x1::option::Option<u64>":
      return "optU64";
    case "0x1::option::Option<u128>":
      return "optU128";
    default:
      return undefined;
  }
}

/**
 * The intent fields an argument may be bound to.
 *
 * Deliberately a closed union: a binding cannot name a field the intent has no
 * notion of, and `BINDABLE_INTENT_FIELDS` is derived from the bindings rather
 * than maintained beside them, so the two cannot drift apart.
 */
type Bindable =
  | "accountId"
  | "ticker"
  | "delegateAddress"
  | "delegateBasePermissions"
  // Compared per protocol against the call's type argument rather than as a
  // single value; see `ProtocolMask`.
  | "delegatePermissions"
  | "delegateExpiresAtMs"
  | "positionId"
  | "orderId"
  | "requestId"
  | "recipient"
  | "alias"
  | "collateralRaw"
  | "amountRaw"
  | "sizeRaw"
  | "triggerPriceRaw"
  | "acceptablePriceRaw"
  | "side"
  | "reduceOnly"
  | "isStopOrder"
  // Bound outside the argument tables — by the leg walk and by the funds
  // withdrawal input. See `LEG_BOUND_FIELDS`.
  | "legs"
  | "movesFundsIn"
  | "assetType";

/**
 * An argument this cannot constrain, and why. Every one is a stated limit of
 * the guarantee rather than an oversight — which is the point of requiring the
 * reason.
 */
interface Free {
  readonly free: string;
}

/**
 * A permission bitmask bounded by whatever the intent asked for *for this
 * call's protocol*.
 *
 * Which protocol a grant applies to is the call's first TYPE argument, not
 * anything in its values. An earlier version bounded every such call by the
 * UNION of the perp, predict and staking masks, which let a grant on one
 * protocol carry a bit that had only been requested for another — ask for
 * `perp: OPEN_POSITION` and `staking: CLAIM`, and a perp grant of both passed.
 */
interface ProtocolMask {
  readonly protocolMask: true;
}

/**
 * An argument that must be the result of a particular call.
 *
 * Several of the positions marked "an object or a prior command's result" are
 * not opaque at all — they are the output of one specific entrypoint, and which
 * one matters. `senderRequest` is the AUTHORITY HANDLE: every checked call
 * takes one, and it comes from `account::request`. A handle produced anywhere
 * else is a different authority, and nothing else in this file would notice.
 *
 * The same holds for the pieces a withdrawal is assembled from: `extraData` is
 * the result of the route call, which is how the route actually reaches the
 * contract, and `req` is the withdrawal request the queue enqueues.
 */
interface ProducedBy {
  readonly producedBy: string;
}

/** A vector of results, each from one specific call. */
interface VectorOf {
  readonly vectorOf: string;
}

export type Binding =
  | Bindable
  | Free
  | ProtocolMask
  | ProducedBy
  | VectorOf
  | SharedObjectRole;

const isFree = (b: Binding): b is Free => typeof b === "object" && "free" in b;
const isProtocolMask = (b: Binding): b is ProtocolMask =>
  typeof b === "object" && "protocolMask" in b;
const isProducedBy = (b: Binding): b is ProducedBy =>
  typeof b === "object" && "producedBy" in b;
const isSharedObject = (b: Binding): b is SharedObjectRole =>
  typeof b === "object" && "object" in b;
const isVectorOf = (b: Binding): b is VectorOf => typeof b === "object" && "vectorOf" in b;

/** The authority handle every checked call carries. */
const SENDER_REQUEST: ProducedBy = { producedBy: "account::request" };

/**
 * Which protocol each delegate-permission slot governs, by the Move type the
 * call is parameterised with.
 *
 * Read off a live grant that asked for a different mask per protocol, so the
 * mapping is observed rather than assumed. A type that matches none of these is
 * a slot this does not understand, and an unrecognised authority slot is
 * refused rather than waved through.
 */
/**
 * The two coins the deployment settles in, as WHOLE types.
 *
 * Comparing the package alone was the defect: `0x<usd>::other_module::Other`
 * satisfied "is the collateral coin" as readily as `usd::USD`. A package is
 * where a type lives, not which type it is.
 */
const COIN = {
  usd: { pkg: "usd", type: "usd::USD" },
  wlp: { pkg: "wlp", type: "wlp::WLP" },
} as const;

const PROTOCOL_SLOTS: readonly {
  /** The manifest package the slot's type belongs to. */
  readonly pkg: string;
  /** The rest of the type, after the package. */
  readonly type: string;
  /** For a generic slot, the manifest package its single parameter must belong to. */
  readonly generic?: { pkg: string; type: string };
  readonly protocol: Protocol;
  /**
   * Whether this is the slot the contract READS when it authorizes an action.
   *
   * The distinction is load-bearing. A delegate granted only in the superseded
   * `TradingRequest` slot reads as fully permissioned off chain and aborts
   * `EUnauthorized` on every order — the exact failure the backend's own
   * delegate-mask fix exists to prevent. Checking that *some* grant is present
   * accepts that transaction; checking that the ENFORCED slot is present does
   * not.
   */
  readonly enforced: boolean;
}[] = [
  { pkg: "waterx_perp", type: "account_data::WaterXPerp", protocol: "perp", enforced: true },
  // The superseded trading slot. Parameterised by the account's collateral
  // coin, and only by that: accepting any `TradingRequest<T>` accepted a slot
  // over a coin this deployment does not settle in.
  {
    pkg: "waterx_perp",
    type: "request::TradingRequest",
    generic: COIN.usd,
    protocol: "perp",
    enforced: false,
  },
  {
    pkg: "waterx_prediction",
    type: "account_data::WaterXPrediction",
    protocol: "predict",
    enforced: true,
  },
  { pkg: "waterx_staking", type: "witness::WaterXStaking", protocol: "staking", enforced: true },
];

/**
 * Which slot a grant's type argument names — matched whole, never as a
 * substring.
 *
 * A substring test read `Wrapper<0x…::account_data::WaterXPerp>` as the perp
 * slot, and ignored the package entirely, so any package of the deployment
 * exporting the same module and struct names would do. Type identity in Move is
 * keyed by the ORIGINAL package id, which is what a live grant carries, so both
 * ids are accepted here and nothing else is.
 */
function slotOf(
  type: string,
  deployment: Deployment,
): (typeof PROTOCOL_SLOTS)[number] | undefined {
  return PROTOCOL_SLOTS.find((slot) => {
    const ids = deployment.idsFor(slot.pkg);
    return ids.some((id) => {
      const prefix = `0x${id}::${slot.type}`;
      const actual = normalizeType(type);
      if (slot.generic === undefined) return actual === prefix;
      // A generic slot is the slot only over the parameter the deployment
      // settles in. `X<…>` is the slot; `Wrapper<X>` never is, because the
      // comparison is anchored at the start.
      const inner = actual.startsWith(`${prefix}<`) && actual.endsWith(">")
        ? actual.slice(prefix.length + 1, -1)
        : undefined;
      if (inner === undefined) return false;
      return isDeploymentType(inner, slot.generic, deployment);
    });
  });
}

/**
 * Every package id inside a type padded to its full form, so two spellings of
 * the same type compare equal.
 *
 * Only the ids: Move type and module names are case-sensitive, and lowering
 * them made `account_data::WaterXPerp` stop matching itself.
 */
const normalizeType = (type: string): string =>
  type.replace(/0x[0-9a-fA-F]+/g, (id) => `0x${normalizePackage(id)}`);

type Protocol = "perp" | "predict" | "staking";

/** Shared reasons, so the common cases read the same way everywhere. */
/** Where an order's real parameters live; see the constructor section below. */
const ORDER_ARG_CONSTRUCTOR = "request::new_place_order_argument";

const OBJ: Free = { free: "a shared object or a prior command's result, not a value to match" };

/**
 * A shared object argument, held to the object the deployment names for that
 * ROLE.
 *
 * Membership in the deployment's object set was the first answer, and it left
 * every role interchangeable: `place_order_request` would take the market
 * registry where it expects the global config, or the oracle where it expects
 * either, and pass. The document names them individually, so they can be
 * checked individually.
 */
interface SharedObjectRole {
  readonly object: string;
}
const obj = (role: string): SharedObjectRole => ({ object: role });
const LOCATOR: Free = {
  free: "a locator the backend reads from live order state so the contract can find the order; the agent never chose it",
};

/**
 * Type arguments that carry a CHOICE, and what constrains them.
 *
 * Most type arguments are deployment constants — the collateral coin, the LP
 * token — and for those the package check above is the whole story. A few name
 * something the caller picked, and those were unbound: the asset a withdrawal
 * pays out in is not a value anywhere in `request_withdraw`, it is the type
 * argument of the route call.
 *
 * A type argument this table does not mention is still held to the deployment's
 * own packages; what it is not held to is the intent.
 */
export const TYPE_BINDINGS: Readonly<Record<string, Readonly<Record<number, Bindable>>>> = {
  // Which coin the account is paid in. The route function's type argument is
  // the only place it appears.
  "withdrawal_queue::route_native": { 0: "assetType" },
  // Which coin is being credited on the way in.
  "custody_vault::mint": { 0: "assetType" },
};

/**
 * Type arguments whose ROLE is fixed by the deployment rather than chosen by
 * the caller: which coin is the collateral, which is the LP token.
 *
 * Checking only that a type's package belongs to the deployment left these
 * interchangeable — `place_order_request<WLP, USD>` would have passed as
 * readily as `<USD, WLP>`. Pinned to the manifest by package name, since that
 * is where the deployment says which coin is which.
 */

export const TYPE_ROLES: Readonly<
  Record<string, Readonly<Record<number, { pkg: string; type: string }>>>
> = {
  "trading::place_order_request": { 0: COIN.usd, 1: COIN.wlp },
  "trading::close_position_request": { 0: COIN.usd, 1: COIN.wlp },
  "trading::decrease_position_request": { 0: COIN.usd, 1: COIN.wlp },
  "trading::increase_position_request": { 0: COIN.usd, 1: COIN.wlp },
  "trading::deposit_collateral_request": { 0: COIN.usd, 1: COIN.wlp },
  "trading::withdraw_collateral_request": { 0: COIN.usd, 1: COIN.wlp },
  "trading::cancel_order_request": { 0: COIN.usd, 1: COIN.wlp },
  "trading::update_order_request": { 0: COIN.usd, 1: COIN.wlp },
  "lp_pool::mint_wlp": { 0: COIN.wlp, 1: COIN.usd },
  "lp_pool::request_redeem": { 0: COIN.wlp, 1: COIN.usd },
  "lp_pool::cancel_redeem": { 0: COIN.wlp, 1: COIN.usd },
  "account::request_withdraw": { 0: COIN.usd },
  "withdrawal_queue::enqueue": { 0: COIN.usd },
};

/** Does `type` name exactly this deployment's `role`? */
function isDeploymentType(
  type: string | undefined,
  role: { pkg: string; type: string },
  deployment: Deployment,
): boolean {
  if (type === undefined) return false;
  const actual = normalizeType(type);
  return deployment
    .idsFor(role.pkg)
    .some((id) => actual === `0x${id}::${role.type}`);
}

/**
 * What constrains each argument of each defining entrypoint, keyed by the
 * parameter's NAME.
 *
 * Names rather than positions, because positions are the thing that moves. An
 * argument inserted upstream shifts every index after it, and a table of
 * indices would then read the wrong slots while still passing its own arity
 * check; a table of names simply stops matching, loudly. The positions and the
 * encodings both come from `ABI`, which is generated from the SDK that ships
 * with the deployment.
 *
 * Every parameter the ABI declares must appear here — bound, or free with a
 * reason. `test/verify.test.ts` asserts it.
 */
export const BINDINGS: Readonly<Record<string, Readonly<Record<string, Binding>>>> = {
  "trading::place_order_request": {
    globalConfig: obj("waterx_perp.global_config"), wxaRegistry: obj("waterx_account.account_registry"), marketRegistry: obj("waterx_perp.market_registry_wlp"), senderRequest: SENDER_REQUEST,
    ticker: "ticker",
    accountId: "accountId",
    // The order itself, and the reduce-only legs attached to it. Both are
    // constructor results, and saying WHICH call produced them is what stops a
    // value of the right shape from somewhere else standing in — the walk that
    // collects constructors matched on function name alone.
    main: { producedBy: ORDER_ARG_CONSTRUCTOR },
    preOrder: { vectorOf: ORDER_ARG_CONSTRUCTOR },
  },
  "trading::close_position_request": {
    globalConfig: obj("waterx_perp.global_config"), wxaRegistry: obj("waterx_account.account_registry"), marketRegistry: obj("waterx_perp.market_registry_wlp"), senderRequest: SENDER_REQUEST,
    ticker: "ticker",
    accountId: "accountId",
    positionId: "positionId",
    acceptablePrice: "acceptablePriceRaw",
  },
  "trading::decrease_position_request": {
    globalConfig: obj("waterx_perp.global_config"), wxaRegistry: obj("waterx_account.account_registry"), marketRegistry: obj("waterx_perp.market_registry_wlp"), senderRequest: SENDER_REQUEST,
    ticker: "ticker",
    accountId: "accountId",
    positionId: "positionId",
    size: "sizeRaw",
    acceptablePrice: "acceptablePriceRaw",
  },
  "trading::increase_position_request": {
    globalConfig: obj("waterx_perp.global_config"), wxaRegistry: obj("waterx_account.account_registry"), marketRegistry: obj("waterx_perp.market_registry_wlp"), senderRequest: SENDER_REQUEST,
    ticker: "ticker",
    accountId: "accountId",
    // An `Option<u64>`, absent when increasing a position directly. A hand
    // written table had this position down as a direction flag, which is what
    // reading layouts off sample transactions rather than off the ABI gets you.
    orderId: "orderId",
    positionId: "positionId",
    collateralAmount: "collateralRaw",
    size: "sizeRaw",
    acceptablePrice: "acceptablePriceRaw",
  },
  "trading::deposit_collateral_request": {
    globalConfig: obj("waterx_perp.global_config"), wxaRegistry: obj("waterx_account.account_registry"), marketRegistry: obj("waterx_perp.market_registry_wlp"), senderRequest: SENDER_REQUEST,
    ticker: "ticker",
    accountId: "accountId",
    positionId: "positionId",
    collateralAmount: "collateralRaw",
  },
  "trading::withdraw_collateral_request": {
    globalConfig: obj("waterx_perp.global_config"), wxaRegistry: obj("waterx_account.account_registry"), marketRegistry: obj("waterx_perp.market_registry_wlp"), senderRequest: SENDER_REQUEST,
    ticker: "ticker",
    accountId: "accountId",
    positionId: "positionId",
    amount: "collateralRaw",
  },
  "trading::cancel_order_request": {
    globalConfig: obj("waterx_perp.global_config"), wxaRegistry: obj("waterx_account.account_registry"), marketRegistry: obj("waterx_perp.market_registry_wlp"), senderRequest: SENDER_REQUEST,
    ticker: "ticker",
    accountId: "accountId",
    orderId: "orderId",
    triggerPrice: LOCATOR,
    orderTypeTag: LOCATOR,
  },
  "trading::update_order_request": {
    globalConfig: obj("waterx_perp.global_config"), wxaRegistry: obj("waterx_account.account_registry"), marketRegistry: obj("waterx_perp.market_registry_wlp"), senderRequest: SENDER_REQUEST,
    ticker: "ticker",
    accountId: "accountId",
    orderId: "orderId",
    currentTriggerPrice: LOCATOR,
    orderTypeTag: LOCATOR,
    newSize: "sizeRaw",
    newTriggerPrice: "triggerPriceRaw",
  },
  "lp_pool::mint_wlp": {
    pool: obj("wlp.wlp_pool"),
    globalConfig: obj("waterx_perp.global_config"),
    wxaRegistry: obj("waterx_account.account_registry"),
    aum: obj("wlp.wlp_aum"),
    senderRequest: SENDER_REQUEST,
    oracle: obj("waterx_oracle.oracle"),
    accountId: "accountId",
    depositAmount: "collateralRaw",
    minLpAmount: {
      free: "a minimum-output bound the backend computes from live pool state; the agent names no figure for it and so has none to compare against",
    },
  },
  "lp_pool::request_redeem": {
    pool: obj("wlp.wlp_pool"),
    globalConfig: obj("waterx_perp.global_config"),
    wxaRegistry: obj("waterx_account.account_registry"),
    senderRequest: SENDER_REQUEST,
    accountId: "accountId",
    lpAmount: "amountRaw",
  },
  "lp_pool::cancel_redeem": {
    pool: obj("wlp.wlp_pool"),
    globalConfig: obj("waterx_perp.global_config"),
    wxaRegistry: obj("waterx_account.account_registry"),
    senderRequest: SENDER_REQUEST,
    requestId: "requestId",
  },
  "waterx_staking::claim": {
    // No transaction could be built for this — the probe account has never had
    // claimable rewards — so the objects it takes have not been seen and cannot
    // be pinned to a role. Declared rather than left as a generic object, and
    // the action refuses outright unless WATERX_ALLOW_UNCONFIRMED_ABI is set.
    self: {
      free: "the staking pool, unobserved: no claim could be built to read which object it takes",
    },
    request: {
      free: "an authority handle, unobserved: no claim could be built to read how it is produced",
    },
    wxaRegistry: obj("waterx_account.account_registry"),
    accountId: "accountId",
  },
  "custody_vault::mint": {
    vault: obj("native_custody.vault"),
    registry: obj("waterx_credit.credit_registry"),
    accountRegistry: obj("waterx_account.account_registry"),
    accountId: "accountId",
    // The coin being credited comes from the sender's own balance withdrawal,
    // whose amount and asset are bound against that input.
    assetCoin: { producedBy: "coin::redeem_funds" },
    extraData: { free: "an opaque routing blob the backend composes; the agent supplies none" },
  },
  "account::request_withdraw": {
    registry: obj("waterx_account.account_registry"), senderRequest: SENDER_REQUEST,
    accountId: "accountId",
    amount: "collateralRaw",
    // A real argument, not something the contract derives. An earlier table
    // declared this free on the reasoning that withdrawal is owner-only so the
    // contract must pay the owner — which was an assumption about a function
    // nobody had read. It is bound now.
    recipient: "recipient",
    // Not an opaque blob: it is the route call's own result, which is how the
    // chosen route reaches the contract at all.
    extraData: { producedBy: "withdrawal_queue::route_native" },
  },
  "account::create_account": {
    registry: obj("waterx_account.account_registry"), senderRequest: SENDER_REQUEST,
    alias: "alias",
  },
  "account::add_delegate": {
    registry: obj("waterx_account.account_registry"), senderRequest: SENDER_REQUEST,
    accountId: "accountId",
    delegateAddress: "delegateAddress",
    alias: { free: "a label on the grant, carrying no authority" },
    // The base mask, which every observed grant carried as ZERO — the authority
    // that matters is conferred per protocol by
    // `account::set_delegate_protocol_permission`. Bound to what the agent
    // sends rather than assumed, so a deployment that starts using it fails
    // here and gets looked at instead of passing unchecked.
    permissions: "delegateBasePermissions",
    // How long the grant lasts. Left unbound, an authority the caller meant to
    // be short-lived can be made permanent — and an earlier table had this
    // position down as an opaque "scope selector".
    expiresAtMs: "delegateExpiresAtMs",
  },
  "account::remove_delegate": {
    registry: obj("waterx_account.account_registry"), senderRequest: SENDER_REQUEST,
    accountId: "accountId",
    delegateAddress: "delegateAddress",
  },
  /**
   * The withdrawal route.
   *
   * WHICH of these is called is the route itself, and the asset the account is
   * paid in is the call's type argument — neither is a value in
   * `request_withdraw`, so neither was checked. `route_native` is a required
   * companion of a withdrawal; `route_wormhole` appears here so that a
   * transaction taking the bridge instead is a call that belongs to no
   * authorized action, rather than one nothing looks at.
   */
  "withdrawal_queue::route_native": {
    minOutput: {
      free: "a floor on the amount received, computed by the backend from live bridge and pool state; the agent names no figure for it",
    },
  },
  "withdrawal_queue::route_wormhole": {
    evmDestinationChain: { free: "unreachable: this agent only ever withdraws natively on Sui" },
    evmRecipient: { free: "unreachable: this agent only ever withdraws natively on Sui" },
    evmToken: { free: "unreachable: this agent only ever withdraws natively on Sui" },
  },
  "withdrawal_queue::enqueue": {
    queue: obj("withdrawal_queue.queue"),
    registry: obj("waterx_account.account_registry"),
    // The withdrawal this queues must be the one this action authorized, not
    // another request that happens to be in the transaction.
    req: { producedBy: "account::request_withdraw" },
  },
  /**
   * The call that actually confers authority.
   *
   * `add_delegate` names the delegate but grants almost nothing: in a live
   * grant of every trading permission its own `permissions` argument was zero,
   * and the real mask arrived here, in a call the verifier did not inspect at
   * all. A delegate could therefore be authorized for one thing and granted
   * another.
   *
   * The protocol each grant applies to is the call's TYPE argument, and those
   * are already held to the deployment's own packages.
   */
  "account::set_delegate_protocol_permission": {
    registry: obj("waterx_account.account_registry"), senderRequest: SENDER_REQUEST,
    accountId: "accountId",
    delegateAddress: "delegateAddress",
    permissions: { protocolMask: true },
  },
};


// ─── Actions ──────────────────────────────────────────────────────────────────

interface ActionRule {
  /** The Move call that makes a transaction be this action. */
  entrypoint: string;
  /**
   * How many times it may appear.
   *
   * `one` for everything that acts on a single subject — a second occurrence is
   * a second operation nobody authorized. `many` only where the action is
   * inherently plural: revoking every delegate is one intent and N calls.
   */
  multiplicity: "one" | "many";
  /**
   * Parameters whose meaning differs for this action specifically. Used where
   * two actions share an entrypoint but not its constraints.
   */
  overrides?: Readonly<Record<string, Binding>>;
  /**
   * Entrypoints that legitimately accompany this action and are checked with
   * it.
   *
   * `required` is per entrypoint, not "at least one of them". An earlier
   * version asked only whether ANY companion was present, so a withdrawal
   * carrying `enqueue` but not `route_native` satisfied the requirement — and
   * the asset binding, which lives on the route call, simply never ran.
   */
  companions?: readonly { readonly entrypoint: string; readonly required: boolean }[];
  /**
   * This action confers delegate authority, so every protocol it authorizes
   * must actually be granted in the slot the contract enforces.
   */
  grantsProtocolPermissions?: boolean;
}

/**
 * The actions that only ever unwind, by name. **For the ceilings, and nothing
 * else.**
 *
 * A risk LIMIT that trapped a position open would be worse than none, so an
 * exit is never metered. That is a statement about limits, and it was wrong to
 * borrow it for the layout requirement: whether an argument is read from the
 * right slot has nothing to do with whether the action reduces risk. Using this
 * set there made it an implicit allowlist — five uncaptured entrypoints
 * proceeding on a layout nobody had confirmed, with no operator having decided
 * anything.
 *
 * Derived from the ACTION, never from `intent.increasesExposure`: that field is
 * supplied by the caller and bound to nothing in the transaction. The action
 * name is bound — the transaction has to call that action's defining entrypoint
 * to be accepted as it.
 */
export const EXITS: ReadonlySet<string> = new Set([
  "closePosition",
  "reducePosition",
  // Adding margin lowers leverage; refusing it is refusing to de-risk.
  "addMargin",
  "cancelOrder",
  // A bracket is how a position is protected. Blocking it leaves one naked.
  "placeTpSl",
  // Redeeming is how a liquidity position is left.
  "burnWlp",
  // Revoking authority must never be the thing that is unavailable.
  "removeDelegate",
  "removeAllDelegates",
  // Funds-out from the account; its recipient and amount are both bound.
  "withdraw",
]);

export const ACTION_RULES: Readonly<Record<string, ActionRule>> = {
  openLong: { entrypoint: "trading::place_order_request", multiplicity: "one" },
  openShort: { entrypoint: "trading::place_order_request", multiplicity: "one" },
  placeLimitOrder: { entrypoint: "trading::place_order_request", multiplicity: "one" },
  placeTpSl: {
    entrypoint: "trading::place_order_request",
    // The backend emits ONE call per leg here, unlike a bracket attached at
    // open time, which feeds several constructors into a single call. Pinning
    // this to `one` refused every take-profit-and-stop-loss pair — a false
    // refusal that a sweep testing only single-leg brackets did not reveal.
    // The real bound is the authorized leg count, which `checkOrders` enforces
    // across however many calls carry them.
    multiplicity: "many",
  },
  closePosition: { entrypoint: "trading::close_position_request", multiplicity: "one" },
  reducePosition: { entrypoint: "trading::decrease_position_request", multiplicity: "one" },
  increasePosition: { entrypoint: "trading::increase_position_request", multiplicity: "one" },
  addMargin: { entrypoint: "trading::deposit_collateral_request", multiplicity: "one" },
  removeMargin: { entrypoint: "trading::withdraw_collateral_request", multiplicity: "one" },
  cancelOrder: { entrypoint: "trading::cancel_order_request", multiplicity: "one" },
  updateOrder: { entrypoint: "trading::update_order_request", multiplicity: "one" },
  mintWlp: { entrypoint: "lp_pool::mint_wlp", multiplicity: "one" },
  burnWlp: { entrypoint: "lp_pool::request_redeem", multiplicity: "one" },
  cancelWlpBurn: { entrypoint: "lp_pool::cancel_redeem", multiplicity: "one" },
  claimWlpRewards: { entrypoint: "waterx_staking::claim", multiplicity: "one" },
  deposit: { entrypoint: "custody_vault::mint", multiplicity: "one" },
  withdraw: {
    entrypoint: "account::request_withdraw",
    multiplicity: "one",
    // The route decides which asset leaves and by what path. `route_wormhole`
    // is deliberately NOT here: it is a known call that no action authorizes,
    // so a bridged withdrawal is refused rather than unexamined.
    companions: [
      { entrypoint: "withdrawal_queue::route_native", required: true },
      { entrypoint: "withdrawal_queue::enqueue", required: true },
    ],
  },
  createAccount: { entrypoint: "account::create_account", multiplicity: "one" },
  addDelegate: {
    entrypoint: "account::add_delegate",
    multiplicity: "one",
    // `add_delegate` names the delegate; these confer what it may do, one per
    // protocol. Required, because a grant that reached the chain without them
    // would mean the mask was set somewhere this does not look.
    companions: [{ entrypoint: "account::set_delegate_protocol_permission", required: true }],
    grantsProtocolPermissions: true,
  },
  removeDelegate: { entrypoint: "account::remove_delegate", multiplicity: "one" },
  removeAllDelegates: {
    entrypoint: "account::remove_delegate",
    // One intent, one call per delegate across every account the owner holds.
    multiplicity: "many",
    overrides: {
      delegateAddress: {
        free:
          "which delegates exist is the account's state, not the intent's. The bound here is " +
          "that every call is a removal — never identity, because the intent names no one.",
      },
    },
  },
};

/**
 * Every entrypoint this file knows how to check — defining calls and their
 * companions alike.
 *
 * The foreign-call test is drawn from this rather than from defining calls
 * alone, because a call that grants authority is worth stopping in a
 * transaction that was authorized as something else, whether or not any action
 * happens to be DEFINED by it.
 */
const SENSITIVE: ReadonlySet<string> = new Set(Object.keys(BINDINGS));

// ─── Decoding ─────────────────────────────────────────────────────────────────

/** Every `module::function` a transaction invokes. */
export function entrypointsOf(txBytes: string): string[] {
  const data = Transaction.from(fromBase64(txBytes)).getData();
  const out: string[] = [];
  for (const command of data.commands) {
    if (command.$kind !== "MoveCall" || command.MoveCall == null) continue;
    out.push(`${command.MoveCall.module}::${command.MoveCall.function}`);
  }
  return out;
}

/**
 * Every package a transaction calls into, including via type arguments.
 *
 * Used by `runDoctor` to report where the deployment config and the deployment
 * disagree — a difference that decides how much of a transaction can be pinned.
 */
export function packagesCalledBy(txBytes: string): string[] {
  return [...usesByPackage(txBytes).keys()];
}

/**
 * Every package a transaction reaches, and the `module::function` calls it
 * makes in each.
 *
 * To the function, because an exception may be narrowed that far and a
 * diagnostic that only knew the module would report a call as covered when the
 * signer would refuse it. A package reached only through a type argument maps
 * to an empty set — nothing is called in it at all.
 */
export function usesByPackage(txBytes: string): Map<string, Set<string>> {
  const data = Transaction.from(fromBase64(txBytes)).getData();
  const out = new Map<string, Set<string>>();
  const note = (pkg: string, call?: string): void => {
    const key = normalizePackage(pkg);
    const calls = out.get(key) ?? new Set<string>();
    if (call !== undefined) calls.add(call);
    out.set(key, calls);
  };
  for (const command of data.commands) {
    const call = command.MoveCall;
    if (call == null) continue;
    note(call.package, `${call.module}::${call.function}`);
    for (const argument of call.typeArguments) {
      for (const referenced of argument.match(/0x[0-9a-fA-F]+/g) ?? []) note(referenced);
    }
  }
  return out;
}

/** The address a transaction will execute as. */
export function senderOf(txBytes: string): string | undefined {
  return Transaction.from(fromBase64(txBytes)).getData().sender ?? undefined;
}

type Decoded = ReturnType<Transaction["getData"]>;

/** The raw bytes of a pure argument at one position, if it is one. */
function pureAt(data: Decoded, args: readonly unknown[], index: number): Uint8Array | undefined {
  const argument = args[index] as { $kind?: string; Input?: number } | undefined;
  if (argument?.$kind !== "Input" || argument.Input === undefined) return undefined;
  const input = data.inputs[argument.Input];
  if (input?.$kind !== "Pure" || input.Pure == null) return undefined;
  return fromBase64(input.Pure.bytes);
}

type Value = bigint | string | boolean;
/** `undefined` = a well-formed absent Option. `"bad"` = does not decode as this. */
type Read = Value | undefined | "bad";

function readEncoded(bytes: Uint8Array | undefined, enc: Encoding): Read {
  if (bytes === undefined) return "bad";
  const buf = Buffer.from(bytes);
  switch (enc) {
    case "address":
      return bytes.length === 32 ? buf.toString("hex") : "bad";
    case "string": {
      // A ULEB128 length then the bytes. Every value bound this way is a ticker,
      // which is far below the 128-byte single-byte-length boundary.
      if (bytes.length < 1 || bytes[0] !== bytes.length - 1) return "bad";
      return buf.subarray(1).toString("utf8");
    }
    case "bool":
      return bytes.length === 1 && bytes[0] !== undefined && bytes[0] <= 1 ? bytes[0] === 1 : "bad";
    case "u8":
      return bytes.length === 1 ? BigInt(buf.readUInt8(0)) : "bad";
    case "u32":
      return bytes.length === 4 ? BigInt(buf.readUInt32LE(0)) : "bad";
    case "u64":
      return bytes.length === 8 ? buf.readBigUInt64LE(0) : "bad";
    case "u128":
      return bytes.length === 16 ? buf.readBigUInt64LE(0) | (buf.readBigUInt64LE(8) << 64n) : "bad";
    case "optU64":
    case "optU128": {
      const width = enc === "optU64" ? 8 : 16;
      if (bytes.length === 1) return bytes[0] === 0 ? undefined : "bad";
      if (bytes.length !== width + 1 || bytes[0] !== 1) return "bad";
      return readEncoded(buf.subarray(1), width === 8 ? "u64" : "u128");
    }
  }
}

/** What the intent authorizes for a bound field, in the same shape `readEncoded` returns. */
function authorized(intent: WriteIntent, field: Bindable): Value | undefined {
  switch (field) {
    case "accountId":
      return intent.accountId === "" ? undefined : normalizeAddress(intent.accountId);
    case "ticker":
      return intent.ticker;
    case "delegateAddress":
      return intent.delegateAddress === undefined
        ? undefined
        : normalizeAddress(intent.delegateAddress);
    case "positionId":
      return intent.positionId === undefined ? undefined : BigInt(intent.positionId);
    case "orderId":
      return intent.orderId === undefined ? undefined : BigInt(intent.orderId);
    case "collateralRaw":
      return intent.collateralRaw === undefined ? undefined : BigInt(intent.collateralRaw);
    case "sizeRaw":
      return intent.sizeRaw === undefined ? undefined : BigInt(intent.sizeRaw);
    case "triggerPriceRaw":
      return intent.triggerPriceRaw === undefined ? undefined : BigInt(intent.triggerPriceRaw);
    case "acceptablePriceRaw":
      return intent.acceptablePriceRaw === undefined
        ? undefined
        : BigInt(intent.acceptablePriceRaw);
    case "side":
      return intent.side === undefined ? undefined : intent.side === "long";
    case "reduceOnly":
      return intent.reduceOnly;
    case "isStopOrder":
      return intent.isStopOrder;
    case "recipient":
      return intent.recipient === undefined ? undefined : normalizeAddress(intent.recipient);
    case "alias":
      return intent.alias;
    case "delegateBasePermissions":
      return intent.delegateBasePermissions === undefined
        ? undefined
        : BigInt(intent.delegateBasePermissions);
    case "delegateExpiresAtMs":
      return intent.delegateExpiresAtMs === undefined
        ? undefined
        : BigInt(intent.delegateExpiresAtMs);
    case "requestId":
      return intent.requestId === undefined ? undefined : BigInt(intent.requestId);
    case "amountRaw":
      return intent.amountRaw === undefined ? undefined : BigInt(intent.amountRaw);
    case "movesFundsIn":
    case "assetType":
      // Bound in two places, for two different reasons: as the type argument of
      // the route and mint calls, and against the funds withdrawal that pays
      // for a deposit.
      return intent.assetType;
    case "delegatePermissions":
      // Never read through here: the mask a grant may carry depends on which
      // protocol the CALL names in its type argument, so the comparison lives
      // in `checkProtocolMask` where that type is available.
      return undefined;
    case "legs":
      // Never read through here. The leg check compares the whole set against
      // the constructors found by walking, and no single argument position
      // could hold it — which is why it is listed in `LEG_BOUND_FIELDS`.
      return undefined;
  }
}

const normalizeAddress = (address: string): string =>
  address.toLowerCase().replace(/^0x/, "").padStart(64, "0");

const show = (value: Read): string =>
  value === undefined ? "absent" : value === "bad" ? "unreadable" : String(value);

// ─── The order-argument constructor ───────────────────────────────────────────

/**
 * An order's real parameters live here, not in `place_order_request`: the
 * collateral for an order is not an argument of that call at all, it is an
 * argument of a constructor whose result is passed in.
 *
 * `acceptablePrice` is the argument that made this round necessary. It is the
 * bound that gives slippage any meaning, and it sat here decoded by nothing
 * while the ceiling above it checked a *percentage* the transaction never
 * carries.
 */

/** What constrains each of the constructor's arguments, by ABI parameter name. */
export const ORDER_ARG_BINDINGS: Readonly<Record<string, Binding>> = {
  isLong: "side",
  // Was `free`, on the reasoning that a leg's trigger price implies which leg
  // it is. That reasoning was wrong twice over: it says nothing about the MAIN
  // order, whose flag is a caller field and picks between two opposite
  // instructions at the same price; and even for legs the flag, not the price,
  // is what decides which side the trigger fires from.
  isStopOrder: "isStopOrder",
  reduceOnly: "reduceOnly",
  size: "sizeRaw",
  triggerPrice: "triggerPriceRaw",
  linkedPositionId: "positionId",
  acceptablePrice: "acceptablePriceRaw",
  collateralAmount: "collateralRaw",
};

/**
 * Every intent field some argument is bound to, derived from the specs rather
 * than listed beside them.
 *
 * A previous round declared this as a hand-written array, which meant the
 * "completeness" test it fed could pass while a spec bound nothing at all. It
 * is computed now, so it cannot disagree with what is actually checked.
 */
/**
 * Bound by `checkOrders` rather than by a single argument position, because a
 * bracket's legs are a variable-length set of constructor calls and not an
 * argument of anything.
 *
 * Declared here so the completeness test can see it. It is the one binding that
 * cannot be derived from a spec table, and keeping it to one entry is the point
 * — a second would mean the table had stopped describing what is checked.
 */
const LEG_BOUND_FIELDS: readonly Bindable[] = [
  "legs",
  // Bound against the `FundsWithdrawal` input rather than an argument: whether
  // an action pays out of the signer's balance is not a value anywhere.
  "movesFundsIn",
];

export const BINDABLE_INTENT_FIELDS: readonly string[] = [
  ...new Set(
    [
      ...Object.values(BINDINGS).flatMap((e) => Object.values(e)),
      ...Object.values(ACTION_RULES).flatMap((r) => Object.values(r.overrides ?? {})),
      ...Object.values(ORDER_ARG_BINDINGS),
      ...Object.values(TYPE_BINDINGS).flatMap((e) => Object.values(e)),
    ]
      // Every non-field binding kind has to be excluded here, or the derived
      // list stops being a list of field names — which is what it is for.
      .filter((b): b is Bindable => typeof b === "string")
      .concat(LEG_BOUND_FIELDS)
      // Bound per protocol against the call's type argument rather than against
      // one value, so it is named here instead of derived from a plain binding.
      .concat(["delegatePermissions"]),
  ),
].sort();

interface OrderArgs {
  isLong: boolean;
  isStopOrder: boolean;
  reduceOnly: boolean;
  size: bigint;
  collateralAmount: bigint;
  triggerPrice?: bigint;
  linkedPositionId?: bigint;
  acceptablePrice?: bigint;
}

/** One constructor call, fully decoded — or a stated reason it could not be. */
function readOrderArgs(data: Decoded, commandIndex: number): OrderArgs | string {
  const call = data.commands[commandIndex]?.MoveCall;
  if (call == null) return "not a Move call";
  const abi = ABI[ORDER_ARG_CONSTRUCTOR];
  if (abi === undefined) return `${ORDER_ARG_CONSTRUCTOR} is not in the generated ABI`;
  if (call.arguments.length !== abi.params.length) {
    return (
      `${ORDER_ARG_CONSTRUCTOR} takes ${String(call.arguments.length)} arguments, not ` +
      `${String(abi.params.length)} — its signature has changed and these positions no ` +
      `longer mean what this check assumes`
    );
  }

  const out: Partial<OrderArgs> = {};
  for (const [index, name] of abi.params.entries()) {
    const enc = encodingOf(abi.types[index] ?? null);
    if (enc === undefined) {
      return `argument ${String(index)} (${name}) has type ${String(abi.types[index])}, which this cannot read`;
    }
    const value = readEncoded(pureAt(data, call.arguments, index), enc);
    if (value === "bad") return `argument ${String(index)} (${name}) is not a ${enc}`;
    if (value !== undefined) Object.assign(out, { [name]: value });
  }
  return out as OrderArgs;
}

/**
 * Every argument a command consumes, whatever kind of command it is.
 *
 * Found by scanning the command's payload for argument-shaped values rather
 * than by naming the field each command kind keeps them in. The version that
 * named fields walked `MoveCall.arguments` and nothing else, so a bracket's legs
 * — which reach the order through a `MakeMoveVec` — were invisible to it, and
 * two rounds of leg checks ran against a set that was always empty.
 *
 * A structural scan cannot be blind to a command kind it has not heard of,
 * which is the property worth having here.
 */
function argumentsOf(command: unknown): { $kind: string; [k: string]: unknown }[] {
  const found: { $kind: string; [k: string]: unknown }[] = [];
  const KINDS = new Set(["Input", "Result", "NestedResult", "GasCoin"]);
  const scan = (node: unknown, depth: number): void => {
    if (depth > 8 || node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.$kind === "string" && KINDS.has(record.$kind)) {
      found.push(record as { $kind: string });
      return;
    }
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) for (const item of value) scan(item, depth + 1);
      else scan(value, depth + 1);
    }
  };
  scan(command, 0);
  return found;
}

/**
 * Walk outward from the defining call, following every argument to whatever
 * produced it.
 *
 * This is how a value reaches the operation indirectly: the collateral for an
 * order is not an argument of `place_order_request` at all, it is an argument of
 * a constructor whose result is passed in — sometimes through a vector.
 */
function reachableFrom(
  data: Decoded,
  from: number,
  constructorPackage?: string,
): { inputs: Uint8Array[]; constructors: number[] } {
  const inputs: Uint8Array[] = [];
  const constructors: number[] = [];
  const seen = new Set<number>();

  const walk = (index: number): void => {
    if (seen.has(index)) return;
    seen.add(index);
    const command = data.commands[index];
    if (command === undefined) return;
    const call = command.MoveCall;
    // Name AND package. Matching on `module::function` alone meant a
    // constructor from any package the deployment publishes was collected as an
    // order's parameters.
    if (
      call != null &&
      `${call.module}::${call.function}` === ORDER_ARG_CONSTRUCTOR &&
      (constructorPackage === undefined ||
        normalizePackage(call.package) === constructorPackage)
    ) {
      constructors.push(index);
    }
    for (const argument of argumentsOf(command)) {
      if (argument.$kind === "Input") {
        const input = data.inputs[argument.Input as number];
        if (input?.$kind === "Pure" && input.Pure != null) inputs.push(fromBase64(input.Pure.bytes));
      } else if (argument.$kind === "Result") {
        walk(argument.Result as number);
      } else if (argument.$kind === "NestedResult") {
        walk((argument.NestedResult as [number, number])[0]);
      }
    }
  };

  walk(from);
  return { inputs, constructors };
}

// ─── The weaker tier: value search ────────────────────────────────────────────

const carriesValue = (inputs: Uint8Array[], enc: Encoding, want: Value): boolean =>
  inputs.some((b) => readEncoded(b, enc) === want);


// ─── The check ────────────────────────────────────────────────────────────────

/**
 * A vector argument whose every element is the result of one specific call.
 *
 * A bracket's legs arrive this way. The walk that collects them matched on
 * function name and stopped there, so a value of the right shape produced by
 * something else would have been read as a leg.
 */
function checkVectorOf(
  data: Decoded,
  args: readonly unknown[],
  index: number,
  intent: WriteIntent,
  entrypoint: string,
  name: string,
  wanted: string,
  deployment: Deployment,
): void {
  const argument = args[index] as { $kind?: string; Result?: number } | undefined;
  if (argument === undefined) return; // No legs at all is legitimate.
  if (argument.$kind !== "Result" || argument.Result === undefined) {
    // Anything else was previously waved through, which meant a bracket passed
    // as an Input or a nested result skipped every per-leg check while
    // `checkOrders` still walked to whatever it could reach.
    throw refuse(
      intent,
      `${entrypoint} argument ${name} must be a vector of ${wanted} results, but it is ` +
        `${String(argument.$kind ?? "not an argument")}.`,
    );
  }
  const command = data.commands[argument.Result];
  const elements = (command?.MakeMoveVec as { elements?: unknown[] } | null)?.elements;
  if (elements === undefined) {
    throw refuse(
      intent,
      `${entrypoint} argument ${name} must be a vector of ${wanted} results, but it is the ` +
        `result of ${String(command?.$kind ?? "nothing")}.`,
    );
  }
  elements.forEach((element, position) => {
    checkProducedBy(
      data, elements, position, intent, entrypoint, `${name}[${String(position)}]`, wanted,
      deployment,
    );
  });
}

/**
 * A shared object argument, held to the object the deployment names for its
 * role.
 *
 * Membership in the deployment's object set left every role interchangeable:
 * an order would take the market registry where it expects the global config,
 * or the oracle where it expects either, and pass every other check. The
 * document names these objects individually, so they are checked individually.
 */
function checkSharedObject(
  data: Decoded,
  args: readonly unknown[],
  index: number,
  intent: WriteIntent,
  entrypoint: string,
  name: string,
  role: string,
  deployment: Deployment,
): void {
  const wanted = deployment.objectFor(role);
  if (wanted === undefined) {
    throw refuse(
      intent,
      `the deployment document names no ${role}, so ${entrypoint} argument ${name} cannot be ` +
        `held to it. Refusing rather than accepting any object the deployment happens to own.`,
    );
  }
  const argument = args[index] as { $kind?: string; Input?: number } | undefined;
  const input = argument?.$kind === "Input" ? data.inputs[argument.Input as number] : undefined;
  const actual = (input?.Object as { SharedObject?: { objectId?: string } } | null)?.SharedObject
    ?.objectId;
  if (actual === undefined) {
    throw refuse(
      intent,
      `${entrypoint} argument ${name} must be the deployment's ${role}, but it is not a shared ` +
        `object at all.`,
    );
  }
  if (normalizePackage(actual) !== wanted) {
    throw refuse(
      intent,
      `${entrypoint} argument ${name} is object 0x${normalizePackage(actual)}, but the ` +
        `deployment's ${role} is 0x${wanted}. An operation reading the wrong registry or ` +
        `config is not the operation it appears to be.`,
    );
  }
}

/**
 * An argument that must be the output of one specific call.
 *
 * `senderRequest` is the case that matters: every checked call takes an
 * authority handle, and every one of them takes it from `account::request`. A
 * handle produced somewhere else is a different authority — and since a Move
 * call's internals are not PTB commands, nothing else in this file would see
 * where it came from.
 */
function checkProducedBy(
  data: Decoded,
  args: readonly unknown[],
  index: number,
  intent: WriteIntent,
  entrypoint: string,
  name: string,
  wanted: string,
  deployment: Deployment,
): void {
  const argument = args[index] as
    | { $kind?: string; Result?: number; NestedResult?: [number, number] }
    | undefined;
  const from =
    argument?.$kind === "Result"
      ? argument.Result
      : argument?.$kind === "NestedResult"
        ? argument.NestedResult?.[0]
        : undefined;
  if (from === undefined) {
    throw refuse(
      intent,
      `${entrypoint} argument ${name} must be the result of ${wanted}, but it is ` +
        `${String(argument?.$kind ?? "absent")} — not the output of any call in this ` +
        `transaction.`,
    );
  }
  const producer = data.commands[from]?.MoveCall;
  const produced = producer == null ? undefined : `${producer.module}::${producer.function}`;
  if (produced !== wanted) {
    throw refuse(
      intent,
      `${entrypoint} argument ${name} is the result of ${String(produced ?? "a non-call command")}, ` +
        `but it must come from ${wanted}.`,
    );
  }
  // The producer's own package — and where the ABI names one, THAT package.
  // Membership alone let a producer come from any package the deployment
  // publishes, which is not the same as the one the function belongs to.
  if (producer != null) {
    const from = normalizePackage(producer.package);
    const expected = deployment.byName.get(ABI[wanted]?.pkg ?? "");
    if (expected !== undefined ? from !== expected : !deployment.callable.has(from)) {
      throw refuse(
        intent,
        `${entrypoint} argument ${name} comes from ${wanted} in package 0x${from}, which is ` +
          `not where this deployment publishes it.`,
      );
    }
  }
  // And the first result of it. A call returning several values could otherwise
  // have any of them passed where the first is expected.
  const slot = argument?.$kind === "NestedResult" ? argument.NestedResult?.[1] : 0;
  if (slot !== 0) {
    throw refuse(
      intent,
      `${entrypoint} argument ${name} takes result ${String(slot)} of ${wanted}, not its first.`,
    );
  }
}

/**
 * A delegate-permission grant, held to the ceiling for the protocol it names.
 *
 * The protocol is the call's first type argument. Bounding every such call by
 * the union of the perp, predict and staking masks — which is what an earlier
 * version did — let a grant on one protocol carry a bit that had only ever been
 * requested for another.
 */
function checkProtocolMask(
  data: Decoded,
  call: { typeArguments: readonly string[]; arguments: readonly unknown[] },
  index: number,
  intent: WriteIntent,
  entrypoint: string,
  name: string,
  deployment: Deployment,
): void {
  const ceilings = intent.delegatePermissions;
  if (ceilings === undefined) {
    throw refuse(
      intent,
      `the intent does not state what this grant may confer, so ${entrypoint} argument ${name} ` +
        `cannot be checked against it.`,
    );
  }

  const type = call.typeArguments[0];
  const slot = type === undefined ? undefined : slotOf(type, deployment);
  if (slot === undefined) {
    throw refuse(
      intent,
      `${entrypoint} grants authority over ${String(type ?? "no stated protocol")}, which is ` +
        `not a protocol slot this recognises. Refusing to sign a grant whose scope it cannot ` +
        `name.`,
    );
  }

  const granted = readEncoded(pureAt(data, call.arguments, index), "u32");
  if (typeof granted !== "bigint") {
    throw refuse(intent, `${entrypoint} argument ${name} does not decode as a u32 mask.`);
  }
  const allowed = BigInt(ceilings[slot.protocol]);
  const excess = granted & ~allowed;
  if (excess !== 0n) {
    throw refuse(
      intent,
      `${entrypoint} grants ${String(granted)} on ${slot.protocol}, which includes permissions ` +
        `outside the ${String(allowed)} authorized for it (extra bits: ${String(excess)}). ` +
        `A mask asked for on one protocol does not carry to another.`,
    );
  }
}

/**
 * A delegate grant must reach the slot the contract actually reads.
 *
 * Requiring merely that SOME permission call is present accepts a transaction
 * that sets only the superseded `TradingRequest` slot — which reads as fully
 * permissioned everywhere off chain and aborts `EUnauthorized` on every order.
 * That is the same failure the backend's delegate-mask fix addresses, arriving
 * from the other side: there the account API reported an authority the chain
 * would not honour, here the agent would sign a transaction that creates one.
 *
 * So every protocol the intent authorizes anything for must be granted in its
 * enforced slot, with the mask that was asked for — not a subset of it, because
 * a delegate that silently receives less than the caller requested is a broken
 * grant, not a safe one.
 */
function assertGrantsReachEnforcedSlots(
  data: Decoded,
  companionIndices: readonly number[],
  intent: WriteIntent,
  deployment: Deployment,
): void {
  const ceilings = intent.delegatePermissions;
  if (ceilings === undefined) {
    throw refuse(intent, `the intent does not state what this grant may confer.`);
  }

  const enforced = new Map<Protocol, bigint>();
  for (const index of companionIndices) {
    const call = data.commands[index]?.MoveCall;
    if (call == null) continue;
    if (`${call.module}::${call.function}` !== "account::set_delegate_protocol_permission") continue;
    const type = call.typeArguments[0];
    const slot = type === undefined ? undefined : slotOf(type, deployment);
    if (slot === undefined || !slot.enforced) continue;
    const abi = ABI["account::set_delegate_protocol_permission"];
    const position = abi?.params.indexOf("permissions") ?? -1;
    const granted = readEncoded(pureAt(data, call.arguments, position), "u32");
    if (typeof granted !== "bigint") continue;
    // One authorization, one grant per slot. Keeping the last of several
    // observations made the verdict depend on emission order — [1, 3] passed
    // and [3, 1] did not — and quietly discarded a write that did reach the
    // chain. Whether the contract assigns or accumulates on a repeated write is
    // not something this has established, which is the reason to refuse the
    // case rather than reason about it.
    if (enforced.has(slot.protocol)) {
      throw refuse(
        intent,
        `the transaction writes the enforced ${slot.protocol} slot more than once. One ` +
          `authorization confers one grant; which of several writes survives is the contract's ` +
          `business, not something to be inferred here.`,
      );
    }
    enforced.set(slot.protocol, granted);
  }

  for (const protocol of ["perp", "predict", "staking"] as const) {
    const wanted = BigInt(ceilings[protocol]);
    if (wanted === 0n) continue;
    const granted = enforced.get(protocol);
    if (granted === undefined) {
      throw refuse(
        intent,
        `this grants ${String(wanted)} on ${protocol}, but the transaction never sets the slot ` +
          `the contract reads for it. A delegate granted only in a superseded slot reads as ` +
          `authorized everywhere off chain and aborts EUnauthorized on every action.`,
      );
    }
    if (granted !== wanted) {
      throw refuse(
        intent,
        `the enforced ${protocol} slot is granted ${String(granted)}, but ${String(wanted)} was ` +
          `authorized. A delegate that receives less than was asked for is a broken grant.`,
      );
    }
  }
}

/**
 * Compare one Move call's arguments against the intent, argument by argument.
 *
 * Positions and encodings come from the generated ABI; what each one must equal
 * comes from `BINDINGS`, keyed by the parameter's name. Every parameter the ABI
 * declares is visited — a bound one must match, a free one must carry its
 * reason, and one the bindings do not mention at all is a refusal rather than a
 * silent pass, because "not mentioned" was the state of every argument this
 * file ever failed to check.
 */
function checkArguments(
  data: Decoded,
  commandIndex: number,
  intent: WriteIntent,
  entrypoint: string,
  deployment: Deployment,
  overrides: Readonly<Record<string, Binding>> = {},
): void {
  const call = data.commands[commandIndex]?.MoveCall;
  if (call == null) throw refuse(intent, `${entrypoint} is not a Move call`);

  const abi = ABI[entrypoint];
  const bindings = BINDINGS[entrypoint];
  if (abi === undefined || bindings === undefined) {
    throw refuse(
      intent,
      `${entrypoint} has no generated ABI or no bindings, so its arguments cannot be checked. ` +
        `Run \`pnpm run generate-abi\` and give every parameter a binding.`,
    );
  }

  // `types` runs one longer than `params` when the contract takes a Clock the
  // SDK injects without naming it.
  if (call.arguments.length !== abi.types.length) {
    throw refuse(
      intent,
      `${entrypoint} takes ${String(call.arguments.length)} arguments here, but the SDK's ` +
        `generated bindings declare ${String(abi.types.length)}. The deployment and the ` +
        `installed @waterx/sdk disagree about this signature; refusing rather than reading ` +
        `arguments by positions that may no longer mean what they say.`,
    );
  }

  for (const [index, name] of abi.params.entries()) {
    const binding = overrides[name] ?? bindings[name];
    if (binding === undefined) {
      throw refuse(
        intent,
        `${entrypoint} takes an argument named ${name} that nothing in BINDINGS constrains. ` +
          `Bind it to an intent field, or declare why it has no counterpart.`,
      );
    }
    if (isFree(binding)) continue;
    if (isProtocolMask(binding)) {
      checkProtocolMask(data, call, index, intent, entrypoint, name, deployment);
      continue;
    }
    if (isProducedBy(binding)) {
      checkProducedBy(
        data, call.arguments, index, intent, entrypoint, name, binding.producedBy, deployment,
      );
      continue;
    }
    if (isSharedObject(binding)) {
      checkSharedObject(data, call.arguments, index, intent, entrypoint, name, binding.object, deployment);
      continue;
    }
    if (isVectorOf(binding)) {
      checkVectorOf(data, call.arguments, index, intent, entrypoint, name, binding.vectorOf, deployment);
      continue;
    }
    const field = binding;

    const enc = encodingOf(abi.types[index] ?? null);
    if (enc === undefined) {
      throw refuse(
        intent,
        `${entrypoint} argument ${name} is declared ${String(abi.types[index])}, which this ` +
          `cannot decode — so it cannot be held to ${field}.`,
      );
    }

    const want = authorized(intent, field);
    const got = readEncoded(pureAt(data, call.arguments, index), enc);
    const optional = enc === "optU64" || enc === "optU128";

    if (want === undefined) {
      // An optional argument the intent says nothing about must be absent —
      // that is a binding, not a skip. A required one the intent does not state
      // is a parameter this cannot check, and signing it unchecked is the whole
      // failure mode.
      if (optional && got === undefined) continue;
      throw refuse(
        intent,
        optional
          ? `${entrypoint} argument ${name} carries ${show(got)} for ${field}, but the ` +
              `intent authorized none.`
          : `the intent does not state ${field}, so ${entrypoint} argument ${name} cannot ` +
              `be checked against it. Refusing to sign a parameter nothing authorized.`,
      );
    }

    if (got === "bad") {
      throw refuse(
        intent,
        `${entrypoint} argument ${name} does not decode as ${enc}. Refusing rather than ` +
          `signing something this cannot read.`,
      );
    }
    if (got !== want) {
      throw refuse(
        intent,
        `${entrypoint} argument ${name} is ${show(got)}, but ${String(want)} was authorized.`,
      );
    }
  }
}

const refuse = (intent: WriteIntent, message: string): ExecutionPolicyError =>
  new ExecutionPolicyError(`${intent.action}: ${message}`);

/**
 * Check the orders a transaction places: the one that opens exposure, and the
 * reduce-only legs attached to it.
 *
 * Leg handling is the part two rounds got wrong. Treating a leg count as a
 * *ceiling* let an unbracketed open carry two orders nobody asked for, and
 * exempting legs from the trigger check left a take-profit free to rest at any
 * price. So the intent states the legs it authorized, by price, and the
 * transaction must carry exactly those — no ceiling, no exemption.
 */
/**
 * Where each constructor argument is answered for on the LEG path.
 *
 * The main order enumerates the ABI and refuses an argument nothing binds. The
 * leg branch was hand-written instead, so it was checked by reading it — and
 * three separate rounds found a field it did not read: the stop flag, then the
 * side, each of them exploitable on its own while every field beside it was
 * bound. This table is the same inversion applied to legs. An argument with no
 * entry is a refusal, not an omission, so a constructor that grows one stops
 * bracket signing until someone says what happens to it.
 */
export const LEG_ARG_HANDLING: Readonly<Record<string, string>> = {
  isLong: "matched as part of the leg descriptor",
  isStopOrder: "matched as part of the leg descriptor",
  triggerPrice: "matched as part of the leg descriptor",
  reduceOnly: "required true — a leg that is not reduce-only opens exposure",
  collateralAmount: "required zero — a leg commits nothing",
  size: "compared against the size the intent authorized",
  linkedPositionId: "compared against the position the intent names, or its absence",
  acceptablePrice: "required absent — a leg fills at its trigger and sets no bound",
};

function checkOrders(
  data: Decoded,
  definingIndices: readonly number[],
  intent: WriteIntent,
  deployment: Deployment,
): void {
  const constructorPackage = deployment.byName.get(ABI[ORDER_ARG_CONSTRUCTOR]?.pkg ?? "");
  for (const name of ABI[ORDER_ARG_CONSTRUCTOR]?.params ?? []) {
    if (LEG_ARG_HANDLING[name] === undefined) {
      throw refuse(
        intent,
        `an attached order carries an argument named ${name} that the leg check does not ` +
          `account for. Say what a leg may do with it, or this cannot vouch for one.`,
      );
    }
  }
  const authorizedLegs = intent.legs;
  if (authorizedLegs === undefined) {
    throw refuse(
      intent,
      `the intent does not state which reduce-only legs it authorizes. An order action must ` +
        `say, even to say none — otherwise a transaction may attach orders nobody asked for.`,
    );
  }
  // Consumed as legs are matched, so two legs cannot both satisfy one
  // authorized descriptor while a second goes unused.
  const remaining = authorizedLegs.map((leg) => ({
    triggerPrice: BigInt(leg.triggerPriceRaw),
    isStopOrder: leg.isStopOrder,
    isLong: leg.isLong,
  }));
  const describe = (leg: { triggerPrice: bigint; isStopOrder: boolean; isLong: boolean }): string =>
    `${leg.isLong ? "buy-side" : "sell-side"} ${leg.isStopOrder ? "stop" : "take-profit"} at ` +
    `${String(leg.triggerPrice)}`;
  const attachesToExisting = intent.reduceOnly === true;
  let mains = 0;
  let legs = 0;

  for (const index of definingIndices) {
    for (const ctorIndex of reachableFrom(data, index, constructorPackage).constructors) {
      const args = readOrderArgs(data, ctorIndex);
      if (typeof args === "string") {
        throw refuse(
          intent,
          `an order's parameters could not be read — ${args}. Refusing rather than signing ` +
            `something this cannot check.`,
        );
      }

      // A leg commits no collateral and only ever reduces. For an action that
      // attaches to an existing position there is no main order at all.
      const isLeg = attachesToExisting || (args.collateralAmount === 0n && args.reduceOnly);
      if (!isLeg) {
        mains += 1;
        checkMainOrder(args, intent);
        continue;
      }

      legs += 1;
      if (!args.reduceOnly) {
        throw refuse(
          intent,
          `an attached order is not reduce-only, so it opens exposure rather than limiting it.`,
        );
      }
      if (args.collateralAmount !== 0n) {
        throw refuse(
          intent,
          `an attached order commits ${String(args.collateralAmount)} of collateral. Legs commit nothing.`,
        );
      }
      if (intent.sizeRaw !== undefined && args.size !== BigInt(intent.sizeRaw)) {
        throw refuse(
          intent,
          `an attached order is sized ${String(args.size)}, but ${intent.sizeRaw} was authorized. ` +
            `The contract requires every leg to mirror the order it protects.`,
        );
      }
      // A leg fills at its trigger; a widened acceptable price here would be a
      // bound nobody set.
      if (args.acceptablePrice !== undefined) {
        throw refuse(
          intent,
          `an attached order carries an acceptable-price bound of ` +
            `${String(args.acceptablePrice)}. Legs execute at their trigger and set none.`,
        );
      }
      // Which position it protects. A bracket placed with a new position cannot
      // name one, because it does not exist yet — so absent is the only correct
      // value there, and a named one is an order aimed at something else.
      const wantPosition = attachesToExisting
        ? authorized(intent, "positionId")
        : undefined;
      if (args.linkedPositionId !== wantPosition) {
        throw refuse(
          intent,
          `an attached order names position ${show(args.linkedPositionId)}, but ` +
            `${show(wantPosition)} was authorized.`,
        );
      }

      // Price, flag AND side, matched as one descriptor. Each was left out
      // once and each was exploitable on its own: price alone let a
      // take-profit come back as a stop that fires the instant it is placed;
      // adding the flag still left the side free, and a buy-side leg on a long
      // reduces nothing, so the position is left with no protection at all.
      const at = remaining.findIndex(
        (leg) =>
          leg.triggerPrice === args.triggerPrice &&
          leg.isStopOrder === args.isStopOrder &&
          leg.isLong === args.isLong,
      );
      if (at === -1) {
        const got =
          `${args.isLong ? "buy-side" : "sell-side"} ` +
          `${args.isStopOrder ? "stop" : "take-profit"} at ${show(args.triggerPrice)}`;
        throw refuse(
          intent,
          `an attached order is a ${got}, which is not one of the ` +
            `${String(authorizedLegs.length)} legs authorized` +
            (authorizedLegs.length === 0
              ? ""
              : ` (${authorizedLegs
                  .map((leg) =>
                    describe({
                      triggerPrice: BigInt(leg.triggerPriceRaw),
                      isStopOrder: leg.isStopOrder,
                      isLong: leg.isLong,
                    }),
                  )
                  .join(", ")})`) +
            `.`,
        );
      }
      remaining.splice(at, 1);
    }
  }

  if (legs !== authorizedLegs.length) {
    throw refuse(
      intent,
      `the transaction attaches ${String(legs)} reduce-only orders, but ` +
        `${String(authorizedLegs.length)} were authorized.`,
    );
  }
  const wantMains = attachesToExisting ? 0 : definingIndices.length;
  if (mains !== wantMains) {
    throw refuse(
      intent,
      `the transaction places ${String(mains)} orders that open exposure, but ` +
        `${String(wantMains)} were authorized.`,
    );
  }
}

/** The order that actually commits collateral, held to every bound field. */
function checkMainOrder(args: OrderArgs, intent: WriteIntent): void {
  const abi = ABI[ORDER_ARG_CONSTRUCTOR];
  for (const [index, name] of (abi?.params ?? []).entries()) {
    const binding = ORDER_ARG_BINDINGS[name];
    if (binding === undefined) {
      throw refuse(
        intent,
        `the order carries an argument named ${name} that nothing constrains. Bind it, or ` +
          `declare why it has no counterpart.`,
      );
    }
    if (isFree(binding)) continue;
    // No constructor argument is a permission mask, so a subset binding here
    // would be a mistake rather than a case to handle.
    if (typeof binding !== "string") {
      throw refuse(intent, `the order's ${name} is not a value this compares`);
    }
    const want = authorized(intent, binding);
    const got = args[name as keyof OrderArgs] as Read;
    const enc = encodingOf(abi?.types[index] ?? null);
    const optional = enc === "optU64" || enc === "optU128";
    if (want === undefined) {
      if (optional && got === undefined) continue;
      throw refuse(
        intent,
        optional
          ? `the order carries ${name}=${show(got)}, but the intent authorized none.`
          : `the intent does not state ${binding}, so the order's ${name} cannot be ` +
              `checked against it.`,
      );
    }
    if (got !== want) {
      throw refuse(
        intent,
        `the order's ${name} is ${show(got)}, but ${String(want)} was authorized.`,
      );
    }
  }
}

/**
 * The shape of the transaction itself, before any question of what it means.
 *
 * Deny-by-default, and the reason it exists: every check below this one reasons
 * about Move calls and their arguments, so anything that is not a Move call —
 * or any object the signer owns being handed to one — was invisible to all of
 * them. A `TransferObjects` appended to a correct order passed every parameter
 * binding in this file.
 */
function assertShapeIsAllowed(
  data: Decoded,
  intent: WriteIntent,
  deployment: Deployment,
  extraPackages: readonly string[],
): void {
  // Every call, not only the defining one. A single Move call from an unknown
  // package can do whatever it likes with the shared objects and the sender's
  // authority — its inner calls are not PTB commands, so nothing else in this
  // file sees them. Pinning the defining call and leaving the rest open was a
  // gap, and the shape restrictions below do not close it: reaching the account
  // needs no owned object.
  const exceptions = parseExceptions(extraPackages);
  for (const command of data.commands) {
    const call = command.MoveCall;
    if (call == null) continue;
    const id = normalizePackage(call.package);
    const exception = exceptions.find((e) => exceptionCovers(e, id, call.module, call.function));
    // An exception names WHICH of the SDK's packages the address stands in for,
    // so the call can be held to that package's declared function and argument
    // count. This catches an exception pointed at the wrong package; it cannot
    // catch a package that lies about what it does, and does not claim to.
    if (exception?.sdkPackage !== undefined) {
      const key = `${exception.sdkPackage}::${call.module}::${call.function}`;
      const arities = KNOWN_FUNCTIONS.get(key);
      if (arities === undefined) {
        throw refuse(
          intent,
          `${call.module}::${call.function} in package 0x${id} is accepted only because ` +
            `WATERX_EXTRA_PACKAGES names it as ${exception.sdkPackage}, and @waterx/sdk ` +
            `${SDK_VERSION} declares no such function in that package.`,
        );
      }
      if (!arities.includes(call.arguments.length)) {
        throw refuse(
          intent,
          `${key} is declared with ${arities.join(" or ")} arguments, but this call passes ` +
            `${String(call.arguments.length)}. Whatever is at 0x${id}, it is not the function ` +
            `the exception names.`,
        );
      }
    }
    if (!deployment.callable.has(id) && exception === undefined) {
      throw refuse(
        intent,
        deployment.typeable.has(id)
          ? // The deployment's own code, but a version it has already replaced.
            // Sui keeps upgraded packages callable forever.
            `the transaction calls ${call.module}::${call.function} in package 0x${id}, which ` +
              `is a SUPERSEDED version of one this deployment publishes.`
          : `the transaction calls ${call.module}::${call.function} in package 0x${id}, which ` +
              `this deployment does not publish. If that package is legitimately part of this ` +
              `deployment and the config document has not caught up, name it in ` +
              `WATERX_EXTRA_PACKAGES — \`doctor\` prints the current list.`,
      );
    }
    for (const argument of call.typeArguments) {
      for (const referenced of argument.match(/0x[0-9a-fA-F]+/g) ?? []) {
        const type = normalizePackage(referenced);
        if (
          !deployment.typeable.has(type) &&
          !exceptions.some((e) => e.pkg === type)
        ) {
          throw refuse(
            intent,
            `${call.module}::${call.function} is parameterised with a type from package ` +
              `0x${type}, which this deployment does not publish: ${argument}`,
          );
        }
      }
    }
  }

  for (const [index, command] of data.commands.entries()) {
    const kind = command.$kind;
    if (!ALLOWED_COMMANDS.has(kind)) {
      throw refuse(
        intent,
        `the transaction contains a ${kind} command (#${String(index)}), which these ` +
          `operations never use. Refusing: a command this cannot reason about can move ` +
          `objects the rest of these checks never look at.`,
      );
    }
  }

  for (const [index, input] of data.inputs.entries()) {
    const kind =
      input.$kind === "Object"
        ? ((input.Object as { $kind?: string } | null)?.$kind ?? "Object")
        : input.$kind;
    // A shared object the deployment does not name is state nobody vouched for
    // — a registry, a config or an oracle that is not this protocol's. Two
    // earlier rounds left this open on the belief that no list of them existed;
    // the deployment document publishes them, and every shared object a live
    // transaction touches is in it or is one of Sui's own.
    if (kind === "SharedObject") {
      const id = normalizePackage(
        (input.Object as { SharedObject?: { objectId?: string } } | null)?.SharedObject?.objectId ??
          "",
      );
      if (!deployment.objects.has(id)) {
        throw refuse(
          intent,
          `input #${String(index)} is a shared object 0x${id} that this deployment does not ` +
            `publish. The state an operation reads is as much a part of what it does as the ` +
            `values it carries.`,
        );
      }
    }
    if (!ALLOWED_INPUTS.has(kind)) {
      throw refuse(
        intent,
        `input #${String(index)} is a ${kind}. These operations read only pure values and ` +
          `shared objects, so an owned object here would be the signer's own — handed to a ` +
          `call nothing else in this file constrains.`,
      );
    }
  }
}

/**
 * The one input kind that moves the signer's funds.
 *
 * `FundsWithdrawal` reserves an amount of a balance from the sender, and it is
 * how a deposit is paid. It is also the deposit amount and asset that were
 * missing from the intent — they were never argument values to find, they were
 * here.
 */
function assertFundsWithdrawal(data: Decoded, intent: WriteIntent): void {
  const withdrawals = data.inputs.filter((i) => i.$kind === "FundsWithdrawal");
  const wantAmount = intent.collateralRaw;
  const wantAsset = intent.assetType;
  const declared = intent.movesFundsIn === true;

  if (!declared) {
    if (withdrawals.length > 0) {
      throw refuse(
        intent,
        `the transaction withdraws funds from the signer's balance, which this action does ` +
          `not do. Refusing to pay out of an operation that authorized no payment.`,
      );
    }
    return;
  }

  if (withdrawals.length !== 1) {
    throw refuse(
      intent,
      `this action pays from the signer's balance exactly once, but the transaction reserves ` +
        `${String(withdrawals.length)} such withdrawals.`,
    );
  }
  if (wantAmount === undefined || wantAsset === undefined) {
    throw refuse(
      intent,
      `the intent does not state the amount and asset it pays, so the withdrawal from the ` +
        `signer's balance cannot be checked against it.`,
    );
  }

  const withdrawal = withdrawals[0] as unknown as {
    FundsWithdrawal?: {
      reservation?: { MaxAmountU64?: string };
      typeArg?: { Balance?: string };
      withdrawFrom?: { Sender?: boolean };
    };
  };
  const body = withdrawal.FundsWithdrawal;
  const reserved = body?.reservation?.MaxAmountU64;
  const balance = body?.typeArg?.Balance;

  if (body?.withdrawFrom?.Sender !== true) {
    throw refuse(intent, `the funds withdrawal does not draw from the sender's own balance.`);
  }
  if (reserved === undefined || BigInt(reserved) !== BigInt(wantAmount)) {
    throw refuse(
      intent,
      `the transaction reserves ${String(reserved ?? "an unreadable amount")} from the signer's ` +
        `balance, but ${wantAmount} was authorized.`,
    );
  }
  if (balance !== wantAsset) {
    throw refuse(
      intent,
      `the transaction pays in ${String(balance ?? "an unreadable asset")}, but ${wantAsset} ` +
        `was authorized.`,
    );
  }
}

/**
 * Where the code being called actually lives.
 *
 * `module::function` names nothing on its own — anyone may publish a package
 * exporting `trading::place_order_request`, satisfy every argument binding in
 * this file, and run a different body. Pinning the package is what makes the
 * argument checks mean anything.
 *
 * Only the DEFINING call is pinned. The surrounding oracle and rule legs are
 * not, because the deployment's published config does not currently agree with
 * the packages the backend composes with — pinning them would refuse every
 * trade. `runDoctor` reports that divergence rather than this passing over it
 * silently; the theft path those calls would need is closed by
 * `assertShapeIsAllowed` instead.
 */
function assertCodeIsTheDeployments(
  data: Decoded,
  commandIndex: number,
  intent: WriteIntent,
  entrypoint: string,
  deployment: Deployment,
): void {
  const call = data.commands[commandIndex]?.MoveCall;
  if (call == null) return;

  const id = normalizePackage(call.package);

  // Membership first: whether this code belongs to the deployment at all, and
  // whether it is a version the deployment still runs.
  if (!deployment.callable.has(id)) {
    throw refuse(
      intent,
      deployment.typeable.has(id)
        ? // Reachable only via an original id: the package is this deployment's,
          // but a superseded version of it. Sui keeps every version callable, so
          // this is a downgrade to code the deployment has already replaced.
          `${entrypoint} is called on package 0x${id}, which is a SUPERSEDED version of one ` +
            `this deployment publishes. Sui keeps upgraded packages callable forever, so this ` +
            `runs code that has already been replaced.`
        : `${entrypoint} is called on package 0x${id}, which this deployment does not publish. ` +
            `A package exporting the same module and function names is not the same code, and ` +
            `every parameter check in this file would pass against it.`,
    );
  }

  // Then identity: WHICH of the deployment's packages this entrypoint belongs
  // to is not a judgement call — the generated bindings say. Checking only that
  // the id is somewhere in the deployment would let `custody_vault::mint` be
  // served by the perp package, or any other pairing among the deployment's own
  // code that an attacker found convenient.
  const key = ABI[entrypoint]?.pkg;
  const expected = key === undefined ? undefined : deployment.byName.get(key);
  if (expected === undefined) {
    // Skipping the identity check when the manifest lacks the key would mean an
    // entrypoint silently reverts to "any of this deployment's packages will
    // do" — the check quietly stops applying at exactly the moment the
    // deployment document stops describing the deployment.
    throw refuse(
      intent,
      `${entrypoint} belongs to the ${String(key)} package, which the deployment document does ` +
        `not name, so there is nothing to pin this call to. Refusing rather than accepting any ` +
        `package the deployment happens to publish.`,
    );
  }
  if (id !== expected) {
    throw refuse(
      intent,
      `${entrypoint} belongs to the ${String(key)} package (0x${expected}), but is called here ` +
        `on 0x${id}, which is another of this deployment's packages — not the same thing as ` +
        `the right one.`,
    );
  }

  // A type argument whose role the deployment fixes must be the coin the
  // deployment says it is, not merely some coin the deployment publishes.
  for (const [position, role] of Object.entries(TYPE_ROLES[entrypoint] ?? {})) {
    const actual = call.typeArguments[Number(position)];
    // An absent type argument was skipped, which made a call that simply omits
    // one indistinguishable from one that names the right coin.
    if (!isDeploymentType(actual, role, deployment)) {
      throw refuse(
        intent,
        `${entrypoint} type argument ${position} must be this deployment's ${role.type}, but ` +
          `it is ${String(actual ?? "absent")}.`,
      );
    }
  }

  // A type argument that names a CHOICE is held to the intent, not merely to
  // the deployment. The asset a withdrawal pays out in lives here and nowhere
  // else in the transaction.
  const typeBindings = TYPE_BINDINGS[entrypoint];
  if (typeBindings !== undefined) {
    for (const [position, field] of Object.entries(typeBindings)) {
      const actual = call.typeArguments[Number(position)];
      const want = authorized(intent, field);
      if (want === undefined) {
        throw refuse(
          intent,
          `the intent does not state ${field}, so ${entrypoint}'s type argument ` +
            `${position} cannot be checked against it.`,
        );
      }
      if (actual !== want) {
        throw refuse(
          intent,
          `${entrypoint} operates on ${String(actual ?? "no stated type")}, but ${String(want)} ` +
            `was authorized.`,
        );
      }
    }
  }

  // Type arguments choose which coin, balance and protocol the call operates
  // on. A foreign type here is foreign code reached by another route.
  for (const argument of call.typeArguments) {
    for (const referenced of argument.match(/0x[0-9a-fA-F]+/g) ?? []) {
      const type = normalizePackage(referenced);
      if (!deployment.typeable.has(type)) {
        throw refuse(
          intent,
          `${entrypoint} is parameterised with a type from package 0x${type}, which this ` +
            `deployment does not publish: ${argument}`,
        );
      }
    }
  }
}

/**
 * Who pays, checked on both branches rather than one.
 *
 * Sponsored bytes naming the signer as gas owner are the backend billing us. On
 * the self-pay branch the opposite must hold — this process assembled the
 * envelope and chose the gas, so anyone else named there means the assembly did
 * not do what it is supposed to. Only the sponsored half was checked, on the
 * reasoning that we build the other ourselves; "we build it" is an argument for
 * expecting the check to pass, not for leaving it out.
 */
function assertGasIsRight(
  data: Decoded,
  intent: WriteIntent,
  signerAddress: string,
  sponsored: boolean,
): void {
  const owner = (data.gasData as { owner?: string | null }).owner;
  if (owner == null) return;
  const isSigner = normalizePackage(owner) === normalizePackage(signerAddress);
  if (sponsored && isSigner) {
    throw refuse(
      intent,
      `these bytes are presented as sponsored, but name the signer as gas owner — so the ` +
        `signer pays. Refusing to fund a transaction that was supposed to be sponsored.`,
    );
  }
  if (!sponsored && !isSigner) {
    throw refuse(
      intent,
      `this transaction pays gas from 0x${normalizePackage(owner)}, but it was assembled here ` +
        `to be paid by ${signerAddress}. Refusing to sign an envelope this process did not ` +
        `build the way it believes it did.`,
    );
  }
}

/**
 * Refuse an action whose argument layout this deployment has never been seen to
 * emit.
 *
 * Every action, exits included. An unconfirmed layout is a statement about
 * whether the arguments can be read at all, and that does not change because
 * the action happens to reduce risk — an earlier version exempted exits on that
 * reasoning and turned `EXITS` into an allowlist nobody had opted into. An exit
 * appearing here is urgent, because it means the corpus does not cover the way
 * out; the answer is to capture it or name it.
 *
 * The only lever is a list of exact entrypoints. There is no boolean, here or
 * on `AgentConfig`: one existed in both places, and closing the environment
 * form while leaving the programmatic one was the same escape a layer in.
 *
 * Separate from `assertTransactionMatches` so the signing path can apply it
 * BEFORE it forks: the self-pay branch rebuilds through a fullnode to choose
 * gas, and there is no reason to do that work for an action that is going to
 * be refused either way.
 */
/**
 * Actions that leave something behind which another action has to take away.
 *
 * Placing a resting order whose cancellation this agent cannot sign is strictly
 * worse than not placing it: the order sits on the book, and the one command
 * that would remove it refuses. Nothing else in this file would have noticed —
 * every check here is about the transaction in hand, and this hazard is about
 * the one you will need *next*.
 *
 * It came up on mainnet, where `cancel_order_request` was unconfirmed while
 * `place_order_request` was not, so the agent would happily have placed and
 * then been unable to retract. Both deployments confirm both now, so today this
 * costs nothing anywhere. It stays: capturing a cancel needs a resting order to
 * exist somewhere on the deployment, a later capture can lose it again, and
 * nothing else would notice.
 */
export const NEEDS_A_WAY_BACK: Readonly<Record<string, { entrypoint: string; because: string }>> = {
  placeLimitOrder: {
    entrypoint: "trading::cancel_order_request",
    because: "a resting order that cannot be cancelled can only be got rid of by letting it fill",
  },
  placeTpSl: {
    entrypoint: "trading::cancel_order_request",
    because:
      "a bracket that cannot be cancelled stays attached until the position it protects is closed",
  },
};

export function assertLayoutConfirmed(
  intent: WriteIntent,
  allowUnconfirmed: readonly string[],
  network: Network,
  /**
   * What the deployment has been measured to confirm — the committed record for
   * `network` unless one is given. Tests give one, so the rule is exercised
   * against a deployment with the gap it guards rather than depending on the
   * fixture happening to have that gap today.
   */
  record: NetworkCorpus = corpusFor(network),
): void {
  const unconfirmed = record.uncaptured;

  // Checked before the action's own layout, because it is the less obvious
  // failure: the action itself is fine, and what is missing is the way out.
  const wayBack = NEEDS_A_WAY_BACK[intent.action];
  if (
    wayBack !== undefined &&
    Object.hasOwn(unconfirmed, wayBack.entrypoint) &&
    !allowUnconfirmed.includes(wayBack.entrypoint)
  ) {
    throw refuse(
      intent,
      `this would rest on the book, and ${wayBack.entrypoint} — the call that takes it back — ` +
        `has never been confirmed against this deployment, so cancelling would refuse. ` +
        `${wayBack.because}. ${corroborationNote(network, wayBack.entrypoint, record)} ` +
        `${CAPTURING_LAYOUTS} Until then, accept it deliberately in ` +
        `WATERX_ALLOW_UNCONFIRMED_ABI — but do not place what you cannot retract by accident.`,
    );
  }

  const entrypoint = ACTION_RULES[intent.action]?.entrypoint;
  const why =
    entrypoint !== undefined && Object.hasOwn(unconfirmed, entrypoint)
      ? unconfirmed[entrypoint]
      : undefined;
  if (why === undefined || allowUnconfirmed.includes(entrypoint ?? "")) return;
  throw refuse(
    intent,
    `${String(entrypoint)} has never been confirmed against this deployment: ${why}. Its ` +
      `argument layout comes from the SDK alone — authoritative, but never seen from this ` +
      `deployment. ${corroborationNote(network, String(entrypoint), record)} ` +
      `${CAPTURING_LAYOUTS} Until then, name this entrypoint in WATERX_ALLOW_UNCONFIRMED_ABI to ` +
      `accept it deliberately.`,
  );
}

/**
 * Refuse a transaction that does not match the action it is presented for.
 *
 * Called immediately before the signature, on the final bytes, so it depends on
 * nothing upstream having behaved.
 */
export function assertTransactionMatches(
  txBytes: string,
  intent: WriteIntent,
  signerAddress: string,
  context: VerificationContext,
): void {
  let data: Decoded;
  let entrypoints: string[];
  let sender: string | undefined;
  try {
    data = Transaction.from(fromBase64(txBytes)).getData();
    entrypoints = entrypointsOf(txBytes);
    sender = senderOf(txBytes);
  } catch (cause) {
    // Undecodable bytes are not "probably fine".
    throw refuse(
      intent,
      `the transaction could not be decoded, so nothing about it can be checked: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  // Shape first: everything below reasons about Move calls and their
  // arguments, so a command or input those checks cannot see must not exist.
  assertShapeIsAllowed(data, intent, context.deployment, context.extraPackages ?? []);
  assertFundsWithdrawal(data, intent);

  // Who signs before who pays: a transaction sent from another address is not
  // ours to reason about at all, and saying so first gives the clearer error.
  if (sender !== undefined && sender.toLowerCase() !== signerAddress.toLowerCase()) {
    throw refuse(
      intent,
      `the transaction is sent from ${sender}, but this process signs as ${signerAddress}. ` +
        `Refusing to sign for another address.`,
    );
  }

  assertLayoutConfirmed(intent, context.allowUnconfirmed ?? [], context.network);

  assertGasIsRight(data, intent, signerAddress, context.sponsored);

  const rule = ACTION_RULES[intent.action];
  if (rule === undefined) {
    // An unmapped action cannot be checked, and an unverifiable signature is
    // not a lesser problem than a wrong one.
    throw refuse(
      intent,
      `no defining entrypoint is recorded for this action, so the transaction cannot be ` +
        `checked against it. Add it to ACTION_RULES.`,
    );
  }
  const required = rule.entrypoint;
  const present = new Set(entrypoints);

  // 1. It must actually do the thing it claims.
  if (!present.has(required)) {
    throw refuse(
      intent,
      `the transaction does not call ${required}, so it is not ${intent.action}. It calls ` +
        `${entrypoints.filter((e) => SENSITIVE.has(e)).join(", ") || "no known entrypoint"}.`,
    );
  }

  // 2. And nothing else's thing. This is what stops a permit for a cheap action
  //    — one that clears every ceiling because it commits nothing — carrying a
  //    transaction that opens a position.
  const companions = rule.companions ?? [];
  const companionNames = companions.map((c) => c.entrypoint);
  const foreign = [...present].filter(
    (e) => SENSITIVE.has(e) && e !== required && !companionNames.includes(e),
  );
  if (foreign.length > 0) {
    throw refuse(
      intent,
      `the transaction also calls ${foreign.join(", ")}, which is not part of ${intent.action}. ` +
        `One authorization covers one operation.`,
    );
  }

  // 3. EVERY occurrence of the defining call, not just the first. A PTB can
  //    contain two operations: one matching the permit exactly and a second for
  //    a different account, market or amount, both executing under one
  //    signature.
  const definingIndices = data.commands
    .map((c, i) => [c, i] as const)
    .filter(
      ([c]) =>
        c.$kind === "MoveCall" &&
        c.MoveCall != null &&
        `${c.MoveCall.module}::${c.MoveCall.function}` === required,
    )
    .map(([, i]) => i);

  if (rule.multiplicity === "one" && definingIndices.length !== 1) {
    throw refuse(
      intent,
      `the transaction performs it ${String(definingIndices.length)} times. One authorization ` +
        `covers one operation.`,
    );
  }

  // 4. Every argument of every occurrence, and the code it runs.
  for (const index of definingIndices) {
    assertCodeIsTheDeployments(data, index, intent, required, context.deployment);
    checkArguments(data, index, intent, required, context.deployment, rule.overrides);
  }

  // 5. The calls that ride WITH this action — a delegate grant's authority is
  //    conferred by one of these, not by the call that names the delegate.
  const companionIndices = data.commands
    .map((c, i) => [c, i] as const)
    .filter(([c]) => {
      const call = c.MoveCall;
      return call != null && companionNames.includes(`${call.module}::${call.function}`);
    })
    .map(([, i]) => i);

  // Each required companion on its own terms. A withdrawal that reaches the
  // queue without going through a route has an unbound asset; a delegate grant
  // that never sets a protocol permission confers its authority somewhere this
  // cannot see. Neither is covered by "at least one companion is present".
  for (const companion of companions) {
    if (!companion.required) continue;
    if (!present.has(companion.entrypoint)) {
      throw refuse(
        intent,
        `the transaction does not call ${companion.entrypoint}, which ${intent.action} is not ` +
          `${intent.action} without — the parameters bound to it would go unchecked.`,
      );
    }
  }
  for (const index of companionIndices) {
    const call = data.commands[index]?.MoveCall;
    if (call == null) continue;
    const entrypoint = `${call.module}::${call.function}`;
    assertCodeIsTheDeployments(data, index, intent, entrypoint, context.deployment);
    checkArguments(data, index, intent, entrypoint, context.deployment, rule.overrides);
  }

  // 6. A grant has to land where the contract will look for it.
  if (rule.grantsProtocolPermissions === true) {
    assertGrantsReachEnforcedSlots(data, companionIndices, intent, context.deployment);
  }

  // 7. Order-shaped actions carry their real parameters in a constructor.
  if (required === "trading::place_order_request") {
    checkOrders(data, definingIndices, intent, context.deployment);
  }
}
