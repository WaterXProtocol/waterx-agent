/**
 * What this process may sign, and on whose say-so.
 *
 * Three modes, and the reason there is a scoped one at all: on chain a perp
 * delegate's permissions are **capability bits** — may it open a position, may
 * it cancel an order — not amounts. Nothing on the perp side enforces a
 * per-order or per-hour ceiling server-side (the predict line's risk profile has
 * no perp equivalent), so a delegate with `PERM_OPEN_POSITION` can commit the
 * account's whole collateral in one order. The bound has to be written down
 * somewhere, and until the backend grows one, here is the only place left.
 *
 * The gate is deliberately not the same object as the signer. `authorize()`
 * decides and issues a permit; `TxExecutor.execute()` consumes one per
 * signature, so a write path that forgot to authorize would find no permit and
 * refuse rather than quietly sign.
 *
 * That holds for paths that go through `execute()`, which is every one this
 * package exposes — and not for a caller that reaches `SignerProvider`
 * directly. There is no permit check at the signer; there is nothing there to
 * check one. So this makes an unauthorized signature impossible **by mistake**,
 * which is what a policy object can do from inside the process it is bounding.
 * See the threat model in `chain/verify.ts` for what that is and is not worth.
 */
import { createHash } from "node:crypto";

import { EXITS } from "./chain/verify.ts";
import { ExecutionPolicyError } from "./errors.ts";

export type PolicyMode = "read-only" | "interactive" | "delegated-auto";

/**
 * Ceilings an operator wrote down. Every ceiling that applies to an allowed
 * action is **mandatory**: an optional ceiling is one somebody forgets, and a
 * forgotten ceiling in an auto-approving policy is an unbounded one.
 */
export interface PolicyScope {
  /** Required. "Any account" is not a scope. */
  accounts: string[];
  /** Optional allowlist of tickers. Absent means every listed market. */
  markets?: string[];
  /** Optional. Absent means both directions. */
  sides?: ("long" | "short")[];
  /** Required. Display USD per opening order. */
  maxCollateralPerOrder: number;
  /**
   * Required. Display USD committed to OPEN positions at any one moment,
   * counting orders already sent that no keeper has filled yet.
   *
   * The ceiling people mean when they say "this agent may risk at most $X of
   * my money". `maxCumulativeCollateral` bounds it too, arithmetically — what
   * is open can never exceed what was ever committed — but it is a bound that
   * decays: every close-and-reopen spends headroom without changing what is at
   * risk, so a strategy that turns over stops trading long before it has taken
   * the risk anyone agreed to.
   */
  maxOpenCollateral: number;
  /**
   * Required. Display USD summed across this installation's life, including
   * across restarts — see `src/agent/spend.ts`.
   *
   * Not the same job as `maxOpenCollateral`, and not replaceable by it: a
   * concurrent ceiling alone permits unbounded churn. Open, close, repeat, and
   * exposure never breaches $X while fees, slippage and funding bleed the
   * account down. This is the only ceiling that bounds how much capital is put
   * at risk in total, so it belongs well above the concurrent one.
   */
  maxCumulativeCollateral: number;
  /** Required. */
  maxLeverage: number;
  /** Required. Rejects a request that would accept more slippage than this. */
  maxSlippagePercent: number;
  /** Required. ISO-8601 instant after which nothing is signed. */
  notAfter: string;
}

/** What a caller is about to do, in the units a human wrote the scope in. */
/**
 * Actions that move funds out or change who may act on the account.
 *
 * Owner-only on chain, so a delegate key cannot perform them whatever its mask
 * says — which is the entire reason `delegated-auto` is a bounded risk. Named
 * here so the policy refuses them under an unattended mode regardless of which
 * key is loaded: the on-chain guarantee only holds while the key IS a delegate,
 * and this makes the safety argument independent of that assumption.
 */
const OWNER_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  "withdraw",
  "deposit",
  "createAccount",
  "addDelegate",
  "removeDelegate",
  "removeAllDelegates",
]);

/**
 * One reduce-only leg, exactly as the transaction must carry it.
 *
 * Both fields, because they are independent: the price says where the leg
 * rests and the flag says which direction it triggers from.
 */
