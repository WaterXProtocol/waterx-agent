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
  /** `.env` was already ignored; nothing to do. */
  | { kind: "already"; gitignore: string }
  /** A rule was appended, or a `.gitignore` created. */
  | { kind: "added"; gitignore: string }
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

/**
 * Ensure `.env` is ignored by git, creating or appending to `.gitignore`.
 *
 * Deliberately does not shell out to `git check-ignore`: this runs right after
 * a key has been written, and a missing git binary is not a reason to leave it
 * exposed. Reading the file is enough for the case that matters — a project
 * with no rule for `.env` at all.
 */
export function ensureEnvIgnored(cwd = process.cwd()): IgnoreOutcome {
  const root = repoRoot(cwd);
  if (root === undefined) return { kind: "not-a-repo" };

  const gitignore = join(root, ".gitignore");
  try {
    const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
    const ignored = existing
      .split("\n")
      .map((line) => line.trim())
      .some((line) => line === ".env" || line === "*.env" || line === ".env*");
    if (ignored) return { kind: "already", gitignore };

    const note =
      "\n# Added by waterx-agent: this holds a private key.\n.env\n.waterx/\n";
    if (existing === "") writeFileSync(gitignore, note.trimStart(), "utf8");
    else appendFileSync(gitignore, existing.endsWith("\n") ? note.trimStart() : note, "utf8");
    return { kind: "added", gitignore };
  } catch (cause) {
    return { kind: "failed", reason: cause instanceof Error ? cause.message : String(cause) };
  }
}
