/**
 * The contract an automated caller is held to — and holds this package to.
 *
 * Everything here exists to answer five questions **without reading English**:
 *
 *  1. did it work?              `ok`
 *  2. may I try again?          `retryable`
 *  3. did a transaction leave?  `submitted`
 *  4. must I reconcile first?   `reconcileRequired`
 *  5. am I waiting on a human?  `awaitingApproval`
 *
 * They are separate booleans because they are genuinely independent. A refusal
 * by the policy gate is `!ok` and safe to leave alone; a chain abort is `!ok`
 * and `submitted`; a timeout after the digest was recorded is `!ok`,
 * `submitted` AND `reconcileRequired`, and is the one case where trying again
 * is how an agent trades twice. Collapsing any of these into "error" is what
 * makes a wrapper guess, and a wrapper that guesses about (3) loses money.
 *
 * The exit code carries the same answer for a caller that only has `$?`. It is
 * derived from `status`, never chosen separately, so the two cannot disagree.
 */

/**
 * Every terminal state a command can end in.
 *
 * Ordered by exit code, and the codes are stable: a script may branch on them.
 * `1` is deliberately unused — it is what Node exits with when it dies of an
 * unhandled throw, so reserving it keeps "this command decided" distinguishable
 * from "this process fell over".
 */
export const EXIT = {
  /** It did what it was asked. */
  ok: 0,
  /** The arguments are wrong. Fix them; do not retry as-is. */
  usage: 2,
  /** The environment is wrong — no account, no key, an unreadable scope file. */
  config: 3,
  /** A key/authority problem: wrong signer, not a delegate, owner-only action. */
  auth: 4,
  /** The execution policy or the delegation scope refused it. Nothing was built. */
  policy: 5,
  /** The venue, the verifier or the chain rejected it. It did NOT happen. */
  rejected: 6,
  /** Transient — unreachable backend, sponsorship down. Retrying is safe. */
  unavailable: 7,
  /** It may or may not have been submitted. Reconcile; never retry blindly. */
  ambiguous: 8,
  /** A human has not approved it yet. */
  "needs-approval": 9,
} as const;

export type Status = keyof typeof EXIT;

export interface Outcome {
  status: Status;
  /** One sentence, for a human reading a log. Never parse this. */
  message: string;
  /**
   * Did transaction bytes leave this process?
   *
   * Under `status: "ambiguous"` this reads **"may have"**, not "did" — that is
   * what ambiguous means, and the field is deliberately conservative there. A
   * timeout does not cancel the work it gave up waiting for, so even a
   * submission that had not started when the clock ran out may have gone out
   * immediately afterwards. Reporting `false` in that case would be a lie in
   * the one direction that costs money.
   */
  submitted: boolean;
  /** Is re-running the same command safe and potentially useful? */
  retryable: boolean;
  /** Must the caller settle an in-flight submission before doing anything else? */
  reconcileRequired: boolean;
  /** Is this waiting on a person? */
  awaitingApproval: boolean;
  /** The exact command to run next, when there is one. Copy it; do not compose one. */
  nextCommand?: string;
  /** Backend `AppError.code`, on-chain abort details — whatever the source gave. */
  details?: unknown;
}

/** The single JSON document a `--json` invocation writes to stdout. */
export interface Envelope {
  ok: boolean;
  status: Status;
  command: string;
  network: string;
  /** ISO-8601, so a transcript can be ordered without a filesystem. */
  at: string;
  message: string;
  submitted: boolean;
  retryable: boolean;
  reconcileRequired: boolean;
  awaitingApproval: boolean;
  nextCommand?: string;
  /** The command's own result. Absent when it produced none. */
  data?: unknown;
  /**
   * Present when something went wrong — which `needs-approval` is not. A
   * preview that is waiting on a person is `ok: false` because the write has
   * not happened, and carries no `error`, because nothing failed.
   */
  error?: { kind: string; details?: unknown };
  /** Extra structure for the non-error statuses. */
  details?: unknown;
}

/** The happy path, with nothing outstanding. */
export const succeeded = (message: string, extra: Partial<Outcome> = {}): Outcome => ({
  status: "ok",
  message,
  submitted: false,
  retryable: false,
  reconcileRequired: false,
  awaitingApproval: false,
  ...extra,
});

/**
 * How to spell a command this package hands back for someone to run next.
 *
 * Every `nextCommand` is written to be **copied verbatim**, so it has to be an
 * invocation that works *where it was printed*. Two things can make it wrong:
 *
 * `pnpm run <command>` breaks the contract it belongs to — the package manager
 * writes its own banner to stdout, and the promise of one JSON document dies on
 * the first thing an agent pastes. The instructions all say `pnpm --silent
 * run`, which makes correctness depend on a word nobody would notice missing.
 *
 * And a checkout and an installed package are reached differently:
 * `node bin/waterx.mjs` is a path that exists in one and not the other. The
 * shim knows which it is, because it is the thing being run, so it states it in
 * `WATERX_INVOKED_AS` rather than leaving this to guess.
 */
/**
 * The first of these commands a caller can run as printed, or the fallback.
 *
 * `nextCommand` is a promise -- copy it, do not compose one -- and a command
 * carrying a `<placeholder>` breaks it: the caller either fills it in by
 * guessing, which is the one thing this package refuses to let an agent do, or
 * runs it and gets a usage error. Those are skipped.
 *
 * It exists because `bootstrap` handed back NO `nextCommand` on the path it
 * takes most often, the one where setup is not finished. An install read that
 * envelope as the end of the road: it had a wallet, a remaining item addressed
 * to somebody else, and nothing to run. Every other command in this package
 * hands back a pointer, and the loop SKILL.md documents -- run `next`, do the
 * one thing it says, run `next` again -- needs the exit to be there.
 */
export function firstRunnable(
  commands: readonly (string | undefined)[],
  fallback: string,
): string {
  for (const command of commands) {
    if (command === undefined || command.trim() === "") continue;
    if (command.includes("<")) continue;
    return command;
  }
  return fallback;
}

/** Who can supply a missing setup step, as `bootstrap` reports it. */
export type StepWho = "you" | "an operator" | "the account owner" | "the maintainers";

/**
 * How a remaining step is labelled: whose act it needs, and who runs the
 * command under it.
 *
 * `who` answers the first question. It used to be rendered as the second --
 * "ASK THE ACCOUNT OWNER" -- and an install obeyed exactly that: it stopped,
 * asked, and waited to be told to run the command printed underneath, so the
 * person never got the link that command exists to produce.
 *
 * Both halves are true and they attach to different things. The owner signs;
 * the agent runs the command that hands them the link. A step whose command
 * cannot be run as printed -- a `<placeholder>` nobody may fill in by guessing
 * -- is the other case, where stopping to ask really is the whole of it.
 */
export function stepOwnerLabel(who: StepWho, command: string | undefined): string {
  if (who === "you") return "you";
  const runnable = command !== undefined && command.trim() !== "" && !command.includes("<");
  if (!runnable) return `ASK ${who.toUpperCase()}`;
  const act: Record<Exclude<StepWho, "you">, string> = {
    "an operator": "AN OPERATOR supplies it",
    "the account owner": "THE ACCOUNT OWNER signs it",
    "the maintainers": "THE MAINTAINERS fix it",
  };
  // A semicolon, not a dash: the caller joins this to the step's name with a
  // dash of its own, and two at the same level read as one sentence trailing off.
  return `${act[who]}; YOU run the command below`;
}

export const invoke = (command: string, ...args: string[]): string =>
  [process.env.WATERX_INVOKED_AS?.trim() || "node bin/waterx.mjs", command, ...args].join(" ");
