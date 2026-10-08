/**
 * A structural trap in the CLI scripts, caught statically.
 *
 * Every script ends with a top-level `await run(async () => { … })`. Top-level
 * await *suspends the module*, so any `const` declared after that line does not
 * exist while the body is running — referencing one throws
 * `Cannot access 'X' before initialization` at runtime, on every invocation.
 *
 * TypeScript accepts it. The unit suite does not exercise it. It shipped twice
 * in one afternoon (`balance`'s formatter, `bootstrap`'s gas threshold), which
 * makes it a property of the file layout rather than two mistakes: helpers
 * belong at the bottom, and `const` helpers at the bottom are landmines.
 *
 * `function` declarations are hoisted and are therefore fine — which is why the
 * rule below is about `const`/`let`/`var`, not about helpers in general.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

function scriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return scriptFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("CLI scripts", () => {
  it("declare nothing after the top-level `await run(`", () => {
    const offenders: string[] = [];
    for (const path of scriptFiles("scripts")) {
      const lines = readFileSync(path, "utf8").split("\n");
      const start = lines.findIndex((line) => line.startsWith("await run("));
      if (start === -1) continue;
      lines.slice(start).forEach((line, offset) => {
        // Top-level only: an indented declaration is inside something and is
        // evaluated when that something runs.
        if (/^(const|let|var)\s/.test(line)) {
          offenders.push(
            `${path}:${String(start + offset + 1)} — ${line.slice(0, 60)}… is declared after ` +
              `\`await run(\`, so it does not exist while the script body runs`,
          );
        }
      });
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

/**
 * Configuration belongs to the caller, not to this package.
 *
 * `dotenv` reads `.env` from the working directory; the wallet used to *write*
 * it relative to its own source file. Those name the same path in exactly one
 * situation — a checkout driven from its root — and diverge everywhere else: a
 * key written from a subdirectory is never loaded, and an installed package
 * would write one inside `node_modules`, to be wiped by the next install.
 */
describe("the .env this package writes", () => {
  it("follows the working directory, like the one it reads", async () => {
    const { envPath } = await import("../src/chain/wallet.ts");
    expect(envPath()).toBe(join(process.cwd(), ".env"));
  });

  it("can be pointed elsewhere, for a caller that keeps configuration apart", async () => {
    const { envPath } = await import("../src/chain/wallet.ts");
    vi.stubEnv("WATERX_ENV_FILE", "/somewhere/else/.env");
    expect(envPath()).toBe("/somewhere/else/.env");
    vi.unstubAllEnvs();
  });

  it("is never resolved against this file's own location", () => {
    // The shape of the old bug, so it cannot come back by refactor.
    const source = readFileSync("src/chain/wallet.ts", "utf8");
    expect(source).not.toMatch(/import\.meta\.url/);
  });
});

/**
 * Every command the documentation tells someone to run has to exist.
 *
 * This is not hypothetical tidiness. A recommended prompt shipped naming
 * `waterx skill`, which existed only on an unmerged branch; the person who
 * followed it got "no such command" as the very first thing this package ever
 * said to them, and had to recover by guessing. Docs and `package.json` drift
 * silently in that direction — a command is easy to write about before it is
 * written, and nothing else notices.
 */
describe("commands named in the documentation", () => {
  const scripts = new Set(
    Object.keys(JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, unknown>),
  );

  it("all exist in package.json", () => {
    const missing: string[] = [];
    for (const doc of ["README.md", "SKILL.md", "AGENT_INSTRUCTIONS.md", "AGENT.md", "AGENTS.md", ".env.example"]) {
      const text = readFileSync(doc, "utf8");
      // Both spellings this package uses for itself.
      const named = [
        ...text.matchAll(/(?:npx waterx|node bin\/waterx\.mjs)\s+([a-z][a-z0-9:-]*)/g),
        ...text.matchAll(/pnpm (?:--silent )?run ([a-z][a-z0-9:-]*)/g),
      ].map((m) => m[1] as string);
      for (const command of new Set(named)) {
        // Placeholders that stand in for a real name, not commands themselves.
        if (command === "build" || command === "install") continue;
        if (!scripts.has(command)) missing.push(`${doc} names \`${command}\`, which is not a script`);
      }
    }
    expect([...new Set(missing)], missing.join("\n")).toEqual([]);
  });
});

/**
 * Switches that belong to a person, held to a prohibition an agent will obey.
 *
 * These agents follow a direct instruction: told "Do not pass `--open`
 * yourself", one did exactly that, verbatim. What they do not do is infer a
 * prohibition from surrounding prose — a later install passed `--no-open` on
 * its own initiative, reasoning that a mainnet authorization page should not
 * auto-launch without a click, because nothing forbade it and the paragraph
 * offered it beside the environment switches as an equal option.
 *
 * So the prohibition is a checked invariant rather than a sentence somebody
 * once wrote. Softening it fails here.
 */
