/**
 * `TxResponse` → digest: the path every write in this package takes.
 *
 * Not the only way to reach the key. `SignerProvider` is callable directly, and
 * a process that has been taken over will call it — see the threat model in
 * `verify.ts`. What this function is, is the one path the package itself uses,
 * so a write that forgot to authorize refuses rather than quietly signs.
 *
 * Two things live here on purpose.
 *
 * **The sponsored/regular fork.** The two branches do not merely submit
 * differently — they carry *different bytes*, and nothing in the type says so:
 *
 *  - **sponsored** — complete `TransactionData` with the Enoki sponsor as gas
 *    owner, plus a reserved digest. Sign it as-is and hand both to
 *    `/sponsor/execute`. Submitting it to a fullnode fails for gas.
 *  - **regular** — transaction **kind** bytes only. The backend deliberately
 *    never touches the caller's gas coins, so the client rebuilds via
 *    `Transaction.fromKind`, sets its own sender, and lets its own client
 *    select gas. Signing the kind bytes and submitting them produces a
 *    protobuf decode failure, not a helpful error.
 *
 * Getting this wrong is not a type error, so the union is narrowed exactly once,
 * here, and the signature is taken *after* the fork rather than before it.
 *
 * **The execution policy.** Every signature produced by the agent's own write
 * paths goes through `execute()`, so a `read-only` process cannot sign by any
 * of THEM and an `interactive` one cannot sign without the caller saying so —
 * which is a property of this package, not of the process it runs in.
 * Scattering that check across the trading helpers would make it a convention;
 * keeping it here makes it a property of this package.
 *
 * It is a property of this package and not of the process. `SignerProvider` is
 * reachable directly, so code executing here can sign without coming through
 * this function at all — see the threat model in `verify.ts`. What this buys is
 * that a *mistake* cannot route around the policy, not that an attacker cannot.
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";

import type { TxApi } from "../api/tx.ts";
import type { AgentConfig } from "../config.ts";
import { TxExecutionError } from "../errors.ts";
import type { Permit, PolicyGate, WriteIntent } from "../policy.ts";
import type { SignerProvider } from "./signer.ts";
import { assertCorpusDescribes, loadDeployment } from "./deployment.ts";
import { corpusFor } from "./corpus.ts";
import { assertLayoutConfirmed, assertTransactionMatches } from "./verify.ts";
import type { TxResponse } from "../api/types.ts";
import { signsAsDelegate } from "../config.ts";

export interface ExecuteOptions {
  /** Log breadcrumb for sponsored submissions; conventionally `agent/<intent>`. */
  source?: string;
  /**
   * Called with the transaction digest **before** the submission leaves this
   * process, and awaited.
   *
   * This is what makes a crash recoverable. The window between "sent" and
   * "observed the result" cannot be closed — a process can die inside it — so
   * the only defence is to know, afterwards, which transaction to ask about. A
   * caller that persists this digest can resolve the ambiguity exactly, by
   * looking the digest up on chain; one that does not has to guess from
   * timestamps and order shapes, and guessing wrong means trading twice.
   *
   * Throwing from this hook aborts the submission — the honest behaviour when
   * the record could not be durably written.
   */
  onSubmitting?: (digest: string) => Promise<void>;
}

export interface ExecuteResult {
  digest: string;
  sponsored: boolean;
  /** Absent for sponsored submissions — Enoki returns only the digest. */
  effects?: unknown;
}

export class TxExecutor {
  private grpc?: SuiGrpcClient;

  /**
   * @param grpc A fullnode client to use instead of opening one.
   *
   * The self-pay branch rebuilds through a fullnode to choose gas, which made
   * that whole path untestable without a network — so it went untested, and a
   * check that lived only on it would have gone unnoticed. This injects the
   * client and nothing else: it carries no policy, no key and no bytes, so it
   * cannot be a way around any of the checks above it.
   */
  constructor(
    private readonly signer: SignerProvider,
    private readonly config: AgentConfig,
    private readonly txApi: TxApi,
    private readonly gate: PolicyGate,
    grpc?: SuiGrpcClient,
  ) {
    this.grpc = grpc;
  }

  /** The address this executor signs as. */
  get address(): string {
    return this.signer.address;
  }

  /** Where the key lives, for diagnostics. */
  get signerDescription(): string {
    return this.signer.describe;
  }

  /**
   * The address the backend should treat as the authorisation subject.
   * Equals `address` for an owner key, and the configured owner when this
   * process holds a delegate key.
   */
  get senderAddress(): string {
    return this.config.ownerAddress ?? this.address;
  }

  /**
   * Set when signing as a delegate; the backend requires it to be absent otherwise.
   *
   * A comparison, not the presence of `ownerAddress`. The owner is derived from
   * the account when it is not configured, so an owner key trading its own
   * account HAS an `ownerAddress` — its own address. Testing presence would send
   * that owner's writes as a delegate of itself.
   */
  get delegateSender(): string | undefined {
    return signsAsDelegate(this.config, this.address) ? this.address : undefined;
  }

  /** Body fields every tx-build request carries. Spread this into each request. */
  txBody(): { sender: string; delegateSender?: string } {
    const delegate = this.delegateSender;
    return delegate === undefined
      ? { sender: this.senderAddress }
      : { sender: this.senderAddress, delegateSender: delegate };
  }

