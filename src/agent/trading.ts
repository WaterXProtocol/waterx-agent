import {
  buildOpenPositionTx,
  buildClosePositionTx,
  buildIncreasePositionTx,
  buildDecreasePositionTx,
  buildDepositCollateralTx,
  buildWithdrawCollateralTx,
  buildPlaceOrderTx,
  buildPlaceTpSlTx,
  buildCancelOrderTx,
  buildMintWlpTx,
  buildRequestRedeemWlpTx,
  buildStakeRewardDistributorTx,
  buildUnstakeRewardDistributorTx,
  buildClaimRewardDistributorTx,
  TESTNET_TYPES,
} from "@waterx/perp-sdk";
import type { BaseAsset, CollateralAsset } from "@waterx/perp-sdk";
import { rawPrice } from "../helpers.ts";
import type { AgentSigner, TxResult } from "./signer.ts";

// ============================================================================
// Position Operations
// ============================================================================

export interface OpenPositionParams {
  accountId: string;
  base: BaseAsset;
  collateral?: CollateralAsset;
  isLong: boolean;
  /** Collateral amount in raw units (6 decimals for USDC, e.g. 10_000_000 = 10 USDC) */
  collateralAmount: bigint | number;
  /** Leverage multiplier (e.g. 5 = 5x) */
  leverage?: number;
  /** Position size in 1e9-scaled units (overrides leverage) */
  size?: bigint | number;
  /** Take-profit trigger price in USD */
  takeProfitPrice?: number;
  /** Stop-loss trigger price in USD */
  stopLossPrice?: number;
}

/**
 * Open a long position.
 */
export async function openLong(
  signer: AgentSigner,
  params: Omit<OpenPositionParams, "isLong">,
): Promise<TxResult> {
  return openPosition(signer, { ...params, isLong: true });
}

/**
 * Open a short position.
 */
export async function openShort(
  signer: AgentSigner,
  params: Omit<OpenPositionParams, "isLong">,
): Promise<TxResult> {
  return openPosition(signer, { ...params, isLong: false });
}

/**
 * Open a position (long or short).
 */
export async function openPosition(
  signer: AgentSigner,
  params: OpenPositionParams,
): Promise<TxResult> {
  const tx = await buildOpenPositionTx(signer.client, {
    accountId: params.accountId,
    base: params.base,
    collateral: params.collateral,
    isLong: params.isLong,
    collateralAmount: params.collateralAmount,
    leverage: params.leverage,
    size: params.size,
    updatePythPrice: true,
    takeProfit: params.takeProfitPrice
      ? { triggerPrice: rawPrice(params.takeProfitPrice) }
      : undefined,
    stopLoss: params.stopLossPrice
      ? { triggerPrice: rawPrice(params.stopLossPrice) }
      : undefined,
  });

  return signer.signAndExecute(tx);
}

/**
 * Close a position entirely.
 */
export async function closePosition(
  signer: AgentSigner,
  params: {
    accountId: string;
    positionId: number;
    base: BaseAsset;
    collateral?: CollateralAsset;
  },
): Promise<TxResult> {
  const tx = await buildClosePositionTx(signer.client, {
    accountId: params.accountId,
    positionId: params.positionId,
    base: params.base,
    collateral: params.collateral,
    updatePythPrice: true,
  });

  return signer.signAndExecute(tx);
}

/**
 * Increase an existing position's size by adding more collateral.
 */
export async function increasePosition(
  signer: AgentSigner,
  params: {
    accountId: string;
    positionId: number;
    base: BaseAsset;
    collateral?: CollateralAsset;
    collateralAmount: bigint | number;
    leverage?: number;
  },
): Promise<TxResult> {
  const tx = await buildIncreasePositionTx(signer.client, {
    accountId: params.accountId,
    positionId: params.positionId,
    base: params.base,
    collateral: params.collateral,
    collateralAmount: params.collateralAmount,
    leverage: params.leverage,
    updatePythPrice: true,
  });

  return signer.signAndExecute(tx);
}

/**
 * Decrease an existing position's size.
 * @param size - Amount to reduce in 1e9-scaled units
 */
