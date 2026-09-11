/**
 * WaterX agent SDK.
 *
 * The backend composes every perpetual PTB (oracle refreshes, per-ticker dedup,
 * the per-position reentrancy lock); this package shapes the request, signs the
 * bytes it gets back, and submits them. `@waterx/sdk` is a dependency for its
 * permission and order-type constants — the on-chain source of truth for those
 * bitmasks — not for transaction building.
 */
export { WaterXAgent } from "./agent/agent.ts";
export type {
  AgentOptions,
  ClosePositionParams,
  LimitOrderParams,
  OpenPositionParams,
  ReducePositionParams,
} from "./agent/agent.ts";
export { assertNotCrossing, MarketRegistry } from "./agent/markets.ts";
export {
  AUTHORIZE_PATH,
  authorizeUrl,
  CONSOLE_ENDPOINTS,
  consoleUrl,
  delegationStatus,
  REQUESTED_PERMISSION_NAMES,
  REQUESTED_PERP_PERMISSIONS,
} from "./agent/delegation.ts";
export type { DelegationState, DelegationStatus } from "./agent/delegation.ts";
export { decide } from "./agent/guidance.ts";
export type { Guidance, Situation, State, Suggestion } from "./agent/guidance.ts";
export { buildTx, previewOf } from "./agent/plan.ts";
export type {
  BuildRequest,
  PlanContext,
  Preview,
  PreviewBound,
  PreviewLeg,
  SenderFields,
  TradePlan,
} from "./agent/plan.ts";

export { HttpClient } from "./api/http.ts";
export { ReadApi } from "./api/read.ts";
export { TxApi } from "./api/tx.ts";
export type * from "./api/types.ts";

export { TxExecutor } from "./chain/executor.ts";
export type { ExecuteOptions, ExecuteResult } from "./chain/executor.ts";
export { createSigner, signerReadiness } from "./chain/create-signer.ts";
export { gasBalance, MIN_GAS_SUI } from "./chain/gas.ts";
export type { SignerReadiness } from "./chain/create-signer.ts";
export {
  ExternalCommandSigner,
  KeypairSigner,
  SignerError,
} from "./chain/signer.ts";
export type {
  ExternalSignerOptions,
  SignerKind,
  SignerProvider,
} from "./chain/signer.ts";
export { SIGNER_PROTOCOL } from "./chain/signer-protocol.ts";
export type { SignerRequest, SignerResponse } from "./chain/signer-protocol.ts";
export { generateWallet, getOrCreateWallet, loadWallet, saveToEnv } from "./chain/wallet.ts";
export type { WalletInfo } from "./chain/wallet.ts";

export { explorerTxUrl, isDefaultExtraPackage, loadConfig, requireAccountId } from "./config.ts";
export type { AgentConfig, ExecutionPolicy, Network } from "./config.ts";

export {
  AmbiguousSubmissionError,
  ConfigError,
  ErrorCode,
  ExecutionPolicyError,
  TxExecutionError,
  UsageError,
  WaterXApiError,
} from "./errors.ts";

export { fingerprintIntent, narrowOnly, PolicyGate } from "./policy.ts";
export type { Permit, PolicyMode, PolicyScope, WriteIntent } from "./policy.ts";

export {
  acceptablePriceFor,
  COLLATERAL_DECIMALS,
  FLOAT_DECIMALS,
  fromRaw,
  fromRawCollateral,
  fromRawFloat,
  toRawAcceptablePrice,
  toRawCollateral,
  toRawPrice,
  toRawSize,
  toRawTokenAmount,
} from "./units.ts";

export { runDoctor } from "./doctor.ts";
export type { DoctorCheck, DoctorReport } from "./doctor.ts";

export { describeIntent, Runner } from "./runner/runner.ts";
export type { RunnerOptions } from "./runner/runner.ts";
export { JobStore, StoreLockedError } from "./runner/store.ts";
export { Inbox } from "./runner/inbox.ts";
export type { InboxEntry } from "./runner/inbox.ts";
export { Reconciler } from "./runner/reconcile.ts";
export type { LandedVerdict, OrderOutcome } from "./runner/reconcile.ts";
export { DEFAULT_LIMITS, TERMINAL_STATES } from "./runner/types.ts";
export type { Intent, Job, JobEvent, JobState, RunnerLimits } from "./runner/types.ts";

/**
 * Delegate permission bitmasks and order-type tags, re-exported from
 * `@waterx/sdk` so callers have one import. Never redeclare these locally —
 * they mirror the Move contracts.
 */
export {
  ORDER_LIMIT_BUY,
  ORDER_LIMIT_SELL,
  ORDER_STOP_BUY,
  ORDER_STOP_SELL,
  PERM_ALL,
  PERM_ALL_TRADING,
  PERM_CANCEL_ORDER,
  PERM_CLOSE_POSITION,
  PERM_DECREASE_POSITION,
  PERM_DEPOSIT_COLLATERAL,
  PERM_INCREASE_POSITION,
  PERM_MINT_WLP,
  PERM_OPEN_POSITION,
  PERM_PLACE_ORDER,
  PERM_REDEEM_WLP,
  PERM_WITHDRAW_COLLATERAL,
} from "@waterx/sdk";
