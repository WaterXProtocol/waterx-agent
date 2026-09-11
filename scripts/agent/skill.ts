/**
 * Where the instructions are, without anyone having to know where they are.
 *
 * The prompt that installs this package and points an agent at `SKILL.md` has
 * to name a path, and the path depends on the package manager: npm puts it at
 * `node_modules/waterx-agent/SKILL.md`, pnpm at a symlink into `.pnpm/…`, and a
 * checkout has it at the root. A prompt that hardcodes one of those is wrong
 * for the others, and wrong quietly — the agent reports "no such file" and
 * improvises from there.
 *
 * So the package answers the question itself. `waterx skill` prints the
 * instructions; `--json` gives the paths for a caller that would rather read
 * the files directly.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { succeeded } from "../../src/cli/contract.ts";
import { note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";

const args = parseArgs(
  {
    which: { desc: "skill | instructions | reference", default: "skill" },
  },
  "skill",
);

/**
 * The package root, found from this file rather than from the working
 * directory — the documents ship with the package, and the caller is usually
 * standing somewhere else entirely.
 */
const packageRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Up from either `scripts/agent/` in a checkout or `dist/scripts/agent/` in
  // an install, until the package manifest turns up.
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "SKILL.md"))) return dir;
    dir = dirname(dir);
  }
  return dirname(fileURLToPath(import.meta.url));
};

const DOCS: Record<string, string> = {
  skill: "SKILL.md",
  instructions: "AGENT_INSTRUCTIONS.md",
  reference: "AGENT.md",
};

await run(async () => {
  const root = packageRoot();
  const paths = Object.fromEntries(
    Object.entries(DOCS).map(([name, file]) => [name, join(root, file)]),
  );

  const which = args.which ?? "skill";
  const file = DOCS[which];
  if (file === undefined) {
    const { UsageError } = await import("../../src/errors.ts");
    throw new UsageError(`--which expects ${Object.keys(DOCS).join(" | ")} (got "${which}").`);
  }

  // Not in `--json` mode: the point of the bare form is that an agent can read
  // the instructions straight out of stdout without a second command.
  if (args.json !== "true") {
    note(readFileSync(join(root, file), "utf8"));
  }

  show({ ...paths, root, showing: which }, { rendered: args.json !== "true" });
  setOutcome(succeeded(`the instructions are at ${join(root, file)}`));
});