export interface AuthorizedLeg {
  /** Trigger price in 1e9-scaled units. */
  triggerPriceRaw: string;
  /** `true` for the stop-loss leg, `false` for the take-profit. */
  isStopOrder: boolean;
  /**
   * The side the leg must take: the OPPOSITE of the position it protects.
   *
   * Carried per leg rather than read from `side`, because `side` describes the
   * main order and a bracket has none when it attaches to a position that
   * already exists. Left unbound, a leg protecting a long could come back
   * buy-side — reduce-only, so it opens nothing, but it protects nothing
   * either, and the position it was placed for is left uncovered.
   */
  isLong: boolean;
}

export interface WriteIntent {
  /** Stable name for the operation, e.g. `openLong`. Used in refusals and breadcrumbs. */
  action: string;
  accountId: string;
  /**
   * Whether this intent increases exposure. Only these consume the collateral
   * ceilings — refusing to let a bounded agent *close* a position would turn a
   * risk limit into a way to trap one open.
   */
  increasesExposure: boolean;
  ticker?: string;
  side?: "long" | "short";
  /** Display USD committed by this action. */
  collateral?: number;
  /**
   * The same amount in the raw base units the transaction will carry.
   *
   * Carried alongside the display figure because the ceilings compare the one a
   * human wrote and the verifier searches for the one the chain sees. Deriving
   * it inside the verifier would mean re-implementing the scale conversion in a
   * second place, where the two could drift apart.
   */
  collateralRaw?: string;
  leverage?: number;
  slippagePercent?: number;
  /**
   * Whether this action attaches to an existing position rather than opening
   * exposure.
   *
   * `placeTpSl` shares an entrypoint, an account and a market with an opening
   * order — `reduce_only` is the only thing that separates them on chain, so it
   * is the only thing that can separate them here.
   */
  reduceOnly?: boolean;
  /** Position size in 1e9-scaled units, as the transaction will carry it. */
  sizeRaw?: string;
  /** Trigger price in 1e9-scaled units, for an order that rests. */
  triggerPriceRaw?: string;
  /** The delegate an authority change names. */
  delegateAddress?: string;
  /** The position a close, reduce, margin change or attached order acts on. */
  positionId?: number;
  /** The order a cancel or update acts on. */
  orderId?: number;
  /**
   * The worst fill the order may take, in 1e9-scaled units.
   *
   * This is what `slippagePercent` becomes by the time it reaches the chain.
   * The percentage itself appears nowhere in the transaction, so binding it was
   * impossible and the ceiling on it was, for four rounds, unenforceable: a
   * process could widen the bound to anything and every check still passed.
   */
  acceptablePriceRaw?: string;
  /**
   * Whether the order that commits collateral is a STOP rather than a limit.
   *
   * The two are opposite instructions at the same price: a long limit at 100
   * fills at or below 100, a long stop at 100 fills at or above it. The flag is
   * the only thing separating them in the transaction, and it is a caller field
   * — so leaving it unbound let the backend return the other order entirely.
   * Worse, `assertNotCrossing` only lets a limit rest at a non-crossing price,
   * which is exactly the price at which the same order read as a stop fills
   * immediately: flipping the flag turned a resting order into a market fill
   * and voided the one local guard that was supposed to prevent that.
   */
  isStopOrder?: boolean;
  /**
   * Every reduce-only leg this authorizes. Empty means none, which is different
   * from saying nothing.
   *
   * A DESCRIPTOR per leg, not a price: the count alone let a bracket rest at a
   * price nobody chose, a price alone let a transaction attach more legs than
   * were asked for — and a price WITHOUT its stop flag let the backend swap a
   * take-profit for a stop at the same price, which triggers on the opposite
   * side and so closes the position the moment it is placed.
   */
  legs?: readonly AuthorizedLeg[];
  /**
   * Whether this action pays out of the signer's own balance.
   *
   * Stated rather than inferred, so a transaction that reserves a withdrawal
   * under an action that never pays is refused. The amount and asset are
   * `collateralRaw` and `assetType`.
   */
  movesFundsIn?: boolean;
  /** The fully-qualified Move coin type a deposit pays in. */
  assetType?: string;
  /** Where a withdrawal is paid. A real contract argument, not something it derives. */
  recipient?: string;
  /** The human label on a new account or a delegate grant. */
  alias?: string;
  /**
   * What a delegate grant may confer, PER PROTOCOL.
   *
   * Kept apart rather than merged into one ceiling. Which protocol a grant
   * applies to is the call's Move type argument, so a single union bound let a
   * perp grant carry a bit that had only ever been asked for on staking.
   */
  delegatePermissions?: { perp: number; predict: number; staking: number };
  /**
   * The mask `account::add_delegate` itself carries, as distinct from the
   * per-protocol grants that follow it. Observed as zero in every real grant.
   */
  delegateBasePermissions?: number;
  /**
   * When a delegate grant lapses, in epoch milliseconds; absent means never.
   *
   * Bound because an authority meant to be short-lived can otherwise be made
   * permanent without changing anything else about the transaction.
   */
  delegateExpiresAtMs?: number;
  /** The redeem request a WLP burn cancellation names. */
  requestId?: number;
  /** A token amount that is not collateral — WLP being redeemed. */
  amountRaw?: string;
}

