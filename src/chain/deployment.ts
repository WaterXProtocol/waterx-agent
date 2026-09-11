/**
 * The set of Move packages this deployment publishes.
 *
 * Needed because a transaction's entrypoints are matched on `module::function`,
 * and those names are not owned by anyone: a package the attacker publishes can
 * export `trading::place_order_request` with whatever body it likes, satisfy
 * every argument check, and do something else entirely. Without the package id
 * the argument checks are decorative.
 *
 * Fetched once per process and cached. It is deliberately NOT re-fetched on
 * failure after a first success: a long-running runner should not lose the
 * ability to sign because a CDN blipped, and a package set that was valid a
 * minute ago is still the right one to check against.
 */
import { ExecutionPolicyError } from "../errors.ts";

export interface Deployment {
  /**
   * Package ids a transaction may CALL: the current `published_at` of each
   * package, and nothing else.
   *
   * Deliberately excludes `original_id`. Sui packages are immutable and an
   * upgrade publishes a new object, so every previous version stays on chain
   * and stays callable. Accepting the original id therefore accepts a
   * downgrade — routing the call through v1 of a package now on v3. Whether
   * that is harmful depends on version guards inside the contract, which is not
   * something a client should be betting on.
   */
  callable: ReadonlySet<string>;
  /**
   * Package ids that may appear in a TYPE argument: `published_at` and
   * `original_id` both.
   *
   * Type identity in Move is keyed by the ORIGINAL package id, so real
   * transactions legitimately name it — `set_delegate_protocol_permission`
   * carries `<0x5056…::account_data::WaterXPerp>`, which is waterx_perp v1's
   * id while the deployment runs v3. Holding type arguments to `published_at`
   * would refuse every delegate change.
   */
  typeable: ReadonlySet<string>;
  /** Name → current package id. The identity each action's entrypoint is pinned to. */
  byName: ReadonlyMap<string, string>;
  /**
   * Every id a named package has held — current and original.
   *
   * Type identity in Move is keyed by the ORIGINAL id, so a type naming one of
   * this deployment's structs may carry either. Matching a slot type needs both.
   */
  idsFor: (name: string) => readonly string[];
  /**
   * Every shared object the deployment document names, by id.
   *
   * The document lists them — registries, configs, the oracle, the pool, each
   * market — alongside the packages. Two earlier rounds declined to constrain
   * shared inputs on the grounds that no such list existed; it did, in the
   * document this module already fetches.
   */
  objects: ReadonlySet<string>;
  /** Role name (`waterx_perp.global_config`) → object id, for per-argument pinning. */
  objectFor: (role: string) => string | undefined;
}

interface PackageEntry {
  published_at?: string;
  original_id?: string;
  version?: number;
  [field: string]: unknown;
}

interface DeploymentDocument {
  packages?: Record<string, PackageEntry | undefined>;
  coin_registry?: unknown;
}

/**
 * Every object id anywhere under an entry.
 *
 * Walked rather than named field by field: the document nests markets under
 * packages and coins under the registry, and a check that had to be taught each
 * new shape would quietly stop covering the ones it had not learned.
 */
function collectObjects(
  node: unknown,
  into: Set<string>,
  byRole: Map<string, string>,
  prefix = "",
  depth = 0,
): void {
  if (depth > 6 || node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    // Package ids are covered by `callable`/`typeable`; these are objects.
    if (key === "published_at" || key === "original_id") continue;
    if (typeof value === "string" && /^0x[0-9a-fA-F]{4,}$/.test(value)) {
      into.add(normalizePackage(value));
      byRole.set(`${prefix}${key}`, normalizePackage(value));
    } else {
      collectObjects(value, into, byRole, `${prefix}${key}.`, depth + 1);
    }
  }
}

/** Sui's own packages, which every transaction may call. */
const FRAMEWORK = ["0x1", "0x2", "0x3"];

export const normalizePackage = (id: string): string =>
  id.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/**
 * How long a fetched manifest is trusted before it is re-read.
 *
 * A manifest cached for the life of the process was worse than it sounds. The
 * corpus-freshness check asserts that the recorded layouts still describe the
 * deployment — but it compares them against THIS manifest, so a runner started
 * before an upgrade held the old ids, agreed with itself, and signed happily
 * against a contract that had moved.
 */
const MANIFEST_TTL_MS = 5 * 60_000;

/**
 * How long a stale manifest may still be used when the re-read fails. **Zero
 * unless an operator sets it.**
 *
 * A grace window was the first answer here, on the reasoning that the document
 * is served from a different host than the API and a blip should not stop a
 * runner mid-flight. That reasoning is about availability and says nothing
 * about the case it has to survive: an upgrade DURING an outage is exactly when
 * the held manifest is wrong, and exactly when it cannot be corrected. An hour
 * of signing against superseded packages is not a small window when the
 * packages have just been superseded.
 *
 * So the default refuses. An operator who would rather keep trading through an
 * outage can say so in minutes, and `runDoctor` reports the allowance for as
 * long as it is set.
 */
