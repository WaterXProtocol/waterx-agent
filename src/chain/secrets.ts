/**
 * Keep the key this package just wrote out of the caller's next commit.
 *
 * `generate-wallet` and `bootstrap` write a private key to `.env` in the
 * working directory — which is, more often than not, someone's git repository.
 * A fresh `npm init` project has no `.gitignore` at all, so the very first
 * `git add .` after setup stages the key. The person who reported this had to
 * notice and write the `.gitignore` themselves; that it worked out says
 * something about them, not about this package.
 *
 * Writing a secret somewhere it can be committed is the mistake. Having written
 * it, closing that door is not an imposition on the caller's project — it is
 * finishing the thing we started.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type IgnoreOutcome =
  /** `.env` and `.waterx/` were both already ignored; nothing to do. */
  | { kind: "already"; gitignore: string }
  /** The missing rules were appended, or a `.gitignore` created. `added` names them. */
  | { kind: "added"; gitignore: string; added: string[] }
  /** Not inside a git repository, so nothing could be committed by accident. */
  | { kind: "not-a-repo" }
  /** Something stopped it. The caller is told; it is never silent. */
  | { kind: "failed"; reason: string };

/** The nearest enclosing git repository, or `undefined`. */
function repoRoot(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Rules that already keep `.env` out, as people actually write them. */
const COVERS_ENV = new Set([".env", "/.env", "*.env", ".env*"]);

/** Rules that already keep `.waterx/` out. */
const COVERS_STATE = new Set([".waterx", ".waterx/", "/.waterx", "/.waterx/", ".waterx/*", ".waterx/**"]);

/**
 * Ensure `.env` and `.waterx/` are ignored by git, creating or appending to
 * `.gitignore`.
 *
 * Two rules, checked separately. `.waterx/` holds the approvals and adoptions
 * ledgers and the pairing code, and it used to be added only alongside `.env`:
 * a project that already ignored `.env` — which a careful person or agent sets
 * up before the key is written — got "already" and no rule for `.waterx/`, so
 * the next `git add .` committed who adopted which account.
 *
 * Deliberately does not shell out to `git check-ignore`: this runs right after
 * a key has been written, and a missing git binary is not a reason to leave it
 * exposed. Reading the file is enough for the case that matters — a project
 * with no rule at all.
 */
export function ensureEnvIgnored(cwd = process.cwd()): IgnoreOutcome {
  const root = repoRoot(cwd);
  if (root === undefined) return { kind: "not-a-repo" };

  const gitignore = join(root, ".gitignore");
  try {
    const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
    const lines = existing.split("\n").map((line) => line.trim());
    const added = [
      ...(lines.some((line) => COVERS_ENV.has(line)) ? [] : [".env"]),
      ...(lines.some((line) => COVERS_STATE.has(line)) ? [] : [".waterx/"]),
    ];
    if (added.length === 0) return { kind: "already", gitignore };

    const note =
      "\n# Added by waterx-agent: .env holds a private key; .waterx/ holds who adopted and " +
      "approved what.\n" +
      `${added.join("\n")}\n`;
    if (existing === "") writeFileSync(gitignore, note.trimStart(), "utf8");
    else appendFileSync(gitignore, existing.endsWith("\n") ? note.trimStart() : note, "utf8");
    return { kind: "added", gitignore, added };
  } catch (cause) {
    return { kind: "failed", reason: cause instanceof Error ? cause.message : String(cause) };
  }
}