describe("switches an agent must not reach for", () => {
  const FORBIDDEN: Record<string, RegExp> = {
    // Whether a browser opens is the person's call; they have WATERX_NO_BROWSER.
    "--no-open": /\*\*Do not pass `--no-open`\.?\*\*/u,
    // Widening what a process may sign is the same kind of decision as approving.
    "policy --set": /a person runs that, never you/u,
  };

  it("are forbidden in SKILL.md, in words that name the flag", () => {
    const skill = readFileSync("SKILL.md", "utf8");
    for (const [flag, prohibition] of Object.entries(FORBIDDEN)) {
      expect(skill, `SKILL.md no longer forbids ${flag}`).toMatch(prohibition);
    }
  });

  it("say so in --help too, where an agent looks before it reads the docs", () => {
    const source = readFileSync("scripts/agent/onboard.ts", "utf8");
    const block = source.slice(source.indexOf("noOpen: {"), source.indexOf("approver: {"));

    expect(block).toMatch(/an agent must not pass it/u);
  });
});

/**
 * Redeclaring a global flag replaces it, whole.
 *
 * `parseArgs` merges `{ ...GLOBAL, ...defs }`, so a script that documents
 * `--yes` in its own words and forgets `flag: true` does not get the global
 * definition back — it gets a flag that demands a value. `policy --set
 * interactive --yes` then failed as "Missing value for --yes", which is a
 * usage error for a command that was invoked correctly.
 *
 * TypeScript cannot see it: both shapes are valid `ArgDef`s. Only running it
 * shows it, which is how this one was found.
 */
