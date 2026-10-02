/**
 * Cancelling an order that is not there.
 *
 * `planUpdateOrder` looked the order up and refused a stale id by name.
 * `planCancelOrder` did not, so a preview was produced for an order that did not
 * exist, a person approved it, and the chain refused it. The same half-checked
 * set the owner-only actions were in, and the same cost: the refusal was never in
 * doubt, only when somebody heard it.
 */
import { describe, expect, it, vi } from "vitest";

import { WaterXAgent } from "../src/agent/agent.ts";
import { UsageError } from "../src/errors.ts";

const ACCOUNT = `0x${"1".repeat(64)}`;
const SIGNER = `0x${"d".repeat(64)}`;

const order = (id: string, ticker = "SUIUSD") => ({
  id,
  ticker,
  side: "long" as const,
  triggerPrice: 1,
  size: 1,
  reduceOnly: false,
});

function agentWith(orders: ReturnType<typeof order>[]): WaterXAgent {
  const agent = new WaterXAgent({
    config: { accountId: ACCOUNT },
    signer: { address: SIGNER, describe: "test key" } as never,
    readAccount: vi.fn(async () => ({ accountId: ACCOUNT, owner: SIGNER, delegates: [] })),
  });
  vi.spyOn(agent.markets, "resolveTicker").mockResolvedValue("SUIUSD");
  vi.spyOn(agent.read, "orders").mockResolvedValue(orders as never);
  return agent;
}

describe("planCancelOrder", () => {
  it("refuses an order id the account does not hold", async () => {
    await expect(
      agentWith([order("7")]).planCancelOrder({ ticker: "SUIUSD", orderId: 999 }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("names the open orders, so a mistyped id is corrected rather than rejected", async () => {
    await expect(
      agentWith([order("7"), order("8")]).planCancelOrder({ ticker: "SUIUSD", orderId: 999 }),
    ).rejects.toThrow(/SUIUSD#7, SUIUSD#8/u);
  });

  it("says so plainly when the account holds none at all", async () => {
    await expect(
      agentWith([]).planCancelOrder({ ticker: "SUIUSD", orderId: 1 }),
    ).rejects.toThrow(/Open orders: none/u);
  });

  it("still plans a cancellation of an order that is there", async () => {
    // The guard on the three above: a lookup that refused everything would pass
    // them all and break the command.
    await expect(
      agentWith([order("7")]).planCancelOrder({ ticker: "SUIUSD", orderId: 7 }),
    ).resolves.toMatchObject({ action: "cancelOrder" });
  });
});
