/**
 * The money boundary: display units ↔ the raw integer strings the backend DTOs demand.
 *
 * Three scales are in play and they are NOT interchangeable:
 *
 *  - **collateral** — 6 decimals, `u64`, e.g. "8000000" = 8 USD.
 *  - **price**      — 1e9-scaled, `u128`, e.g. "65000000000000" = $65,000.
 *    One exception the contract keeps at `u64`: `acceptable_price` on the
 *    trading requests, which is why `toRawAcceptablePrice` exists separately
 *    and bounds to u64 — the backend's `@IsU64String` rejects anything wider.
 *  - **size**       — 1e9-scaled base-asset units, `u128`.
 *
 * Everything crosses the wire as a decimal *string*: a JS `number` cannot hold
 * a u128, and `JSON.parse` would silently round one. So conversion is done on
 * the decimal text with BigInt, never through `Number`.
 */

/** Collateral tokens (USDC / USDSUI) carry 6 decimals on chain. */
export const COLLATERAL_DECIMALS = 6;
/** Prices and sizes are `Float` values scaled by 1e9. */
export const FLOAT_DECIMALS = 9;

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/**
 * Scale a non-negative decimal string/number to an integer of `decimals` places.
 *
 * Rejects rather than rounds when the input carries more precision than the
 * scale can hold: silently dropping a digit off an amount is how an agent
 * spends the wrong number, and there is no safe default for which digit to
 * lose. Callers that genuinely want truncation should do it explicitly first.
 */
export function scaleToInteger(value: string | number, decimals: number, label: string): bigint {
  const text = typeof value === "number" ? numberToDecimalString(value, label) : value.trim();

  const match = DECIMAL_RE.exec(text);
  if (match === null) {
    throw new Error(`${label}: "${text}" is not a non-negative decimal number.`);
  }

  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new Error(
      `${label}: "${text}" has ${String(fraction.length)} decimal places but only ${String(decimals)} are representable. ` +
        `Round it yourself so the loss is deliberate.`,
    );
  }

  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

/**
 * A `number` reaches here from CLI parsing and from callers who type a literal.
 * Anything past 2^53 or in exponential form cannot be trusted to survive the
 * round-trip, so it is refused at the door rather than scaled.
 */
function numberToDecimalString(value: number, label: string): string {
  if (!Number.isFinite(value)) throw new Error(`${label}: ${String(value)} is not a finite number.`);
  if (value < 0) throw new Error(`${label}: ${String(value)} must not be negative.`);
  if (!Number.isSafeInteger(Math.trunc(value))) {
    throw new Error(
      `${label}: ${String(value)} exceeds the safe-integer range; pass it as a decimal string instead.`,
    );
  }
  const text = String(value);
  if (text.includes("e") || text.includes("E")) {
    throw new Error(`${label}: ${text} is in exponential form; pass it as a decimal string instead.`);
  }
  return text;
}

function assertWidth(raw: bigint, max: bigint, label: string): bigint {
  if (raw > max) throw new Error(`${label}: value overflows the on-chain integer width.`);
  return raw;
}

/** Human collateral (e.g. `10` = 10 USD) → base units string, u64-bounded. */
export const toRawCollateral = (amount: string | number): string =>
  assertWidth(
    scaleToInteger(amount, COLLATERAL_DECIMALS, "collateralAmount"),
    U64_MAX,
    "collateralAmount",
  ).toString();

/** USD price (e.g. `65000` = $65,000) → 1e9-scaled string, u128-bounded. */
export const toRawPrice = (price: string | number): string =>
  assertWidth(scaleToInteger(price, FLOAT_DECIMALS, "price"), U128_MAX, "price").toString();

/**
 * USD price → 1e9-scaled string bounded to **u64**, for `acceptablePrice`.
 * The contract keeps that one field at u64 even though `size` beside it is u128.
 */
export const toRawAcceptablePrice = (price: string | number): string =>
  assertWidth(
    scaleToInteger(price, FLOAT_DECIMALS, "acceptablePrice"),
    U64_MAX,
    "acceptablePrice",
  ).toString();

/** Base-asset size (e.g. `0.15` BTC) → 1e9-scaled string, u128-bounded. */
export const toRawSize = (size: string | number): string =>
  assertWidth(scaleToInteger(size, FLOAT_DECIMALS, "size"), U128_MAX, "size").toString();

/** WLP / staked amounts share the collateral scale and width. */
export const toRawTokenAmount = (amount: string | number, label = "amount"): string =>
  assertWidth(scaleToInteger(amount, COLLATERAL_DECIMALS, label), U64_MAX, label).toString();

/** Raw integer string → a display number. Lossy by design; never feed it back into a request. */
export function fromRaw(raw: string | bigint, decimals: number): number {
  return Number(BigInt(raw)) / 10 ** decimals;
}

export const fromRawCollateral = (raw: string | bigint): number => fromRaw(raw, COLLATERAL_DECIMALS);
export const fromRawFloat = (raw: string | bigint): number => fromRaw(raw, FLOAT_DECIMALS);

/**
 * Derive a slippage-bounded `acceptablePrice` from a reference price.
 *
 * The direction is the whole point: a buy may pay *up to* `price × (1 + s)`,
 * a sell may accept *down to* `price × (1 - s)`. Getting the sign backwards
 * produces a bound that can never bind, which looks like it worked.
 */
export function acceptablePriceFor(
  referencePrice: number,
  side: "buy" | "sell",
  slippagePercent: number,
): string {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    throw new Error(`acceptablePrice: reference price ${String(referencePrice)} must be positive.`);
  }
  if (!Number.isFinite(slippagePercent) || slippagePercent < 0 || slippagePercent >= 100) {
    throw new Error(`acceptablePrice: slippage ${String(slippagePercent)}% must be within [0, 100).`);
  }
  const factor = side === "buy" ? 1 + slippagePercent / 100 : 1 - slippagePercent / 100;
  // 9 dp is exactly the on-chain scale — rounding here keeps `scaleToInteger`
  // from rejecting the float noise that `*` leaves behind.
  return toRawAcceptablePrice((referencePrice * factor).toFixed(FLOAT_DECIMALS));
}
