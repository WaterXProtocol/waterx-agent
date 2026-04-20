/** Float precision (1e9) used by the `Float` type. */
export const FLOAT_SCALE = 1_000_000_000n;

/**
 * Converts a human-readable USD price to the 1e9-scaled `u128` value
 * expected by Move `Float` parameters (`trigger_price`, `size`, etc.).
 *
 * @example rawPrice(65000)   // 65000_000_000_000n  ($65,000)
 * @example rawPrice(0.088)   // 88_000_000n          ($0.088)
 */
export function rawPrice(usd: number | bigint): bigint {
  if (typeof usd === "bigint") return usd;
  return BigInt(Math.round(usd * 1e9));
}