  /**
   * Sign and submit a built transaction, spending the permit that authorized it.
   *
   * The permit is the load-bearing argument: it can only have come from
   * `PolicyGate.authorize()`, it is spent here, and a second use of the same one
   * is refused. That makes "this signature was authorized" hold for every
   * signature that comes through here, which is every one the agent's own write
   * paths produce — not every one the process can produce.
   *
   * The full `intent` is taken, not just its name: the gate re-derives the
   * permit's fingerprint from it, so a permit issued for one action — or for
   * the same action with different parameters — cannot be spent here.
   */
  async execute(
    built: TxResponse,
    intent: WriteIntent,
    permit: Permit,
    options: ExecuteOptions = {},
  ): Promise<ExecuteResult> {
    // The bytes are part of what is checked: a permit bound to one transaction
    // cannot be presented alongside another.
    this.gate.consume(permit, intent, built.txBytes);

    // Which packages this deployment publishes, so an entrypoint name means
    // the deployment's code rather than anything that exports the same name.
    // Loaded once per process; a failure here is a refusal, because a check
    // that cannot identify the code is not a check.
    const deployment = await loadDeployment(this.config.configUrl);
    // And that the layouts every positional check relies on still describe it.
    // Checking this only in `runDoctor` protected an operator who runs the
    // preflight and nobody else; a runner signs for weeks without one.
    // Per network: testnet and mainnet publish different packages under the
    // same names, so the record for the other one describes this deployment as
    // entirely changed — and a fixture that held only one made the two networks
    // mutually exclusive without saying so.
    const corpus = corpusFor(this.config.network);
    assertCorpusDescribes(deployment, corpus.packages, corpus.capturedAt);
    // Before the fork, so both branches refuse identically — and so the
    // self-pay path does not rebuild through a fullnode to choose gas for an
    // action that will be refused either way.
    assertLayoutConfirmed(intent, this.config.allowUnconfirmed, this.config.network);

    const action = intent.action;

    if (built.sponsored) {
      // And then the bytes are checked on their own terms. The permit says a
      // transaction was authorized; this says what the transaction DOES.
      // Provenance can be spoofed by anything upstream — the artifact cannot lie
      // about its own commands.
      assertTransactionMatches(built.txBytes, intent, this.address, {
        deployment,
        extraPackages: this.config.extraPackages,
        allowUnconfirmed: this.config.allowUnconfirmed,
        network: this.config.network,
        sponsored: true,
      });
      // Already complete and gas-owned by the sponsor: sign exactly these bytes.
      const signature = await this.signer.signTransaction(fromBase64(built.txBytes));
      // Enoki reserved this digest at build time, so it is knowable before the
      // submission goes out — which is what makes a crash here recoverable.
      await options.onSubmitting?.(built.digest);
      const result = await this.txApi.executeSponsored({
        digest: built.digest,
        signature,
        source: options.source ?? `agent/${action}`,
      });
      return { digest: result.digest, sponsored: true };
    }

    // A delegate wallet is not expected to hold gas — the backend sponsors it
    // and returns 6003 when it cannot. Reaching the self-pay branch as a
    // delegate means the transaction is about to fail for gas instead, so say
    // that plainly rather than letting the fullnode phrase it.
    if (this.delegateSender !== undefined) {
      throw new TxExecutionError(
        `${action}: the backend returned an unsponsored build while signing as a delegate. ` +
          `A delegate wallet has no gas of its own — retry once sponsorship is available.`,
        undefined,
      );
    }

    const client = this.grpcClient();
    // Kind bytes in, complete transaction out: we choose the sender and this
    // client selects the gas coins, which is the whole reason the backend
    // withheld them.
    const tx = Transaction.fromKind(fromBase64(built.txBytes));
    tx.setSender(this.address);
    const bytes = await tx.build({ client });
    // Checked HERE, not before the fork: what arrived was transaction *kind*
    // bytes, carrying no sender and no gas, and what gets signed is this
    // rebuild. Verifying the kind and signing the rebuild would leave the
    // difference between them unexamined.
    assertTransactionMatches(toBase64(bytes), intent, this.address, {
      deployment,
      extraPackages: this.config.extraPackages,
      allowUnconfirmed: this.config.allowUnconfirmed,
      network: this.config.network,
      sponsored: false,
    });
    // Complete bytes, not kind bytes: a signer cannot tell the two apart, so
    // handing over a kind would be asking a key holder to sign something that
    // cannot execute.
    const signature = await this.signer.signTransaction(bytes);
    await options.onSubmitting?.(await tx.getDigest({ client }));

    const result = await client.core.executeTransaction({
      transaction: bytes,
      signatures: [signature],
    });

    if (result.$kind === "FailedTransaction") {
      throw new TxExecutionError(
        `${action}: transaction failed on chain.`,
        result.FailedTransaction.digest,
        result.FailedTransaction.effects,
      );
    }

    return {
      digest: result.Transaction.digest,
      sponsored: false,
      effects: result.Transaction.effects,
    };
  }

  /** Lazily built so a read-only process never opens a chain connection. */
  private grpcClient(): SuiGrpcClient {
    this.grpc ??= new SuiGrpcClient({
      network: this.config.network,
      baseUrl: this.config.grpcUrl,
    });
    return this.grpc;
  }
}
