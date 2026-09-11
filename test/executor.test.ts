/**
 * The execution policy is only a property if it cannot be bypassed, so it is
 * tested at the point every write in this package signs through — not every
 * signature the process can produce, since `SignerProvider` is callable
 * directly. The sponsored
 * branch is used throughout: it needs no chain connection, and the fork itself
 * is covered by the "regular build while delegated" case.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";

import type { TxApi } from "../src/api/tx.ts";
import type { SponsoredTxResponse, TxResponse } from "../src/api/types.ts";
import { TxExecutor } from "../src/chain/executor.ts";
import { ABI } from "../src/chain/abi.generated.ts";
import { BINDINGS, TYPE_ROLES } from "../src/chain/verify.ts";
import { normalizePackage, seedDeployment } from "../src/chain/deployment.ts";
import corpus from "../src/chain/abi-corpus.json" with { type: "json" };
import { KeypairSigner } from "../src/chain/signer.ts";
import { loadConfig } from "../src/config.ts";
import { ExecutionPolicyError, TxExecutionError } from "../src/errors.ts";
import {
  type PolicyMode,
  PolicyGate,
  type PolicyScope,
  type WriteIntent,
  fingerprintIntent,
} from "../src/policy.ts";

const keypair = Ed25519Keypair.generate();
const owner = keypair.getPublicKey().toSuiAddress();

/**
 * Real signable bytes carrying the Move call that DEFINES an action — the
 * executor now verifies the transaction does what it is presented as, so a
 * contentless transaction is correctly refused.
 */
const DEFINING: Record<string, string> = {
  openLong: "trading::place_order_request",
  closePosition: "trading::close_position_request",
  cancelOrder: "trading::cancel_order_request",
};

let txBytes: string;

/** Memoised so the same action always yields identical bytes — a permit binds a
 *  digest, so a freshly-built equivalent transaction is a DIFFERENT one. */
const byteCache = new Map<string, string>();

/**
 * The manifest the committed corpus was captured against.
 *
 * The executor now refuses to sign when the recorded layouts predate the
 * running deployment, so a fabricated manifest here would make every test look
 * like a stale corpus.
 */
/**
 * A distinct object for every role the bindings name — distinct because the
 * point of pinning roles is that they are not interchangeable.
 */
const ROLE_OBJECTS = new Map<string, string>(
  [
    ...new Set(
      Object.values(BINDINGS)
        .flatMap((e) => Object.values(e))
        .flatMap((b) => (typeof b === "object" && "object" in b ? [b.object] : [])),
    ),
  ]
    .sort()
    .map((role, i) => [role, `0x${(i + 16).toString(16).padStart(64, "0")}`]),
);

function seedCurrentDeployment(): void {
  const byName = new Map(
    Object.entries(corpus.packages as Record<string, string>).map(([name, id]) => [
      name,
      normalizePackage(id),
    ]),
  );
  const pkgs = new Set([...byName.values(), normalizePackage("0x2")]);
  seedDeployment(loadConfig().configUrl, {
    callable: pkgs,
    typeable: pkgs,
    byName,
    objects: new Set([...ROLE_OBJECTS.values()].map(normalizePackage)),
    objectFor: (role) => {
      const id = ROLE_OBJECTS.get(role);
      return id === undefined ? undefined : normalizePackage(id);
    },
    idsFor: (name) => {
      const id = byName.get(name);
      return id === undefined ? [] : [id];
    },
  });
}

