/**
 * A code this agent issues, and the owner's grant carries back.
 *
 * `add_delegate` asks nothing of the delegate, so anyone can make this wallet a
 * delegate of THEIR account, and `discover` cannot tell that grant from the
 * owner's: both are real, and both are on chain. `adopt` used to settle it with
 * a name typed on the command line — which a person could mean and anything at
 * the terminal could type, and which proved nothing about the grant either way.
 *
 * The grant can prove it itself. It is the owner's own signed transaction, and
 * `add_delegate` writes an `alias` into the delegate entry. So `onboard` mints a
 * code, the authorize link carries it as `label`, a console that supports it
 * writes it into the grant, and `adopt` reads it back off the chain. A grant carrying the code was made by
 * whoever received this agent's link: the agent cannot write it into somebody
 * else's account, and a stranger who never saw the link cannot guess it.
 *
 * What it does not prove is that the link reached only the owner. The code is a
 * secret until a grant uses it and public afterwards, so a second grant carrying
 * it is a copy — and then `adopt` asks a person instead of choosing.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { normalizeSuiAddress } from "@mysten/sui/utils";

import type { Network } from "../config.ts";

export const PAIRING_FILE = process.env.WATERX_PAIRING_FILE?.trim() || ".waterx/pairing.json";

/** `waterx_account` aborts a longer alias (`ALIAS_MAX_LENGTH`, counted in bytes). */
export const ALIAS_MAX_BYTES = 64;

/** What the agent calls itself when nobody named it. */
export const DEFAULT_LABEL = "waterx-agent";

/**
 * ASCII letters, digits and `._-` for the label; one `:`; the code.
 *
 * Narrow on purpose. The alias is shown to the owner on the authorize page and
 * in their delegate list, so nothing in it may render as something it is not,
 * and ASCII keeps "64 bytes" and "64 characters" the same number.
 */
const LABEL_PATTERN = /^[A-Za-z0-9._-]+$/;
const ALIAS_PATTERN = /^[A-Za-z0-9._-]+:[0-9A-HJKMNP-TV-Z]{12}$/;

/** Crockford base32: no I, L, O or U, so a code read aloud is not misread. 32 divides 256, so no bias. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 60 bits. A guess costs an on-chain grant, so this is far past what guessing can reach. */
const CODE_LENGTH = 12;

export interface Pairing {
  v: 1;
  network: Network;
  /** The agent wallet the code was issued for. A different wallet gets a different code. */
  delegate: string;
  /** `<label>:<code>` — exactly what the owner's grant must carry. */
  alias: string;
  createdAt: number;
}

/** Whether a string is shaped like an alias this module minted. */
export const isPairingAlias = (alias: string): boolean =>
  Buffer.byteLength(alias, "utf8") <= ALIAS_MAX_BYTES && ALIAS_PATTERN.test(alias);

export function mintAlias(
  label: string = DEFAULT_LABEL,
  random: (size: number) => Uint8Array = randomBytes,
): string {
  const longest = ALIAS_MAX_BYTES - 1 - CODE_LENGTH;
  if (label.length === 0 || label.length > longest || !LABEL_PATTERN.test(label)) {
    throw new Error(
      `The label "${label}" cannot name a grant: use 1–${String(longest)} characters from ` +
        `A–Z, a–z, 0–9, ".", "_" and "-".`,
    );
  }
  const bytes = random(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[(bytes[i] ?? 0) & 31];
  return `${label}:${code}`;
}

/**
 * The pairing issued for this wallet on this network, if there is one.
 *
 * Anything else — no file, an unreadable one, another wallet's, another
 * network's — is no pairing. That fails closed: with nothing to match, a grant
 * is unpaired and adopting it needs a person.
 */
export function loadPairing(
  delegate: string,
  network: Network,
  path: string = PAIRING_FILE,
): Pairing | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: Partial<Pairing>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Pairing>;
  } catch {
    return undefined;
  }
  if (
    parsed.v !== 1 ||
    parsed.network !== network ||
    typeof parsed.delegate !== "string" ||
    typeof parsed.alias !== "string" ||
    typeof parsed.createdAt !== "number" ||
    normalizeSuiAddress(parsed.delegate) !== normalizeSuiAddress(delegate) ||
    !isPairingAlias(parsed.alias)
  ) {
    return undefined;
  }
  return parsed as Pairing;
}

/**
 * The pairing for this wallet, minted on first use and never re-minted after.
 *
 * Stable because a link already handed to an owner has to go on matching: a
 * code that changed every time `onboard` ran would unpair the grant they are
 * about to sign. So a `label` only takes effect when the code is first minted.
 */
export function ensurePairing(
  input: { delegate: string; network: Network; label?: string },
  path: string = PAIRING_FILE,
  now: number = Date.now(),
  random?: (size: number) => Uint8Array,
): { pairing: Pairing; created: boolean } {
  const existing = loadPairing(input.delegate, input.network, path);
  if (existing !== undefined) return { pairing: existing, created: false };
  const pairing: Pairing = {
    v: 1,
    network: input.network,
    delegate: normalizeSuiAddress(input.delegate),
    alias: mintAlias(input.label ?? DEFAULT_LABEL, random),
    createdAt: now,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(pairing, null, 2)}\n`, "utf8");
  return { pairing, created: true };
}