export async function decreasePosition(
  signer: AgentSigner,
  params: {
    accountId: string;
    positionId: number;
    base: BaseAsset;
    collateral?: CollateralAsset;
    size: bigint | number;
  },
): Promise<TxResult> {
  const tx = await buildDecreasePositionTx(signer.client, {
    accountId: params.accountId,
    positionId: params.positionId,
    base: params.base,
    collateral: params.collateral,
    size: params.size,
    updatePythPrice: true,
  });

  return signer.signAndExecute(tx);
}

/**
 * Add collateral to an existing position (increase margin).
 */
export async function addCollateral(
  signer: AgentSigner,
  params: {
    accountId: string;
    positionId: number;
    base: BaseAsset;
    collateral?: CollateralAsset;
    collateralAmount: bigint | number;
  },
): Promise<TxResult> {
  const tx = await buildDepositCollateralTx(signer.client, {
    accountId: params.accountId,
    positionId: params.positionId,
    base: params.base,
    collateral: params.collateral,
    collateralAmount: params.collateralAmount,
    updatePythPrice: true,
  });

  return signer.signAndExecute(tx);
}

/**
 * Withdraw collateral from an existing position (decrease margin).
 */
export async function removeCollateral(
  signer: AgentSigner,
  params: {
    accountId: string;
    positionId: number;
    base: BaseAsset;
    collateral?: CollateralAsset;
    amount: bigint | number;
  },
): Promise<TxResult> {
  const tx = await buildWithdrawCollateralTx(signer.client, {
    accountId: params.accountId,
    positionId: params.positionId,
    base: params.base,
    collateral: params.collateral,
    amount: params.amount,
    updatePythPrice: true,
  });

  return signer.signAndExecute(tx);
}

// ============================================================================
// Order Operations
// ============================================================================

export interface PlaceOrderParams {
  accountId: string;
  base: BaseAsset;
  collateral?: CollateralAsset;
  isLong: boolean;
  /** Collateral amount in raw units */
  collateralAmount: bigint | number;
  /** Leverage multiplier */
  leverage?: number;
  /** Trigger price in USD */
  triggerPrice: number;
  /** True for stop order, false for limit order (default: false) */
  isStopOrder?: boolean;
  /** Reduce-only order (default: false) */
  reduceOnly?: boolean;
  /** Link to existing position for TP/SL */
  linkedPositionId?: number;
}

/**
 * Place a limit or stop order.
 */
export async function placeOrder(
  signer: AgentSigner,
  params: PlaceOrderParams,
): Promise<TxResult> {
  const tx = await buildPlaceOrderTx(signer.client, {
    accountId: params.accountId,
    base: params.base,
    collateral: params.collateral,
    isLong: params.isLong,
    collateralAmount: params.collateralAmount,
    leverage: params.leverage,
    triggerPrice: rawPrice(params.triggerPrice),
    isStopOrder: params.isStopOrder,
    reduceOnly: params.reduceOnly,
    linkedPositionId: params.linkedPositionId,
    updatePythPrice: true,
  });

  return signer.signAndExecute(tx);
}

/**
 * Place a take-profit order linked to an existing position.
 */
export async function placeTakeProfit(
  signer: AgentSigner,
  params: {
    accountId: string;
    base: BaseAsset;
    collateral?: CollateralAsset;
    /** True if the linked position is long */
    positionIsLong: boolean;
    positionId: number;
    /** Size of the TP order (omit for full position close) */
    size?: bigint | number;
    /** Current position size (required when size is omitted) */
    positionSize?: bigint | number;
    triggerPrice: number;
  },
): Promise<TxResult> {
  const tx = await buildPlaceTpSlTx(signer.client, {
    accountId: params.accountId,
    base: params.base,
    collateral: params.collateral,
    positionIsLong: params.positionIsLong,
    positionId: params.positionId,
    size: params.size,
    positionSize: params.positionSize,
    triggerPrice: rawPrice(params.triggerPrice),
    type: "tp",
    updatePythPrice: true,
  });

  return signer.signAndExecute(tx);
}

/**
 * Place a stop-loss order linked to an existing position.
 */
