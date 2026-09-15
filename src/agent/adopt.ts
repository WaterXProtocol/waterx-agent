/**
 * Whether an account can be adopted by this wallet: settled on chain, not taken on trust.
 *
 * `discover` found it; a person chose it; this is the last check before the
 * choice is written down. It re-reads the account because minutes may have
 * passed and the grant may be gone — and because the account id reached here
 * from a command line, which is not a source of truth.
 */
import { normalizeSuiAddress } from "@mysten/sui/utils";

import type { AccountObjectReader } from "../chain/account-object.ts";

/** The account exists but does not (or no longer) grant this wallet anything. */
export class NotAGrantError extends Error {
  readonly name = "NotAGrantError";
}

export interface Adoptable {
  accountId: string;
  /** Read from the Account object — what the agent will act on behalf of. */
  ownerAddress: string;
  /** The label the grant wrote, read from chain now rather than from discovery earlier. */
  alias: string;
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
  return {
    accountId: account.accountId,
    ownerAddress: account.owner,
    alias: entry.alias,
    expiresAtMs: entry.expiresAtMs,
  };
}
