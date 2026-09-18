/**
 * Whether an account can be adopted by this wallet: settled on chain, not taken on trust.
 *
 * `discover` found it; this is the last check before it is written down. It
 * re-reads the account because minutes may have passed and the grant may be
 * gone — and because the account id reached here from a command line, which is
 * not a source of truth.
 */
import { normalizeSuiAddress } from "@mysten/sui/utils";

import type { AccountObjectReader } from "../chain/account-object.ts";
import { ensureEnvIgnored, type IgnoreOutcome } from "../chain/secrets.ts";
import { saveToEnv } from "../chain/wallet.ts";
import { type AdoptionRecord, recordAdoption, resolveApprover } from "./adoptions.ts";

/** The account exists but does not (or no longer) grant this wallet anything. */
export class NotAGrantError extends Error {
  readonly name = "NotAGrantError";
}

/**
 * The configured owner and the chain disagree about who owns the account.
 *
 * A leftover `WATERX_OWNER_ADDRESS` would make every write claim the wrong
 * principal, so this refuses rather than writing a contradiction down.
 */
export class OwnerMismatchError extends Error {
  readonly name = "OwnerMismatchError";
}

export interface Adoptable {
  accountId: string;
  /** Read from the Account object — what the agent will act on behalf of. */
  ownerAddress: string;
  expiresAtMs: number | null;
}

export async function verifyAdoptable(input: {
  accountId: string;
  delegate: string;
  readAccount: AccountObjectReader;
  now?: number;
}): Promise<Adoptable> {
  const me = normalizeSuiAddress(input.delegate);
  const account = await input.readAccount(input.accountId);
  if (account.owner === me) {
    throw new NotAGrantError(
      `${me} OWNS ${account.accountId}; it is not a delegate of it. Adoption is for a wallet an ` +
        `owner granted. An owner key trades its own account with WATERX_ACCOUNT_ID alone.`,
    );
  }
  const entry = account.delegates.find((d) => d.address === me);
  if (entry === undefined) {
    throw new NotAGrantError(
      `${me} is not a delegate of ${account.accountId} on chain. The owner has to grant it ` +
        `first — \`onboard\` prints where.`,
    );
  }
  const now = input.now ?? Date.now();
  if (entry.expiresAtMs !== null && now >= entry.expiresAtMs) {
    throw new NotAGrantError(
      `${me} was a delegate of ${account.accountId}, but that grant expired at ` +
        `${new Date(entry.expiresAtMs).toISOString()}. The owner must remove it and grant again.`,
    );
  }
  return { accountId: account.accountId, ownerAddress: account.owner, expiresAtMs: entry.expiresAtMs };
}

/**
 * The side effects of adopting, named so a test can watch them instead of
 * writing to the developer's own `.env`.
 *
 * They are not incidental. Adoption is the moment this package starts acting on
 * someone's account, and it leaves two marks: the id it will trade, and a line
 * in the ledger saying who took it and when.
 */
export interface AdoptionEffects {
  ensureEnvIgnored: () => IgnoreOutcome;
  saveToEnv: (key: string, value: string) => void;
  recordAdoption: (input: Omit<AdoptionRecord, "v" | "at">) => AdoptionRecord;
}

const REAL_EFFECTS: AdoptionEffects = {
  ensureEnvIgnored: () => ensureEnvIgnored(),
  saveToEnv,
  recordAdoption: (input) => recordAdoption(input),
};

export interface Adopted extends Adoptable {
  delegate: string;
  /** The name on the record: the one given, or a generated id. */
  by: string;
  generated: boolean;
  gitignore: IgnoreOutcome;
}

/**
 * Take the account: check the grant on chain, then write it down.
 *
 * Lives here rather than in the `adopt` script because two commands do it —
 * `adopt`, and `onboard --wait` once the grant it was waiting for arrives — and
 * the order matters. The `.gitignore` rule goes in BEFORE the ledger line: the
 * ledger records which account this agent trades, and a project that ignored
 * only `.env` would otherwise commit it.
 *
 * It re-reads the account rather than trusting what discovery found, because
 * minutes may have passed and the grant may be gone.
 */
export async function adoptAccount(input: {
  accountId: string;
  delegate: string;
  network: string;
  readAccount: AccountObjectReader;
  /** `WATERX_OWNER_ADDRESS`, when something set it. Checked, never written. */
  configuredOwner?: string;
  approver?: string;
  now?: number;
  effects?: AdoptionEffects;
}): Promise<Adopted> {
  const effects = input.effects ?? REAL_EFFECTS;
  const adoptable = await verifyAdoptable({
    accountId: input.accountId,
    delegate: input.delegate,
    readAccount: input.readAccount,
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  if (
    input.configuredOwner !== undefined &&
    normalizeSuiAddress(input.configuredOwner) !== adoptable.ownerAddress
  ) {
    throw new OwnerMismatchError(
      `WATERX_OWNER_ADDRESS is ${input.configuredOwner}, but ${adoptable.accountId} is owned by ` +
        `${adoptable.ownerAddress} on chain. Remove WATERX_OWNER_ADDRESS from .env — the owner is ` +
        `read from the account — then adopt again.`,
    );
  }

  const approver = resolveApprover(input.approver);
  const gitignore = effects.ensureEnvIgnored();
  effects.saveToEnv("WATERX_ACCOUNT_ID", adoptable.accountId);
  effects.recordAdoption({
    accountId: adoptable.accountId,
    ownerAddress: adoptable.ownerAddress,
    delegate: normalizeSuiAddress(input.delegate),
    network: input.network,
    by: approver.by,
    generated: approver.generated,
  });

  return { ...adoptable, delegate: input.delegate, ...approver, gitignore };
}
