import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

import { WaterXClient, createTestnetConfig } from "@waterx/perp-sdk";

type Network = "MAINNET" | "TESTNET";

export interface TxResult {
  digest: string;
  effects: any;
  events: any[];
}

/**
 * Wraps a WaterXClient with an Ed25519Keypair for signing and executing transactions.
 * This is the central class for the agent — all trading functions use it.
 */
export class AgentSigner {
  client: WaterXClient;
  keypair: Ed25519Keypair;
  address: string;

  constructor(keypair: Ed25519Keypair, network: Network = "TESTNET") {
    this.keypair = keypair;
    this.address = keypair.getPublicKey().toSuiAddress();

    if (network === "TESTNET") {
      this.client = new WaterXClient(createTestnetConfig());
    } else {
      // TODO: add createMainnetConfig when mainnet launches
      throw new Error("Mainnet not yet supported. Use TESTNET.");
    }
  }

  /**
   * Sign and execute a transaction, wait for confirmation.
   * Automatically sets sender and gas budget if not already set.
   */
  async signAndExecute(
    tx: Transaction,
    opts?: { gasBudget?: number },
  ): Promise<TxResult> {
    tx.setSender(this.address);
    tx.setGasBudget(opts?.gasBudget ?? 200_000_000);

    const raw = await this.client.grpcClient.signAndExecuteTransaction({
      signer: this.keypair,
      transaction: tx,
      include: { effects: true, events: true, objectTypes: true },
    });

    // TransactionResult is a discriminated union: { $kind: 'Transaction', Transaction } | { $kind: 'FailedTransaction', FailedTransaction }
    const txData =
      raw.$kind === "Transaction" ? raw.Transaction! : raw.FailedTransaction!;

    const digest = txData.digest;

    await this.client.grpcClient.waitForTransaction({
      digest,
      timeout: 30_000,
    });

    const effects = txData.effects;
    if (effects && !effects.status.success) {
      throw new Error(
        `Transaction failed: ${effects.status.error}`,
      );
    }

    const events: any[] = txData.events ?? [];

    return { digest, effects, events };
  }
}
