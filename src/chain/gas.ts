/**
 * How much SUI an address holds, for paying for transactions.
 *
 * Its own module because two callers need it and they need it for different
 * reasons: `bootstrap` decides whether to bother the faucet, and the guidance
 * in `agent/guidance.ts` needs to know that an empty wallet — not a missing
 * account — is why account creation keeps failing. Without that, an agent
 * following the guidance loops: create the account, watch it fail, be told to
 * create the account.
 */
import type { AgentConfig } from "../config.ts";

/** Below this, a transaction may not have gas to pay for itself. */
export const MIN_GAS_SUI = 0.02;

/**
 * SUI held by an address, or `undefined` when the fullnode could not say.
 *
 * `undefined` is not zero, and the distinction matters at both call sites.
 * Treating a failed lookup as an empty wallet would send every run to the
 * faucet during a fullnode wobble, and would report "no gas" as the reason for
 * a failure that had nothing to do with gas.
 */
export async function gasBalance(
  config: AgentConfig,
  owner: string,
): Promise<number | undefined> {
  try {
    const { SuiGrpcClient } = await import("@mysten/sui/grpc");
    const client = new SuiGrpcClient({ network: config.network, baseUrl: config.grpcUrl });
    const result = (await client.core.getBalance({ owner, coinType: "0x2::sui::SUI" })) as {
      balance?: { balance?: string | number };
    };
    return Number(result.balance?.balance ?? 0) / 1e9;
  } catch {
    return undefined;
  }
}