export async function placeStopLoss(
  signer: AgentSigner,
  params: {
    accountId: string;
    base: BaseAsset;
    collateral?: CollateralAsset;
    /** True if the linked position is long */
    positionIsLong: boolean;
    positionId: number;
    /** Size of the SL order (omit for full position close) */
    size?: bigint | number;
    /** Current position size (required when size is omitted) */
    positionSize?: bigint | number;
    triggerPrice: number;
  },
): Promise<TxResult> {
  const tx = await buildPlaceTpSlTx(signer.client, {
    accountId: params.accountId,
    base: params.base,
    collateral: params.collateral,
    positionIsLong: params.positionIsLong,
    positionId: params.positionId,
    size: params.size,
    positionSize: params.positionSize,
    triggerPrice: rawPrice(params.triggerPrice),
    type: "sl",
    updatePythPrice: true,
  });

  return signer.signAndExecute(tx);
}

/**
 * Cancel an existing order.
 * @param orderTypeTag - 0=limit_buy, 1=limit_sell, 2=stop_buy, 3=stop_sell, 255=wildcard (default)
 */
export async function cancelOrder(
  signer: AgentSigner,
  params: {
    accountId: string;
    base: BaseAsset;
    collateral?: CollateralAsset;
    orderId: number;
    /** Trigger price as 1e9-scaled bigint. 0 scans all price buckets. */
    triggerPrice?: bigint;
    /** 0=limit_buy, 1=limit_sell, 2=stop_buy, 3=stop_sell, 255=wildcard (default) */
    orderTypeTag?: number;
  },
): Promise<TxResult> {
  const tx = await buildCancelOrderTx(signer.client, {
    accountId: params.accountId,
    base: params.base,
    collateral: params.collateral,
    orderId: params.orderId,
    triggerPrice: params.triggerPrice,
    orderTypeTag: params.orderTypeTag,
    updatePythPrice: true,
  });

  return signer.signAndExecute(tx);
}

// ============================================================================
// WLP Operations
// ============================================================================

/**
 * Mint WLP tokens by depositing collateral into the liquidity pool.
 */
export async function mintWlp(
  signer: AgentSigner,
  params: {
    depositCoin: string;
    collateral?: CollateralAsset;
    recipient?: string;
  },
): Promise<TxResult> {
  const tx = await buildMintWlpTx(signer.client, {
    depositCoin: params.depositCoin,
    collateral: params.collateral,
    recipient: params.recipient ?? signer.address,
    updatePythPrice: true,
  });

  return signer.signAndExecute(tx);
}

/**
 * Request to redeem WLP tokens for collateral.
 */
export async function redeemWlp(
  signer: AgentSigner,
  params: {
    lpCoin: any;
    collateral?: CollateralAsset;
  },
): Promise<TxResult> {
  const tx = await buildRequestRedeemWlpTx(signer.client, {
    lpCoin: params.lpCoin,
    collateral: params.collateral,
    recipient: signer.address,
    updatePythPrice: true,
  });

  return signer.signAndExecute(tx);
}

// ============================================================================
// Reward Distributor Operations
// ============================================================================

/**
 * Stake WLP tokens in the reward distributor.
 */
export async function stakeRewards(
  signer: AgentSigner,
  params: {
    stakeCoin: string;
    stakeTokenType?: string;
  },
): Promise<TxResult> {
  const tx = buildStakeRewardDistributorTx(signer.client, {
    stakeTokenType: params.stakeTokenType ?? TESTNET_TYPES.WLP,
    stakeCoin: params.stakeCoin,
  });

  return signer.signAndExecute(tx);
}

/**
 * Unstake tokens from the reward distributor.
 */
export async function unstakeRewards(
  signer: AgentSigner,
  params: {
    withdrawalAmount: bigint | number;
    stakeTokenType?: string;
    recipient?: string;
  },
): Promise<TxResult> {
  const tx = buildUnstakeRewardDistributorTx(signer.client, {
    stakeTokenType: params.stakeTokenType ?? TESTNET_TYPES.WLP,
    withdrawalAmount: params.withdrawalAmount,
    recipient: params.recipient ?? signer.address,
  });

  return signer.signAndExecute(tx);
}

/**
 * Claim accrued rewards from the reward distributor.
 */
export async function claimRewards(
  signer: AgentSigner,
  params?: {
    stakeTokenType?: string;
    recipient?: string;
  },
): Promise<TxResult> {
  const tx = buildClaimRewardDistributorTx(signer.client, {
    stakeTokenType: params?.stakeTokenType ?? TESTNET_TYPES.WLP,
    recipient: params?.recipient ?? signer.address,
  });

  return signer.signAndExecute(tx);
}
