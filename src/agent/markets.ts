/**
 * Market resolution and the guards that depend on live market state.
 *
 * Tickers are `BTCUSD`-shaped, not `BTC`. Older callers (and humans) say
 * `BTC`, so `resolveTicker` accepts either and checks the result against the
 * deployment's own list rather than a table compiled into this repo — the
 * market set has roughly doubled since this agent was last updated, and a
 * hardcoded list is exactly the thing that went stale.
 */
import type { ReadApi } from "../api/read.ts";
import type { MarketInfo, TickerData } from "../api/types.ts";
import { UsageError } from "../errors.ts";

/** Tradeable states. `not_listed` markets exist in config but have no metadata. */
const TRADEABLE: ReadonlySet<MarketInfo["status"]> = new Set(["open", "closed", "paused"]);

export class MarketRegistry {
  private markets?: Map<string, MarketInfo>;

  constructor(private readonly read: ReadApi) {}

  private async load(): Promise<Map<string, MarketInfo>> {
    this.markets ??= new Map((await this.read.markets()).map((m) => [m.ticker.toUpperCase(), m]));
    return this.markets;
  }

  /** Drop the memoised market list, e.g. after a listing changes mid-session. */
  invalidate(): void {
    this.markets = undefined;
  }

  /** Every ticker the deployment will actually trade. */
  async tradeableTickers(): Promise<string[]> {
    const markets = await this.load();
    return [...markets.values()].filter((m) => TRADEABLE.has(m.status)).map((m) => m.ticker).sort();
  }

  /**
   * Normalise `BTC` / `btcusd` / `BTCUSD` to the deployment's ticker.
   *
   * Fails with the available list rather than a bare "unknown market": when a
   * caller is wrong about a ticker it is usually because the listing moved, and
   * the list is the answer to the question they are about to ask next.
   */
  async resolveTicker(input: string): Promise<string> {
    const markets = await this.load();
    const raw = input.trim().toUpperCase();

    const direct = markets.get(raw) ?? markets.get(`${raw}USD`);
    if (direct === undefined) {
      const available = (await this.tradeableTickers()).join(", ");
      throw new UsageError(`Unknown market "${input}". Available: ${available}`);
    }
    if (!TRADEABLE.has(direct.status)) {
      throw new UsageError(`Market ${direct.ticker} is not tradeable (status: ${direct.status}).`);
    }
    return direct.ticker;
  }

  /**
   * Live spot price for sizing and slippage bounds.
   *
   * A stale price is refused rather than used. Everything derived from spot —
   * order size, the acceptable-price bound — inherits its staleness, and a
   * slippage bound computed off a stale price is a bound that does not bind.
   */
  async spotPrice(ticker: string): Promise<number> {
    const data: TickerData = await this.read.ticker(ticker);
    if (data.stale) {
      throw new Error(`${ticker}: oracle price is stale; refusing to size an order from it.`);
    }
    if (!Number.isFinite(data.spotPrice) || data.spotPrice <= 0) {
      throw new Error(`${ticker}: no usable spot price (got ${String(data.spotPrice)}).`);
    }
    return data.spotPrice;
  }
}

/**
 * Refuse a limit order that is already fillable.
 *
 * The contract aborts these with `ECrossingLimitOrder` at both placement and
 * re-price: a long/buy limit priced *above* market, or a short/sell limit
 * priced *below* it. Catching it here costs one read and names the fix;
 * letting it through costs a failed transaction whose abort code says nothing
 * about market orders being the intended path.
 *
 * The comparison is strict — a limit exactly at market is allowed on chain, and
 * so is allowed here. Stop orders and reduce-only (TP/SL) legs are exempt:
 * triggering at or through the current price is what they are for.
 */
export function assertNotCrossing(input: {
  ticker: string;
  isLong: boolean;
  triggerPrice: number;
  spotPrice: number;
  isStopOrder?: boolean;
  reduceOnly?: boolean;
}): void {
  if (input.isStopOrder === true || input.reduceOnly === true) return;

  const crosses = input.isLong
    ? input.triggerPrice > input.spotPrice
    : input.triggerPrice < input.spotPrice;
  if (!crosses) return;

  const side = input.isLong ? "long" : "short";
  const relation = input.isLong ? "above" : "below";
  throw new UsageError(
    `${input.ticker}: a ${side} limit at ${String(input.triggerPrice)} is ${relation} the market ` +
      `price ${String(input.spotPrice)}, so it would fill immediately — the contract rejects that ` +
      `(ECrossingLimitOrder). Send a market order if immediate execution is what you want.`,
  );
}
