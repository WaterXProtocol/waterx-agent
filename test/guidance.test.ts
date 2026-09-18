/**
 * The order in which states are resolved, which is the safety property.
 *
 * Every one of these is a claim about what an agent will offer a person. The
 * dangerous direction is always the same: offering a trade before something
 * outstanding has been settled. So the tests are mostly about *precedence* —
 * that a worse state hides a better one — rather than about wording.
 */
import { describe, expect, it } from "vitest";

import { DELEGATE_BOUNDARY } from "../src/agent/delegation.ts";
import { decide, sentenceOf, type Situation } from "../src/agent/guidance.ts";

const ok: Situation = {
  open: 0,
  firstUnsettled: undefined,
  pending: [],
  configured: true,
  missing: { signer: false, gas: false, account: false },
  readOnly: false,
  freeMargin: 100,
  positions: 0,
  orders: 0,
  blockers: [],
  network: "testnet",
  mode: "owner",
};

describe("what to do next", () => {
  it("offers trading only when everything else is clear", () => {
    const g = decide(ok);
    expect(g.state).toBe("ready");
    expect(g.suggestions[0]?.command).toContain("preview");
  });

  it("never offers a trade while a submission is unsettled", () => {
    // The whole reason this file exists. An agent that checks "can I trade?"
    // before "is anything in flight?" opens the same position twice.
    const g = decide({ ...ok, open: 1, firstUnsettled: "sub_1" });
    expect(g.state).toBe("unsettled");
    expect(g.suggestions.map((s) => s.command).join(" ")).toContain("reconcile");
    expect(g.suggestions.map((s) => s.command).join(" ")).not.toContain("preview");
  });

  it("puts an unsettled submission ahead of every other problem", () => {
    // Including a broken configuration. A transaction whose effect is unknown
    // is more urgent than one that cannot be sent.
    const g = decide({
      ...ok,
      open: 1,
      pending: [{ id: "apr_1", action: "openLong" }],
      configured: false,
      readOnly: true,
      freeMargin: 0,
      blockers: ["abi corpus"],
    });
    expect(g.state).toBe("unsettled");
  });

  it("surfaces a waiting approval before anything new", () => {
    const g = decide({ ...ok, pending: [{ id: "apr_1", action: "openLong" }] });
    expect(g.state).toBe("awaiting-approval");
    expect(g.suggestions[0]?.command).toContain("apr_1");
    // And says whose name goes on it, rather than letting the agent use its own.
    expect(g.suggestions[0]?.command).toContain("<their name>");
  });

  it("sends an unconfigured caller to bootstrap, not to a trade", () => {
    const g = decide({ ...ok, configured: false, missing: { signer: true, gas: false, account: true } });
    expect(g.state).toBe("not-set-up");
    expect(g.suggestions.map((s) => s.command).join(" ")).toContain("bootstrap");
  });

  it("offers the delegate path first, and asks for no money to do it", () => {
    // The correction that prompted this. A wallet with nothing granted to it
    // was told to fund itself and create an account — solving a problem it does
    // not have. A delegate needs no gas (the backend sponsors it), no account
    // and no collateral; the owner keeps all three.
    const g = decide({ ...ok, mode: "undecided", configured: false, network: "mainnet" });
    expect(g.state).toBe("awaiting-grant");
    // In the detail, not the headline. All three of these are addressed to the
    // account owner — how the arrangement works, what it cannot do, what it
    // does not need — and the headline is relayed to an operator whose next act
    // is to send someone a link.
    expect(g.detail).toContain("grants THIS address");
    // The sentence every surface uses, so what a delegate cannot do reads the
    // same here as it does beside the permission list.
    expect(g.detail).toContain(DELEGATE_BOUNDARY);
    expect(g.detail).toContain("no SUI of its own");
    expect(g.suggestions[0]?.command).toContain("onboard");
    // The delegate path is ONE step now — hand over the link, wait for the
    // grant, adopt what granted — so the property is that it comes before the
    // owner alternative, not that a separate discovery step sits at slot 1.
    const handshake = g.suggestions.findIndex((x) => x.command.includes("onboard --wait"));
    const ownerPath = g.suggestions.findIndex((x) => x.command.includes("--create-account"));
    expect(handshake).toBe(0);
    // The owner path stays available, after the delegate step, and says what it costs.
    expect(ownerPath).toBeGreaterThan(handshake);
    expect(g.suggestions[ownerPath]?.what).toContain("SUI for gas");
  });

  it("names where the owner signs, in the first state a fresh install reaches", () => {
    // This state described the grant and named no place to make it, so where to
    // sign depended on the caller going on to run `onboard`. An agent that
    // relays the headline and stops left the owner with nowhere to go — and the
    // install that did exactly that was told to prescribe a CLI key paste.
    const g = decide({
      ...ok,
      mode: "undecided",
      configured: false,
      network: "mainnet",
      address: `0x${"a".repeat(64)}`,
    });
    expect(g.state).toBe("awaiting-grant");
    expect(g.headline).toContain(`https://waterx.app/en/agent/authorize/perp?agent=0x${"a".repeat(64)}`);
    expect(g.headline).toContain("their key stays");
  });

  it("adopts what is already granted instead of asking for a grant that exists", () => {
    // The state a fresh install lands in was decided entirely by which
    // variables were set, so a wallet granted minutes earlier was told nothing
    // had been granted to it — and its owner was sent back to a link they had
    // already used. The grant is keyed on the wallet; it is findable here.
    const account = `0x${"c".repeat(64)}`;
    const owner = `0x${"b".repeat(64)}`;
    const g = decide({
      ...ok,
      mode: "undecided",
      configured: false,
      network: "mainnet",
      address: `0x${"a".repeat(64)}`,
      discovered: [{ accountId: account, ownerAddress: owner }],
    });

    expect(g.state).toBe("granted-not-adopted");
    expect(g.headline).toContain(account);
    expect(g.suggestions[0]?.command).toContain(`adopt --account ${account}`);
    // And does not hand out the authorize link again.
    expect(g.headline).not.toContain("agent/authorize");
    expect(g.link).toBeUndefined();
  });

  it("never picks between several accounts that grant the same wallet", () => {
    const g = decide({
      ...ok,
      mode: "undecided",
      configured: false,
      network: "mainnet",
      address: `0x${"a".repeat(64)}`,
      discovered: [
        { accountId: `0x${"c".repeat(64)}`, ownerAddress: `0x${"b".repeat(64)}` },
        { accountId: `0x${"d".repeat(64)}`, ownerAddress: `0x${"b".repeat(64)}` },
      ],
    });

    expect(g.state).toBe("granted-not-adopted");
    expect(g.suggestions).toHaveLength(2);
    expect(g.headline).toMatch(/choice, not a guess/u);
  });

  it("does not claim the chain is empty when nothing asked the chain", () => {
    // The same defect as in `delegationStatus`, in the surface an agent relays
    // every turn: this sentence used to assert that nothing had been granted,
    // in a branch reached entirely by looking at which variables were set.
    const address = `0x${"a".repeat(64)}`;
    const unasked = decide({ ...ok, mode: "undecided", configured: false, network: "mainnet", address });
    expect(unasked.headline).toContain("recorded here");
    expect(unasked.headline).not.toMatch(/nothing grants/iu);

    const asked = decide({
      ...ok,
      mode: "undecided",
      configured: false,
      network: "mainnet",
      address,
      discovered: [],
    });
    expect(asked.headline).toMatch(/nothing grants/iu);
  });

  it("still asks for the grant when the index answered that there is none", () => {
    const g = decide({
      ...ok,
      mode: "undecided",
      configured: false,
      network: "mainnet",
      address: `0x${"a".repeat(64)}`,
      discovered: [],
    });

    expect(g.state).toBe("awaiting-grant");
  });

  it("offers the code in the state an agent relays, not only in --help", () => {
    // The defect this closes: an agent that follows the contract -- relay the
    // headline, offer the suggestions -- could not learn the option existed.
    const g = decide({
      ...ok,
      mode: "undecided",
      configured: false,
      network: "mainnet",
      address: `0x${"a".repeat(64)}`,
    });

    expect(g.suggestions.map((s) => s.command).join(" ")).toContain("onboard --qr");
    // And still leads with the one command that finishes the handshake.
    expect(g.suggestions[0]?.command).toContain("--wait");
  });

  it("hands the link out as a field too, so a renderer can put it on its own line", () => {
    // The headline keeps it — an agent that relays one field and stops must not
    // leave the owner with nowhere to go. But inside the paragraph it wrapped
    // across three lines of an 80-column terminal, and a wrapped URL is one
    // nobody can click.
    const address = `0x${"a".repeat(64)}`;
    const g = decide({ ...ok, mode: "undecided", configured: false, network: "mainnet", address });

    expect(g.link).toBe(`https://waterx.app/en/agent/authorize/perp?agent=${address}`);
    expect(g.headline).toContain(g.link ?? "never");
    // And the sentence stands on its own once the link is lifted out of it,
    // rather than trailing the colon that introduced it.
    const sentence = sentenceOf(g);
    expect(sentence).not.toContain("https://");
    expect(sentence).toMatch(/[a-z]$/u);
    expect(g.headline.startsWith(sentence)).toBe(true);
  });

  it("returns the headline whole when there is no link to lift out", () => {
    // Guessing where a sentence stops is worse than printing one URL twice.
    const g = decide({ ...ok, freeMargin: 0 });

    expect(sentenceOf(g)).toBe(g.headline);
  });

  it("keeps the headline to one thing to do, so relaying it is not a wall of text", () => {
    // What prompted this: a fresh install's first screen was one paragraph of
    // ~850 characters with the link about three-quarters of the way through,
    // and SKILL.md tells an agent to relay the headline verbatim. Nobody reads
    // that far, and the link was the only part they needed.
    const g = decide({
      ...ok,
      mode: "undecided",
      configured: false,
      network: "mainnet",
      address: `0x${"a".repeat(64)}`,
    });

    expect(g.headline.length).toBeLessThan(400);
    expect(g.detail?.length ?? 0).toBeGreaterThan(0);
  });

  it("names no page when there is no wallet to name in it", () => {
    // `?agent=` with nothing in it is a page that refuses; better to say
    // nothing until bootstrap has made a wallet.
    const g = decide({ ...ok, mode: "undecided", configured: false, network: "mainnet" });
    expect(g.state).toBe("awaiting-grant");
    expect(g.headline).not.toContain("agent/authorize");
  });

  it("does not ask a would-be delegate for gas", () => {
    // Gas is an owner-path requirement. Reaching the gas branch from
    // `undecided` is the bug this ordering exists to prevent.
    const g = decide({
      ...ok,
      mode: "undecided",
      configured: false,
      missing: { signer: false, gas: true, account: true },
    });
    expect(g.state).toBe("awaiting-grant");
    expect(g.headline).not.toContain("no SUI, so nothing can be sent");
  });

  it("still asks for gas on the owner path, where it is really needed", () => {
    const g = decide({
      ...ok,
      mode: "owner",
      configured: false,
      missing: { signer: false, gas: true, account: false },
    });
    expect(g.state).toBe("not-set-up");
    expect(g.headline).toContain("no gas");
  });

  it("names the specific gap, so asking again moves things along", () => {
    // Generic advice made a loop: bootstrap says "you need an account", the
    // agent asks `next`, `next` says "run bootstrap", bootstrap says the same
    // thing. Each turn costs the user a message and changes nothing.
    const noKey = decide({ ...ok, configured: false, missing: { signer: true, gas: false, account: true } });
    expect(noKey.headline).toContain("No signing key");

    const noAccount = decide({ ...ok, configured: false, missing: { signer: false, gas: false, account: true } });
    expect(noAccount.headline).toContain("no WaterX account");
    expect(noAccount.suggestions[0]?.command).toContain("--create-account");

    // A wallet and an account, but a failing check: name the check.
    const noGas = decide({
      ...ok,
      configured: false,
      missing: { signer: false, gas: true, account: true },
    });
    expect(noGas.headline).toContain("no gas");
    expect(noGas.suggestions[0]?.command).toContain("fund-sui");

    // On mainnet there is no faucet, and `fund-sui` refuses there — naming it
    // would spend a turn on a command that cannot work.
    const mainnetNoGas = decide({
      ...ok,
      network: "mainnet",
      address: "0xabc",
      configured: false,
      missing: { signer: false, gas: true, account: true },
    });
    expect(mainnetNoGas.headline).toContain("no faucet on mainnet");
    expect(mainnetNoGas.headline).toContain("0xabc");
    expect(mainnetNoGas.suggestions.map((x) => x.command).join(" ")).not.toContain("fund-sui");

    const blocked = decide({
      ...ok,
      configured: false,
      missing: { signer: false, gas: false, account: false },
      blockers: ["abi corpus"],
    });
    expect(blocked.headline).toContain("abi corpus");
  });

  it("does not offer a trade with no collateral, and says who can fix it", () => {
    const g = decide({ ...ok, freeMargin: 0 });
    expect(g.state).toBe("no-collateral");
    expect(g.headline).toContain("Gas is not collateral");
    expect(g.headline, "testnet has no self-service route").toContain("operator");

    // On mainnet there is nobody to ask — you send yourself USDC. Sending a
    // mainnet user looking for an operator sends them after someone who does
    // not exist.
    const onMainnet = decide({ ...ok, network: "mainnet", freeMargin: 0 });
    expect(onMainnet.state).toBe("no-collateral");
    expect(onMainnet.headline).not.toContain("operator");
    expect(onMainnet.headline).toContain("you send");
    expect(g.suggestions.map((s) => s.command).join(" ")).not.toContain("--action open-long");
  });

  it("will not offer a trade the chain is going to refuse", () => {
    // A missing or stale grant makes every write abort on chain, and the
    // refusal arrives as a generic 6002 long after the agent has told the user
    // it is placing an order. No policy and no funding changes that — the owner
    // has to act, and they are not at this terminal.
    for (const state of ["awaiting-grant", "not-granted", "stale-grant", "insufficient"]) {
      const g = decide({
        ...ok,
        delegation: { state, headline: `delegation is ${state}` },
      });
      expect(g.state, state).toBe("not-delegated");
      expect(g.suggestions.map((x) => x.command).join(" ")).toContain("onboard");
      expect(g.suggestions.map((x) => x.command).join(" "), state).not.toContain("preview");
    }
  });

  it("gets out of the way once the grant is real", () => {
    for (const state of ["granted", "owner-key"]) {
      const g = decide({
        ...ok,
        delegation: { state, headline: "fine" },
      });
      expect(g.state, state).toBe("ready");
    }
  });

  it("still settles an in-flight submission before discussing a grant", () => {
    const g = decide({
      ...ok,
      open: 1,
      delegation: { state: "not-granted", headline: "no" },
    });
    expect(g.state).toBe("unsettled");
  });

  it("treats read-only as a decision, not as unfinished setup", () => {
    // These were the same thing when the state was keyed on doctor's
    // `writeReady`, which folds the policy in with the signer and the account.
    // Someone who had chosen read-only — the default on mainnet — was told to
    // run `bootstrap`, which would have found nothing to fix.
    const g = decide({ ...ok, readOnly: true });
    expect(g.state).toBe("read-only");
    expect(g.headline).toContain("deliberately");
    expect(g.suggestions.map((x) => x.command).join(" ")).not.toContain("bootstrap");
  });

  it("still calls a read-only process unconfigured when it also is", () => {
    const g = decide({
      ...ok,
      readOnly: true,
      configured: false,
      missing: { signer: false, gas: false, account: true },
    });
    expect(g.state).toBe("not-set-up");
  });

  it("offers to manage what is already open", () => {
    const g = decide({ ...ok, positions: 2, orders: 1 });
    const commands = g.suggestions.map((s) => s.command).join(" ");
    expect(commands).toContain("close-position");
    expect(commands).toContain("cancel-order");
  });

  it("names the numbers the user must supply, everywhere it could guess one", () => {
    // The code half of "stop and ask". Any suggestion that takes a size, a
    // leverage or a slippage has to say so, or an agent fills it in.
    for (const situation of [ok, { ...ok, positions: 1, orders: 1 }]) {
      for (const suggestion of decide(situation).suggestions) {
        const takesANumber = /<n>|<id>/.test(suggestion.command);
        if (takesANumber) {
          expect(suggestion.needsFromUser, suggestion.command).toBeDefined();
          expect(suggestion.needsFromUser?.length, suggestion.command).toBeGreaterThan(0);
        }
      }
    }
  });

  it("emits commands that can be run as printed", () => {
    // `nextCommand` and these share the rule: a package-manager banner on
    // stdout breaks the one-document guarantee the caller is about to rely on.
    for (const suggestion of decide(ok).suggestions) {
      expect(suggestion.command).toMatch(/^node bin\/waterx\.mjs /);
    }
  });
});
