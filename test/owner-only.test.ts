/**
 * The five actions a delegate cannot perform, refused before anybody approves.
 *
 * `withdraw`, `addDelegate`, `removeDelegate` and `removeAllDelegates` were
 * refused while the plan was being derived. `deposit` and `createAccount` were
 * not, so a delegate previewed them, a person approved them, and the backend
 * answered `delegateSender is not allowed` at execute. One half of the same set
 * was telling somebody in time and the other half was not — and the half that
 * was not spent a person's approval to say so.
 */
import { describe, expect, it, vi } from "vitest";

import { WaterXAgent } from "../src/agent/agent.ts";
import { ExecutionPolicyError } from "../src/errors.ts";

const OWNER = `0x${"9".repeat(64)}`;
const DELEGATE = `0x${"d".repeat(64)}`;
const ACCOUNT = `0x${"1".repeat(64)}`;

const signer = (address: string) => ({ address, describe: "test key" }) as never;
const asDelegate = () =>
  new WaterXAgent({
    config: { accountId: ACCOUNT },
    signer: signer(DELEGATE),
    readAccount: vi.fn(async () => ({ accountId: ACCOUNT, owner: OWNER, delegates: [] })),
  });
const asOwner = () =>
  new WaterXAgent({
    config: { accountId: ACCOUNT },
    signer: signer(OWNER),
    readAccount: vi.fn(async () => ({ accountId: ACCOUNT, owner: OWNER, delegates: [] })),
  });

describe("what a delegate is told before it asks for an approval", () => {
  it("refuses a deposit, which is paid from the signer's own balance", async () => {
    await expect(
      asDelegate().planDeposit({ assetType: "0x2::sui::SUI", amount: 1 }),
    ).rejects.toBeInstanceOf(ExecutionPolicyError);
  });

  it("refuses creating an account, which would belong to whoever signed", async () => {
    await expect(asDelegate().planCreateAccount({ name: "probe" })).rejects.toBeInstanceOf(
      ExecutionPolicyError,
    );
  });

  it("refuses a withdrawal, as it always did", async () => {
    await expect(
      asDelegate().planWithdraw({ assetType: "0x2::sui::SUI", amount: 1 }),
    ).rejects.toBeInstanceOf(ExecutionPolicyError);
  });

  it("names the key to run it with, rather than only refusing", async () => {
    await expect(asDelegate().planDeposit({ assetType: "0x2::sui::SUI", amount: 1 })).rejects.toThrow(
      /owner key/u,
    );
  });
});

describe("what an owner key is still allowed to do", () => {
  // The guard is about which key is signing, not about the action. An owner
  // trading its own account must not be refused its own deposit.
  it("plans a deposit", async () => {
    await expect(asOwner().planDeposit({ assetType: "0x2::sui::SUI", amount: 1 })).resolves.toMatchObject({
      action: "deposit",
    });
  });

  it("plans an account creation", async () => {
    await expect(asOwner().planCreateAccount({ name: "probe" })).resolves.toMatchObject({
      action: "createAccount",
    });
  });
});
