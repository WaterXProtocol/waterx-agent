/**
 * The order in which states are resolved, which is the safety property.
 *
 * Every one of these is a claim about what an agent will offer a person. The
 * dangerous direction is always the same: offering a trade before something
 * outstanding has been settled. So the tests are mostly about *precedence* —
 * that a worse state hides a better one — rather than about wording.
 */
import { describe, expect, it } from "vitest";

import { decide, type Situation } from "../src/agent/guidance.ts";

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
    expect(g.headline).toContain("grants THIS address");
    expect(g.headline).toContain("cannot withdraw");
    expect(g.headline).toContain("no SUI of its own");
    expect(g.suggestions[0]?.command).toContain("onboard");
    // The delegate path is two steps now: hand over the address, then find the
    // account the owner granted instead of asking them to copy its id back.
    // Asserted by content and relative order, not by index — the property is
    // "delegate steps come before the owner alternative", not "slot 1".
    const commands = g.suggestions.map((s) => s.command);
    const discover = commands.findIndex((c) => c.includes("discover"));
    const ownerPath = g.suggestions.findIndex((s) => s.command.includes("--create-account"));
    expect(discover).toBe(1);
    // The owner path stays available, after the delegate steps, and says what it costs.
    expect(ownerPath).toBeGreaterThan(discover);
    expect(g.suggestions[ownerPath]?.what).toContain("SUI for gas");
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
        delegation: { state, headline: `delegation is ${state}`, grantUrl: "https://x" },
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
        delegation: { state, headline: "fine", grantUrl: "https://x" },
      });
      expect(g.state, state).toBe("ready");
    }
  });

  it("still settles an in-flight submission before discussing a grant", () => {
    const g = decide({
      ...ok,
      open: 1,
      delegation: { state: "not-granted", headline: "no", grantUrl: "https://x" },
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
