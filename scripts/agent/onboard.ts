/**
 * The delegate handshake, from either side of it — and with `--wait`, through
 * to the end of it.
 *
 * An agent that trades an account it does not own needs one thing from a
 * person: a grant, made on chain from the wallet that owns the account. This
 * command says where that has got to and what the next move is — for the agent
 * ("give this link to the owner") and for the owner ("grant it here").
 *
 * It reads; it never grants. The grant is the owner's act, made from their own
 * wallet, and an agent that could make it for them would be an agent that could
 * grant itself authority.
 *
 * `--wait` is the one thing it writes, and only after the owner has acted: it
 * polls for the grant and, when exactly one account turns out to have made it,
 * adopts that account — `WATERX_ACCOUNT_ID` and a line in the adoption ledger.
 * That is the step that used to depend on a person typing "I signed it" into a
 * chat window, while the console's own completion screen was already telling
 * them the agent would pick it up within seconds. Between several grants it
 * still stops and asks: which account an agent trades is whose money it trades.
 */
import { adoptAccount, NotAGrantError, OwnerMismatchError } from "../../src/agent/adopt.ts";
import {
  completeHandshakeCommand,
  DELEGATE_BOUNDARY,
  delegationStatus,
  handshakeScreen,
  perpGrantCommand,
  REQUESTED_PERMISSION_NAMES,
  REQUESTED_PERP_PERMISSIONS,
  requestedPermissions,
} from "../../src/agent/delegation.ts";
import {
  awaitGrants,
  DEFAULT_POLL_SECONDS,
  type DiscoveredGrant,
  discoverGrants,
  type DiscoveryDeps,
  MIN_POLL_SECONDS,
} from "../../src/agent/discovery.ts";
import { AccountNotFoundError, accountObjectReader } from "../../src/chain/account-object.ts";
import {
  browserSuppressed,
  openedRecently,
  openUrl,
  rememberOpened,
} from "../../src/cli/open-url.ts";
import { qrLines } from "../../src/cli/qr.ts";
import { signerReadiness } from "../../src/chain/create-signer.ts";
import { loadDeployment } from "../../src/chain/deployment.ts";
import { grantEventCandidates } from "../../src/chain/grant-events.ts";
import { invoke, succeeded } from "../../src/cli/contract.ts";
import type { DelegateData } from "../../src/api/types.ts";
import { asNumber, initAgent, note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";

const args = parseArgs(
  {
    label: {
      desc: "A name for this agent, shown to the owner on the authorization screen",
    },
    details: {
      desc: "Print the full consent account: every permission asked for, the CLI route, where to revoke",
      flag: true,
    },
    link: {
      desc: "Print only the authorize link — one line, for pasting or piping",
      flag: true,
    },
    wait: {
      desc: "Wait this many seconds for the owner's grant, then adopt the account that made it (writes WATERX_ACCOUNT_ID)",
    },
    interval: { desc: `Seconds between looks while waiting (default ${String(DEFAULT_POLL_SECONDS)})` },
    qr: {
      desc: "Draw the authorize link as a QR code, for an owner who is not at this machine",
      flag: true,
    },
    open: {
      desc: "Open the authorize page now, even if it was opened here recently or a browser was turned off",
      flag: true,
    },
    noOpen: {
      desc: "Do not open a browser this time (WATERX_NO_BROWSER=1 turns it off for good)",
      flag: true,
    },
  },
  "onboard",
);

const quiet = { submitted: false, reconcileRequired: false } as const;

/**
 * Where discovery looks: the backend's index first, recent grant events when it
 * cannot answer, and the chain for every candidate either way.
 *
 * Built in one place because two paths need it — the look this command makes
 * before it reports anything, and the wait `--wait` runs afterwards.
 */
async function discoveryDeps(agent: ReturnType<typeof initAgent>): Promise<DiscoveryDeps> {
  const deployment = await loadDeployment(agent.config.configUrl);
  // The ORIGINAL package id names event types; `idsFor` lists it last.
  const accountPackage = deployment.idsFor("waterx_account").at(-1);
  return {
    delegatedAccounts: (delegate) => agent.read.delegatedAccounts(delegate),
    recentGrantEvents:
      accountPackage === undefined
        ? () => Promise.reject(new Error("the deployment config names no waterx_account package"))
        : grantEventCandidates(agent.config.network, accountPackage),
    readAccount: accountObjectReader(agent.config),
  };
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Nothing in flight, nothing signed: every outcome this command can reach is one of these. */
const config = (message: string, extra: { retryable?: boolean; nextCommand?: string } = {}) => ({
  ...quiet,
  status: "config" as const,
  message,
  retryable: extra.retryable ?? false,
  awaitingApproval: false,
  ...(extra.nextCommand === undefined ? {} : { nextCommand: extra.nextCommand }),
});

await run(async () => {
  const agent = initAgent();
  const ready = signerReadiness(agent.config);

  // The address only when a key exists. Asking for it otherwise would load one
  // that is not there and fail with a message about wallets.
  const delegateAddress = ready.ready ? agent.signer.address : undefined;
  // Derived from the account when only WATERX_ACCOUNT_ID is configured.
  try {
    await agent.resolveIdentity();
  } catch {
    // Left unset: reported below as unconfirmed, never guessed.
  }
  const ownerAddress = agent.config.ownerAddress;
  const accountId = agent.config.accountId;

  // Only asked for when there is something to ask about; a failed lookup is
  // reported as unconfirmed rather than as an absent grant.
  let delegates: DelegateData[] | undefined;
  if (accountId !== undefined && delegateAddress !== undefined && ownerAddress !== undefined) {
    try {
      delegates = await agent.read.delegates(accountId);
    } catch {
      delegates = undefined;
    }
  }

  // Ask before reporting. A grant is keyed on the wallet, so it can be found
  // with no account id — and reporting "nothing is granted" without asking is
  // how a wallet that had been granted minutes earlier sent its owner back to
  // a link they had already used. A failed look is left `undefined`, which
  // reads as "nobody knows", never as "none".
  let discovered: readonly DiscoveredGrant[] | undefined;
  if (delegateAddress !== undefined && accountId === undefined) {
    try {
      discovered = (await discoverGrants(delegateAddress, await discoveryDeps(agent))).grants;
    } catch {
      discovered = undefined;
    }
  }

  const status = delegationStatus({
    network: agent.config.network,
    ...(discovered === undefined ? {} : { discovered }),
    ...(args.label === undefined ? {} : { label: args.label }),
    ...(delegateAddress === undefined
      ? {}
      : {
          grantCommand: perpGrantCommand({
            agentWallet: delegateAddress,
            ...(accountId === undefined ? {} : { accountId }),
            invoke,
          }),
        }),
    ...(delegateAddress === undefined ? {} : { delegateAddress }),
    ...(ownerAddress === undefined ? {} : { ownerAddress }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(delegates === undefined ? {} : { delegates }),
  });

  const payload = {
    ...status,
    network: agent.config.network,
    grantCommand: status.grantCommand ?? null,
    requestedPerpPermissions: REQUESTED_PERP_PERMISSIONS,
    requestedPermissionNames: Object.keys(REQUESTED_PERMISSION_NAMES),
    // The same list with what each bit does, so an agent relaying it relays
    // the meaning too — and the one sentence on what the grant cannot do.
    requestedPermissions: requestedPermissions(),
    delegateCannot: DELEGATE_BOUNDARY,
  };

  // ── --link: the one line, and nothing else ──────────────────────────────
  // For a person who is about to paste it somewhere, and for `$(…)`. Anything
  // else on stdout would have to be stripped by whoever called it.
  if (args.link === "true") {
    if (status.authorizeUrl === undefined) {
      show({ ...payload, next: null }, { rendered: true });
      setOutcome(
        config(
          `No perp authorize page is known for this console, so there is no link to print. ` +
            `Name one in WATERX_PERP_AUTHORIZE_URL, or have the owner grant it from a terminal.`,
          { nextCommand: invoke("onboard", "--details") },
        ),
      );
      return;
    }
    note(status.authorizeUrl);
    show({ ...payload, next: completeHandshakeCommand() }, { rendered: true });
    setOutcome(succeeded(status.authorizeUrl, { nextCommand: completeHandshakeCommand() }));
    return;
  }

  const waitSeconds = asNumber(args.wait);
  const granted = status.state === "granted" || status.state === "owner-key";
  // Already granted, just not written down: `--wait` has nothing to wait for
  // and goes straight to adopting it.
  const readyToAdopt = status.state === "granted-not-adopted";
  // Waiting needs a wallet to have been granted TO, and something still to
  // wait for. Asked for otherwise it is not an error — it is just nothing.
  const waiting =
    waitSeconds !== undefined && waitSeconds >= 0 && delegateAddress !== undefined && !granted;

  // Colour only where something can render it. A code drawn as ink on the
  // terminal's own background inverts on a dark theme; explicit colours make it
  // scan either way, and are noise in a log file.
  const drawn =
    args.qr === "true" && status.authorizeUrl !== undefined
      ? qrLines(status.authorizeUrl, {
          color:
            process.env.NO_COLOR === undefined &&
            (process.stdout.isTTY === true || process.stderr.isTTY === true),
        })
      : undefined;

  const firstGrant = status.grants?.[0];
  const next = waiting
    ? undefined
    : status.state === "no-wallet"
      ? invoke("bootstrap", "--json")
      : granted
        ? invoke("next", "--json")
        : readyToAdopt && status.grants?.length === 1 && firstGrant !== undefined
          ? invoke("adopt", "--account", firstGrant.accountId, "--json")
          : readyToAdopt
            ? invoke("discover", "--json")
            : completeHandshakeCommand();

  for (const line of handshakeScreen(status, {
    details: args.details === "true",
    ...(next === undefined ? {} : { next }),
    ...(drawn === undefined ? {} : { qr: drawn }),
  })) {
    note(line);
  }

  if (args.qr === "true" && drawn === undefined) {
    note(
      status.authorizeUrl === undefined
        ? "  no authorize page is known for this console, so there is no link to draw"
        : "  the link is too long to draw as a scannable code — hand it over as text",
    );
  }

  // The page opens by itself, and the link is printed first so that a machine
  // with no browser on it loses nothing. Four things can stop it, and each says
  // so in one line rather than silently doing nothing:
  //
  //  - there is nothing left for the owner to sign;
  //  - `--no-open`, for this run;
  //  - WATERX_NO_BROWSER or CI, for a machine that has no one watching it;
  //  - it was already opened here for this same link, because `onboard` is run
  //    again constantly and a five-minute wait should not end in twenty tabs.
  //
  // `--open` overrides the last two: it is the "I am here, open it now" button.
  let opened: { opened: boolean; detail: string } | undefined;
  const pageToOpen = granted || readyToAdopt ? undefined : status.authorizeUrl;
  if (pageToOpen !== undefined) {
    const forced = args.open === "true";
    const suppressed = browserSuppressed();
    const already = openedRecently(pageToOpen);
    const reason = args.noOpen === "true" ? "--no-open" : (suppressed ?? (already ? "already" : undefined));

    if (forced || reason === undefined) {
      const outcome = await openUrl(pageToOpen);
      opened = outcome.opened
        ? { opened: true, detail: outcome.command }
        : { opened: false, detail: outcome.reason };
      if (outcome.opened) rememberOpened(pageToOpen);
      note(outcome.opened ? `  opened it here (${outcome.command})` : `  ${outcome.reason}`);
    } else {
      opened = { opened: false, detail: reason };
      note(
        reason === "already"
          ? "  already opened here — `--open` opens it again"
          : `  not opening a browser (${reason})`,
      );
    }
  } else if (args.open === "true") {
    note("  nothing to open: no authorize page is known, or there is nothing left to sign");
  }

  if (!waiting || delegateAddress === undefined) {
    show(
      { ...payload, next: next ?? null, ...(opened === undefined ? {} : { browser: opened }) },
      { rendered: true },
    );
    setOutcome(
      granted
        ? succeeded(status.headline, { nextCommand: next ?? invoke("next", "--json") })
        : readyToAdopt && status.grants !== undefined && status.grants.length > 1
          ? {
              ...quiet,
              status: "needs-approval",
              message: status.headline,
              retryable: false,
              awaitingApproval: true,
            }
          : config(status.headline, { nextCommand: next ?? completeHandshakeCommand() }),
    );
    return;
  }

  // ── --wait: watch for the grant the owner is making right now ───────────
  const intervalSeconds = Math.max(MIN_POLL_SECONDS, asNumber(args.interval) ?? DEFAULT_POLL_SECONDS);
  const deps = await discoveryDeps(agent);

  note(
    `  waiting up to ${String(waitSeconds)}s for the grant, looking every ` +
      `${String(intervalSeconds)}s — Ctrl-C is safe, nothing is in flight`,
  );
  const attempt = await awaitGrants(delegateAddress, deps, {
    waitMs: waitSeconds * 1000,
    intervalMs: intervalSeconds * 1000,
  });

  if (attempt.discovery === undefined) {
    show({ ...payload, error: attempt.failure ?? "unknown" }, { rendered: true });
    setOutcome({
      ...quiet,
      status: "unavailable",
      message:
        `Could not look for the grant — neither the backend nor recent chain events could be ` +
        `read (${attempt.failure ?? "unknown"}). Whether this wallet is granted is unknown; ` +
        `try again.`,
      retryable: true,
      awaitingApproval: false,
      nextCommand: completeHandshakeCommand(),
    });
    return;
  }

  const { grants, unverified, truncated, source } = attempt.discovery;
  const found = {
    ...payload,
    source,
    grants,
    unverified,
    truncated,
  };

  for (const id of unverified) note(`  unreadable    ${id}  (could not confirm either way)`);

  if (grants.length === 0) {
    show(found, { rendered: true });
    setOutcome(
      unverified.length > 0
        ? {
            ...quiet,
            status: "unavailable",
            message:
              `${String(unverified.length)} candidate account(s) could not be read from chain, so ` +
              `whether this wallet is granted is unknown. Try again.`,
            retryable: true,
            awaitingApproval: false,
            nextCommand: completeHandshakeCommand(),
          }
        : config(
            `No account grants ${delegateAddress} yet. The link is still good — hand it over, ` +
              `and this finds the grant the moment it lands.`,
            { retryable: true, nextCommand: completeHandshakeCommand() },
          ),
    );
    return;
  }

  const [only] = grants;
  if (grants.length > 1 || only === undefined) {
    for (const g of grants) {
      note(`  granted by    ${g.accountId}`);
      note(`    owner       ${g.ownerAddress}`);
      note(`    adopt it    ${invoke("adopt", "--account", g.accountId, "--json")}`);
    }
    show(found, { rendered: true });
    setOutcome({
      ...quiet,
      status: "needs-approval",
      message:
        `${String(grants.length)} accounts grant this wallet. Which one it trades is a choice, ` +
        `not a guess: ask which, then run that grant's adopt command.`,
      retryable: false,
      awaitingApproval: true,
    });
    return;
  }

  // Exactly one, and `adoptAccount` reads it from chain again before writing
  // anything: minutes may have passed, and the grant may already be gone.
  try {
    const adopted = await adoptAccount({
      accountId: only.accountId,
      delegate: delegateAddress,
      network: agent.config.network,
      readAccount: deps.readAccount,
      ...(ownerAddress === undefined ? {} : { configuredOwner: ownerAddress }),
    });
    const recordedAs = `${adopted.by}${adopted.generated ? " (generated — no approver was given)" : ""}`;
    note("");
    note(`  granted by    ${adopted.accountId}`);
    note(`  owner         ${adopted.ownerAddress}  (read from chain)`);
    note(`  adopted       WATERX_ACCOUNT_ID written; recorded as ${recordedAs}`);
    note("");
    show({ ...found, adopted }, { rendered: true });
    setOutcome(
      succeeded(
        `This wallet now trades ${adopted.accountId}, owned by ${adopted.ownerAddress}. ` +
          `Recorded as ${recordedAs}.`,
        { nextCommand: invoke("next", "--json") },
      ),
    );
  } catch (error) {
    show(found, { rendered: true });
    if (error instanceof NotAGrantError) {
      setOutcome({
        ...quiet,
        status: "auth",
        message: error.message,
        retryable: false,
        awaitingApproval: false,
        nextCommand: completeHandshakeCommand(),
      });
      return;
    }
    if (error instanceof OwnerMismatchError) {
      setOutcome(config(error.message));
      return;
    }
    if (error instanceof AccountNotFoundError) {
      setOutcome({
        ...quiet,
        status: "unavailable",
        message: error.message,
        retryable: true,
        awaitingApproval: false,
        nextCommand: invoke("adopt", "--account", only.accountId, "--json"),
      });
      return;
    }
    setOutcome({
      ...quiet,
      status: "unavailable",
      message:
        `${only.accountId} grants this wallet, but it could not be adopted, so nothing was ` +
        `written: ${describe(error)}`,
      retryable: true,
      awaitingApproval: false,
      nextCommand: invoke("adopt", "--account", only.accountId, "--json"),
    });
  }
});