async function bytesFor(action: string): Promise<string> {
  const cached = byteCache.get(action);
  if (cached !== undefined) return cached;
  const tx = new Transaction();
  tx.setSender(owner);
  tx.setGasBudget(10_000_000);
  tx.setGasPrice(1000);
  tx.setGasPayment([
    { objectId: `0x${"1".repeat(64)}`, version: "1", digest: "11111111111111111111111111111111" },
  ]);
  // Sponsored bytes are gas-owned by the sponsor. Naming the signer here is the
  // backend billing us, which the verifier refuses.
  tx.setGasOwner(`0x${"5".repeat(64)}`);
  // Built at the entrypoint's real arity, with the account and market the
  // intents name at the positions that mean them. The verifier reads arguments
  // by position now, so a stub call of convenient shape is refused outright.
  const entrypoint = DEFINING[action] ?? DEFINING.openLong;
  const abi = ABI[entrypoint];
  const bindings = BINDINGS[entrypoint] ?? {};
  // An order action's parameters live in a constructor whose result the
  // defining call consumes, so it is built first and passed in.
  const manifest = corpus.packages as Record<string, string>;
  // `account::request` is the authority handle and lives in the framework
  // package, which the ABI does not describe because nothing binds its
  // arguments — only its identity as a producer.
  const pkgOf = (ep: string): string =>
    manifest[ABI[ep]?.pkg ?? ""] ?? manifest.bucket_framework ?? `0x${"c".repeat(64)}`;
  const orderArg =
    entrypoint === "trading::place_order_request"
      ? tx.moveCall({
          target: `${pkgOf("request::new_place_order_argument")}::request::new_place_order_argument`,
          arguments: [
            tx.pure.bool(true),
            tx.pure.bool(false),
            tx.pure.bool(false),
            tx.pure.u128(0n),
            tx.pure.option("u128", null),
            tx.pure.option("u64", null),
            tx.pure.option("u64", null),
            tx.pure.u64(0n),
          ],
        })
      : undefined;
  // An absent type argument is a refusal now, so the fixtures name them as the
  // deployment does.
  const typeArgs: string[] = [];
  for (const [position, role] of Object.entries(TYPE_ROLES[entrypoint] ?? {})) {
    typeArgs[Number(position)] = `${manifest[role.pkg] ?? `0x${"c".repeat(64)}`}::${role.type}`;
  }
  tx.moveCall({
    target: `${pkgOf(entrypoint)}::${entrypoint}`,
    ...(typeArgs.length > 0 ? { typeArguments: typeArgs } : {}),
    arguments: (abi?.types ?? []).map((type, index) => {
      // Position 6 is `main`, where the order constructor's result is passed.
      if (abi?.params[index] === "main" && orderArg !== undefined) return orderArg;
      const name = abi?.params[index];
      const binding = name === undefined ? undefined : bindings[name];
      if (binding !== undefined && typeof binding === "object" && "producedBy" in binding) {
        // The authority handle is the result of a specific call, not a filler.
        return tx.moveCall({
          target: `${pkgOf(binding.producedBy as string)}::${binding.producedBy as string}`,
          arguments: [],
        });
      }
      if (binding !== undefined && typeof binding === "object" && "vectorOf" in binding) {
        // The deployment passes a vector here even for an order with no legs.
        return tx.makeMoveVec({
          type: `${pkgOf("request::new_place_order_argument")}::request::PlaceOrderArgument`,
          elements: [],
        });
      }
      if (binding !== undefined && typeof binding === "object" && "object" in binding) {
        return tx.sharedObjectRef({
          objectId: ROLE_OBJECTS.get(binding.object as string) ?? `0x${"0".repeat(64)}`,
          initialSharedVersion: "1",
          mutable: false,
        });
      }
      if (binding === undefined || typeof binding === "object") return tx.pure.u8(0);
      switch (type) {
        case "address":
        case "0x2::object::ID":
          return tx.pure.address(`0x${"a".repeat(64)}`);
        case "0x1::string::String":
          return tx.pure.string("SUIUSD");
        case "u64":
          return tx.pure.u64(0n);
        case "u128":
          return tx.pure.u128(0n);
        case "u32":
          return tx.pure.u32(0);
        case "bool":
          return tx.pure.bool(false);
        case "0x1::option::Option<u64>":
          return tx.pure.option("u64", null);
        case "0x1::option::Option<u128>":
          return tx.pure.option("u128", null);
        default:
          return tx.pure.u8(0);
      }
    }) as never,
  });
  const bytes = toBase64(await tx.build());
  byteCache.set(action, bytes);
  return bytes;
}

beforeAll(async () => {
  // The package set the fixtures are built against. Production fetches this;
  // seeding it keeps the unit tests off the network without making the
  // production failure mode disappear.
  seedCurrentDeployment();
  // Warm every action so `sponsored(action)` can stay synchronous.
  for (const action of Object.keys(DEFINING)) await bytesFor(action);
  txBytes = byteCache.get("openLong")!;
});

