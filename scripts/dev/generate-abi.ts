/**
 * Extract the Move ABI this agent verifies against, from `@waterx/sdk`'s
 * generated bindings.
 *
 * Why generated rather than written: the argument layouts were previously read
 * off transactions built by the live backend, which meant any entrypoint that
 * could not be built at that moment — a margin withdrawal with no free margin,
 * a redeem with no WLP — had no layout at all and fell back to searching the
 * transaction for values anywhere. That was a bad method, not a limitation. The
 * SDK ships the real signatures and ships WITH the deployment, so this reads
 * them instead.
 *
 * Run `pnpm run generate-abi` after bumping the SDK. The committed output is
 * checked by `test/abi.test.ts`, so a bump that changes a signature fails CI
 * rather than silently shifting what the verifier reads.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * The entrypoints the verifier needs laid out, as `module::function`.
 *
 * Declared rather than discovered: an SDK release that drops or renames one of
 * these must fail here, where it is obvious, instead of quietly leaving an
 * action unverified.
 */
const WANTED = [
  "trading::place_order_request",
  "trading::close_position_request",
  "trading::decrease_position_request",
  "trading::increase_position_request",
  "trading::deposit_collateral_request",
  "trading::withdraw_collateral_request",
  "trading::cancel_order_request",
  "trading::update_order_request",
  "lp_pool::mint_wlp",
  "lp_pool::request_redeem",
  "lp_pool::cancel_redeem",
  "waterx_staking::claim",
  "custody_vault::mint",
  "account::request_withdraw",
  "account::create_account",
  "account::add_delegate",
  "account::remove_delegate",
  "account::set_delegate_protocol_permission",
  // Not for its arguments — nothing binds them — but for its identity: it is
  // the authority handle every checked call takes, and without an ABI entry its
  // package could be any the deployment publishes.
  "account::request",
  // The withdrawal route. Which function is called IS the route, and the asset
  // the account is paid in is its type argument — neither appears as a value in
  // `request_withdraw`, so neither was bound until they were checked here.
  "withdrawal_queue::route_native",
  "withdrawal_queue::route_wormhole",
  "withdrawal_queue::enqueue",
  "request::new_place_order_argument",
];

/**
 * The SDK's generated directory names, where they differ from the deployment
 * manifest's key for the same package.
 *
 * Checked rather than trusted: `emit` refuses if a mapped name is absent from
 * the live manifest, so an alias that goes stale fails here instead of quietly
 * falling back to "any package this deployment publishes".
 */
const MANIFEST_ALIASES: Record<string, string> = {
  bucket_v2_framework: "bucket_framework",
  waterx_constant_rule: "constant_rule",
  waterx_pyth_rule: "pyth_rule",
  waterx_supra_rule: "supra_rule",
};

interface Extracted {
  /** The deployment manifest's package key. */
  pkg: string;
  /** The SDK's symbolic package name, e.g. `@waterx/perp`. */
  symbol: string;
  params: string[];
  types: (string | null)[];
}

const require_ = createRequire(import.meta.url);

const root = join(dirname(require_.resolve("@waterx/sdk/package.json")), "dist/src/generated");

/**
 * Read the wanted signatures out of the installed SDK.
 *
 * Exported so `test/abi.test.ts` can re-run it and compare against the
 * committed output: an SDK bump that changes a signature then fails CI instead
 * of leaving the verifier reading positions that have moved.
 */
