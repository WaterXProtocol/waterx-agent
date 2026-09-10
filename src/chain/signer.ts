/**
 * Where the key is, and how far it is from this process.
 *
 * `SignerProvider` exists so the executor can hold *a way to get a signature*
 * rather than a key. Two implementations ship:
 *
 *  - `KeypairSigner` — the key is loaded from `.env` into this address space.
 *    Convenient, and the honest default for a developer at a terminal.
 *  - `ExternalCommandSigner` — a child process holds the key and this one never
 *    sees it. The wire is `SIGNER_PROTOCOL` v1, so an existing provider (the
 *    `waterx-predict-keystore` agent, a browser-wallet bridge, a KMS shim)
 *    serves this package unmodified.
 *
 * The distinction is the whole point of `delegated-auto`. A policy that signs
 * while nobody is watching, with an owner key resident in memory, is one bug
 * away from the account's full authority. With the key held outside this
 * process, the worst an exploited agent can do is ask for a signature.
 *
 * Be precise about what then limits WHAT it may ask for. The policy scope, the
 * permit and `assertTransactionMatches` all run in this process, so an attacker
 * with execution here goes around them. What genuinely stands in the way is
 * enforced elsewhere: the delegate's on-chain permission mask, and the
 * contract's owner-only rule on funds leaving the account.
 *
 * Those on-chain limits are coarse — a set of action flags, with no ceiling on
 * size or notional. Narrowing them is a contract-side change, and it is the
 * only one that would make an unattended agent's blast radius small by
 * construction rather than by the good behaviour of this process.
 */
import { spawn } from "node:child_process";

import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { toBase64 } from "@mysten/sui/utils";

import { type SignerRequest, type SignerResponse } from "./signer-protocol.ts";

export type SignerKind = "in-process-keypair" | "external-command";

export interface SignerProvider {
  readonly kind: SignerKind;
  /** The address signatures will resolve to. */
  readonly address: string;
  /** Human-readable identity for diagnostics. Never the full argv. */
  readonly describe: string;
  /** Sign complete transaction bytes; returns the base64 signature. */
  signTransaction(bytes: Uint8Array): Promise<string>;
}

/** The key lives here. Simple, and stated plainly rather than implied. */
export class KeypairSigner implements SignerProvider {
  readonly kind = "in-process-keypair";
  readonly address: string;
  readonly describe = "in-process keypair (SUI_PRIVATE_KEY)";

  constructor(private readonly keypair: Ed25519Keypair) {
    this.address = keypair.getPublicKey().toSuiAddress();
  }

  async signTransaction(bytes: Uint8Array): Promise<string> {
    const { signature } = await this.keypair.signTransaction(bytes);
    return signature;
  }
}

export class SignerError extends Error {
  readonly name = "SignerError";

  constructor(
    message: string,
    readonly executable: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface ExternalSignerOptions {
  /** argv, already split. Spawned without a shell, so no argument is interpreted. */
  command: string[];
  /**
   * The address the child holds. Stated, never derived — deriving it would
   * require the key, which is the thing this arrangement exists to avoid. A
   * conforming signer refuses a request for an address it does not hold, so a
   * wrong value fails at the child rather than producing a stray signature.
   */
  agentWallet: string;
  /**
   * How long to wait for the child. The default is generous because a
   * conforming provider may be a person: a browser-wallet bridge blocks on a
   * dialog. A keystore agent answers in milliseconds.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class ExternalCommandSigner implements SignerProvider {
  readonly kind = "external-command";
  readonly address: string;
  readonly describe: string;

  private readonly command: string[];
  private readonly timeoutMs: number;

  constructor(options: ExternalSignerOptions) {
    if (options.command.length === 0) {
      throw new SignerError("The signer command is empty.", "");
    }
    this.command = options.command;
    this.address = options.agentWallet;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.describe = `external command (${baseName(this.command[0] ?? "")})`;
  }

  async signTransaction(bytes: Uint8Array): Promise<string> {
    return await this.request({
      version: 1,
      type: "TRANSACTION",
      agentWallet: this.address,
      transactionBytesBase64: toBase64(bytes),
    });
  }

  private async request(request: SignerRequest): Promise<string> {
    const executable = baseName(this.command[0] ?? "");
    const result = await runChild(this.command, `${JSON.stringify(request)}\n`, this.timeoutMs);

    // The child's stderr is its own diagnostics — a wrong passphrase, a socket
    // it could not reach. It belongs on this process's stderr and never in a
    // return value a caller might archive.
    if (result.stderr.trim() !== "") {
      process.stderr.write(`signer: ${result.stderr.trim()}\n`);
    }
    if (result.timedOut) {
      throw new SignerError(
        `The signer did not respond within ${String(this.timeoutMs)}ms and was terminated.`,
        executable,
        { request: request.type, timedOut: true },
      );
    }
    if (result.code !== 0) {
      throw new SignerError(
        `The signer exited with status ${String(result.code)}; its output was not used.`,
        executable,
        { request: request.type, exitCode: result.code },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new SignerError(
        'The signer wrote no JSON to stdout. It must write {"signature":"<base64>"} and nothing else.',
        executable,
        { request: request.type },
      );
    }
    const signature = (parsed as Partial<SignerResponse> | null)?.signature;
    if (typeof signature !== "string" || signature === "") {
      throw new SignerError(
        "The signer returned JSON with no `signature` string.",
        executable,
        { request: request.type },
      );
    }
    return signature;
  }
}

interface ChildResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * One request, one child. Nothing is reused between signatures: a long-lived
 * child would be a second place for key-adjacent state to live, and the
 * ssh-agent-shaped providers this talks to already hold the key in *their*
 * resident process, which is the one that should own that risk.
 */
function runChild(command: string[], input: string, timeoutMs: number): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const [executable, ...args] = command;
    if (executable === undefined) {
      reject(new SignerError("The signer command is empty.", ""));
      return;
    }

    // No shell: argv is passed through, so a path with a space is a path and
    // never a second argument, and nothing in it is interpreted.
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    const finish = (result: ChildResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on("error", (cause: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new SignerError(
          `Could not run the signer: ${cause.message}`,
          baseName(executable),
        ),
      );
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, code, timedOut });
    });

    // A child that never reads stdin closes the pipe under us; that is its
    // answer, not a crash here.
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

const baseName = (path: string): string => path.split("/").pop() ?? path;
