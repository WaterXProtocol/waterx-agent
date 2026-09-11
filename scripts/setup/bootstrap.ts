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
import { gasBalance, MIN_GAS_SUI } from "../../src/chain/gas.ts";
import { ensureEnvIgnored } from "../../src/chain/secrets.ts";
import { envPath, getOrCreateWallet, saveToEnv } from "../../src/chain/wallet.ts";
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
  note(`  wallet     ${wallet.address}`);

  // A key was just written into the caller's project, which is usually a git
  // repository, and a fresh one has no `.gitignore` at all. Closing that door
  // is finishing what this command started, not a liberty taken with someone
  // else's repo.
  let ignored: ReturnType<typeof ensureEnvIgnored> | undefined;
  if (wallet.isNew) {
    ignored = ensureEnvIgnored();
    note(`             new key written to ${envPath()}`);
    if (ignored.kind === "added") {
      note(`             .env added to ${ignored.gitignore} so it cannot be committed`);
    } else if (ignored.kind === "already") {
      note(`             .env is already ignored by git`);
    } else if (ignored.kind === "failed") {
      note(`             ⚠ could not check .gitignore (${ignored.reason}) — make sure .env is ignored`);
      remaining.push({
        what: "keep the private key out of git",
        why: `.env holds a private key and this could not confirm it is ignored: ${ignored.reason}`,
        who: "you",
      });
    }
  }

  // ── Gas ─────────────────────────────────────────────────────────────────
  // A rate-limited faucet is not a failure of the setup; it is a queue. It is
  // reported as remaining work rather than thrown, so the rest still runs.
  const agent = initAgent();

  /**
   * Which arrangement this wallet is being set up for.
   *
   * `--create-account` is the owner path and says so. Everything else is the
   * delegate path, where the owner keeps the account and the funds and this
   * wallet only gets permission to trade — so it needs no SUI (the backend
   * sponsors a delegate's transactions), no account of its own and no
   * collateral. Asking a would-be delegate to fund a wallet is asking them to
   * solve a problem they do not have, and this command did exactly that.
   */
  const ownerPath = args.createAccount === "true" || agent.config.accountId !== undefined;

  // Asked for only when it is actually needed. A wallet that already holds gas
  // does not want the faucet, and asking anyway turned a busy faucet — shared
  // by everyone on this IP — into a reported fault on a setup that was fine.
  const gas = await gasBalance(agent.config, wallet.address);
  note(
    `  gas        ${gas === undefined ? "balance unknown" : `${String(gas)} SUI`}` +
      (ownerPath ? "" : "  (not needed — the backend sponsors a delegate's transactions)"),
  );
  const needsGas = ownerPath && gas !== undefined && gas < MIN_GAS_SUI;
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
    // On the delegate path there is nothing to create: the account is the
    // owner's, and what is missing is their grant, not an account.
    remaining.push(
      ownerPath
        ? {
            what: "a WaterX account",
            why: "every account-scoped write refuses without one",
            who: "you",
            command: invoke("bootstrap", "--create-account", "--yes", "--json"),
          }
        : {
            what: "the owner's grant",
            why:
              `nothing has been granted to ${wallet.address} yet. The account owner grants it ` +
              `trading permission from their own wallet — they keep the funds, this wallet ` +
              `cannot withdraw them, and it needs no SUI of its own. Then set ` +
              `WATERX_OWNER_ADDRESS and WATERX_ACCOUNT_ID to what they give you.`,
            who: "an operator",
            command: invoke("onboard", "--json"),
          },
    );
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

  // Only on the owner path. Collateral belongs to whoever holds the account,
  // and on the delegate path that is not this wallet — telling a would-be
  // delegate to fund itself is the same mistake as telling it to buy gas.
  //
  // Within the owner path it is reported even before there is an account to
  // hold it: on testnet it is the one item that needs someone else, so it is
  // the one with a lead time, and an agent that mentions it on the second round
  // trip has already sent the user away to do two other things first.
  if (free <= 0 && ownerPath) {
    // `who` differs by deployment and is the field an agent acts on. On testnet
    // the credit faucet is whitelist-gated, so no amount of trying gets you
    // there and the answer is to ask a person. On mainnet there is nobody to
    // ask: you send yourself USDC. Telling a mainnet user to find an operator
    // sends them looking for someone who does not exist.
    const onTestnet = agent.config.network === "testnet";
    remaining.push({
      what: "trading collateral",
      why: onTestnet
        ? "gas is not collateral, and testnet's credit faucet is whitelist-gated — there is " +
          "no self-service route, so this is the one to start asking about first"
        : "gas is not collateral: the wallet needs USDC or USDsui of its own to mint credit " +
          "against, and on mainnet you send that to it yourself",
      who: onTestnet ? "an operator" : "you",
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
      ...(ignored === undefined ? {} : { envIgnored: ignored }),
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
