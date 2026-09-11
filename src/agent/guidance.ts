import { invoke } from "../cli/contract.ts";

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
  readOnly: boolean;
  freeMargin: number | undefined;
  positions: number;
  orders: number;
  blockers: string[];
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
    return {
      state: "not-set-up",
      headline:
        `Reads work, writes do not${s.blockers.length === 0 ? "" : ` (${s.blockers.join(", ")})`}. ` +
        `Run bootstrap and relay what it says is still missing — some of it needs an operator, ` +
        `not you.`,
      suggestions: [
        { what: "find out exactly what is missing", command: invoke("bootstrap", "--json") },
        { what: "the full preflight", command: invoke("doctor", "--json") },
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
        `on testnet the credit faucet is whitelist-gated, so this one needs an operator.`,
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