export function manifestGraceMs(): number {
  const raw = (process.env.WATERX_MANIFEST_GRACE_MINUTES ?? "").trim();
  if (raw === "") return 0;
  const minutes = Number(raw);
  // `abc` gives NaN and `Infinity` gives Infinity, and BOTH make every
  // comparison against the window false — so a typo or a clever value turned
  // the stale-manifest guard off altogether rather than shortening it. A value
  // this cannot read is a configuration error, not a licence.
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new ExecutionPolicyError(
      `WATERX_MANIFEST_GRACE_MINUTES is "${raw}", which is not a number of minutes. It decides ` +
        `how long this agent may sign against a deployment manifest it could not re-read, so a ` +
        `value it cannot read is refused rather than treated as "no limit".`,
    );
  }
  return Math.min(minutes, 24 * 60) * 60_000;
}

interface Cached {
  deployment: Deployment;
  fetchedAt: number;
}

const cache = new Map<string, Cached>();

/**
 * One fetch at a time per URL, shared by every caller waiting on it.
 *
 * A cold start took this from the cached entry, which on a cold start does not
 * exist — so concurrent first callers each opened their own request, and
 * whichever resolved LAST wrote the cache, not whichever was issued last. Two
 * requests spanning an upgrade could therefore leave the older manifest in
 * place. Keyed separately so the in-flight request exists before any entry
 * does.
 */
const inflight = new Map<string, Promise<Deployment>>();

export async function loadDeployment(configUrl: string): Promise<Deployment> {
  const held = cache.get(configUrl);
  if (held !== undefined && Date.now() - held.fetchedAt < MANIFEST_TTL_MS) return held.deployment;

  let refresh = inflight.get(configUrl);
  if (refresh === undefined) {
    refresh = fetchDeployment(configUrl)
      .then((deployment) => {
        cache.set(configUrl, { deployment, fetchedAt: Date.now() });
        return deployment;
      })
      .finally(() => {
        inflight.delete(configUrl);
      });
    inflight.set(configUrl, refresh);
  }

  try {
    return await refresh;
  } catch (cause) {
    if (held === undefined) throw cause;
    const age = Math.round((Date.now() - held.fetchedAt) / 60_000);
    if (Date.now() - held.fetchedAt > manifestGraceMs()) {
      throw new ExecutionPolicyError(
        `The deployment manifest at ${configUrl} could not be re-read, and the copy this ` +
          `process holds is ${String(age)} minute(s) old. Every package pin and the layouts ` +
          `they qualify are checked against it, so a package upgraded while the document was ` +
          `unreachable would be treated as current. Refusing to sign until it can be re-read. ` +
          `Set WATERX_MANIFEST_GRACE_MINUTES to keep trading through an outage, knowing that.`,
      );
    }
    return held.deployment;
  }
}

/** Seconds since the held manifest was fetched, for diagnostics. */
export function manifestAgeMs(configUrl: string): number | undefined {
  const held = cache.get(configUrl);
  return held === undefined ? undefined : Date.now() - held.fetchedAt;
}

