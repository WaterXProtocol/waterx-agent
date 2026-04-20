import { requestSuiFromFaucetV2, getFaucetHost } from "@mysten/sui/faucet";
import { Transaction } from "@mysten/sui/transactions";

import { TESTNET_PACKAGE_IDS, TESTNET_OBJECTS, TESTNET_TYPES } from "@waterx/perp-sdk";
import type { AgentSigner } from "./signer.ts";

/**
 * Request testnet SUI from the faucet.
 * Rate-limited — retries once on 429.
 */
export async function requestTestnetSui(address: string): Promise<void> {
  const host = getFaucetHost("testnet");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await requestSuiFromFaucetV2({ host, recipient: address });
      return;
    } catch (e: any) {
      if (attempt === 0 && String(e).includes("429")) {
        console.log("Faucet rate-limited, waiting 5s...");
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw e;
    }
  }
}

/**
 * Mint testnet mock USDC using the public treasury cap.
 * @param amount - Amount in raw units (6 decimals, e.g. 100_000_000 = 100 USDC)
 */
export async function mintTestnetUsdc(
  signer: AgentSigner,
  amount: bigint | number = 100_000_000n, // 100 USDC
): Promise<string> {
  const tx = new Transaction();

  // Call mock_usdc::mock_usdc::mint(treasury, amount, recipient, ctx)
  tx.moveCall({
    target: `${TESTNET_PACKAGE_IDS.MOCK_USDC}::mock_usdc::mint`,
    arguments: [
      tx.object(TESTNET_OBJECTS.USDC_TREASURY),
      tx.pure.u64(BigInt(amount)),
      tx.pure.address(signer.address),
    ],
  });

  const result = await signer.signAndExecute(tx);
  return result.digest;
}

/**
 * Get wallet SUI balance (in MIST, 1 SUI = 1e9 MIST).
 */
export async function getSuiBalance(signer: AgentSigner): Promise<bigint> {
  const res = await signer.client.getBalance({
    owner: signer.address,
    coinType: "0x2::sui::SUI",
  });
  return BigInt(res.balance.coinBalance);
}

/**
 * Get wallet USDC balance (testnet mock USDC, 6 decimals).
 */
export async function getUsdcBalance(signer: AgentSigner): Promise<bigint> {
  const res = await signer.client.getBalance({
    owner: signer.address,
    coinType: TESTNET_TYPES.USDC,
  });
  return BigInt(res.balance.coinBalance);
}
