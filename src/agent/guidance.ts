import { invoke } from "../cli/contract.ts";
import { DELEGATE_BOUNDARY, perpAuthorizeLink } from "./delegation.ts";

/**
 * What to tell a person next, decided rather than composed.
 *
 * An agent guiding someone has to answer "where am I and what should I offer?"
 * at every turn. It used to have to build that answer itself out of `doctor`,
 * `balance`, `positions`, `orders` and `approvals`, and then apply an ordering
 * rule that existed only as prose: settle anything in flight *before* trading,
 * do not offer a trade with no collateral, never invent numbers the user has
 * not given.
 *
 * Rules that live in prose are followed unevenly. These live here, in a
 * priority order a caller cannot get wrong, and are tested — because the order
 * is the safety property, not a presentation choice.
 */

/**
 * Where the caller is, in the order the states must be resolved.
 *
 * Ordered deliberately: `unsettled` outranks everything, including a broken
 * configuration, because a transaction whose effect is unknown is the one thing
 * that must be settled before anything else is decided.
 */
export type State =
  | "unsettled"
  | "awaiting-approval"
  | "not-set-up"
  | "awaiting-grant"
  | "not-delegated"
  | "read-only"
  | "no-collateral"
  | "ready";

/** Something the agent may offer to do next. */
export interface Suggestion {
  what: string;
  command: string;
  /**
   * Values the user must supply before this command can be run.
   *
   * Present so the agent asks for them rather than choosing them. Every entry
   * here is a number nobody but the user can pick, and the commands refuse
   * without them.
   */
  needsFromUser?: string[];
}

export interface Guidance {
  state: State;
  /** One sentence, addressed to the agent, about what to say and why. */
  headline: string;
  suggestions: Suggestion[];
}

/** The numbers no agent may choose on a user's behalf. */
const SIZING = ["collateral in USD", "leverage (or an exact size)", "slippage percent"];

/** What the caller found, in the shape `decide` reasons about. */
export interface Situation {
  open: number;
  firstUnsettled: string | undefined;
  pending: { id: string; action: string }[];
  /**
   * Whether a signer, an account and the signing-path checks are all in place.
   *
   * Deliberately NOT `doctor`'s `writeReady`, which folds the execution policy
   * in with them. A read-only process is not an unconfigured one, and told they
   * were the same thing this sent someone who had chosen read-only — the
   * default on mainnet — off to run `bootstrap`, which would have found nothing
   * to fix.
   */
  configured: boolean;
  /**
   * What specifically is missing, so the advice can name it.
   *
   * Without this, `not-set-up` could only say "run bootstrap" — and an agent
   * that ran bootstrap, was told it needed an account, and then asked `next`
   * what to do was sent back to bootstrap. It loops, and each turn costs the
   * user a message to say the same thing.
   */
  missing: { signer: boolean; gas: boolean; account: boolean };
  /**
   * The delegate handshake, when this process holds a delegate key.
   *
   * `undefined` when it holds the owner's own key, where there is nothing to
   * grant. A grant that is absent or stale makes every write abort on chain, so
   * it has to outrank "ready" — otherwise the agent offers a trade that the
   * chain will refuse, and the refusal arrives as a generic 6002.
   */
  delegation?: { state: string; headline: string };
  readOnly: boolean;
  freeMargin: number | undefined;
  positions: number;
  orders: number;
  blockers: string[];
  /**
   * Which deployment this is about.
   *
   * Gas advice is not the same on both, and the default network is now mainnet.
   * "Ask the faucet" is a sentence that only means anything on testnet; on
   * mainnet it names a command that refuses and a source that does not exist.
   */
  network: "testnet" | "mainnet";
  /**
   * Which arrangement this process is in, which decides what it needs.
   *
   * The two are not variations on one setup, they are different setups, and
   * treating them as one is how this told a would-be delegate to fund a wallet
   * and create an account it will never use:
   *
   * - `delegate` — the owner keeps their account and their funds, and grants
   *   this wallet permission to trade it. It needs **no gas** (the backend
   *   sponsors a delegate's transactions), no account of its own, and no
   *   collateral of its own.
   * - `owner` — this wallet IS the account holder. It needs SUI for gas, an
   *   account, and collateral, and it can withdraw its own funds.
   * - `undecided` — a wallet exists and nobody has said which. The delegate
   *   path is offered first: it moves no money to the agent and the agent
   *   cannot withdraw.
   */
  mode: "delegate" | "owner" | "undecided";
  /**
   * This process's own wallet: the address that needs gas on the owner path,
   * and the one an owner grants to on the delegate path. Named in the advice
   * either way, because "fund the wallet" and "grant this address" are both
   * useless without it.
   */
  address?: string;
}

