import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "../../.env");

export interface WalletInfo {
  keypair: Ed25519Keypair;
  address: string;
  secretKey: string;
}

/**
 * Generate a new SUI wallet (Ed25519 keypair).
 * Returns the keypair, SUI address, and bech32-encoded secret key.
 */
export function generateWallet(): WalletInfo {
  const keypair = Ed25519Keypair.generate();
  const address = keypair.getPublicKey().toSuiAddress();
  const secretKey = keypair.getSecretKey(); // bech32 suiprivkey1...
  return { keypair, address, secretKey };
}

/**
 * Load wallet from SUI_PRIVATE_KEY environment variable.
 * The key must be bech32-encoded (suiprivkey1...).
 *
 * Called on write paths only. `WaterXAgent` constructs its signer lazily, so a
 * process that only reads never reaches this function — which is what lets
 * `env -u SUI_PRIVATE_KEY pnpm run markets` work.
 */
export function loadWallet(): WalletInfo {
  const key = process.env.SUI_PRIVATE_KEY?.trim();
  if (!key) {
    throw new Error(
      "SUI_PRIVATE_KEY not set. Run `pnpm run generate-wallet` to create one, " +
        "or set SUI_PRIVATE_KEY in .env yourself (bech32 suiprivkey1...). " +
        "Read-only commands — markets, ticker, positions, orders — need no key at all.",
    );
  }
  const keypair = Ed25519Keypair.fromSecretKey(key);
  const address = keypair.getPublicKey().toSuiAddress();
  return { keypair, address, secretKey: key };
}

/**
 * Update or append a key=value pair in the .env file.
 */
export function saveToEnv(key: string, value: string): void {
  let content = "";
  if (existsSync(ENV_PATH)) {
    content = readFileSync(ENV_PATH, "utf8");
  }

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escapedKey}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    if (content && !content.endsWith("\n")) content += "\n";
    content += `${key}=${value}\n`;
  }

  writeFileSync(ENV_PATH, content, "utf8");
}

/**
 * Load existing wallet or generate a new one.
 * If generated, saves the secret key to .env automatically.
 *
 * This is what `pnpm run generate-wallet` runs. There is no `setup` script;
 * earlier revisions of this file pointed at one that never existed.
 */
export function getOrCreateWallet(): WalletInfo & { isNew: boolean } {
  const key = process.env.SUI_PRIVATE_KEY?.trim();
  if (key) {
    // Key exists — load it (let errors propagate if the key is malformed)
    const wallet = loadWallet();
    return { ...wallet, isNew: false };
  }
  // No key configured — generate a new wallet
  const wallet = generateWallet();
  saveToEnv("SUI_PRIVATE_KEY", wallet.secretKey);
  return { ...wallet, isNew: true };
}
