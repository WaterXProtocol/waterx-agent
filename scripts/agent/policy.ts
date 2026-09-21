/**
 * Read the execution policy, or change it.
 *
 * The last step of the setup that had no command. Everything else -- a wallet,
 * gas, an account, the owner's grant, discovery, adoption -- is something this
 * package does or tells you exactly how to do. Widening the policy was the one
 * that said "changing it is a decision a person makes deliberately" and then
 * named no way to make it, so the documented loop -- run `next`, do the one
 * thing it says, run `next` again -- ended at a state whose only suggestion was
 * a command that reports and cannot change anything. A real install stopped
 * there and said so: "no more commands to run".
 *
 * A person still decides. What changes is that deciding no longer means hand
 * editing a dotfile that the instructions elsewhere forbid an agent to touch.
 *
 * Narrowing needs no confirmation -- `read-only` can always be reached, and
 * refusing to let someone turn writes OFF would be absurd. Widening needs
 * `--yes`, and on mainnet says what it is widening against.
 */
import { ensureEnvIgnored } from "../../src/chain/secrets.ts";
import { envPath, saveToEnv } from "../../src/chain/wallet.ts";
import { invoke, succeeded } from "../../src/cli/contract.ts";
import { type PolicyMode, policyChoices, POLICY_MODES } from "../../src/policy.ts";
import { confirmed, initAgent, note, parseArgs, run, setOutcome, show } from "../lib/cli.ts";

const args = parseArgs(
  {
    set: { desc: "read-only | interactive | delegated-auto — the policy to write to .env" },
    // `flag: true` is not optional here: a per-script definition REPLACES the
    // global one, so declaring `yes` without it turned --yes into a flag that
    // wants a value, and `--set interactive --yes` fell out as a usage error.
    yes: { desc: "Confirm widening what this process may sign", flag: true },
  },
  "policy",
);

const MODES = POLICY_MODES;

const rank = (mode: PolicyMode): number => MODES.indexOf(mode);

const quiet = { submitted: false, reconcileRequired: false, awaitingApproval: false } as const;

/**
 * Break prose to a width a terminal holds, so it does not wrap mid-sentence.
 *
 * Commands are never passed through this: a wrapped command is one nobody can
 * copy, which is the same reason the authorize link gets a line of its own.
 */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") {
      line = word;
    } else if (`${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

await run(async () => {
  const agent = initAgent();
  const current = agent.config.executionPolicy;
  const wanted = args.set;

  // With no `--set`, this is the choosing screen rather than a report. It used
  // to print one command -- `--set interactive --yes` -- and an install relayed
  // that to its user as THE next step, because a single suggestion is not a
  // choice. All three are here, in rank order, with what each costs.
  const choices = policyChoices({
    current,
    hasScope: agent.config.policyScope !== undefined,
    invoke,
  });

  if (wanted === undefined) {
    note("");
    note(`  policy     ${current} on ${agent.config.network}`);
    note(`  file       ${envPath()}`);
    note("");
    note("  Pick one. This is a person's decision, not the agent's:");
    note("");
    for (const choice of choices) {
      const head = `  ${choice.current ? "→" : " "} ${choice.mode.padEnd(16)}`;
      const pad = " ".repeat(head.length);
      const [first, ...rest] = wrap(choice.means, 58);
      note(`${head}${first ?? ""}`);
      for (const line of rest) note(`${pad}${line}`);
      if (choice.requires !== undefined) {
        for (const line of wrap(`needs ${choice.requires}`, 58)) note(`${pad}${line}`);
      }
      // Unwrapped, always: a command is for copying. The prerequisite's command
      // is a field of its own for exactly this reason -- put inside the
      // sentence, the wrapper broke it across three lines.
      if (choice.requiresCommand !== undefined) note(`${pad}${choice.requiresCommand}`);
      note(`${pad}${choice.command}`);
      note("");
    }
    show(
      { executionPolicy: current, network: agent.config.network, envFile: envPath(), choices },
      { rendered: true },
    );
    setOutcome(
      succeeded(`policy ${current} on ${agent.config.network}; three modes to choose from`),
    );
    return;
  }

  if (!MODES.includes(wanted as PolicyMode)) {
    setOutcome({
      ...quiet,
      status: "usage",
      message: `--set expects ${MODES.join(" | ")} (got "${wanted}").`,
      retryable: false,
    });
    return;
  }
  const mode = wanted as PolicyMode;

  if (mode === current) {
    show({ executionPolicy: current, network: agent.config.network, changed: false }, { rendered: true });
    setOutcome(succeeded(`already ${current}`, { nextCommand: invoke("next", "--json") }));
    return;
  }

  // Widening is the direction that matters. Narrowing is always allowed: a
  // person turning writes off should never be asked to confirm it.
  const widening = rank(mode) > rank(current);
  if (widening && !confirmed()) {
    setOutcome({
      ...quiet,
      status: "config",
      message:
        `Widening ${current} to ${mode} lets this process sign${
          agent.config.network === "mainnet" ? " against real money on mainnet" : ""
        }. That is a person's decision, so it needs --yes. An agent must not add it on its own.`,
      retryable: false,
      nextCommand: invoke("policy", "--set", mode, "--yes"),
    });
    return;
  }

  // `delegated-auto` signs with nobody watching, and the gate refuses to build
  // without ceilings. Refusing here means the refusal names the fix, rather
  // than arriving at the first trade from a policy that cannot load.
  if (mode === "delegated-auto") {
    // `loadConfig` already read it into the config, and threw if it was named
    // and unreadable -- so absent here means nobody named one.
    if (agent.config.policyScope === undefined) {
      setOutcome({
        ...quiet,
        status: "config",
        message:
          `delegated-auto signs unattended, so it needs ceilings: write a scope file with ` +
          `\`limits --write policy.json …\` and point WATERX_POLICY_SCOPE_FILE at it. Nothing ` +
          `was changed.`,
        retryable: false,
        nextCommand: invoke("limits", "--json"),
      });
      return;
    }
  }

  // The key may already live here; a project that has neither is one where the
  // next write would create an unignored file.
  const ignored = ensureEnvIgnored();
  saveToEnv("WATERX_EXECUTION_POLICY", mode);

  note("");
  note(`  policy     ${current} → ${mode}`);
  note(`  wrote      WATERX_EXECUTION_POLICY to ${envPath()}`);
  if (mode === "interactive") {
    // What it means in practice for the caller that is usually driving this: an
    // agent still cannot sign on its own. `--yes` is the human shortcut; the
    // agent path is preview -> approve -> execute, and `approve` takes a name.
    note("  means      every write needs a person: preview → approve → execute, and");
    note("             `approve` records their name against the exact plan");
  }
  if (mode === "delegated-auto") {
    note("  means      this process signs with nobody watching, inside the scope file's ceilings");
  }
  if (agent.config.network === "mainnet" && widening) {
    note("  mainnet    this is real money");
  }
  note("");
  show(
    {
      executionPolicy: mode,
      previous: current,
      network: agent.config.network,
      changed: true,
      envFile: envPath(),
      ...(ignored.kind === "added" || ignored.kind === "failed" ? { gitignore: ignored } : {}),
    },
    { rendered: true },
  );
  setOutcome(
    succeeded(`execution policy is ${mode} on ${agent.config.network}`, {
      nextCommand: invoke("next", "--json"),
    }),
  );
});
