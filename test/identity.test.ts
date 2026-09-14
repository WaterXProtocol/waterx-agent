/**
 * WATERX_ACCOUNT_ID is enough: the owner is read from the account.
 */
import { describe, expect, it, vi } from "vitest";

import { WaterXAgent } from "../src/agent/agent.ts";

const OWNER = `0x${"9".repeat(64)}`;
const DELEGATE = `0x${"d".repeat(64)}`;
const ACCOUNT = `0x${"1".repeat(64)}`;

const signer = (address: string) => ({ address, describe: "test key" }) as never;
const readAccountOwnedBy = (owner: string) =>
  vi.fn(async () => ({ accountId: ACCOUNT, owner, delegates: [] }));

describe("resolveIdentity", () => {
  it("derives the owner when only the account id is configured, and signs as its delegate", async () => {
    const agent = new WaterXAgent({
      config: { accountId: ACCOUNT },
      signer: signer(DELEGATE),
      readAccount: readAccountOwnedBy(OWNER),
    });

    await agent.resolveIdentity();

    expect(agent.config.ownerAddress).toBe(OWNER);
    expect(agent.executor.txBody()).toEqual({ sender: OWNER, delegateSender: DELEGATE });
  });

  it("keeps an owner key trading its own account an owner — never a delegate of itself", async () => {
    // Derivation gives an owner key an ownerAddress equal to its own address.
    // Deciding "delegate" by the field's presence would send delegateSender=self.
    const agent = new WaterXAgent({
      config: { accountId: ACCOUNT },
      signer: signer(OWNER),
      readAccount: readAccountOwnedBy(OWNER),
    });

    await agent.resolveIdentity();

    expect(agent.executor.txBody()).toEqual({ sender: OWNER });
  });

  it("honours an explicitly configured owner without reading the chain", async () => {
    const read = readAccountOwnedBy(OWNER);
    const agent = new WaterXAgent({
      config: { accountId: ACCOUNT, ownerAddress: OWNER },
      signer: signer(DELEGATE),
      readAccount: read,
    });

    await agent.resolveIdentity();

    expect(read).not.toHaveBeenCalled();
  });

  it("reads the account once however many times it is asked", async () => {
    const read = readAccountOwnedBy(OWNER);
    const agent = new WaterXAgent({ config: { accountId: ACCOUNT }, signer: signer(DELEGATE), readAccount: read });

    await Promise.all([agent.resolveIdentity(), agent.resolveIdentity()]);
    await agent.resolveIdentity();

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed read — the next attempt tries again", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockResolvedValue({ accountId: ACCOUNT, owner: OWNER, delegates: [] });
    const agent = new WaterXAgent({ config: { accountId: ACCOUNT }, signer: signer(DELEGATE), readAccount: read });

    await expect(agent.resolveIdentity()).rejects.toThrow("rpc down");
    await agent.resolveIdentity();

    expect(agent.config.ownerAddress).toBe(OWNER);
  });

  it("does nothing when no account is configured", async () => {
    const read = readAccountOwnedBy(OWNER);
    const agent = new WaterXAgent({ signer: signer(DELEGATE), readAccount: read });

    await agent.resolveIdentity();

    expect(read).not.toHaveBeenCalled();
  });

  it("refuses to build the write plane before the owner is settled", () => {
    // Fail closed: otherwise the gate would judge a delegate key an owner key
    // on a fact nobody had read yet.
    const agent = new WaterXAgent({
      config: { accountId: ACCOUNT },
      signer: signer(DELEGATE),
      readAccount: readAccountOwnedBy(OWNER),
    });

    expect(() => agent.executor).toThrow(/resolveIdentity/);
  });

  it("reports its signing address without building the write plane", () => {
    const agent = new WaterXAgent({
      config: { accountId: ACCOUNT },
      signer: signer(DELEGATE),
      readAccount: readAccountOwnedBy(OWNER),
    });

    expect(agent.address).toBe(DELEGATE);
  });
});