describe("scripts that redeclare a global flag", () => {
  /** How `scripts/lib/cli.ts` declares each one. */
  const GLOBAL_IS_FLAG: Record<string, boolean> = { json: true, yes: true, policy: false };

  it("keep it the same shape", () => {
    const offenders: string[] = [];
    for (const path of scriptFiles("scripts")) {
      if (path.startsWith(join("scripts", "lib"))) continue;
      const source = readFileSync(path, "utf8");
      for (const [name, isFlag] of Object.entries(GLOBAL_IS_FLAG)) {
        // The small, brace-free definitions these always are.
        const match = new RegExp(`\\n\\s+${name}: \\{([^{}]*)\\}`, "u").exec(source);
        if (match === null) continue;
        const declaresFlag = /flag:\s*true/u.test(match[1] ?? "");
        if (declaresFlag !== isFlag) {
          offenders.push(
            `${path} redeclares --${name} with flag: ${String(declaresFlag)}, but the global is ` +
              `flag: ${String(isFlag)} — the script's definition replaces it, so the flag changes shape`,
          );
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

/**
 * A flag nobody can find is a flag that does not exist.
 *
 * `--qr` and `--open` shipped in `--help` and in one line of a SKILL table, and
 * neither is on the path an agent reads: SKILL tells it to relay `headline` and
 * offer `suggestions`. Four minutes later a real session reasoned its way to
 * "the owner probably isn't at this machine" -- exactly what `--qr` is for --
 * and never mentioned it, because nothing it read named it.
 *
 * So adding a flag to `onboard` now forces a decision: put it where it can be
 * found, or say here why it does not need to be.
 */
describe("flags an agent could never discover", () => {
  /** Reached another way, and deliberately not on the handshake screen. */
  const HELP_ONLY: Record<string, string> = {
    json: "the output contract, documented in SKILL.md itself",
    policy: "a global, documented with the execution policy",
    yes: "a global confirmation, documented per write",
    label: "cosmetic: a name shown on the authorize page",
    link: "for piping; `--json` callers read authorizeUrl instead",
    interval: "tuning for --wait, which is itself surfaced",
    open: "the page opens by itself; this only re-opens it",
    noOpen: "an opt-out, and WATERX_NO_BROWSER is the documented one",
    approver: "a name for the record, the same flag `adopt` documents",
    details: "surfaced on the screen itself",
    qr: "surfaced on the screen itself",
    wait: "surfaced on the screen and in `next`",
  };

  it("are each either surfaced or explained", async () => {
    const source = readFileSync("scripts/agent/onboard.ts", "utf8");
    const block = source.slice(source.indexOf("const args = parseArgs("), source.indexOf('"onboard",'));
    const flags = [...block.matchAll(/^\s{4}([a-zA-Z]+): \{/gmu)].map((m) => m[1] as string);
    expect(flags.length, "no flags found — the parse above has drifted").toBeGreaterThan(4);

    const { delegationStatus, handshakeScreen } = await import("../src/agent/delegation.ts");
    const { decide } = await import("../src/agent/guidance.ts");
    const status = delegationStatus({ network: "mainnet", delegateAddress: `0x${"a".repeat(64)}` });
    const surfaced =
      handshakeScreen(status, { details: true }).join(" ") +
      decide({
        open: 0,
        firstUnsettled: undefined,
        pending: [],
        configured: false,
        missing: { signer: false, gas: false, account: true },
        readOnly: false,
        freeMargin: undefined,
        positions: 0,
        orders: 0,
        blockers: [],
        network: "mainnet",
        mode: "undecided",
        address: `0x${"a".repeat(64)}`,
      })
        .suggestions.map((x) => x.command)
        .join(" ");

    const invisible = flags.filter(
      (flag) => !surfaced.includes(`--${flag.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)}`),
    );
    const undeclared = invisible.filter((flag) => HELP_ONLY[flag] === undefined);

    expect(
      undeclared,
      `these are in --help and nowhere an agent reads. Surface them on the handshake screen or ` +
        `in next's suggestions, or add them to HELP_ONLY with a reason: ${undeclared.join(", ")}`,
    ).toEqual([]);
  });
});

/**
 * A maintainer tool must not be one typo away from a consumer.
 *
 * `waterx capture-corpus --help` ran the capture: the script has no argument
 * parsing, so the flag was ignored, and it overwrote the committed fixture with
 * a one-entry capture from an unconfigured run. Hiding it from `--help` was not
 * enough, because hiding is not refusing.
 */
describe("the bin shim", () => {
  const shim = readFileSync("bin/waterx.mjs", "utf8");

  it("refuses the maintainer tools by name, not merely hides them", () => {
    expect(shim).toMatch(/if \(INTERNAL\.has\(command\)\)/);
    for (const tool of ["capture-corpus", "generate-abi", "build", "prepare"]) {
      expect(shim, tool).toContain(`"${tool}"`);
    }
  });

  it("names an install that has no build in it, in the contract's own terms", () => {
    // `prepare` compiles at install time; npm >= 11 warns about it, and where
    // that warning is a policy the package installs with no `dist/`. What the
    // caller used to get was a MODULE_NOT_FOUND stack naming a path inside
    // node_modules, empty stdout, and exit 1 — the code reserved for "this
    // process fell over" — because `spawnSync` succeeds at spawning Node with a
    // path that does not exist, which left the shim's own message unreachable.
    const dir = mkdtempSync(join(tmpdir(), "waterx-unbuilt-"));
    mkdirSync(join(dir, "bin"));
    copyFileSync("bin/waterx.mjs", join(dir, "bin", "waterx.mjs"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "waterx-agent", scripts: { next: "tsx scripts/agent/next.ts" } }),
    );

    const run = spawnSync(process.execPath, [join(dir, "bin", "waterx.mjs"), "next", "--json"], {
      encoding: "utf8",
    });

    // `config`, not 1: the environment is wrong, and that is a thing a caller
    // can act on.
    expect(run.status, run.stderr).toBe(3);
    expect(run.stderr).toContain("npm install github:WaterXProtocol/waterx-agent");
    // And warns off the obvious wrong move: `npm rebuild` reports success and
    // does not run `prepare`, so it leaves the package exactly as broken.
    expect(run.stderr).toMatch(/npm rebuild` does NOT/u);
    // And the one-document promise survives the failure it is most likely to
    // meet on a first install.
    const envelope = JSON.parse(run.stdout) as { ok: boolean; status: string; nextCommand: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.status).toBe("config");
    expect(envelope.nextCommand).toBe("npm install github:WaterXProtocol/waterx-agent");
  });

  it("does not ship them either", () => {
    // Belt and braces: the refusal is a behaviour, this is an absence. A
    // destructive tool that is not in the tarball cannot be reached by any
    // route, including ones nobody thought of.
    const files = JSON.parse(readFileSync("package.json", "utf8")).files as string[];
    expect(files).toContain("!dist/scripts/dev");
  });
});

/**
 * The scope-writing command as an agent will copy it.
 *
 * Every ceiling in a scope is mandatory and the file is refused whole when one
 * is missing, so the example in the docs is not illustrative — it is the
 * command that runs. Adding a required ceiling is exactly the change that
 * leaves that example one flag short, and the result is not a clear error at
 * the point of the mistake: `limits --write` fails, or writes a file that a
 * runner refuses later, for a reason the agent did not cause and cannot see.
 *
 * So the example is checked against what the script actually demands.
 */
describe("the documented scope-writing command", () => {
  const source = readFileSync("scripts/agent/limits.ts", "utf8");
  // The two helpers that refuse a missing value, and the flag each one names.
  const required = new Set(
    [...source.matchAll(/(?:numeric|demand)\(\s*args\.\w+,\s*"(--[a-z-]+)"/g)].map(
      (m) => m[1] as string,
    ),
  );

  it("names every flag the script refuses to run without", () => {
    expect(required.size, "no required flags found — the regex stopped matching").toBeGreaterThan(5);

    for (const doc of ["AGENT_INSTRUCTIONS.md", "SKILL.md", "README.md", "AGENT.md"]) {
      const text = readFileSync(doc, "utf8");
      for (const block of text.matchAll(/```bash\n([^`]*?limits[^`]*?--write[^`]*?)```/g)) {
        const example = block[1] as string;
        const missing = [...required].filter((flag) => !example.includes(flag));
        expect(missing, `${doc}: the \`limits --write\` example omits ${missing.join(", ")}`).toEqual(
          [],
        );
      }
    }
  });
});

describe("a read command does not touch the write plane", () => {
  // Building the executor asserts that the account's owner has been settled,
  // because whether this process signs as a delegate must not be decided from a
  // missing fact. Two query scripts reached for `executor.senderAddress` just to
  // learn which wallet to ask about, so commands that sign nothing died on an
  // assertion about signing — and `delegated-auto` went with them, since the
  // runner reached the same getter on its first line of output.
  //
  // Checked as a property of the source rather than by running them: the
  // hermetic suite has no server to read from, and this is the mistake that is
  // easy to make again precisely because it looks harmless.
  it("takes the wallet from `subjectWallet()`, not from the executor", () => {
    const offenders = readdirSync("scripts/query")
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => /\bagent\.executor\b/u.test(readFileSync(join("scripts/query", name), "utf8")));

    expect(
      offenders,
      "a read command reached the write plane; `agent.subjectWallet()` answers the same question and resolves the owner first",
    ).toEqual([]);
  });
});

describe("a scope that is already over", () => {
  // `--not-after` in the past was accepted and reported `ok`, so the next
  // unattended write refused for a reason the operator had just been told was
  // fine — and the remedy, rewriting the scope, is what they had done.
  it("refuses to write a delegation that has already expired, and writes nothing", () => {
    const at = join(mkdtempSync(join(tmpdir(), "waterx-scope-")), "scope.json");
    const run = spawnSync(
      process.execPath,
      [
        "--import", "tsx", "scripts/agent/limits.ts",
        "--write", at,
        "--accounts", `0x${"a".repeat(64)}`,
        "--not-after", "2020-01-01T00:00:00Z",
        "--max-collateral-per-order", "10",
        "--max-open-collateral", "20",
        "--max-cumulative-collateral", "100",
        "--max-leverage", "3",
        "--max-slippage-percent", "1",
      ],
      { encoding: "utf8" },
    );

    expect(run.stdout + run.stderr).toMatch(/already passed/u);
    // The assertion that matters: a refusal that still wrote the file would be
    // a scope on disk nobody meant to install.
    expect(existsSync(at), "an expired scope was written anyway").toBe(false);
  }, 30_000);
});

describe("the one JSON document --json promises", () => {
  // The flag promises stdout carries exactly one document, and this shim was
  // exempting itself: an unknown command, `--help` and a maintainer tool all
  // wrote prose to stderr and left stdout EMPTY. A caller that parses stdout —
  // which is what the flag is for — met its first mistake as a parse error
  // rather than as an answer, so the most likely first interaction with this
  // binary was also the one that broke the contract.
  const shim = (argv: readonly string[]) =>
    spawnSync(process.execPath, ["bin/waterx.mjs", ...argv], { encoding: "utf8" });

  for (const [label, argv] of [
    ["an unknown command", ["zzz-not-a-command", "--json"]],
    ["help", ["--help", "--json"]],
    ["a maintainer tool", ["capture-corpus", "--json"]],
  ] as const) {
    it(`answers ${label} with one parseable document`, () => {
      const run = shim(argv);
      expect(run.stdout, `${label}: stdout was empty`).not.toBe("");
      const parsed = JSON.parse(run.stdout) as { ok: boolean; status: string; message: string };
      expect(typeof parsed.ok).toBe("boolean");
      expect(parsed.status.length).toBeGreaterThan(0);
      expect(parsed.message.length).toBeGreaterThan(0);
    });
  }

  it("leaves the human output alone when nobody asked for JSON", () => {
    // The prose is still prose, and stdout is still clean for a caller that
    // pipes it without the flag.
    const run = shim(["zzz-not-a-command"]);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/unknown command/u);
  });
});

/**
 * What `preview` tells a machine about its own risk checks.
 *
 * The findings were written with `note()` only, so they reached a human reading
 * the terminal and nothing reached an agent reading `--json`: no `warnings`
 * field, and no way to tell a preview CHECKED against its market from one where
 * the market could not be read. An external tester previewed 1000x leverage, saw
 * nothing, and reasonably reported the check as missing — it had run and had
 * nothing to compare against, and the document could not say so.
 *
 * Static, like the rest of this file: the scripts have no end-to-end harness,
 * and a deleted field should fail here rather than in somebody's test report.
 */
describe("preview's machine-readable risk report", () => {
  const source = readFileSync("scripts/agent/preview.ts", "utf8");

  it("puts the feasibility report in the document, not only on the human stream", () => {
    expect(source).toMatch(/feasibility: feasibilityReport/);
    expect(source).toMatch(/checked: feasibility\.checked/);
  });

  it("says WHY nothing was checked, when nothing was", () => {
    // `checked: false` with no reason is a dead end for the caller: it cannot
    // tell a market that is down from an account it has not adopted.
    expect(source).toMatch(/notCheckedBecause/);
  });

  it("also reports it on the blocking path, where an approval was withheld", () => {
    // The refusal already carried `feasibility`; it has to carry the same shape,
    // or a caller parses one field two ways depending on the answer.
    expect(source).toMatch(/blocking: feasibility\.blocking/);
  });
});

/**
 * Where `.env` is READ from.
 *
 * `stateRoot()` anchored where `.env` is written and where the four ledgers
 * live, and left `dotenv.config()` resolving against the working directory. So
 * half the fix shipped: `next` found the install from a subdirectory and every
 * command that needs a configured account did not. An external tester saw `next`
 * answer and `balance` answer "No WaterX account configured" from the same
 * install, two directories apart.
 *
 * Spawned, because that is the only way this is observable — the bug was in
 * module-load order, which no in-process import can reproduce. `limits` is the
 * subject because it reads the account and touches no network.
 */
describe("a configured install, seen from a subdirectory", () => {
  it("finds the account that .env names", () => {
    const install = mkdtempSync(join(tmpdir(), "waterx-subdir-"));
    const deep = join(install, "a", "b");
    mkdirSync(deep, { recursive: true });
    writeFileSync(
      join(install, ".env"),
      `WATERX_ACCOUNT_ID=0x${"a".repeat(64)}\nWATERX_NETWORK=testnet\n`,
    );

    const run = spawnSync(process.execPath, [join(process.cwd(), "bin", "waterx.mjs"), "limits", "--json"], {
      cwd: deep,
      encoding: "utf8",
      // A clean environment, or the suite's own WATERX_* would supply the very
      // thing this asserts has to come from the file.
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });

    const document = JSON.parse(run.stdout) as { status?: string; data?: { accountId?: string } };
    expect(document.status, run.stdout).toBe("ok");
    expect(document.data?.accountId).toBe(`0x${"a".repeat(64)}`);
  }, 60_000);
});

/**
 * `--help` under `--json`.
 *
 * The contract is one JSON document on stdout, and this was the path that
 * exempted itself: `<cmd> --help --json` wrote the option list to the HUMAN
 * stream and exited, leaving stdout empty. Asking a tool to describe itself is
 * the most likely first thing an agent does.
 *
 * And for the eighteen scripts that never call `parseArgs` — they take no
 * options of their own — the flag was not merely unanswered, it was ignored and
 * the command RAN. `markets --help` performed the read; `fund-sui --help` would
 * have asked a faucet for money and `generate-wallet --help` would have minted a
 * key. Describing an action must never perform it.
 */
describe("--help answers in the contract's own format", () => {
  const help = (command: string): { status?: string; ok?: boolean; details?: { options?: unknown[]; takesNoOptionsOfItsOwn?: boolean } } => {
    const run = spawnSync(
      process.execPath,
      [join(process.cwd(), "bin", "waterx.mjs"), command, "--help", "--json"],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } },
    );
    expect(run.stdout.trim(), `${command} wrote nothing to stdout`).not.toBe("");
    return JSON.parse(run.stdout) as ReturnType<typeof help>;
  };

  it("lists a command's own options", () => {
    const document = help("preview");
    expect(document.ok).toBe(true);
    expect(document.details?.options?.length ?? 0).toBeGreaterThan(5);
  });

  it("answers for a command that parses no arguments, instead of running it", () => {
    // `markets` is a read, so running it was survivable. It is here because the
    // same path reaches two commands that are not.
    const document = help("markets");
    expect(document.ok).toBe(true);
    expect(document.details?.takesNoOptionsOfItsOwn).toBe(true);
  });

  it("describes the two commands where running instead of describing would act", () => {
    for (const command of ["fund-sui", "generate-wallet"]) {
      const document = help(command);
      expect(document.ok, command).toBe(true);
      expect(document.details?.takesNoOptionsOfItsOwn, command).toBe(true);
    }
  });

  it("is `ok`, not `usage` — being asked for help is not a misuse", () => {
    expect(help("limits").status).toBe("ok");
  });
}, 90_000);

describe("what SKILL.md says before it says anything else", () => {
  const skill = readFileSync("SKILL.md", "utf8");
  /** Everything an agent has read by the time it runs the first command. */
  const opening = skill.slice(0, skill.indexOf("## Start here"));

  it("states that the default network is production, in the opening", () => {
    // It was said at line 78 and line 127, and the first command is at line 16.
    // An agent that reads top-down had already run reads against production
    // before it learned which deployment it was talking to.
    expect(opening).toMatch(/mainnet/u);
    expect(opening).toMatch(/real money/u);
  });

  it("and that nothing is signed by default, so the two are not confused", () => {
    // Reading production and spending on it are different facts. Stating the
    // first alone would read as more alarming than it is; stating only the
    // second would read as less.
    expect(opening).toMatch(/read-only/u);
  });
});

/**
 * `jobs` answers a machine as well as a person.
 *
 * Everything it printed went through `note` — the human stream — so `--json`
 * returned an envelope with no `data` at all, and an agent asking what was
 * scheduled got a document that said nothing either way. An operator reading
 * "no jobs" from a full inbox queues the work twice; an agent reading an empty
 * document cannot even tell that it was not told.
 *
 * Spawned with a real store and a real inbox, because the two halves coming from
 * two files is the thing that was wrong.
 */
describe("jobs reports the queue in the document", () => {
  it("names what is queued, what is in the store, and what it could not read", () => {
    const home = mkdtempSync(join(tmpdir(), "waterx-jobs-"));
    const inbox = join(home, ".waterx", "jobs.inbox");
    mkdirSync(inbox, { recursive: true });
    // One readable intent and one file that is not. An unreadable entry must be
    // COUNTED, not skipped: it is the one state where either number alone lies.
    writeFileSync(
      join(inbox, "aaaaaaaa-1.json"),
      JSON.stringify({ intent: { action: "open-long", ticker: "SUIUSD", side: "long" }, key: "k" }),
    );
    writeFileSync(join(inbox, "bbbbbbbb-2.json"), "{ not json");

    const run = spawnSync(
      process.execPath,
      [join(process.cwd(), "bin", "waterx.mjs"), "jobs", "--store", join(home, ".waterx", "jobs.json"), "--json"],
      { cwd: home, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home } },
    );

    const document = JSON.parse(run.stdout) as {
      data?: { queued?: { readable?: boolean }[]; counts?: { queued?: number; unreadable?: number; inStore?: number } };
    };
    expect(document.data, run.stdout).toBeDefined();
    expect(document.data?.counts?.queued).toBe(2);
    expect(document.data?.counts?.unreadable).toBe(1);
    expect(document.data?.counts?.inStore).toBe(0);
    // And the empty store is still reported, rather than ending the answer: the
    // early return meant a full inbox produced no document at all.
    expect(document.data?.queued?.some((q) => q.readable === false)).toBe(true);
  }, 60_000);
});

/**
 * Every action an agent is allowed to take can be previewed.
 *
 * `place-tpsl` and `update-order` were not in `preview`, so the only way to
 * reach them was a direct command with `--yes` — and SKILL.md forbids an agent
 * from passing `--yes`, because that is the flag that skips the person. A
 * capability an agent is told not to use and given no alternative to is a dead
 * end, not a safeguard. Both plan methods already existed; only the dispatch was
 * missing.
 */
describe("preview covers the actions an agent may ask for", () => {
  const preview = (action: string): { status?: string; message?: string } => {
    const run = spawnSync(
      process.execPath,
      [join(process.cwd(), "bin", "waterx.mjs"), "preview", "--action", action, "--json"],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } },
    );
    expect(run.stdout.trim(), `${action} wrote nothing`).not.toBe("");
    return JSON.parse(run.stdout) as { status?: string; message?: string };
  };

  for (const action of ["place-tpsl", "update-order"]) {
    it(`knows ${action}, and asks for its arguments rather than rejecting it`, () => {
      const document = preview(action);
      // The distinction that matters: "which market?" is a recognised action
      // missing an argument. "Unknown --action" is the bug.
      expect(document.message ?? "").not.toMatch(/Unknown --action/u);
      expect(document.message ?? "").toMatch(/--ticker is required/u);
    });
  }

  it("still refuses an action that does not exist", () => {
    // The guard on the test above: if preview accepted anything, the two
    // assertions would pass without the dispatch existing.
    expect(preview("not-an-action").message ?? "").toMatch(/Unknown --action/u);
  });
}, 90_000);

