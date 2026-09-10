#!/usr/bin/env node
/**
 * A minimal SIGNER_PROTOCOL v1 provider — the smallest thing that satisfies the
 * wire, so the boundary can be exercised without standing up a keystore daemon.
 *
 *   WATERX_SIGNER_COMMAND='["./examples/keypair-signer.mjs"]'
 *   WATERX_AGENT_WALLET=0x<64 hex>
 *   DEMO_SIGNER_KEY=suiprivkey1...   # read by THIS process, never by the agent
 *
 * It is a demonstration, not a deployment. The key is decrypted, resident, and
 * arrives in an environment variable, which `ps eww` shows to anyone on the box.
 * For real unattended work point WATERX_SIGNER_COMMAND at a provider that holds
 * the key properly — `waterx-predict-keystore sign` speaks this exact protocol.
 *
 * What it does demonstrate is the property that matters: the agent process
 * never sees a key, and this one refuses to sign for an address it does not
 * hold, naming the address it does.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromBase64 } from "@mysten/sui/utils";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  try {
    const req = JSON.parse(input);
    if (req.version !== 1) throw new Error(`unsupported protocol version ${req.version}`);
    const keypair = Ed25519Keypair.fromSecretKey(process.env.DEMO_SIGNER_KEY);
    const held = keypair.getPublicKey().toSuiAddress();
    // A conforming signer refuses an address it does not hold, naming the one it does.
    if (req.agentWallet !== held) throw new Error(`this signer holds ${held}, not ${req.agentWallet}`);
    if (req.type !== "TRANSACTION") throw new Error(`unsupported request ${req.type}`);
    const { signature } = await keypair.signTransaction(fromBase64(req.transactionBytesBase64));
    process.stdout.write(JSON.stringify({ signature }));
  } catch (e) {
    process.stderr.write(String(e.message ?? e));
    process.exit(1);
  }
});