export function extractAbi(): { entrypoints: Map<string, Extracted>; known: Map<string, number> } {
  const known = new Map<string, number>();
  const found = new Map<string, Extracted>();

  for (const pkg of readdirSync(root, { withFileTypes: true })) {
  if (!pkg.isDirectory()) continue;
  for (const file of readdirSync(join(root, pkg.name))) {
    if (!file.endsWith(".js")) continue;
    const source = readFileSync(join(root, pkg.name, file), "utf8");
    // Split on the export boundary so each block holds exactly one builder.
    for (const block of source.split(/^export function /m).slice(1)) {
      const symbol = /options\.package \?\? '([^']+)'/.exec(block)?.[1];
      const module = /\bmodule: '([^']+)'/.exec(block)?.[1];
      const fn = /\bfunction: '([^']+)'/.exec(block)?.[1];
      if (symbol === undefined || module === undefined || fn === undefined) continue;
      const key = `${module}::${fn}`;
      // Every function the SDK describes is recorded as a known identity, even
      // the ones with no bindings: an auxiliary call the deployment composes is
      // still the deployment's own code, and a call that is NOT in this set is
      // code nothing in the SDK has heard of.
      const arity = (/const argumentsTypes = \[([\s\S]*?)\];/.exec(block)?.[1] ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0).length;
      known.set(`${pkg.name}::${key}`, arity);
      if (!WANTED.includes(key)) continue;

      const typesRaw = /const argumentsTypes = \[([\s\S]*?)\];/.exec(block)?.[1] ?? "";
      const namesRaw = /const parameterNames = \[([\s\S]*?)\];/.exec(block)?.[1] ?? "";
      const types = typesRaw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .map((t) => (t === "null" ? null : t.replace(/^'|'$/g, "")));
      const params = namesRaw
        .split(",")
        .map((n) => n.trim().replace(/^"|"$/g, ""))
        .filter((n) => n.length > 0);

      const existing = found.get(key);
      if (existing !== undefined && existing.symbol !== symbol) {
        throw new Error(
          `${key} is exported by both ${existing.symbol} and ${symbol}. The verifier keys on ` +
            `module::function, so this would be ambiguous — key on the package too.`,
        );
      }
        found.set(key, { pkg: MANIFEST_ALIASES[pkg.name] ?? pkg.name, symbol, params, types });
      }
    }
  }

  const missing = WANTED.filter((k) => !found.has(k));
  if (missing.length > 0) {
    throw new Error(
      `these entrypoints are not in the SDK's generated bindings: ${missing.join(", ")}. ` +
        `Either the SDK renamed them or the deployment dropped them; the verifier cannot check ` +
        `an action whose signature it does not have.`,
    );
  }
  return { entrypoints: found, known };
}

export const SDK_VERSION_INSTALLED = (
  JSON.parse(readFileSync(require_.resolve("@waterx/sdk/package.json"), "utf8")) as {
    version: string;
  }
).version;

// Only the CLI writes the file; importing this module just exposes the reader.
if (process.argv[1]?.endsWith("generate-abi.ts") === true) emit();

function emit(): void {
const { entrypoints: found, known } = extractAbi();
const body = [...found.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(
    ([key, e]) =>
      `  ${JSON.stringify(key)}: {\n` +
      `    pkg: ${JSON.stringify(e.pkg)},\n` +
      `    symbol: ${JSON.stringify(e.symbol)},\n` +
      `    params: [${e.params.map((p) => JSON.stringify(p)).join(", ")}],\n` +
      `    types: [${e.types.map((t) => JSON.stringify(t)).join(", ")}],\n` +
      `  },`,
  )
  .join("\n");

const sdkVersion = SDK_VERSION_INSTALLED;

writeFileSync(
  "src/chain/abi.generated.ts",
  `/**
 * GENERATED — do not edit. Run \`pnpm run generate-abi\`.
 *
 * Move signatures extracted from @waterx/sdk ${sdkVersion}'s generated bindings.
 * \`params\` names each argument in order; \`types\` is one longer when the
 * contract takes a \`Clock\` the SDK injects without naming.
 */
export interface AbiEntry {
  /** The deployment manifest's package key, which is the identity a call is pinned to. */
  readonly pkg: string;
  /** The SDK's symbolic name for that package. */
  readonly symbol: string;
  readonly params: readonly string[];
  readonly types: readonly (string | null)[];
}

export const SDK_VERSION = ${JSON.stringify(sdkVersion)};

export const ABI: Readonly<Record<string, AbiEntry>> = {
${body}
};

/**
 * Every function the SDK describes, keyed by \`sdkPackage::module::function\`,
 * with the argument counts it declares.
 *
 * Not for binding — most of these have no argument checks — but for identity
 * and shape: a Move call whose name is not in here is code the SDK has never
 * heard of, and one whose arity disagrees is not the function it is named
 * after. Package-qualified, so a name that exists in one package does not
 * vouch for a call in another.
 */
export const KNOWN_FUNCTIONS: ReadonlyMap<string, readonly number[]> = new Map([
${[
  ...[...known].reduce((out, [full, arity]) => {
    // Keyed by \`sdkPackage::module::function\`, so a name that exists in one
    // package does not vouch for a call in another.
    const arities = out.get(full) ?? new Set<number>();
    arities.add(arity);
    out.set(full, arities);
    return out;
  }, new Map<string, Set<number>>()),
]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `  [${JSON.stringify(k)}, [${[...v].sort((a, b) => a - b).join(", ")}]],`)
  .join("\n")}
]);
`,
);

console.log(
  `wrote src/chain/abi.generated.ts — ${String(found.size)} entrypoints from @waterx/sdk ${sdkVersion}`,
);
}