/**
 * First state that applies wins.
 *
 * The order is the safety property. Offering a trade to someone with an
 * unsettled submission is how the same position gets opened twice, and it is
 * exactly what an agent does when it checks "can I trade?" before "is anything
 * in flight?".
 */
export function decide(s: Situation): Guidance {
  if (s.open > 0) {
    return {
      state: "unsettled",
      headline:
        `${String(s.open)} transaction(s) were sent and nobody has confirmed what happened to ` +
        `them. Settle that before doing anything else — placing another order on top of an ` +
        `unknown one is how the same trade happens twice.`,
      suggestions: [
        {
          what: "ask the chain what became of them",
          command: invoke("reconcile", "--all", "--json"),
        },
      ],
    };
  }

  if (s.pending.length > 0) {
    return {
      state: "awaiting-approval",
      headline:
        `${String(s.pending.length)} previewed order(s) are waiting for a person. Show the ` +
        `preview and ask; do not approve on their behalf.`,
      suggestions: s.pending.flatMap((p) => [
        {
          what: `approve ${p.action} (${p.id}) — only after the user has seen it and agreed`,
          command: invoke("approve", "--id", p.id, "--approver <their name>", "--json"),
        },
      ]),
    };
  }

  if (!s.configured) {
    // Named, not generic. Each branch is the one thing to do next, so an agent
    // that keeps asking `next` keeps moving instead of being handed the same
    // "run bootstrap" it just ran.
    if (s.missing.signer) {
      return {
        state: "not-set-up",
        headline:
          `No signing key, so nothing can be written. Bootstrap generates one; it signs nothing` +
          (s.network === "testnet" ? " and asks the testnet faucet for gas." : "."),
        suggestions: [
          { what: "generate a wallet", command: invoke("bootstrap", "--json") },
        ],
      };
    }
    // Before gas and before an account, because on the delegate path neither is
    // ever needed. Asking a would-be delegate to fund a wallet is asking them
    // to solve a problem they do not have.
    if (s.mode === "undecided") {
      // The state a fresh install lands in, and the one the owner is needed
      // for. It described the grant and named no place to make it, so where to
      // sign depended on the caller running `onboard` next — which an agent
      // relaying a headline does not necessarily do.
      const page = s.address === undefined ? undefined : perpAuthorizeLink(s.network, s.address);
      return {
        state: "awaiting-grant",
        headline:
          `There is a wallet and nothing has been granted to it yet. The usual arrangement is ` +
          `that the account owner grants THIS address permission to trade their account — they ` +
          `keep the funds, and it needs no SUI of its own because the backend sponsors a ` +
          `delegate's transactions. ${DELEGATE_BOUNDARY} ` +
          (page === undefined
            ? `Ask them to grant it; then `
            : `They grant it at ${page} — signing in their own wallet, where their key stays. ` +
              `Then `) +
          `\`discover\` finds the account on its own and \`adopt\` takes it. Nobody has to copy an ` +
          `account id or an owner address.`,
        suggestions: [
          {
            what: "the address to hand over, and where the owner grants it",
            command: invoke("onboard", "--json"),
          },
          {
            what: "once the owner has signed: find the account that granted this wallet",
            command: invoke("discover", "--wait", "300", "--json"),
          },
          {
            what:
              "or make this wallet an account holder in its own right — it then needs SUI for " +
              "gas and collateral of its own, and can withdraw",
            command: invoke("bootstrap", "--create-account", "--yes", "--json"),
          },
        ],
      };
    }

    if (s.missing.gas) {
      // Before the account, because the account cannot be created without it.
      // Told "create the account" by a wallet with no SUI, an agent runs the
      // command, watches it fail on gas selection, asks what to do next, and
      // is told to create the account. The loop is the symptom; not knowing
      // gas exists is the cause.
      // The remedy differs by deployment, and getting it wrong wastes a turn:
      // there is no faucet on mainnet, and `fund-sui` refuses there rather than
      // doing something useful.
      return s.network === "testnet"
        ? {
            state: "not-set-up",
            headline:
              `The wallet holds no gas, so nothing can be sent — including creating an account. ` +
              `The public testnet faucet supplies it and is often busy; this is a queue, not a ` +
              `fault, so wait and try again.`,
            suggestions: [{ what: "ask the faucet for gas", command: invoke("fund-sui", "--json") }],
          }
        : {
            state: "not-set-up",
            headline:
              `The wallet holds no SUI, so nothing can be sent — including creating an account. ` +
              `There is no faucet on mainnet: someone has to send SUI to ` +
              `${s.address ?? "the agent wallet"}. A small amount covers a lot of transactions.`,
            suggestions: [
              { what: "check the balance once it has been sent", command: invoke("next", "--json") },
            ],
          };
    }
    if (s.missing.account) {
      return {
        state: "not-set-up",
        headline:
          `There is a wallet but no WaterX account, and every account-scoped write refuses ` +
          `without one. Creating it signs one transaction and moves no funds — ask the user ` +
          `before running it.`,
        suggestions: [
          {
            what: "create the account (one signature, no funds moved)",
            command: invoke("bootstrap", "--create-account", "--yes", "--json"),
          },
        ],
      };
    }
    return {
      state: "not-set-up",
      headline:
        `Reads work, writes do not: ${s.blockers.join(", ")}. These are checks the signing path ` +
        `makes for itself, so they refuse a write rather than merely warning.`,
      suggestions: [{ what: "the full preflight, with the fix for each", command: invoke("doctor", "--json") }],
    };
  }

  // Before `read-only` and before collateral: a grant that is missing or in the
  // superseded slot makes every write abort on chain, and no amount of policy
  // or funding changes that. The owner has to act, and they are not at this
  // terminal.
  if (s.delegation !== undefined && s.delegation.state !== "granted" && s.delegation.state !== "owner-key") {
    return {
      state: "not-delegated",
      headline: s.delegation.headline,
      suggestions: [
        { what: "the handshake, and what the owner has to do", command: invoke("onboard", "--json") },
      ],
    };
  }

  if (s.readOnly) {
    return {
      state: "read-only",
      headline:
        `The execution policy is read-only, so nothing can be signed. On mainnet that is the ` +
        `default and changing it is a decision a person makes deliberately.`,
      suggestions: [{ what: "see the policy and ceilings in force", command: invoke("limits", "--json") }],
    };
  }

  if ((s.freeMargin ?? 0) <= 0) {
    return {
      state: "no-collateral",
      headline:
        `Set up and able to sign, but there is no free margin to commit. Gas is not collateral — ` +
        (s.network === "testnet"
          ? `on testnet the credit faucet is whitelist-gated, so this one needs an operator.`
          : `the wallet needs USDC or USDsui of its own, which on mainnet you send to it.`),
      suggestions: [
        { what: "check what the account holds", command: invoke("balance", "--json") },
        {
          what: "deposit, once the wallet holds a backing asset",
          command: invoke("deposit", "--amount <n>", "--yes", "--json"),
          needsFromUser: ["how much to deposit"],
        },
      ],
    };
  }

  const suggestions: Suggestion[] = [
    {
      what: "preview a new position",
      command: invoke(
        "preview",
        "--action open-long|open-short",
        "--ticker <market>",
        "--collateral <n>",
        "--leverage <n>",
        "--slippage <n>",
        "--json",
      ),
      needsFromUser: SIZING,
    },
  ];
  if (s.positions > 0) {
    suggestions.push({
      what: `close or reduce one of the ${String(s.positions)} open position(s)`,
      command: invoke(
        "preview",
        "--action close-position",
        "--ticker <market>",
        "--position-id <id>",
        "--slippage <n>",
        "--json",
      ),
      needsFromUser: ["which position", "slippage percent"],
    });
  }
  if (s.orders > 0) {
    suggestions.push({
      what: `cancel one of the ${String(s.orders)} resting order(s)`,
      command: invoke("preview", "--action cancel-order", "--ticker <market>", "--order-id <id>", "--json"),
      needsFromUser: ["which order"],
    });
  }

  return {
    state: "ready",
    headline:
      `Ready. $${String(s.freeMargin)} free margin, ${String(s.positions)} open position(s), ` +
      `${String(s.orders)} resting order(s). Ask the user what they want to do — and for the ` +
      `numbers, which are theirs to choose.`,
    suggestions,
  };
}
