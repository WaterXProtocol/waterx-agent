/**
 * Where this installation keeps what it has already learned.
 *
 * `.env` and `.waterx/` were both resolved against the CURRENT WORKING
 * DIRECTORY. So the answer to "is this set up?" depended on where somebody
 * stood when they asked. Run from a subdirectory of the install, `next` found
 * no `.env`, reported `not-set-up` and suggested `bootstrap` — and an agent
 * doing what it was told generated a SECOND key, abandoning the one the owner
 * had already granted. The same cwd made `approvals` and `next` read different
 * ledgers and report different numbers for the same question, which is how an
 * agent ends up re-asking a person to look at approvals that do not exist where
 * it is looking.
 *
 * So: walk up from the working directory to the nearest ancestor that already
 * holds state, and use that. Nothing is moved and nothing is created — if no
 * ancestor has any, the working directory is the answer, exactly as before, and
 * a fresh install writes where it always did.
 *
 * Deliberately NOT the package directory. This state belongs to the caller's
 * project, not to the installed dependency: two projects on one machine must
 * not share a wallet, a scope or an approval ledger.
 *
 * Deliberately NOT a git root either. A checkout is not the unit of
 * installation — `npm install` into a plain directory is — and anchoring on
 * `.git` would make a repository's subdirectory behave differently from an
 * ordinary one for no reason the operator could see.
 *
 * `WATERX_ENV_FILE` and `WATERX_APPROVALS_FILE` still win where they are set:
 * an operator who named a path meant that path.
 */
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

/** What makes a directory the one this installation already uses. */
const MARKERS = [".env", ".waterx"] as const;

/**
 * The nearest ancestor of `from` that already holds this agent's state, or
 * `from` itself when none does.
 */
export function stateRoot(from: string = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    if (MARKERS.some((marker) => existsSync(join(dir, marker)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(from);
    dir = parent;
  }
}

/** A path inside the state root, resolved once per call rather than cached. */
export const inStateRoot = (...segments: string[]): string => join(stateRoot(), ...segments);