/**
 * The advertised action list and the dispatch that serves it.
 *
 * `ACTIONS` is only a list for a message; the switch's `default` is the
 * validation. So they drift in both directions and both lies are quiet:
 *
 *  - in the switch, not in `ACTIONS` — it works and is never advertised, which
 *    is what `place-tpsl` would have been had only the dispatch been added;
 *  - in `ACTIONS`, not in the switch — it is advertised and then refused as
 *    unknown, in a message that lists it among the valid ones.
 *
 * Found by a verify-by-removal that did NOT fail: deleting the two entries from
 * `ACTIONS` left the capability working, which is how I learned the list was not
 * what enforced anything.
 */
describe("preview's action list matches its dispatch", () => {
  const source = readFileSync("scripts/agent/preview.ts", "utf8");

  const advertised = (): string[] => {
    const block = source.slice(source.indexOf("const ACTIONS = ["), source.indexOf("] as const;"));
    return [...block.matchAll(/^\s*"([a-z-]+)",$/gmu)].map((m) => m[1] as string);
  };
  const dispatched = (): string[] => {
    const block = source.slice(source.indexOf("function planFor("));
    // The trailing `{` is optional: a branch with a block body is still a
    // branch, and the first version of this regex missed `case "place-order": {`
    // and reported a drift that was its own.
    return [...block.matchAll(/^\s*case "([a-z-]+)":\s*\{?$/gmu)].map((m) => m[1] as string);
  };

  it("advertises exactly what it serves", () => {
    expect([...advertised()].sort()).toEqual([...dispatched()].sort());
  });

  it("found both lists at all, so an empty match cannot pass", () => {
    // Two regexes parsing one file is a test that fails open if either stops
    // matching. This is the assertion that closes it.
    expect(advertised().length).toBeGreaterThan(10);
    expect(dispatched().length).toBe(advertised().length);
  });
});

/**
 * What every document says about the runtime it came from.
 *
 * "MAINNET — this spends real money" was written to the human stream only, so an
 * agent reading `--json` had to derive the risk from the `network` field and know
 * what that implied. On every document rather than only on a preview: whether this
 * installation can spend real money is not a property of one command.
 *
 * Spawned, because the warning is assembled from the loaded config at the moment
 * the envelope is written.
 */
describe("standing warnings travel with every document", () => {
  const documentFrom = (env: Record<string, string>): { warnings?: string[]; network?: string } => {
    const home = mkdtempSync(join(tmpdir(), "waterx-warn-"));
    writeFileSync(
      join(home, ".env"),
      Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
    );
    const run = spawnSync(
      process.execPath,
      [join(process.cwd(), "bin", "waterx.mjs"), "markets", "--help", "--json"],
      { cwd: home, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home } },
    );
    expect(run.stdout.trim(), run.stderr).not.toBe("");
    return JSON.parse(run.stdout) as { warnings?: string[]; network?: string };
  };

  it("says mainnet spends real money, in the document", () => {
    const document = documentFrom({ WATERX_NETWORK: "mainnet" });
    expect(document.network).toBe("mainnet");
    expect((document.warnings ?? []).join(" ")).toMatch(/real money/u);
  });

  it("says nothing of the sort on testnet", () => {
    // The assertion that makes the first one mean something. A warning on every
    // document regardless would be noise, and noise is ignored.
    const document = documentFrom({ WATERX_NETWORK: "testnet" });
    expect((document.warnings ?? []).join(" ")).not.toMatch(/real money/u);
  });

  it("says when nothing can be signed, which is the other half of the risk", () => {
    // Reading production and spending on it are different facts, and a caller
    // told only the first would read it as worse than it is.
    const document = documentFrom({ WATERX_NETWORK: "mainnet" });
    expect((document.warnings ?? []).join(" ")).toMatch(/read-only/u);
  });
}, 90_000);

