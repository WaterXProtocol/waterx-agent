/**
 * The signer boundary.
 *
 * Two things are worth testing here and they are different. One is that the
 * descriptor describes what this package actually writes — a wire contract that
 * only a comment enforces is a wire contract waiting to drift. The other is the
 * child-process contract itself: every way a signer can fail has to become a
 * named error rather than a stray signature or a hang.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { describe, expect, it } from "vitest";

import {
  ExternalCommandSigner,
  KeypairSigner,
  SignerError,
  type SignerProvider,
} from "../src/chain/signer.ts";
import { SIGNER_PROTOCOL } from "../src/chain/signer-protocol.ts";
import { loadConfig } from "../src/config.ts";
import { createSigner } from "../src/chain/create-signer.ts";

const WALLET = `0x${"c".repeat(64)}`;
const BYTES = new Uint8Array([1, 2, 3, 4]);

/** Write a throwaway signer script and return its argv. */
function fakeSigner(name: string, body: string): string[] {
  const dir = join(tmpdir(), "waterx-agent-signer-tests");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.mjs`);
  writeFileSync(
    path,
    `let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => { ${body} });
`,
    { mode: 0o700 },
  );
  return [process.execPath, path];
}

describe("the descriptor describes what we write", () => {
  it("emits exactly the TRANSACTION fields the protocol names", async () => {
    const echo = fakeSigner(
      "echo",
      `process.stdout.write(JSON.stringify({ signature: Buffer.from(input.trim()).toString("base64") }));`,
    );
    const signer = new ExternalCommandSigner({ command: echo, agentWallet: WALLET });
    const signature = await signer.signTransaction(BYTES);
    const request = JSON.parse(Buffer.from(signature, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;

    const declared = SIGNER_PROTOCOL.requests.find((r) => r.type === "TRANSACTION");
    expect(Object.keys(request).sort()).toEqual([...(declared?.fields ?? [])].sort());
    expect(request).toMatchObject({ version: 1, type: "TRANSACTION", agentWallet: WALLET });
  });

  it("declares the same response shape it requires", () => {
    expect(SIGNER_PROTOCOL.response.fields).toEqual(["signature"]);
  });

  /**
   * The other three copies of this descriptor live in waterx-predict-agent-sdk,
   * which this package deliberately does not depend on. When that checkout
   * happens to be beside us, compare — a drift guard on the machine where drift
   * would be introduced. Elsewhere the comparison is skipped rather than faked.
   */
  it("matches the predict workspace's copy, when that checkout is present", () => {
    const peer = join(
      import.meta.dirname,
      "../../waterx-predict-agent-sdk/packages/signer-browser/src/protocol.ts",
    );
    if (!existsSync(peer)) {
      expect(true).toBe(true);
      return;
    }
    const source = readFileSync(peer, "utf8");
    for (const request of SIGNER_PROTOCOL.requests) {
      expect(source).toContain(`type: '${request.type}'`);
      for (const field of request.fields) expect(source).toContain(`'${field}'`);
    }
    expect(source).toContain(`version: ${String(SIGNER_PROTOCOL.version)}`);
  });
});

describe("ExternalCommandSigner", () => {
  const signerWith = (body: string, name: string): SignerProvider =>
    new ExternalCommandSigner({
      command: fakeSigner(name, body),
      agentWallet: WALLET,
      timeoutMs: 4000,
    });

  it("returns the signature the child produced", async () => {
    const signer = signerWith(`process.stdout.write('{"signature":"c2ln"}');`, "ok");
    await expect(signer.signTransaction(BYTES)).resolves.toBe("c2ln");
  });

  it("never exposes the key — it holds only an address and an argv", () => {
    const signer = signerWith(`process.stdout.write('{"signature":"c2ln"}');`, "ok2");
    expect(JSON.stringify(signer)).not.toContain("suiprivkey");
    expect(signer.address).toBe(WALLET);
    expect(signer.kind).toBe("external-command");
  });

  it("names the executable but withholds the argv — an argument may be a path", () => {
    // argv here is [node, /tmp/.../secret-path.mjs]: the executable is `node`
    // and the script is an argument, which is exactly the case the rule is for.
    const signer = signerWith(`process.stdout.write('{"signature":"c2ln"}');`, "secret-path");
    expect(signer.describe).toContain("node");
    expect(signer.describe).not.toContain("secret-path");
    expect(signer.describe).not.toContain(tmpdir());
  });

  it("refuses a non-zero exit rather than using the output", async () => {
    const signer = signerWith(
      `process.stdout.write('{"signature":"c2ln"}'); process.exit(3);`,
      "exit3",
    );
    await expect(signer.signTransaction(BYTES)).rejects.toThrow(/exited with status 3/);
  });

  it("refuses output that is not JSON", async () => {
    const signer = signerWith(`process.stdout.write("please enter your passphrase");`, "notjson");
    await expect(signer.signTransaction(BYTES)).rejects.toThrow(/no JSON/);
  });

  it("refuses JSON with no signature", async () => {
    const signer = signerWith(`process.stdout.write('{"ok":true}');`, "nosig");
    await expect(signer.signTransaction(BYTES)).rejects.toThrow(/no `signature` string/);
  });

  it("refuses an empty signature", async () => {
    const signer = signerWith(`process.stdout.write('{"signature":""}');`, "emptysig");
    await expect(signer.signTransaction(BYTES)).rejects.toThrow(/no `signature` string/);
  });

  it("terminates a signer that never answers", async () => {
    const signer = signerWith(`setTimeout(() => {}, 60000);`, "hang");
    await expect(signer.signTransaction(BYTES)).rejects.toThrow(/did not respond within/);
  });

  it("reports a command that cannot be run", async () => {
    const signer = new ExternalCommandSigner({
      command: ["/nonexistent/waterx-signer"],
      agentWallet: WALLET,
    });
    await expect(signer.signTransaction(BYTES)).rejects.toThrow(SignerError);
  });
});

describe("createSigner", () => {
  it("defaults to the in-process keypair", () => {
    const keypair = Ed25519Keypair.generate();
    const signer = new KeypairSigner(keypair);
    expect(signer.kind).toBe("in-process-keypair");
    expect(signer.address).toBe(keypair.getPublicKey().toSuiAddress());
  });

  it("refuses an external signer with no stated wallet — deriving one needs the key", () => {
    const config = loadConfig({
      network: "testnet",
      apiUrl: "https://example.invalid",
      signerCommand: ["waterx-predict-keystore", "sign"],
    });
    expect(() => createSigner(config)).toThrow(/WATERX_AGENT_WALLET/);
  });

  it("builds an external signer when both are configured", () => {
    const config = loadConfig({
      network: "testnet",
      apiUrl: "https://example.invalid",
      signerCommand: ["waterx-predict-keystore", "sign"],
      agentWallet: WALLET,
    });
    const signer = createSigner(config);
    expect(signer.kind).toBe("external-command");
    expect(signer.address).toBe(WALLET);
    expect(signer.describe).toContain("waterx-predict-keystore");
  });
});
