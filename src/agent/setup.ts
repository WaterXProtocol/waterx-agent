import { Transaction } from "@mysten/sui/transactions";

import {
  TESTNET_TYPES,
  getAccountsByOwner,
  createAccount,
  buildTransferToAccountTx,
} from "@waterx/perp-sdk";
import type { AgentSigner } from "./signer.ts";
import { saveToEnv } from "./wallet.ts";

/**
 * Extract account ID from AccountCreated event in transaction result.
 * Falls back to reading created objects from effects if events are unavailable (gRPC).
 */
function accountIdFromResult(result: { events: any[]; effects: any }): string {
  // Try events first (JSON-RPC format)
  const ev = (result.events ?? []).find(
    (e: any) => e && (e.type || "").includes("AccountCreated"),
  );
  if (ev) {
    const j = ev.parsedJson as Record<string, unknown> | null | undefined;
    const id = j?.account_id ?? j?.accountId;
    if (typeof id === "string") return id;
  }

  // Fallback: extract from effects created objects (gRPC format)
  const created = result.effects?.created ?? [];
  for (const obj of created) {
    const ref = obj?.reference ?? obj;
    const objectId = ref?.objectId ?? ref?.object_id;
    if (typeof objectId === "string" && objectId !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
      // Return the first non-trivial created object (the UserAccount)
      return objectId;
    }
  }

  throw new Error(
    "Could not read account_id from transaction result. " +
    `Events: ${JSON.stringify(result.events)}, ` +
    `Created: ${JSON.stringify(created)}`,
  );
}

/**
 * Create a new WaterX UserAccount on-chain.
 * Returns the account object address (accountId).
 */
export async function createWaterXAccount(
  signer: AgentSigner,
  name: string = "agent",
): Promise<string> {
  const tx = new Transaction();
  createAccount(signer.client, tx, name);
  const result = await signer.signAndExecute(tx, { gasBudget: 50_000_000 });
  const accountId = accountIdFromResult(result);
  return accountId;
}

/**
 * Get existing accounts or create one if none exist.
 * Saves account ID and object address to .env.
 */
export async function getOrCreateAccount(
  signer: AgentSigner,
): Promise<{ accountId: string; isNew: boolean }> {
  // Check env first
  const envAccountId = process.env.WATERX_ACCOUNT_ID?.trim();
  if (envAccountId) {
    return { accountId: envAccountId, isNew: false };
  }

  // Check on-chain
  const accounts = await getAccountsByOwner(signer.client, signer.address);
  if (accounts.length > 0) {
    const accountId = accounts[0]!.accountObjectAddress;
    saveToEnv("WATERX_ACCOUNT_ID", accountId);
    console.log(`Found existing account: ${accountId}`);
    return { accountId, isNew: false };
  }

  // Create new
  const accountId = await createWaterXAccount(signer);
  saveToEnv("WATERX_ACCOUNT_ID", accountId);
  console.log(`Created new account: ${accountId}`);
  return { accountId, isNew: true };
}

/**
 * Deposit collateral from wallet into a WaterX UserAccount.
 * @param amount - Amount in raw units (e.g. 10_000_000 = 10 USDC)
 * @param collateral - "USDC" or "USDSUI" (default: "USDC")
 */
export async function depositToAccount(
  signer: AgentSigner,
  accountId: string,
  amount: bigint | number,
  collateral: "USDC" | "USDSUI" = "USDC",
): Promise<string> {
  const coinType = collateral === "USDSUI" ? TESTNET_TYPES.USDSUI : TESTNET_TYPES.USDC;
  const tx = buildTransferToAccountTx(signer.client, {
    accountObjectAddress: accountId,
    amount: BigInt(amount),
    coinType,
  });

  const result = await signer.signAndExecute(tx);
  return result.digest;
}