describe("a bad --tf is the caller's mistake, not the server's refusal", () => {
  it("refuses an unknown timeframe before the request, as usage", () => {
    // `--tf zzz` was cast into the closed union, reached the server, and came
    // back `rejected` — the code this contract reserves for a request refused on
    // its merits. An agent branching on it would report a server problem for a
    // value it typed itself.
    const home = mkdtempSync(join(tmpdir(), "waterx-tf-"));
    writeFileSync(join(home, ".env"), "WATERX_NETWORK=testnet\n");
    const run = spawnSync(
      process.execPath,
      [join(process.cwd(), "bin", "waterx.mjs"), "candles", "--ticker", "SUIUSD", "--tf", "zzz", "--json"],
      { cwd: home, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home } },
    );
    const document = JSON.parse(run.stdout) as { status?: string; message?: string };
    expect(document.status, run.stdout).toBe("usage");
    // And it lists them, so the next attempt is right rather than another guess.
    expect(document.message ?? "").toMatch(/1m, 5m, 15m, 1h, 4h, 1d/u);
  }, 60_000);
});

/**
 * `execute` settles what it confirmed.
 *
 * It left every submission outstanding whatever happened, so `next` blocked the
 * next action until somebody ran `reconcile` — and SKILL.md says to reconcile only
 * an `ambiguous` result, so the instruction and the behaviour disagreed. It could
 * not settle before: it did not know the outcome. Now it reads the status back, so
 * it does.
 *
 * Static, and the limit is worth stating: this asserts the call is there and
 * guarded by the confirmation, not that a real sponsored submission settles. That
 * needs a signature and a chain, which `packages/e2e` is for and which has not
 * run. The behaviour either side of it IS covered — `didLand` separating an abort
 * from an execution, and the executor's three outcomes.
 */
