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
import type { PolicyMode } from "../../src/policy.ts";
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

/** In rank order: each one may sign everything the one before it may, and more. */
const MODES: readonly PolicyMode[] = ["read-only", "interactive", "delegated-auto"];

const rank = (mode: PolicyMode): number => MODES.indexOf(mode);

const quiet = { submitted: false, reconcileRequired: false, awaitingApproval: false } as const;

await run(async () => {
  const agent = initAgent();
  const current = agent.config.executionPolicy;
  const wanted = args.set;

  if (wanted === undefined) {
    note("");
    note(`  policy     ${current} on ${agent.config.network}`);
    note(`  file       ${envPath()}`);
    note(`  change it  ${invoke("policy", "--set", "interactive", "--yes")}`);
    note("");
    show({ executionPolicy: current, network: agent.config.network, envFile: envPath() }, { rendered: true });
    setOutcome(succeeded(`policy ${current} on ${agent.config.network}`));
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
  if (agent.config.network === "mainnet" && widening) {
    note("  mainnet    this is real money; every write still goes preview → approve → execute");
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
