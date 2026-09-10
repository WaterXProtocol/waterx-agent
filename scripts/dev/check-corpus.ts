/**
 * Is the committed ABI corpus still a description of the running deployment?
 *
 * The fixture records argument layouts captured from real transactions, and
 * every positional check in `verify.ts` rests on it. Nothing in an offline test
 * suite can notice when the deployment moves on: the corpus is a file, and a
 * file does not go stale by itself. `runDoctor` makes this comparison, and so
 * does `TxExecutor.execute()` — but both of those run on an operator's machine,
 * which means the first person to find out is whoever was about to trade.
 *
 * So CI asks the same question on a schedule. It is deliberately a separate
 * job: it needs the network, and a config document that is briefly unreachable
 * must not read as "the layouts are wrong".
 *
 * Exit codes follow `src/cli/contract.ts`:
 *   0  the corpus still describes the deployment
 *   3  it does not — re-run `pnpm run capture-corpus` and look at what changed
 *   7  the config document could not be read; this says nothing either way
 */
import { corpusFor, hasCorpusFor, measuredNetworks } from "../../src/chain/corpus.ts";
import { assertCorpusDescribes, loadDeployment } from "../../src/chain/deployment.ts";
import { ACTION_RULES } from "../../src/chain/verify.ts";
import { loadConfig } from "../../src/config.ts";
import { EXIT } from "../../src/cli/contract.ts";

const config = loadConfig();
const corpus = corpusFor(config.network);

if (!hasCorpusFor(config.network)) {
  process.stderr.write(
    `config: no argument layouts have ever been captured on ${config.network}; measured ` +
      `networks are ${measuredNetworks().join(", ") || "none"}. Every write refuses there.\n`,
  );
  process.exit(EXIT.config);
}

let deployment;
try {
  deployment = await loadDeployment(config.configUrl);
} catch (error) {
  process.stderr.write(
    `unavailable: ${config.configUrl} could not be read — ` +
      `${error instanceof Error ? error.message : String(error)}\n` +
      `This says nothing about whether the corpus is stale.\n`,
  );
  process.exit(EXIT.unavailable);
}

try {
  assertCorpusDescribes(deployment, corpus.packages, corpus.capturedAt);
} catch (error) {
  process.stderr.write(`config: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(EXIT.config);
}

// Not a failure — an entrypoint can be uncapturable for as long as the
// conditions to build one do not exist (a redemption needs an unstaked WLP
// balance; minting never leaves one). Reported so the list is visible in a CI
// log rather than only in a preflight nobody ran.
const unconfirmed = Object.entries(ACTION_RULES)
  .filter(([, rule]) => Object.hasOwn(corpus.uncaptured, rule.entrypoint))
  .map(([action]) => action);

process.stdout.write(
  `ok: ${String(Object.keys(corpus.captured).length)} entrypoints confirmed against ` +
    `${config.network} on ${corpus.capturedAt}; the deployment has not moved since.\n` +
    (unconfirmed.length === 0
      ? ""
      : `note: these actions still refuse under default settings — ${unconfirmed.join(", ")}\n`),
);
