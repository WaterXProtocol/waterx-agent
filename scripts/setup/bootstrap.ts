/**
 * Get from a clean checkout to "ready, except for the things a person must
 * arrange" — in one command, and tell the caller precisely which those are.
 *
 * The setup was six commands whose failures an agent had to interpret one at a
 * time: a rate-limited faucet, an indexer that lags, an account id to copy into
 * a file by hand. Each is fine for a human reading a README and wrong for an
 * automated caller, which will either stop at the first surprise or improvise
 * past it.
 *
 * So this does every step that can be done without a person, and returns the
 * rest as **structured work items** — what is missing, why, who can supply it,
 * and the exact command. An agent reads `remaining` and reports it; it does not
 * have to know what a credit faucet is.
 *
 * ## What it will and will not do
 *
 * It generates a wallet and asks the faucet for gas: neither commits anything
 * and both are idempotent. It signs **nothing** unless `--yes` is passed, and
 * then only `createAccount`, which moves no funds. It never deposits — that
 * commits money, and money is a decision.
 */
import { getOrCreateWallet, saveToEnv } from "../../src/chain/wallet.ts";
import { runDoctor } from "../../src/doctor.ts";
import { signerReadiness } from "../../src/chain/create-signer.ts";
import { invoke, succeeded } from "../../src/cli/contract.ts";
import { confirmed, initAgent, note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";

const args = parseArgs(
  {
    createAccount: {
      desc: "Also create a WaterX account. Signs one transaction; moves no funds. Needs --yes",
      flag: true,
    },
    skipFaucet: { desc: "Do not ask the faucet for gas", flag: true },
  },
  "bootstrap",
);

/** The one command the whole setup exists to make runnable. */
const TRADE_COMMAND = invoke(
  "preview",
  "--action open-long",
  "--ticker <market>",
  "--collateral <n>",
  "--leverage <n>",
  "--slippage <n>",
  "--json",
);

/** Below this, a transaction may not have gas to pay for itself. */
const MIN_GAS_SUI = 0.02;

/** One thing a person still has to do, in a shape an agent can relay verbatim. */
interface Step {
  what: string;
  why: string;
  /** Who can do it — the distinction between "run this" and "ask someone". */
  who: "you" | "an operator";
  command?: string;
  /**
   * Whether waiting is the whole remedy.
   *
   * A rate-limited faucet is a queue, not a misconfiguration, and an agent told
   * `config` about it stops and reports a fault instead of trying again in a
   * minute. The overall status is derived from these.
   */
  transient?: boolean;
}

await run(async () => {
  const done: string[] = [];
  const remaining: Step[] = [];

  // ── A wallet ────────────────────────────────────────────────────────────
  const hadKey = signerReadiness(initAgent().config).ready;
  const wallet = getOrCreateWallet();
  done.push(hadKey ? `wallet ${wallet.address} (already configured)` : `generated wallet ${wallet.address}`);
  note(`  wallet     ${wallet.address}${wallet.isNew ? "  (new — key saved to .env)" : ""}`);

  // ── Gas ─────────────────────────────────────────────────────────────────
  // A rate-limited faucet is not a failure of the setup; it is a queue. It is
  // reported as remaining work rather than thrown, so the rest still runs.
  const agent = initAgent();
  // Asked for only when it is actually needed. A wallet that already holds gas
  // does not want the faucet, and asking anyway turned a busy faucet — shared
  // by everyone on this IP — into a reported fault on a setup that was fine.
  const gas = await gasBalance(agent, wallet.address);
  note(`  gas        ${gas === undefined ? "balance unknown" : `${String(gas)} SUI`}`);
  const needsGas = gas !== undefined && gas < MIN_GAS_SUI;
  if (args.skipFaucet !== "true" && agent.config.network === "testnet" && needsGas) {
    try {
      const { getFaucetHost, requestSuiFromFaucetV2 } = await import("@mysten/sui/faucet");
      await requestSuiFromFaucetV2({ host: getFaucetHost("testnet"), recipient: wallet.address });
      done.push("requested testnet gas");
      note("             requested more from the testnet faucet");
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      remaining.push({
        what: "testnet gas",
        why: `the faucet did not answer: ${why.slice(0, 120)}`,
        who: "you",
        command: invoke("fund-sui", "--json"),
        transient: true,
      });
      note(`             faucet declined — ${why.slice(0, 80)}`);
    }
  } else if (gas !== undefined && !needsGas) {
    done.push(`gas ${String(gas)} SUI`);
  }

  // ── An account ──────────────────────────────────────────────────────────
  let accountId = agent.config.accountId;
  const owned = await agent.accounts(wallet.address);
  if (accountId === undefined && owned.length > 0) {
    // Already created on a previous run, just never written down.
    accountId = owned[0]?.accountId;
  }

  if (accountId === undefined && args.createAccount === "true" && confirmed()) {
    const plan = await agent.planCreateAccount({ name: "agent" });
    await agent.submit(plan, { confirm: true });
    note("  account    created — waiting for the indexer…");
    // The id is assigned by the indexer, not returned by the transaction, so
    // it has to be waited for. Polling here is the difference between one
    // command and "run this again in a moment".
    accountId = await waitForAccount(agent, wallet.address);
    if (accountId === undefined) {
      remaining.push({
        what: "the new account's id",
        why: "the indexer had not published it yet",
        who: "you",
        command: invoke("accounts", "--json"),
      });
    }
  }

  if (accountId === undefined) {
    remaining.push({
      what: "a WaterX account",
      why: "every account-scoped write refuses without one",
      who: "you",
      command: invoke("bootstrap", "--create-account", "--yes", "--json"),
    });
  } else {
    if (agent.config.accountId !== accountId) {
      // Written back rather than printed. "Copy this id into .env" is a step an
      // agent has to do by editing a file, which is the one thing it should not
      // be improvising.
      saveToEnv("WATERX_ACCOUNT_ID", accountId);
      note(`  account    ${accountId}  (written to .env)`);
      done.push(`account ${accountId} written to .env`);
    } else {
      note(`  account    ${accountId}`);
      done.push(`account ${accountId}`);
    }
  }

  // ── Collateral ──────────────────────────────────────────────────────────
  // Named even when everything else worked, because it is the step that
  // surprises people: gas is not collateral, and there is no self-service
  // route to the latter on testnet.
  const free =
    accountId === undefined
      ? 0
      : ((await agent.read.overview(accountId)) as { freeMargin?: number }).freeMargin ?? 0;
  if (accountId !== undefined) note(`  collateral $${String(free)} free margin`);

  // Reported even before there is an account to hold it. It is the only item
  // that needs someone else, so it is the only one with a lead time — an agent
  // that learns about it on the second round trip has already sent the user
  // away to do the first two, and the whitelist request could have been in
  // flight the whole time.
  if (free <= 0) {
    remaining.push({
      what: "trading collateral",
      why:
        agent.config.network === "testnet"
          ? "gas is not collateral, and testnet's credit faucet is whitelist-gated — there is " +
            "no self-service route, so this is the one to start asking about first"
          : "the wallet holds no backing asset to mint credit against",
      who: "an operator",
      command: `${invoke("deposit", "--amount <n>", "--yes", "--json")}  (once the wallet holds USDC or USDsui)`,
    });
  }

  // ── Everything the preflight knows ──────────────────────────────────────
  const report = await runDoctor();
  for (const check of report.checks) {
    if (check.status === "fail") {
      remaining.push({ what: check.name, why: check.detail, who: "you" });
    }
  }

  note("");
  if (remaining.length === 0) {
    note(`  Ready to trade. Next:`);
    note(`    ${TRADE_COMMAND}`);
  } else {
    note(`  ${String(remaining.length)} thing(s) left:`);
    for (const step of remaining) {
      note(`    • ${step.what} — ${step.who === "you" ? "you" : "ASK AN OPERATOR"}`);
      note(`      ${step.why}`);
      if (step.command !== undefined) note(`      ${step.command}`);
    }
  }
  note("");

  show(
    {
      network: agent.config.network,
      address: wallet.address,
      accountId: accountId ?? null,
      readReady: report.readReady,
      writeReady: report.writeReady,
      done,
      remaining,
      tradeCommand: TRADE_COMMAND,
    },
    { rendered: true },
  );

  // Transient-only work is `unavailable`: the remedy is to wait, and an agent
  // told `config` would stop and report a fault instead of trying again.
  const allTransient = remaining.every((step) => step.transient === true);
  setOutcome(
    remaining.length === 0
      ? succeeded("ready to trade")
      : {
          status: allTransient ? "unavailable" : "config",
          retryable: allTransient,
          message:
            `${String(remaining.length)} thing(s) still needed: ` +
            remaining.map((s) => s.what).join(", "),
          submitted: false,
          reconcileRequired: false,
          awaitingApproval: false,
          details: { remaining },
        },
  );
});

/**
 * SUI held by an address, or `undefined` when the fullnode could not say.
 *
 * `undefined` is not zero. Treating a failed lookup as an empty wallet would
 * send every run to the faucet during a fullnode wobble.
 */
async function gasBalance(
  agent: ReturnType<typeof initAgent>,
  owner: string,
): Promise<number | undefined> {
  try {
    const { SuiGrpcClient } = await import("@mysten/sui/grpc");
    const client = new SuiGrpcClient({
      network: agent.config.network,
      baseUrl: agent.config.grpcUrl,
    });
    const result = (await client.core.getBalance({
      owner,
      coinType: "0x2::sui::SUI",
    })) as { balance?: { balance?: string | number } };
    return Number(result.balance?.balance ?? 0) / 1e9;
  } catch {
    return undefined;
  }
}

/** The indexer publishes the id a moment after the transaction lands. */
async function waitForAccount(
  agent: ReturnType<typeof initAgent>,
  owner: string,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const accounts = await agent.accounts(owner);
    const found = accounts[0]?.accountId;
    if (found !== undefined) return found;
  }
  return undefined;
}