/**
 * Fields that shape the DECISION but have no counterpart in the transaction.
 *
 * The complement — what IS bound — is derived from the argument specifications
 * in `verify.ts` rather than listed here. A previous round kept both as hand
 * written arrays, which let the "completeness" test they fed pass while a field
 * was declared bindable and bound by nothing.
 */
export const UNBINDABLE_INTENT_FIELDS = [
  "action",
  "increasesExposure",
  // Display figures the ceilings compare; the transaction carries the raw forms.
  "collateral",
  "leverage",
  // Reaches the chain as `acceptablePriceRaw`, which IS bound. The percentage
  // itself never appears in a transaction, so it is enforced through the value
  // derived from it rather than directly.
  "slippagePercent",
] as const;

/**
 * Proof that a **specific** intent was authorized. Consumed by exactly one
 * signature.
 *
 * The fingerprint is the load-bearing part. A permit that only proved "some
 * authorization happened" would be fungible: a caller could authorize a
 * `cancelOrder`, which passes every ceiling trivially, and spend that permit on
 * an `openLong` for the account's whole balance. Binding it to the intent means
 * a permit buys exactly the action it was issued for and nothing else.
 *
 * It cannot bind the transaction BYTES — those do not exist until the backend
 * has built them, which is after authorization. What it can do, and does, is
 * ensure the intent that was checked is the intent that was built from.
 */
export interface Permit {
  readonly action: string;
  /** Digest of the authorized intent. Opaque; compared, never parsed. */
  readonly fingerprint: string;
  /**
   * Digest of the transaction bytes this permit was bound to, set by
   * {@link PolicyGate.bind} once the backend has built them.
   *
   * Binding the intent alone was not enough: it proved that the request SHAPE
   * was authorized, and said nothing about which bytes got signed. A permit for
   * a `closePosition` could still be presented alongside arbitrary sponsored
   * bytes, and the executor would sign them. The bytes do not exist at
   * authorization time, so the binding happens between build and signature —
   * the one moment both are in hand.
   */
  boundTo?: string;
}

/**
 * A stable digest of everything about an intent that the ceilings look at.
 *
 * Deliberately includes the fields a scope bounds — an amount changed between
 * authorization and submission must invalidate the permit, or the ceiling only
 * ever constrained a number nobody used.
 */
export function fingerprintIntent(intent: WriteIntent): string {
  // EVERY field, sorted by key — not a hand-picked list.
  //
  // The list this replaces named ten fields and was written before most of the
  // intent existed, so `recipient`, `assetType`, `positionId`, `orderId`, the
  // delegate permissions and half a dozen others were absent from it: a permit
  // issued for one intent matched another that differed only in those. The
  // permit is also bound to the transaction's bytes, and the bytes are checked
  // against the intent field by field, so the three together left no gap in
  // practice — but "a permit is not transferable between intents" was not true
  // as stated, and a defence that is only correct because two other defences
  // cover it is one bad refactor from being wrong.
  //
  // Deriving it removes the drift entirely: a field added to `WriteIntent` is
  // in the fingerprint the moment it is set, with nothing to remember.
  const entries = Object.entries(intent as unknown as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries, (_key, value) =>
    // Bigints do not survive JSON, and an intent may carry one by mistake.
    typeof value === "bigint" ? `${value.toString()}n` : value,
  );
}