/** The sponsored envelope for an action, over the bytes its permit binds. */
const sponsored = (action = "openLong"): SponsoredTxResponse => ({
  sponsored: true,
  txBytes: byteCache.get(action) ?? txBytes,
  digest: "digest-1",
});

function stubApi(): { api: TxApi; executeSponsored: ReturnType<typeof vi.fn> } {
  const executeSponsored = vi.fn().mockResolvedValue({ digest: "executed-1" });
  return { api: { executeSponsored } as unknown as TxApi, executeSponsored };
}

function executor(
  policy: PolicyMode,
  extra: {
    ownerAddress?: string;
    policyScope?: PolicyScope;
    allowUnconfirmed?: readonly string[];
  } = {},
  grpc?: SuiGrpcClient,
): {
  executor: TxExecutor;
  gate: PolicyGate;
  executeSponsored: ReturnType<typeof vi.fn>;
  signTransaction: MockInstance<(bytes: Uint8Array) => Promise<string>>;
} {
  const { api, executeSponsored } = stubApi();
  const config = loadConfig({
    network: "testnet",
    executionPolicy: policy,
    apiUrl: "https://example.invalid",
    // Most of these exercise the gate and the signing fork, not the layout
    // rule, so the entrypoints they use are ones the corpus has captured. The
    // ones that do test it name the entrypoint, which is the only lever there
    // is — there is no boolean to reach for, in code or in the environment.
    ...extra,
  });
  // These exercise the gate, not the key-provenance rule; a delegate key is the
  // only configuration under which delegated-auto is constructible at all.
  const gate = new PolicyGate(config.executionPolicy, config.policyScope, true);
  // Spied, so a test can assert the refusal happened before the KEY was used —
  // "no API call" only shows nothing was submitted, which is a weaker claim
  // than "nothing was signed".
  const signer = new KeypairSigner(keypair);
  const signTransaction = vi.spyOn(signer, "signTransaction");
  return {
    executor: new TxExecutor(signer, config, api, gate, grpc),
    gate,
    executeSponsored,
    signTransaction,
  };
}

/**
 * The intent a permit is bound to. The pair travels together everywhere.
 *
 * Every field the action's entrypoint binds has to be stated, matching what
 * `bytesFor` builds — an intent that says nothing about an argument is refused
 * rather than waved through, which is the point of the check.
 */
const intentFor = (action: string): WriteIntent => {
  const base: WriteIntent = {
    action,
    accountId: `0x${"a".repeat(64)}`,
    increasesExposure: false,
    ticker: "SUIUSD",
    side: "long",
    reduceOnly: false,
    isStopOrder: false,
    sizeRaw: "0",
    collateralRaw: "0",
    legs: [],
  };
  // An order's position and price bounds live in the constructor as Options,
  // where saying nothing means the argument must be absent. The other actions
  // carry them as plain arguments, where saying nothing is a refusal.
  return DEFINING[action] === "trading::place_order_request"
    ? base
    : { ...base, positionId: 0, orderId: 0, acceptablePriceRaw: "0" };
};

/**
 * Authorize AND bind, the way `agent.submit` does. A permit that is merely
 * authorized cannot be spent — binding is what ties it to specific bytes.
 */
const permitFor = async (gate: PolicyGate, action: string, confirm?: boolean, bytes?: string) => {
  const { permit } = await gate.authorizeAndBuild(
    intentFor(action),
    confirm === undefined ? {} : { confirm },
    async () => ({ txBytes: bytes ?? (await bytesFor(action)) }),
  );
  return permit;
};

/** A sponsored envelope around bytes that genuinely perform `action`. */
const sponsoredFor = async (action: string): Promise<SponsoredTxResponse> => ({
  sponsored: true,
  txBytes: await bytesFor(action),
  digest: "digest-1",
});

const SCOPE: PolicyScope = {
  accounts: [`0x${"a".repeat(64)}`],
  maxCollateralPerOrder: 50,
  maxCumulativeCollateral: 200,
  maxLeverage: 5,
  maxSlippagePercent: 1,
  notAfter: "2099-01-01T00:00:00Z",
};

