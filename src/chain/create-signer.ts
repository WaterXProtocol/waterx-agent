/**
 * Choose where the key lives, once, from configuration.
 *
 * The default stays the in-process keypair: a developer who has just run
 * `generate-wallet` should not have to stand up a signing daemon to place a
 * testnet order. Setting `WATERX_SIGNER_COMMAND` moves the key out of this
 * process, and everything downstream is unchanged — the executor holds a way to
 * get a signature either way.
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
