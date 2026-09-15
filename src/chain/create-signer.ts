/**
 * Choose where the key lives, once, from configuration.
 *
 * The default stays the in-process keypair: a developer who has just run
 * `generate-wallet` should not have to stand up a signing daemon to place a
 * testnet order. Setting `WATERX_SIGNER_COMMAND` moves the key out of this
 * process, and everything downstream is unchanged — the executor holds a way to
 * get a signature either way.
 *
 * Nothing here is called on a read path. `WaterXAgent` builds the signer on
 * first *write*, so `markets`, `ticker` and `positions` run in a process that
 * has no key at all — see {@link signerReadiness}, which answers "could this
 * process sign?" without loading anything.
 */
import type { AgentConfig } from "../config.ts";
import { loadWallet } from "./wallet.ts";
import { ExternalCommandSigner, KeypairSigner, SignerError, type SignerProvider } from "./signer.ts";

export function createSigner(config: AgentConfig): SignerProvider {
  if (config.signerCommand === undefined) {
    return new KeypairSigner(loadWallet().keypair);
  }

  if (config.agentWallet === undefined) {
    throw new SignerError(
      "WATERX_SIGNER_COMMAND is set but WATERX_AGENT_WALLET is not. The address a signer holds " +
        "has to be stated, because deriving it would need the key this arrangement exists to keep out.",
      config.signerCommand[0] ?? "",
    );
  }

  return new ExternalCommandSigner({
    command: config.signerCommand,
    agentWallet: config.agentWallet,
    ...(config.signerTimeoutMs !== undefined ? { timeoutMs: config.signerTimeoutMs } : {}),
  });
}

export interface SignerReadiness {
  /** Whether a signer could be constructed. */
  ready: boolean;
  /** Where the key would live. */
  kind: "in-process-keypair" | "external-command";
  /** Why not, when `ready` is false — phrased as the thing to do about it. */
  reason?: string;
}

/**
 * Could this process sign, if it were asked to?
 *
 * Asked and answered WITHOUT constructing anything: the whole point of the lazy
 * signer is that a read-only invocation never touches the key, and a readiness
 * probe that loaded the keypair to find out would put it straight back. So this
 * inspects configuration only — `loadWallet()` is not called, and no child
 * process is spawned.
 *
 * It therefore reports "a key is configured", not "the key is valid". A
 * malformed `SUI_PRIVATE_KEY` still fails at the first write, which is the
 * right place for it: that is a failure of the key, not of the arrangement.
 */
export function signerReadiness(config: AgentConfig): SignerReadiness {
  if (config.signerCommand !== undefined) {
    return config.agentWallet === undefined
      ? {
          ready: false,
          kind: "external-command",
          reason:
            "WATERX_SIGNER_COMMAND is set but WATERX_AGENT_WALLET is not — state the address " +
            "the child holds, since deriving it would need the key this keeps out.",
        }
      : { ready: true, kind: "external-command" };
  }
  const key = process.env.SUI_PRIVATE_KEY?.trim();
  return key === undefined || key === ""
    ? {
        ready: false,
        kind: "in-process-keypair",
        reason:
          "no SUI_PRIVATE_KEY in the environment — `bootstrap` generates one, or point " +
          "WATERX_SIGNER_COMMAND at a SIGNER_PROTOCOL provider.",
      }
    : { ready: true, kind: "in-process-keypair" };
}