describe("the production default", () => {
  it("refuses before signing when the layout is unconfirmed", async () => {
    // The previous version of this test used `openLong`, whose layout IS
    // captured, and asserted it succeeded — it named a refusal and exercised
    // none. `closePosition` is uncaptured, and being an exit no longer exempts
    // it: whether an argument can be read has nothing to do with whether the
    // action reduces risk.
    const { executor: exec, gate, executeSponsored, signTransaction } = executor("interactive");
    const permit = await permitFor(gate, "closePosition", true);
    await expect(
      exec.execute(sponsored("closePosition"), intentFor("closePosition"), permit),
    ).rejects.toThrow(/never been confirmed against this deployment/);
    // Before the SIGNATURE, not merely before the submission. "No API call"
    // would also hold if the bytes had been signed and the send had failed.
    expect(signTransaction).not.toHaveBeenCalled();
    expect(executeSponsored).not.toHaveBeenCalled();
  });

  it("signs it once the operator names that entrypoint", async () => {
    const { executor: exec, gate } = executor("interactive", {
      allowUnconfirmed: ["trading::close_position_request"],
    });
    const permit = await permitFor(gate, "closePosition", true);
    await expect(
      exec.execute(sponsored("closePosition"), intentFor("closePosition"), permit),
    ).resolves.toMatchObject({ sponsored: true });
  });

  it("signs and submits on the self-pay path once the entrypoint is named", async () => {
    // The refusal above proves the gate stops this path. This proves the gate
    // is the ONLY thing that was stopping it — without it the branch would be
    // asserted by nothing, and a check that lived only here could break
    // unnoticed. The fullnode is injected rather than opened.
    const built = byteCache.get("closePosition") ?? "";
    const kind = toBase64(
      Transaction.from(fromBase64(built)).getData().commands.length > 0
        ? await Transaction.from(fromBase64(built)).build({ onlyTransactionKind: true })
        : new Uint8Array(),
    );
    const executeTransaction = vi.fn().mockResolvedValue({
      $kind: "Transaction",
      Transaction: { digest: "self-pay-1", effects: {} },
    });
    // The only thing a fullnode is needed for here is choosing gas, so the fake
    // supplies exactly that and nothing else.
    const owner = keypair.getPublicKey().toSuiAddress();
    const client = {
      core: {
        executeTransaction,
        resolveTransactionPlugin:
          () =>
          async (
            data: { gasData: Record<string, unknown> },
            _options: unknown,
            next: () => Promise<void>,
          ) => {
            data.gasData = {
              budget: "10000000",
              price: "1000",
              // The signer, as a real fullnode selecting this process's own
              // coins would produce — and as `assertGasIsRight` now requires on
              // this branch. The account fixture was wrong here and passed only
              // because the check did not exist.
              owner,
              payment: [
                {
                  objectId: `0x${"2".repeat(64)}`,
                  version: "1",
                  digest: "11111111111111111111111111111111",
                },
              ],
            };
            await next();
          },
      },
    } as unknown as SuiGrpcClient;
    const { executor: exec, gate, signTransaction } = executor(
      "interactive",
      { allowUnconfirmed: ["trading::close_position_request"] },
      client,
    );
    const permit = await permitFor(gate, "closePosition", true, kind);

    // The digest has to be durable BEFORE the submission leaves, or a crash in
    // the window between them leaves nothing to ask the chain about.
    const recorded: string[] = [];
    const onSubmitting = vi.fn(async (digest: string) => {
      expect(executeTransaction, "submitted before the digest was recorded").not.toHaveBeenCalled();
      recorded.push(digest);
      await Promise.resolve();
    });

    await expect(
      exec.execute(
        { sponsored: false, txBytes: kind } as TxResponse,
        intentFor("closePosition"),
        permit,
        { onSubmitting },
      ),
    ).resolves.toMatchObject({ digest: "self-pay-1", sponsored: false });
    expect(signTransaction).toHaveBeenCalledOnce();
    expect(executeTransaction).toHaveBeenCalledOnce();
    // And it is the digest of what was actually signed, not a placeholder.
    const signed = signTransaction.mock.calls[0]?.[0] as Uint8Array;
    expect(recorded).toEqual([await Transaction.from(signed).getDigest({ client })]);
  });

  it("refuses on the self-pay path too, before it touches a fullnode", async () => {
    // The self-pay branch rebuilds through a fullnode to choose gas. The layout
    // check runs before the fork, so this refuses without a network round trip
    // — and this branch had no test of the rule at all.
    const { executor: exec, gate, signTransaction } = executor("interactive");
    const permit = await permitFor(gate, "closePosition", true, byteCache.get("closePosition"));
    await expect(
      exec.execute(
        { sponsored: false, txBytes: byteCache.get("closePosition") ?? "" } as TxResponse,
        intentFor("closePosition"),
        permit,
      ),
    ).rejects.toThrow(/never been confirmed against this deployment/);
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("signs an action the corpus has captured", async () => {
    const { executor: exec, gate } = executor("interactive", {
    });
    const permit = await permitFor(gate, "openLong", true);
    await expect(
      exec.execute(sponsored("openLong"), intentFor("openLong"), permit),
    ).resolves.toMatchObject({ sponsored: true });
  });
});

describe("the recorded layouts must describe the running deployment", () => {
  it("refuses to sign when a package has moved since the corpus was captured", async () => {
    // Nothing in CI can notice a fixture going stale, and a check that lived
    // only in `runDoctor` protected an operator who runs the preflight and
    // nobody else — a runner signs for weeks without one. So it is asserted
    // where the signature is produced.
    const { executor: exec, gate } = executor("interactive");
    const url = loadConfig().configUrl;
    const moved = new Map(
      Object.keys(corpus.packages as Record<string, string>).map((name) => [
        name,
        normalizePackage(`0x${"9".repeat(64)}`),
      ]),
    );
    seedDeployment(url, {
      callable: new Set(moved.values()),
      typeable: new Set(moved.values()),
      byName: moved,
      objects: new Set<string>(),
      objectFor: () => undefined,
      idsFor: (name) => {
        const id = moved.get(name);
        return id === undefined ? [] : [id];
      },
    });
    try {
      const permit = await permitFor(gate, "openLong", true);
      await expect(
        exec.execute(sponsored("openLong"), intentFor("openLong"), permit),
      ).rejects.toThrow(/captured on .* deployment that has since changed/);
    } finally {
      // Put the real manifest back; the other tests sign against it.
      seedCurrentDeployment();
    }
  });
});

describe("execution policy", () => {
  it('refuses every write under "read-only"', async () => {
    const { gate, executeSponsored } = executor("read-only");
    await expect(permitFor(gate, "openLong")).rejects.toThrow(ExecutionPolicyError);
    expect(executeSponsored).not.toHaveBeenCalled();
  });

  it('refuses an unconfirmed write under "interactive"', async () => {
    const { gate } = executor("interactive");
    await expect(permitFor(gate, "openLong")).rejects.toThrow(/confirm: true/);
  });

  it('allows a confirmed write under "interactive"', async () => {
    const { executor: exec, gate, executeSponsored } = executor("interactive");
    const result = await exec.execute(sponsored(), intentFor("openLong"), await permitFor(gate, "openLong", true));
    expect(result).toEqual({ digest: "executed-1", sponsored: true });
    expect(executeSponsored).toHaveBeenCalledOnce();
  });

  it('allows an unconfirmed in-scope write under "delegated-auto"', async () => {
    const { executor: exec, gate, executeSponsored } = executor("delegated-auto", {
      policyScope: SCOPE,
    });
    await exec.execute(sponsored(), intentFor("openLong"), await permitFor(gate, "openLong"));
    expect(executeSponsored).toHaveBeenCalledOnce();
  });

  it("labels the sponsored submission with the intent by default", async () => {
    const { executor: exec, gate, executeSponsored } = executor("delegated-auto", {
      policyScope: SCOPE,
    });
    await exec.execute(
      sponsored("cancelOrder"),
      intentFor("cancelOrder"),
      await permitFor(gate, "cancelOrder"),
    );
    expect(executeSponsored).toHaveBeenCalledWith(
      expect.objectContaining({ digest: "digest-1", source: "agent/cancelOrder" }),
    );
  });

  it("accepts the previous release's policy names as aliases", () => {
    expect(loadConfig({ network: "testnet", executionPolicy: "interactive" }).executionPolicy).toBe(
      "interactive",
    );
  });
});

describe("the signing gate", () => {
  it("refuses a permit that was never issued — the check cannot be skipped", async () => {
    const { executor: exec, executeSponsored } = executor("delegated-auto", {
      policyScope: SCOPE,
    });
    // Correctly shaped, including a fingerprint that matches the intent — the
    // only thing wrong with it is that this gate never issued it.
    const forged = { action: "openLong", fingerprint: fingerprintIntent(intentFor("openLong")) };
    await expect(exec.execute(sponsored(), intentFor("openLong"), forged)).rejects.toThrow(/No unspent permit/);
    expect(executeSponsored).not.toHaveBeenCalled();
  });

  it("refuses a permit twice — one authorization buys one signature", async () => {
    const { executor: exec, gate } = executor("delegated-auto", { policyScope: SCOPE });
    const permit = await permitFor(gate, "openLong");
    await exec.execute(sponsored(), intentFor("openLong"), permit);
    await expect(exec.execute(sponsored(), intentFor("openLong"), permit)).rejects.toThrow(/No unspent permit/);
  });
});

describe("the pre-submit digest", () => {
  // The runner's at-most-once guarantee rests entirely on this hook, and it is
  // easy to add to one branch of the sponsored/regular fork and not the other —
  // which is exactly what happened once. Both branches are covered here rather
  // than through the runner, whose tests stub the agent and so cannot see it.
  it("reports the sponsored digest before submitting, and aborts if recording fails", async () => {
    const { executor: exec, gate, executeSponsored } = executor("delegated-auto", {
      policyScope: SCOPE,
    });
    const seen: string[] = [];
    await exec.execute(sponsored(), intentFor("openLong"), await permitFor(gate, "openLong"), {
      onSubmitting: async (digest) => {
        // Recorded strictly before the submission goes out.
        expect(executeSponsored).not.toHaveBeenCalled();
        seen.push(digest);
        await Promise.resolve();
      },
    });
    expect(seen).toEqual(["digest-1"]);

    const second = executor("delegated-auto", { policyScope: SCOPE });
    await expect(
      second.executor.execute(sponsored(), intentFor("openLong"), await permitFor(second.gate, "openLong"), {
        onSubmitting: () => Promise.reject(new Error("disk full")),
      }),
    ).rejects.toThrow(/disk full/);
    // A submission whose digest could not be recorded must not go out at all.
    expect(second.executeSponsored).not.toHaveBeenCalled();
  });
});

describe("a permit is bound to its intent", () => {
  const SCOPED = { ...SCOPE, maxCollateralPerOrder: 1000, maxCumulativeCollateral: 5000 };

  it("cannot be spent on a different action", async () => {
    // The escalation this closes. `cancelOrder` passes every ceiling trivially —
    // it commits nothing — so a fungible permit would let it fund an openLong.
    const { executor: exec, gate, executeSponsored } = executor("delegated-auto", {
      policyScope: SCOPED,
    });
    const cheap = await permitFor(gate, "cancelOrder");

    await expect(
      exec.execute(sponsored(), intentFor("openLong"), cheap),
    ).rejects.toThrow(/not transferable/);
    expect(executeSponsored).not.toHaveBeenCalled();
  });

  it("cannot be spent on the same action with bigger numbers", async () => {
    // A ceiling that only bounds a number nobody ends up using is not a ceiling.
    const { executor: exec, gate, executeSponsored } = executor("delegated-auto", {
      policyScope: SCOPED,
    });
    const account = `0x${"a".repeat(64)}`;
    const small: WriteIntent = {
      ...intentFor("openLong"), accountId: account, increasesExposure: true,
      ticker: "BTCUSD", collateral: 10, leverage: 2,
    };
    const { permit } = await gate.authorizeAndBuild(small, {}, () =>
      Promise.resolve({ txBytes }),
    );

    await expect(
      exec.execute(sponsored(), { ...small, collateral: 900 }, permit),
    ).rejects.toThrow(/not transferable/);
    expect(executeSponsored).not.toHaveBeenCalled();
  });

  it("leaves a mismatched permit spendable on the intent it was issued for", async () => {
    // The check runs before the permit is spent, so a wrong attempt must not
    // burn it — otherwise a bug upstream turns into a stuck job.
    const { executor: exec, gate } = executor("delegated-auto", { policyScope: SCOPED });
    const permit = await permitFor(gate, "cancelOrder");

    await expect(
      exec.execute(sponsored("cancelOrder"), intentFor("openLong"), permit),
    ).rejects.toThrow();
    await expect(
      exec.execute(sponsored("cancelOrder"), intentFor("cancelOrder"), permit),
    ).resolves.toMatchObject({ sponsored: true });
  });
});

describe("a permit is bound to its transaction bytes", () => {
  const SCOPED = { ...SCOPE, maxCollateralPerOrder: 1000, maxCumulativeCollateral: 5000 };

  it("cannot be presented alongside different bytes", async () => {
    // Binding the intent proved the request SHAPE was authorized and said
    // nothing about which bytes got signed — a closePosition permit could be
    // handed arbitrary sponsored bytes and the executor would sign them.
    const { executor: exec, gate, executeSponsored } = executor("delegated-auto", {
      policyScope: SCOPED,
    });
    const permit = await permitFor(gate, "closePosition");
    const otherBytes = { sponsored: true as const, txBytes: byteCache.get("openLong")!, digest: "digest-x" };

    await expect(
      exec.execute(otherBytes, intentFor("closePosition"), permit),
    ).rejects.toThrow(/bound to different transaction bytes/);
    expect(executeSponsored).not.toHaveBeenCalled();
  });

  it("cannot be spent without ever being bound", async () => {
    // Skipping the bind must not be a way around it.
    const { executor: exec, gate, executeSponsored } = executor("delegated-auto", {
      policyScope: SCOPED,
    });
    // Reaching in past the sealed path is the only way to get one, which is
    // itself the point: `authorizeAndBuild` never yields an unbound permit.
    const unbound = gate.authorize(intentFor("closePosition"));

    await expect(
      exec.execute(sponsored("closePosition"), intentFor("closePosition"), unbound),
    ).rejects.toThrow(/never bound/);
    expect(executeSponsored).not.toHaveBeenCalled();
  });

  it("is produced already bound — the caller never supplies bytes", async () => {
    // The hole this closes: `bind(permit, bytes)` was public, so a caller could
    // vouch for arbitrary bytes and the gate would believe it. There is no
    // longer a public way to say which bytes a permit covers; the gate learns
    // them by running the builder itself.
    const { gate } = executor("delegated-auto", { policyScope: SCOPED });
    expect("bind" in (gate as unknown as Record<string, unknown>)).toBe(false);

    const { built, permit } = await gate.authorizeAndBuild(
      intentFor("closePosition"),
      {},
      () => Promise.resolve({ txBytes }),
    );
    expect(built.txBytes).toBe(txBytes);
    expect(permit.boundTo).toBeDefined();
  });

  it("signs when the bytes are the ones it was bound to", async () => {
    const { executor: exec, gate, executeSponsored } = executor("delegated-auto", {
      policyScope: SCOPED,
    });
    await exec.execute(
      sponsored("cancelOrder"),
      intentFor("cancelOrder"),
      await permitFor(gate, "cancelOrder"),
    );
    expect(executeSponsored).toHaveBeenCalledOnce();
  });
});

describe("delegate addressing", () => {
  it("keeps the owner as sender and the wallet as delegateSender", () => {
    const other = Ed25519Keypair.generate().getPublicKey().toSuiAddress();
    const { executor: exec } = executor("delegated-auto", { ownerAddress: other, policyScope: SCOPE });
    expect(exec.txBody()).toEqual({ sender: other, delegateSender: owner });
  });

  it("omits delegateSender entirely for an owner key", () => {
    const { executor: exec } = executor("delegated-auto", { policyScope: SCOPE });
    expect(exec.txBody()).toEqual({ sender: owner });
  });

  it("refuses an unsponsored build while delegated — a delegate holds no gas", async () => {
    const other = Ed25519Keypair.generate().getPublicKey().toSuiAddress();
    const { executor: exec, gate } = executor("delegated-auto", {
      ownerAddress: other,
      policyScope: SCOPE,
    });
    const regular: TxResponse = { sponsored: false, txBytes };
    await expect(exec.execute(regular, intentFor("openLong"), await permitFor(gate, "openLong"))).rejects.toThrow(
      TxExecutionError,
    );
  });
});