export interface AuthorizeOptions {
  /** Required under `interactive`. Absent means "do not sign". */
  confirm?: boolean;
  /**
   * Display USD already committed to open positions and to orders still in
   * flight, MEASURED by the caller.
   *
   * Required under `delegated-auto` for anything that commits collateral: the
   * gate is synchronous and reads nothing, so the number has to arrive from
   * somebody who looked. Absent, the concurrent ceiling refuses rather than
   * assuming zero — an unchecked ceiling is not a ceiling.
   */
  openCollateral?: number;
}

/**
 * The running total, and where to write the next entry.
 *
 * Kept outside the gate so the gate stays synchronous and free of I/O — the
 * same reason `adoptAccount` takes its effects. `spent` is seeded from the
 * ledger on disk; `record` appends. A gate built without one starts from zero,
 * which is only correct for a mode that has no cumulative ceiling.
 */
export interface SpendMeter {
  spent: number;
  record?: (entry: { action: string; accountId: string; collateral: number }) => void;
}

export class PolicyGate {
  private readonly permits = new Set<Permit>();
  private cumulativeCollateral: number;
  private readonly meter: SpendMeter | undefined;

  constructor(
    readonly mode: PolicyMode,
    readonly scope?: PolicyScope,
    /**
     * Whether the loaded key is a delegate rather than the account owner.
     *
     * Must be established by COMPARING the signer's address to the configured
     * owner, not by the owner merely being set: pointing `WATERX_OWNER_ADDRESS`
     * at the signer's own address satisfies "is it configured?" while leaving an
     * owner key in an unattended process.
     */
    signingAsDelegate = false,
    /**
     * What has already been committed, and where to write what this gate
     * commits. Without it the cumulative ceiling starts from zero every time a
     * process starts, which is what it used to do — and a runner that crashes
     * and restarts is a thing this package is built to survive.
     */
    meter?: SpendMeter,
  ) {
    this.cumulativeCollateral = meter?.spent ?? 0;
    this.meter = meter;
    if (mode === "delegated-auto") {
      if (scope === undefined) {
        throw new ExecutionPolicyError(
          "delegated-auto needs a scope. Signing unattended with no ceilings is not a policy.",
        );
      }
      assertScopeComplete(scope);
      if (!signingAsDelegate) {
        throw new ExecutionPolicyError(
          `delegated-auto is signing with the account OWNER's key. The bound on unattended ` +
            `trading is that a delegate cannot withdraw or grant authority — an owner key has ` +
            `both, so the scope file would be the only thing between a bug and the balance. ` +
            `Load a delegate key and set WATERX_OWNER_ADDRESS, or use "interactive".`,
        );
      }
    }
  }

  /** Display USD committed so far under this gate. */
  get spentCollateral(): number {
    return this.cumulativeCollateral;
  }

  /**
   * Decide, then issue a permit. Throws `ExecutionPolicyError` on refusal —
   * before any request is built, so an out-of-scope order costs nothing.
   */
  authorize(intent: WriteIntent, options: AuthorizeOptions = {}): Permit {
    // Before any mode check: a NaN or a negative slips through every `>`
    // comparison below (NaN > x is false for all x), so an unvalidated amount
    // does not merely bypass one ceiling — it poisons the running total and
    // silently disables the cumulative ceiling for the rest of the process.
    assertMeasurable(intent);

    switch (this.mode) {
      case "read-only":
        throw new ExecutionPolicyError(
          `Policy is "read-only"; refusing ${intent.action}. ` +
            `Set WATERX_EXECUTION_POLICY=interactive to enable confirmed writes.`,
        );
      case "interactive":
        if (options.confirm !== true) {
          throw new ExecutionPolicyError(
            `Policy is "interactive"; ${intent.action} needs an explicit \`confirm: true\` ` +
              `(\`--yes\` on the CLI).`,
          );
        }
        break;
      case "delegated-auto":
        // Belt and braces, and the braces matter: the "a delegate cannot drain
        // the account" argument holds only while the loaded key is a delegate.
        // Nothing in a scope file can establish that, so an unattended process
        // refuses these outright rather than inheriting a guarantee it cannot
        // check.
        if (OWNER_ONLY_ACTIONS.has(intent.action)) {
          throw new ExecutionPolicyError(
            `${intent.action} moves funds or changes account authority, and is refused under ` +
              `delegated-auto. Run it deliberately under "interactive" with the owner key.`,
          );
        }
        this.assertInScope(intent, options);
        break;
    }

    if (!EXITS.has(intent.action) && intent.collateral !== undefined) {
      this.cumulativeCollateral += intent.collateral;
      // Written where it is counted, so a crash between here and the signature
      // leaves the budget SPENT rather than free. Over-counting a ceiling is
      // the safe direction; the other one hands a restarted process room it
      // has already used.
      this.meter?.record?.({
        action: intent.action,
        accountId: intent.accountId,
        collateral: intent.collateral,
      });
    }
    const permit: Permit = { action: intent.action, fingerprint: fingerprintIntent(intent) };
    this.permits.add(permit);
    return permit;
  }