async function fetchDeployment(configUrl: string): Promise<Deployment> {
  const response = await fetch(configUrl, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${configUrl} returned HTTP ${String(response.status)}`);
  const document = (await response.json()) as DeploymentDocument;
  const entries = Object.entries(document.packages ?? {});
  if (entries.length === 0) {
    throw new Error(`${configUrl} lists no packages, so no transaction could be checked against it`);
  }

  const callable = new Set(FRAMEWORK.map(normalizePackage));
  const typeable = new Set(FRAMEWORK.map(normalizePackage));
  const byName = new Map<string, string>();
  const idsByName = new Map<string, string[]>();
  // Sui's own shared objects: the system state, the clock, the randomness
  // beacon. Every transaction may name them and the document does not.
  const objects = new Set(["0x5", "0x6", "0x8"].map(normalizePackage));
  const byRole = new Map<string, string>();
  for (const [name, entry] of entries) {
    const ids: string[] = [];
    idsByName.set(name, ids);
    const current = entry?.published_at;
    if (typeof current === "string" && current.length > 2) {
      callable.add(normalizePackage(current));
      typeable.add(normalizePackage(current));
      byName.set(name, normalizePackage(current));
      ids.push(normalizePackage(current));
    }
    // Original ids are type identities, not call targets.
    if (typeof entry?.original_id === "string" && entry.original_id.length > 2) {
      typeable.add(normalizePackage(entry.original_id));
      ids.push(normalizePackage(entry.original_id));
    }
    collectObjects(entry, objects, byRole, `${name}.`);
  }
  collectObjects(document.coin_registry, objects, byRole, "coin_registry.");
  return {
    callable,
    typeable,
    byName,
    objects,
    objectFor: (role) => byRole.get(role),
    idsFor: (name) => idsByName.get(name) ?? [],
  };
}

/**
 * An operator's standing exception, parsed.
 *
 * Written `0xPKG=sdkPackage[::module[::function]]`, or a bare `0xPKG` for a
 * package that is only ever named in a type argument.
 *
 * The `=sdkPackage` half is what makes the exception checkable: it says WHICH
 * of the SDK's packages this address is standing in for, so a call through it
 * can be held to that package's declared functions and argument counts. Without
 * it, "this address is fine" is the whole statement and any call through it is
 * unexamined — so a bare id is accepted for type arguments and refused for
 * calls.
 *
 * Be clear about what this buys. An address the operator has vouched for is
 * code this agent cannot see into; if it is hostile, matching a declared
 * signature costs the author nothing. This guards against naming the WRONG
 * package, not against a package that lies. The only thing that removes the
 * risk is the deployment document listing the package, at which point the
 * exception can be deleted.
 */
export interface PackageException {
  readonly pkg: string;
  /** The SDK package this address stands in for; absent means type-argument use only. */
  readonly sdkPackage?: string;
  readonly module?: string;
  readonly fn?: string;
  /**
   * Accept this package's calls with **nothing** holding them to a shape.
   *
   * Spelled `0xPKG=*`, and deliberately uglier than the qualified form because
   * it gives up more. A qualified exception names which of the SDK's packages
   * an address stands in for, so the call can be checked against that package's
   * declared function and argument count. A third-party package has no such
   * declaration anywhere — mainnet's order path calls
   * `pyth_lazer::parse_and_verify_le_ecdsa_update_v2`, which is Pyth's code,
   * and no WaterX SDK release will ever describe it.
   *
   * Before this existed the grammar could not express that case at all: a bare
   * id covers no call, and a qualified one needs a package name that does not
   * exist. So the only way to trade on mainnet was to have no exception and be
   * refused. An unstatable exception is not a safer exception — it is the same
   * risk, taken by someone who edited the check instead.
   */
  readonly unchecked?: boolean;
}

export function parseExceptions(entries: readonly string[]): PackageException[] {
  return entries.map((entry) => {
    const [address, qualified] = entry.split("=");
    if (qualified === "*") {
      return { pkg: normalizePackage(address ?? ""), unchecked: true };
    }
    const [sdkPackage, module, fn] = (qualified ?? "").split("::");
    return {
      pkg: normalizePackage(address ?? ""),
      ...(sdkPackage === undefined || sdkPackage === "" ? {} : { sdkPackage }),
      ...(module === undefined ? {} : { module }),
      ...(fn === undefined ? {} : { fn }),
    };
  });
}

/**
 * Does a standing exception cover this CALL?
 *
 * A bare id covers none — it is the type-argument form, and a package named
 * only as a type never executes. `=*` covers every call and checks nothing;
 * a qualified one covers the calls it names and they are checked against the
 * SDK's declaration.
 */
export const exceptionCovers = (
  exception: PackageException,
  pkg: string,
  module: string,
  fn: string,
): boolean =>
  exception.pkg === pkg &&
  (exception.unchecked === true ||
    (exception.sdkPackage !== undefined &&
      (exception.module === undefined || exception.module === module) &&
      (exception.fn === undefined || exception.fn === fn)));

/**
 * Refuse when the recorded argument layouts predate the running deployment.
 *
 * Every positional check in `verify.ts` rests on layouts captured from
 * transactions the deployment built. Nothing in CI can notice those going
 * stale — a fixture does not expire by itself — and a check that lives only in
 * `runDoctor` protects an operator who runs the preflight and nobody else. A
 * long-running runner never does.
 *
 * So it is asserted where the signature is produced. A contract upgrade that
 * moves an argument stops the agent rather than leaving it reading positions
 * that have quietly changed meaning.
 */
export function assertCorpusDescribes(
  deployment: Deployment,
  corpusPackages: Readonly<Record<string, string>>,
  capturedAt: string,
): void {
  // Moved, gone, and arrived. Comparing only the names present in BOTH left a
  // package added to the deployment, or dropped from it, invisible — a change
  // to the set is a change to the deployment as surely as a change to an id.
  const moved: string[] = [];
  for (const [name, id] of Object.entries(corpusPackages)) {
    const live = deployment.byName.get(name);
    if (live === undefined) moved.push(`${name} (no longer published)`);
    else if (live !== normalizePackage(id)) moved.push(name);
  }
  for (const name of deployment.byName.keys()) {
    // `in` walks the prototype chain, so a package named `toString` would have
    // read as already captured.
    if (!Object.hasOwn(corpusPackages, name)) moved.push(`${name} (newly published)`);
  }
  if (moved.length === 0) return;
  throw new ExecutionPolicyError(
    `The argument layouts this agent checks against were captured on ${capturedAt}, against a ` +
      `deployment that has since changed: ${moved.join(", ")}. Every positional check is now ` +
      `unverified against the running contract — a parameter may have moved, and a check ` +
      `reading the old position would pass on the wrong value. Re-run ` +
      `\`pnpm run capture-corpus\` and look at what changed before trading.`,
  );
}

/** Drops the cache. Tests only — a process should hold one deployment. */
export function forgetDeployments(): void {
  cache.clear();
}

/**
 * Install a deployment without fetching one. Tests only.
 *
 * Production always fetches, so the failure mode of an unreachable config stays
 * real rather than something the tests quietly opt out of.
 */
export function seedDeployment(configUrl: string, deployment: Deployment): void {
  cache.set(configUrl, { deployment, fetchedAt: Date.now() });
}
