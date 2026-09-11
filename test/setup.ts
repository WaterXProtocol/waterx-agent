/**
 * Clear the agent's own environment before any test runs.
 *
 * `loadConfig()` reads `process.env` by design — that is how a deployment
 * configures it. In a test that becomes a dependency on the developer's shell:
 * a `WATERX_POLICY_SCOPE_FILE` left exported from a live run makes the whole
 * suite fail, and a stale `WATERX_ACCOUNT_ID` would make it pass for the wrong
 * reason. Neither is a statement about the code.
 *
 * `.env` is deliberately not loaded either. Tests state their own configuration.
 */
const OWNED = /^(WATERX_|SUI_PRIVATE_KEY$|SUI_NETWORK$|SUI_GRPC_URL$)/;

for (const name of Object.keys(process.env)) {
  if (OWNED.test(name)) delete process.env[name];
}

/**
 * Then state the network, rather than inheriting the default.
 *
 * Almost every fixture here describes **testnet** — the recorded argument
 * layouts, the seeded deployment, the package ids the executor checks against.
 * The default network is mainnet, and once it became so these tests were
 * silently checking testnet fixtures against a mainnet configuration and
 * failing for a reason that had nothing to do with what they assert.
 *
 * Pinning it makes the dependency visible: a test that wants the default asks
 * for it explicitly (see `test/config.test.ts`), and every other one says which
 * deployment it is about.
 */
process.env.WATERX_NETWORK = "testnet";