  /**
   * Spend a permit. Throws if it was not issued here or has already been used,
   * so a replayed or fabricated permit buys nothing.
   */
  /**
   * Authorize an intent, build the transaction for it, and bind the two —
   * without the caller ever handling the bytes in between.
   *
   * This shape exists because a public `bind(permit, bytes)` is self-certifying:
   * the caller says "I vouch for these bytes" and the gate believes it, so
   * arbitrary bytes reach the signer with a valid permit. Handing the gate a
   * *builder* instead of a *result* removes the seam. There is no moment when a
   * caller holds an unbound permit and a transaction it could substitute.
   *
   * **What this does and does not bound.** It bounds an authorized caller: the
   * bytes signed are the ones the builder produced inside the authorized scope,
   * and the permit is spendable on nothing else. It is NOT a sandbox — code
   * running in this process can reach the keypair directly and sign whatever it
   * likes. The gate exists to make mistakes and out-of-scope requests impossible,
   * not to contain an attacker who already has execution here.
   *
   * Moving the key out does not contain one either, and this comment used to
   * offer it as though it did. `SIGNER_PROTOCOL` carries opaque bytes: the
   * child parses no transaction and applies no policy, so an attacker who
   * cannot read the key can still ask for a signature over anything. It bounds
   * what they take away, not what they do while they are there. Containing them
   * would mean the verifier running where the key does — see the threat model
   * in `chain/verify.ts`.
   */
  async authorizeAndBuild<T extends { txBytes: string }>(
    intent: WriteIntent,
    options: AuthorizeOptions,
    build: () => Promise<T>,
  ): Promise<{ built: T; permit: Permit }> {
    const permit = this.authorize(intent, options);
    let built: T;
    try {
      built = await build();
    } catch (error) {
      // The commitment is counted at authorize, before this could be known. A
      // build that threw returned no bytes, so nothing was signed and nothing
      // was sent — releasing it is not optimism about an unknown outcome, it
      // is the outcome. Left counted, a backend that is refusing builds would
      // spend the whole budget on transactions that never existed, and now
      // that the ledger persists, a restart would no longer clear it.
      this.#release(intent, permit);
      throw error;
    }
    this.#bind(permit, built.txBytes);
    return { built, permit };
  }