describe("execute settles a confirmed execution", () => {
  const source = readFileSync("scripts/agent/execute.ts", "utf8");

  it("settles the submission it just confirmed", () => {
    expect(source).toMatch(/settle\(submissionId, \{ landed: true \}\)/u);
  });

  it("only when the chain confirmed it, never on an unconfirmed digest", () => {
    // The guard that matters. Settling an UNCONFIRMED submission would clear it
    // from `next` while nobody knew what it did — which is worse than blocking.
    expect(source).toMatch(/if \(confirmed && submissionId !== undefined\) settle\(/u);
  });

  it("records nothing about the ORDER, which the indexer may not have yet", () => {
    // `landed: true` and no more. `reconcile` already reports a lagging indexer as
    // `not-indexed-yet` rather than as an empty result, and inventing an order
    // status here would be a claim about something nobody read.
    expect(source).not.toMatch(/settle\(submissionId, \{ landed: true, orderIds/u);
  });
});

/**
 * `sync-stops`, and the three places that point at it.
 *
 * A position reduced to 5.93 still showed a stop for 11.87. It is a separate
 * command rather than a step inside `reduce-position`, and both reasons are
 * load-bearing: a reduce is keeper-filled, so at the moment it returns there is no
 * correct resize to make — shrinking a stop to the size the position is ABOUT to be
 * leaves it under-protected until the fill lands — and one approval binds one
 * intent, so a second write on the back of the first is what the approval model
 * exists to prevent.
 */
describe("sync-stops", () => {
  const source = readFileSync("scripts/orders/sync-stops.ts", "utf8");

  it("is a registered command, so the printed instruction runs", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(manifest.scripts?.["sync-stops"]).toBe("tsx scripts/orders/sync-stops.ts");
  });

  it("reads the position before resizing anything", () => {
    // The whole design. Comparing against the observed size is what makes it
    // idempotent and what keeps it from shrinking a stop ahead of a fill.
    expect(source).toMatch(/agent\.read\.positions\(/u);
    expect(source).toMatch(/oversizedStops\(position\)/u);
  });

  it("keeps each leg's trigger price", () => {
    // Resizing must not reprice. Where a stop sits is the trader's decision.
    expect(source).toMatch(/newTriggerPrice: stop\.triggerPrice/u);
    expect(source).toMatch(/newSize: stop\.shouldBe/u);
  });

  it("is authorized like every other write, not waved through as a tidy-up", () => {
    expect(source).toMatch(/confirm: confirmed\(\)/u);
  });

  it("reports a partial run instead of raising it", () => {
    // Each leg is its own signature. One landing and the next being refused must
    // not discard the first — and re-running is safe, because it compares sizes.
    expect(source).toMatch(/if \(resized\.length === 0\) throw error;/u);
  });

  it("is pointed at from `positions` and from `reduce-position`", () => {
    for (const file of ["scripts/query/positions.ts", "scripts/trading/reduce-position.ts"]) {
      expect(readFileSync(file, "utf8"), file).toMatch(/invoke\("sync-stops"/u);
    }
  });
});

describe("a direct command does not claim an unconfirmed execution", () => {
  /**
   * `reportTx` said "submitted and executed" unconditionally. The fix for that
   * went into the approval path only, so every DIRECT command — `reduce-position
   * --yes`, `close-position --yes` — went on saying a sponsored submission whose
   * status could not be read had executed. One bug, two callers, one mended.
   */
  const source = readFileSync("scripts/lib/cli.ts", "utf8");

  it("branches on what the chain confirmed", () => {
    expect(source).toMatch(/const confirmed = result\.executed === "SUCCEEDED";/u);
  });

  it("reports an unconfirmed submission as ambiguous, with a reconcile", () => {
    const block = source.slice(source.indexOf("export function reportTx"), source.indexOf("// ─── The run loop"));
    expect(block).toMatch(/status: "ambiguous"/u);
    expect(block).toMatch(/reconcileRequired: true/u);
    expect(block).toMatch(/must not be sent again/u);
  });

  it("still says executed when it was", () => {
    const block = source.slice(source.indexOf("export function reportTx"), source.indexOf("// ─── The run loop"));
    expect(block).toMatch(/submitted and executed/u);
  });
});
