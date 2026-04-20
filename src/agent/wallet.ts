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
 */
export function loadWallet(): WalletInfo {
  const key = process.env.SUI_PRIVATE_KEY?.trim();
  if (!key) {
    throw new Error(
      "SUI_PRIVATE_KEY not set. Run `npm run setup` to generate a wallet, " +
        "or set SUI_PRIVATE_KEY in .env (bech32 suiprivkey1...).",
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

  const regex = new RegExp(`^${key}=.*$`, "m");
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
 */
export function getOrCreateWallet(): WalletInfo & { isNew: boolean } {
  try {
    const wallet = loadWallet();
    return { ...wallet, isNew: false };
  } catch {
    const wallet = generateWallet();
    saveToEnv("SUI_PRIVATE_KEY", wallet.secretKey);
    return { ...wallet, isNew: true };
  }
}