  /**
   * Give back what an intent committed, because it demonstrably did not happen.
   *
   * The ledger is append-only, so this appends the reversal rather than
   * editing the entry away: "committed $50, released $50" is the honest
   * history, and an append cannot lose a concurrent writer's line.
   *
   * Deliberately narrow. It is called only where the failure proves no bytes
   * existed. Once something is signed, an unknown outcome must stay counted —
   * over-counting a ceiling is the safe direction, and under-counting hands a
   * restarted process room it has already used.
   */
  #release(intent: WriteIntent, permit: Permit): void {
    this.permits.delete(permit);
    // Exactly the condition that counted it, so the two can never diverge.
    if (EXITS.has(intent.action) || intent.collateral === undefined) return;
    this.cumulativeCollateral -= intent.collateral;
    this.meter?.record?.({
      action: `${intent.action}:released`,
      accountId: intent.accountId,
      collateral: -intent.collateral,
    });
  }

  /**
   * Tie a permit to the exact bytes built from its intent.
   *
   * A `#` private, not a TypeScript `private`: the latter is erased at compile
   * time and the method stays reachable on the prototype, which is no barrier
   * at all to the caller this is meant to exclude. See {@link authorizeAndBuild}.
   */
  #bind(permit: Permit, txBytes: string): void {
    if (!this.permits.has(permit)) {
      throw new ExecutionPolicyError(
        `Cannot bind an unknown permit for ${permit.action}.`,
      );
    }
    if (permit.boundTo !== undefined) {
      throw new ExecutionPolicyError(
        `The permit for ${permit.action} is already bound to a transaction. ` +
          `One authorization builds one transaction.`,
      );
    }
    (permit as { boundTo?: string }).boundTo = digestOf(txBytes);
  }

  consume(permit: Permit, intent: WriteIntent, txBytes: string): void {
    if (!this.permits.has(permit)) {
      throw new ExecutionPolicyError(
        `No unspent permit for ${intent.action}. Every write this package signs is authorized ` +
          `by the policy gate first.`,
      );
    }
    // All checks BEFORE the permit is spent: a mismatch must leave it available
    // to the transaction it was actually issued for.
    const presented = fingerprintIntent(intent);
    if (permit.fingerprint !== presented) {
      throw new ExecutionPolicyError(
        `Permit mismatch: it authorizes ${permit.action}, but is being spent on ${intent.action} ` +
          `with different parameters. A permit is not transferable between intents.`,
      );
    }
    if (permit.boundTo === undefined) {
      throw new ExecutionPolicyError(
        `The permit for ${intent.action} was never bound to a transaction. Nothing vouches for ` +
          `these bytes, so they will not be signed.`,
      );
    }
    if (permit.boundTo !== digestOf(txBytes)) {
      throw new ExecutionPolicyError(
        `Permit mismatch: it is bound to different transaction bytes than the ones presented. ` +
          `An authorization covers the transaction it was built for and no other.`,
      );
    }
    this.permits.delete(permit);
  }

  private assertInScope(intent: WriteIntent, options: AuthorizeOptions): void {
    // `scope` is non-undefined for this mode — the constructor refuses otherwise.
    const scope = this.scope as PolicyScope;
    // The annotation is on the binding, not only on the arrow. Control-flow
    // analysis narrows after a `never` call only when the *variable* is typed
    // that way, and without it every check that refuses a value still has to
    // prove that value usable on the next line.
    const refuse: (reason: string) => never = (reason) => {
      throw new ExecutionPolicyError(`Out of scope: ${intent.action} — ${reason}.`);
    };

    const expiry = Date.parse(scope.notAfter);
    if (Date.now() > expiry) {
      refuse(`the delegation scope ended at ${scope.notAfter}`);
    }
    if (!scope.accounts.includes(intent.accountId)) {
      refuse(`account ${intent.accountId} is not in the scope's account list`);
    }
    if (intent.ticker !== undefined && scope.markets !== undefined && !scope.markets.includes(intent.ticker)) {
      refuse(`market ${intent.ticker} is not in the scope's market list (${scope.markets.join(", ")})`);
    }
    if (intent.side !== undefined && scope.sides !== undefined && !scope.sides.includes(intent.side)) {
      refuse(`${intent.side} is not an allowed side (${scope.sides.join(", ")})`);
    }
    if (intent.slippagePercent !== undefined && intent.slippagePercent > scope.maxSlippagePercent) {
      refuse(
        `slippage ${String(intent.slippagePercent)}% exceeds the ceiling ${String(scope.maxSlippagePercent)}%`,
      );
    }

    // Only exposure-increasing actions are metered. Closing, reducing, adding
    // margin and cancelling stay available to a bounded agent by design.
    //
    // BOTH have to agree. `increasesExposure` is supplied by the caller and
    // bound to nothing in the transaction, so on its own it was a single
    // unverifiable boolean that skipped every ceiling below. The action name is
    // bound — a transaction has to call that action's defining entrypoint to be
    // accepted as it — so an action outside the exit set is metered whatever
    // the flag says. This can only add metering, never remove it.
    if (!intent.increasesExposure && EXITS.has(intent.action)) return;

    if (intent.leverage !== undefined && intent.leverage > scope.maxLeverage) {
      refuse(`leverage ${String(intent.leverage)}x exceeds the ceiling ${String(scope.maxLeverage)}x`);
    }
    if (intent.collateral !== undefined) {
      if (intent.collateral > scope.maxCollateralPerOrder) {
        refuse(
          `collateral ${String(intent.collateral)} exceeds the per-order ceiling ` +
            `${String(scope.maxCollateralPerOrder)}`,
        );
      }
      // What is open right now. The gate reads nothing, so this arrives
      // measured; absent, the ceiling cannot be checked and the only honest
      // answer is no. A NaN measurement would pass every comparison below, so
      // it is refused by the same rule as a NaN intent.
      const open = options.openCollateral;
      if (open === undefined) {
        refuse(
          `the concurrent ceiling (${String(scope.maxOpenCollateral)}) cannot be checked without a ` +
            `measurement of what is already open, and none was supplied`,
        );
      }
      if (!Number.isFinite(open) || open < 0) {
        refuse(`the measurement of open collateral (${String(open)}) is not a usable number`);
      }
      const projectedOpen = open + intent.collateral;
      if (projectedOpen > scope.maxOpenCollateral) {
        refuse(
          `open collateral would reach ${String(projectedOpen)}, past the ceiling ` +
            `${String(scope.maxOpenCollateral)} (${String(open)} already open)`,
        );
      }

      const projected = this.cumulativeCollateral + intent.collateral;
      if (projected > scope.maxCumulativeCollateral) {
        refuse(
          `cumulative collateral would reach ${String(projected)}, past the ceiling ` +
            `${String(scope.maxCumulativeCollateral)} (${String(this.cumulativeCollateral)} already committed)`,
        );
      }
    }
  }
}

/**
 * Every number a ceiling will compare must be a finite, non-negative real.
 *
 * `NaN` is the dangerous one: every comparison against it is false, so an
 * unchecked `NaN` collateral passes each ceiling AND makes `cumulativeCollateral`
 * NaN, after which the cumulative ceiling can never fire again. It arrives
 * easily — `Number(undefined)`, `Number("10 USDC")`, a JSON field that came back
 * as a string.
 */
function assertMeasurable(intent: WriteIntent): void {
  for (const [name, value] of [
    ["collateral", intent.collateral],
    ["leverage", intent.leverage],
    ["slippagePercent", intent.slippagePercent],
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new ExecutionPolicyError(
        `${intent.action}: ${name} is ${String(value)}, which no ceiling can bound. ` +
          `Refusing rather than admitting an unmeasurable amount.`,
      );
    }
  }
}

/**
 * Refuse an incomplete scope at construction rather than at the first trigger.
 * A policy that only reveals its gaps under load is not a policy.
 */
function assertScopeComplete(scope: PolicyScope): void {
  const missing: string[] = [];
  if (scope.accounts.length === 0) missing.push("accounts (non-empty)");
  for (const [key, value] of [
    ["maxCollateralPerOrder", scope.maxCollateralPerOrder],
    ["maxOpenCollateral", scope.maxOpenCollateral],
    ["maxCumulativeCollateral", scope.maxCumulativeCollateral],
    ["maxLeverage", scope.maxLeverage],
    ["maxSlippagePercent", scope.maxSlippagePercent],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      missing.push(`${key} (a positive number)`);
    }
  }
  if (typeof scope.notAfter !== "string" || Number.isNaN(Date.parse(scope.notAfter))) {
    missing.push("notAfter (an ISO-8601 instant)");
  }
  if (missing.length > 0) {
    throw new ExecutionPolicyError(
      `delegated-auto scope is incomplete: ${missing.join(", ")}. ` +
        `Every ceiling is mandatory — an optional one is one somebody forgets.`,
    );
  }
  if (scope.maxCumulativeCollateral < scope.maxCollateralPerOrder) {
    throw new ExecutionPolicyError(
      `delegated-auto scope: maxCumulativeCollateral (${String(scope.maxCumulativeCollateral)}) is below ` +
        `maxCollateralPerOrder (${String(scope.maxCollateralPerOrder)}), so no order could ever be placed.`,
    );
  }
}

/** Content digest of the base64 transaction bytes. Compared, never reversed. */
const digestOf = (txBytes: string): string =>
  createHash("sha256").update(txBytes).digest("hex");

/** Ranked weakest-first, so `--policy` can be checked for "narrows only". */
/**
 * The three modes, in rank order: each may sign everything the one before it
 * may, and more.
 *
 * Exported because choosing between them is a decision a person makes, and a
 * decision needs all of its options in front of it. Both surfaces that led
 * someone here -- `next`'s `read-only` state and `policy` itself -- named
 * exactly one of the three, the middle one, without saying why. A real install
 * relayed that single command to its user verbatim, as the next step rather
 * than as one of three.
 */
export const POLICY_MODES: readonly PolicyMode[] = ["read-only", "interactive", "delegated-auto"];

const RANK: Record<PolicyMode, number> = { "read-only": 0, interactive: 1, "delegated-auto": 2 };

/**
 * Where a caller goes once an account has been adopted.
 *
 * Adoption is the moment the grant lands, and the moment it becomes obvious
 * that a grant is not permission to trade: the local policy is still
 * `read-only`, so nothing can be signed. There are two independent locks here
 * -- one on chain, one in `.env` -- and an install worked that out for itself
 * and said so. Pointing at `next` from here costs a hop before the person is
 * shown the choice that is actually theirs to make.
 */
export function nextAfterAdoption(
  policy: PolicyMode,
  invoke: (command: string, ...args: string[]) => string,
): string {
  return policy === "read-only" ? invoke("policy", "--json") : invoke("next", "--json");
}

export interface PolicyChoice {
  mode: PolicyMode;
  /** Whether this is the one in force. */
  current: boolean;
  /** What it lets this process do, and what it costs. */
  means: string;
  /**
   * What is not true yet and has to be before it can be set.
   *
   * Absent when nothing stands in the way. `delegated-auto` is refused without
   * a scope file -- naming it here is the difference between an option and a
   * refusal somebody walks into.
   *
   * Prose only. It is printed through a wrapper, and a command broken across
   * lines is one nobody can copy -- which is why the command that satisfies it
   * is {@link PolicyChoice.requiresCommand} rather than a clause in here.
   */
  requires?: string;
  /** The command that satisfies `requires`, printed unwrapped. */
  requiresCommand?: string;
  /** Whether choosing it widens what may be signed, which is what needs `--yes`. */
  widens: boolean;
  /** The command that sets it, spelled for where it is printed. */
  command: string;
}

/**
 * The three, with what each one costs — for a person to choose between.
 *
 * Deliberately not neutral. They are listed in rank order and say what they
 * allow, because `delegated-auto` is the one where this process signs against
 * real money with nobody watching, and presenting it as the third radio button
 * on a setup screen would be an interface that nudges toward it.
 */
export function policyChoices(input: {
  current: PolicyMode;
  hasScope: boolean;
  invoke: (command: string, ...args: string[]) => string;
}): PolicyChoice[] {
  const means: Record<PolicyMode, string> = {
    "read-only":
      "nothing can be signed. Reads keep working — markets, positions, balance, orders.",
    interactive:
      "can sign, and every write needs a person: preview → approve → execute, where " +
      "`approve` records their name against the exact plan.",
    "delegated-auto":
      "signs with nobody watching, bounded by a scope file — collateral per order and in " +
      "total, leverage, which markets and sides, and an expiry. A delegate key only.",
  };

  return POLICY_MODES.map((mode) => {
    const widens = RANK[mode] > RANK[input.current];
    const unmet = mode === "delegated-auto" && !input.hasScope;
    const requires = unmet
      ? "a scope file first, and WATERX_POLICY_SCOPE_FILE pointing at it"
      : undefined;
    return {
      mode,
      current: mode === input.current,
      means: means[mode],
      ...(requires === undefined ? {} : { requires }),
      ...(unmet
        ? { requiresCommand: input.invoke("limits", "--write", "policy.json", "…") }
        : {}),
      widens,
      // Narrowing needs no confirmation: refusing to let someone turn writes
      // off would be absurd.
      command: widens
        ? input.invoke("policy", "--set", mode, "--yes")
        : input.invoke("policy", "--set", mode),
    };
  });
}

/**
 * A per-invocation override may only **narrow**. Widening is a change to the
 * configuration, made deliberately and in one place — so `--policy read-only`
 * on an unattended machine is a useful safety belt, and the reverse is an error.
 */
export function narrowOnly(configured: PolicyMode, override: PolicyMode): PolicyMode {
  if (RANK[override] > RANK[configured]) {
    throw new ExecutionPolicyError(
      `Cannot widen the policy from "${configured}" to "${override}" per invocation. ` +
        `Change the configuration if that is what you mean.`,
    );
  }
  return override;
}
