/**
 * The delegate handshake, state by state.
 *
 * Every one of these is a claim made to a person about what a wallet may do
 * with their money, so the dangerous direction is always the same: reporting a
 * grant that is not there, or not usable. Two cases carry most of the weight —
 * a grant in the superseded authority slot, which reads as fully permissioned
 * and aborts on chain, and a failed lookup, which is not a revocation.
 */
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addressTail,
  CONSOLE_ENDPOINTS,
  DELEGATE_BOUNDARY,
  handshakeScreen,
  PERMISSION_MEANINGS,
  REQUESTED_PERP_PERMISSIONS,
  delegatesUrl,
  delegationStatus,
  ownerGrantStep,
  perpAuthorizeLink,
  perpAuthorizeUrl,
  REQUESTED_PERMISSION_NAMES,
  requestedPermissions,
} from "../src/agent/delegation.ts";
import { decide, type Situation } from "../src/agent/guidance.ts";
import type { DelegateData } from "../src/api/types.ts";

const AGENT = `0x${"a".repeat(64)}`;
const OWNER = `0x${"b".repeat(64)}`;
const ACCOUNT = `0x${"c".repeat(64)}`;
const ALL = Object.keys(REQUESTED_PERMISSION_NAMES);

const grant = (over: Partial<DelegateData> = {}): DelegateData =>
  ({
    delegateAddress: AGENT,
    permissions: 255,
    permissionList: ALL,
    predictPermissions: 0,
    predictPermissionList: [],
    stakingPermissions: 0,
    stakingPermissionList: [],
    expiresAtMs: null,
    stale: false,
    ...over,
  }) as DelegateData;

describe("where an owner is sent", () => {
  it("knows the console paired with each deployment", () => {
    expect(CONSOLE_ENDPOINTS.mainnet).toBe("https://waterx.app");
    expect(CONSOLE_ENDPOINTS.testnet).toBe("https://testnet.waterx.app");
  });

  it("knows the perp authorize page each console ships", () => {
    // This was `undefined` for four days after the page shipped, and every
    // install in that window told an account owner to paste a private key into
    // a CLI. The fact lived here as a constant about another team's product,
    // and nothing goes stale more quietly than that.
    expect(perpAuthorizeUrl("mainnet")).toBe("https://waterx.app/en/agent/authorize/perp");
    expect(perpAuthorizeUrl("testnet")).toBe(
      "https://testnet.waterx.app/en/agent/authorize/perp",
    );
  });

  it("never sends a perp owner to the predict page", () => {
    // `/agent/authorize` and `/agent/authorize/perp` are different routes, not
    // different copy. The one without `/perp` grants prediction markets and
    // says so on itself; an owner who signs there has granted nothing usable.
    for (const network of ["mainnet", "testnet"] as const) {
      expect(perpAuthorizeUrl(network)).toMatch(/\/agent\/authorize\/perp$/);
    }
  });

  it("puts the agent address in the link, so the page cannot be aimed at another", () => {
    expect(perpAuthorizeLink("mainnet", AGENT)).toBe(
      `https://waterx.app/en/agent/authorize/perp?agent=${AGENT}`,
    );
  });

  it("does not guess the routes of a console it does not know", () => {
    // Appending a known path to an unknown host sends an owner to a 404, and an
    // owner at a 404 concludes the product is broken rather than that the link
    // was wrong. Same reason CONSOLE_ENDPOINTS is a lookup.
    vi.stubEnv("WATERX_CONSOLE_URL", "https://console.internal/");
    expect(perpAuthorizeUrl("mainnet")).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("takes a named page, for a private console or a route that has moved", () => {
    vi.stubEnv("WATERX_CONSOLE_URL", "https://console.internal/");
    vi.stubEnv("WATERX_PERP_AUTHORIZE_URL", "https://console.internal/grant");
    expect(perpAuthorizeLink("mainnet", AGENT)).toBe(
      `https://console.internal/grant?agent=${AGENT}`,
    );
    vi.unstubAllEnvs();
  });

  it("keeps a query string the named page already carries", () => {
    // `?agent=` appended blindly truncates one. The link is built in a single
    // place so this is decided once rather than at each headline.
    vi.stubEnv("WATERX_PERP_AUTHORIZE_URL", "https://console.internal/grant?flow=perp");
    expect(perpAuthorizeLink("mainnet", AGENT)).toBe(
      `https://console.internal/grant?flow=perp&agent=${AGENT}`,
    );
    vi.unstubAllEnvs();
  });

  it("sends them to Account → Delegates to review and revoke", () => {
    // Verified from the console's own copy: "Revoke any time from
    // Account → Delegates."
    expect(delegatesUrl("mainnet")).toBe("https://waterx.app/en/account");
  });

  it("can be pointed at a private console", () => {
    vi.stubEnv("WATERX_CONSOLE_URL", "https://console.internal/");
    expect(delegatesUrl("mainnet")).toBe("https://console.internal/en/account");
    vi.unstubAllEnvs();
  });
});

describe("the delegate handshake", () => {
  it("names every bit it asks for, so the consent screen is not short", () => {
    // This claimed the two margin bits were not requested while requesting them
    // — PERM_ALL_TRADING is 255 and includes both. A names list shorter than
    // the mask undersells the grant, which is the worst direction to be wrong
    // in on a screen someone signs.
    const named = Object.values(REQUESTED_PERMISSION_NAMES).reduce((a, b) => a | b, 0);
    expect(named).toBe(REQUESTED_PERP_PERMISSIONS);
  });

  it("asks for position margin, which is not funds-out", () => {
    // DEPOSIT_/WITHDRAW_COLLATERAL move margin between the account and an open
    // position. Taking money OUT of the account is a different operation, and
    // it refuses a delegate outright rather than being gated by a bit.
    expect(ALL).toContain("DEPOSIT_COLLATERAL");
    expect(ALL).toContain("WITHDRAW_COLLATERAL");
    expect(ALL).not.toContain("MINT_WLP");
    expect(ALL).not.toContain("REDEEM_WLP");
  });

  it("has nothing to hand over before there is a wallet", () => {
    expect(delegationStatus({ network: "mainnet",}).state).toBe("no-wallet");
  });

  it("tells the agent to hand its address to the owner, with the page that grants it", () => {
    const status = delegationStatus({
      network: "mainnet",
      delegateAddress: AGENT,
      grantCommand: "npx waterx add-delegate --delegate 0xa --yes --json",
    });
    expect(status.state).toBe("awaiting-grant");
    expect(status.headline).toContain(AGENT);
    // The browser page first: the owner keeps their key in their wallet.
    expect(status.headline).toContain("https://waterx.app/en/agent/authorize/perp");
    // And the CLI still named — in the detail, where the alternatives live. The
    // headline is the one thing to do; an operator who reads it has to come out
    // of it holding a link, not a choice between two routes.
    expect(status.detail).toContain("add-delegate");
  });

  it("sends a delegate whose owner is known to the command that finds it, not to copy an id", () => {
    // This said there was no way to look an account up from a delegate key and
    // told the agent to ask for the id — true until discovery existed, and then
    // the one surface still sending people to copy it by hand. Discovery and
    // adoption are one command now, so that is the one to name: two steps was
    // two chances to stop half way.
    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT, ownerAddress: OWNER });
    expect(status.state).toBe("awaiting-grant");
    expect(status.headline).toContain("onboard --wait");
    expect(status.headline).not.toMatch(/no way to look one up|set WATERX_ACCOUNT_ID/);
  });

  it("recognises when it is holding the owner's own key", () => {
    // Legal, and it removes the guarantee. Saying so is the difference between
    // a delegate arrangement and one that only looks like it.
    const status = delegationStatus({ network: "mainnet",
      delegateAddress: AGENT,
      ownerAddress: AGENT,
      accountId: ACCOUNT,
    });
    expect(status.state).toBe("owner-key");
    expect(status.headline).toContain("cannot withdraw");
  });

  it("calls an ungranted wallet ungranted", () => {
    const status = delegationStatus({ network: "mainnet",
      delegateAddress: AGENT,
      ownerAddress: OWNER,
      accountId: ACCOUNT,
      delegates: [grant({ delegateAddress: `0x${"9".repeat(64)}` })],
    });
    expect(status.state).toBe("not-granted");
  });

  it("does not read a failed lookup as a revocation", () => {
    // Silence is not a refusal. Tearing down on an unreadable chain would be
    // the same mistake as trading on one.
    const status = delegationStatus({ network: "mainnet",
      delegateAddress: AGENT,
      ownerAddress: OWNER,
      accountId: ACCOUNT,
    });
    expect(status.state).toBe("not-granted");
    expect(status.headline).toContain("unconfirmed");
  });

  it("refuses to call a stale grant a grant", () => {
    // It reads as fully permissioned and aborts EUnauthorized on every order.
    // Reporting it as healthy is how an agent trades for an hour against a
    // grant that was never going to work.
    const status = delegationStatus({ network: "mainnet",
      delegateAddress: AGENT,
      ownerAddress: OWNER,
      accountId: ACCOUNT,
      delegates: [grant({ stale: true })],
    });
    expect(status.state).toBe("stale-grant");
    expect(status.headline).toContain("EUnauthorized");
  });

  it("names the permissions a partial grant is missing", () => {
    const status = delegationStatus({ network: "mainnet",
      delegateAddress: AGENT,
      ownerAddress: OWNER,
      accountId: ACCOUNT,
      delegates: [grant({ permissionList: ["OPEN_POSITION"] as never })],
    });
    expect(status.state).toBe("insufficient");
    expect(status.missing).toContain("CLOSE_POSITION");
    expect(status.missing).toContain("CANCEL_ORDER");
  });

  it("confirms a healthy grant, and says what it still cannot do", () => {
    const status = delegationStatus({ network: "mainnet",
      delegateAddress: AGENT,
      ownerAddress: OWNER,
      accountId: ACCOUNT,
      delegates: [grant()],
    });
    expect(status.state).toBe("granted");
    expect(status.headline).toContain("cannot take money OUT");
  });

  it("matches addresses without caring about case", () => {
    const status = delegationStatus({ network: "mainnet",
      delegateAddress: AGENT.toUpperCase().replace("0X", "0x"),
      ownerAddress: OWNER,
      accountId: ACCOUNT,
      delegates: [grant()],
    });
    expect(status.state).toBe("granted");
  });
});

/**
 * The override has to change the ADVICE, not just the link.
 *
 * `perpAuthorizeUrl()` fed only the review URL while every headline went on
 * prescribing the CLI, so an operator who configured a working authorize page
 * was still told to put their private key in a terminal. Nothing exercised the
 * variable until a real install report did.
 */
describe("a configured authorize page", () => {
  const AGENT = `0x${"a".repeat(64)}`;
  const PAGE = "https://waterx.app/en/agent/authorize/perp";

  afterEach(() => {
    delete process.env.WATERX_PERP_AUTHORIZE_URL;
    delete process.env.WATERX_CONSOLE_URL;
  });

  it("sends the owner to the browser instead of a terminal", () => {
    process.env.WATERX_PERP_AUTHORIZE_URL = PAGE;

    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT });

    expect(status.headline).toContain(PAGE);
    expect(status.headline).toContain("signs in their own wallet");
  });

  it("exposes where to grant and where to review as separate fields", () => {
    process.env.WATERX_PERP_AUTHORIZE_URL = PAGE;

    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT });

    expect(status.authorizeUrl).toBe(`${PAGE}?agent=${AGENT}`);
    expect(status.reviewUrl).toBe("https://waterx.app/en/account");
  });

  it("keeps grantUrl meaning what its contract says: the review page", () => {
    // It briefly held the authorize page whenever one was configured, and the
    // onboard screen printed that page under "review/revoke".
    process.env.WATERX_PERP_AUTHORIZE_URL = PAGE;

    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT });

    expect(status.grantUrl).toBe(status.reviewUrl);
  });

  it("has an authorizeUrl with no configuration at all", () => {
    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT });

    expect(status.authorizeUrl).toBe(
      `https://waterx.app/en/agent/authorize/perp?agent=${AGENT}`,
    );
    expect(status.grantUrl).toBe("https://waterx.app/en/account");
  });

  it("has no authorizeUrl for a console it cannot name a page for", () => {
    process.env.WATERX_CONSOLE_URL = "https://console.internal";

    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT });

    expect(status.authorizeUrl).toBeUndefined();
    expect(status.reviewUrl).toBe("https://console.internal/en/account");
  });

  it("prints review/revoke from the review page, never from the page that grants", () => {
    // It printed `grantUrl` — a field whose meaning changed with the
    // environment — under "review/revoke". Asserted on the rendered line now
    // rather than on the source that renders it: the screen is a return value.
    process.env.WATERX_PERP_AUTHORIZE_URL = PAGE;

    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT });
    const line = handshakeScreen(status, { details: true }).find((l) => l.includes("review/revoke"));

    expect(line).toBeDefined();
    expect(line).toContain(status.reviewUrl);
    expect(line).not.toContain("agent/authorize");
  });

  it("does not promise a number of signatures", () => {
    // It cannot keep that promise: when sponsorship fails the transaction is
    // rebuilt as self-pay and the wallet asks again. The authorize page's own
    // copy was corrected for exactly this; the agent must not reintroduce it.
    process.env.WATERX_PERP_AUTHORIZE_URL = PAGE;

    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT });

    expect(status.headline).not.toMatch(/one signature/iu);
  });

  it("ends on the link, so a terminal wrap cannot cut it in half", () => {
    // 115 characters of URL in the middle of a paragraph wraps across three
    // lines of an 80-column terminal, and a URL split across a wrap is one
    // nobody can click or select. Ending on it also means a renderer can lift
    // it onto a line of its own by slicing rather than by guessing.
    process.env.WATERX_PERP_AUTHORIZE_URL = PAGE;

    for (const status of [
      delegationStatus({ network: "mainnet", delegateAddress: AGENT }),
      delegationStatus({ network: "mainnet", delegateAddress: AGENT, ownerAddress: OWNER, accountId: ACCOUNT, delegates: [] }),
      delegationStatus({ network: "mainnet", delegateAddress: AGENT, ownerAddress: OWNER, accountId: ACCOUNT, delegates: [grant({ stale: true })] }),
    ]) {
      expect(status.headline.trimEnd(), status.state).toMatch(/https:\/\/\S+$/u);
    }
  });

  it("names the wallet once, in the link that already carries it", () => {
    // The screen showed the 66-character address three times: in the link, in
    // the check line, and again in the status line underneath. Two of those
    // were the same string nobody reads twice.
    process.env.WATERX_PERP_AUTHORIZE_URL = PAGE;

    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT });

    expect(status.headline.split(AGENT)).toHaveLength(2);
  });

  it("carries the agent address in the link, so the page cannot be aimed at the wrong one", () => {
    process.env.WATERX_PERP_AUTHORIZE_URL = PAGE;

    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT });

    expect(status.headline).toContain(`${PAGE}?agent=${AGENT}`);
  });

  it("still names the CLI, because a browser is not always wanted", () => {
    process.env.WATERX_PERP_AUTHORIZE_URL = PAGE;

    const status = delegationStatus({
      network: "mainnet",
      delegateAddress: AGENT,
      grantCommand: "npx waterx add-delegate --delegate 0xagent --yes --json",
    });

    expect(status.detail).toContain("npx waterx add-delegate");
  });

  it("prescribes the CLI for a console it cannot name a page for, and says why", () => {
    // The only remaining route to the CLI-only advice. It says which knob turns
    // the browser path back on, rather than reporting the product as unable to
    // do something it can.
    process.env.WATERX_CONSOLE_URL = "https://console.internal";

    const status = delegationStatus({
      network: "mainnet",
      delegateAddress: AGENT,
      grantCommand: "npx waterx add-delegate --delegate 0xagent --yes --json",
    });

    // With no page there is nothing to lead with but the command, so here it
    // IS the headline — and the detail says which variable brings the browser
    // path back rather than reporting the product as unable to do something it
    // can.
    expect(status.headline).toContain("npx waterx add-delegate");
    expect(status.detail).toContain("WATERX_PERP_AUTHORIZE_URL");
    expect(status.headline).not.toContain("signs in their own wallet");
  });

  it("names the grant page in the preflight failure an owner is stuck on", () => {
    // `doctor` is the check a stuck install reads, and it said "the owner must
    // grant it first" without saying where. Whoever read that had to go and
    // find out — which is how one ended up relaying a private-key paste to a
    // person who had a browser open.
    const source = readFileSync(new URL("../src/doctor.ts", import.meta.url), "utf8");

    expect(source).toContain("perpAuthorizeLink(config.network, signer.address)");
    expect(source).toContain("is not a registered delegate");
    expect(source).toContain("grantPage === undefined");
  });

  it("gives next's caller the grant page and the review page under their own names", () => {
    // `next` reported only the deprecated grantUrl — the review page, where perp
    // permission cannot be granted — so a caller reading it had nowhere to send
    // an owner who was ready to grant.
    const source = readFileSync(new URL("../scripts/agent/next.ts", import.meta.url), "utf8");
    expect(source).toContain("reviewUrl: status.reviewUrl");
    expect(source).toContain("authorizeUrl: status.authorizeUrl");
  });

  it("keeps review pointed at the delegates page even when a grant page exists", () => {
    // Granting and revoking are different places; the override is only the
    // first. Collapsing them is what made it inert. Where to revoke is not a
    // thing to do before the grant exists, so it is named in the detail — but
    // it is still named, and still the delegates page.
    process.env.WATERX_PERP_AUTHORIZE_URL = PAGE;

    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT });

    expect(status.detail).toContain("https://waterx.app/en/account");
    expect(status.reviewUrl).toBe("https://waterx.app/en/account");
  });
});

/**
 * One account of the grant, wherever it is given.
 *
 * `bootstrap`, `next`, `onboard` and a confirmed grant each described the grant
 * in their own words, and corrections landed in one of them at a time. A real
 * install read "this wallet cannot withdraw" from `bootstrap` beside
 * `WITHDRAW_COLLATERAL` from `onboard`, and "set WATERX_ACCOUNT_ID to what they
 * give you" from `bootstrap` after `discover` had made that unnecessary. These
 * hold every surface to the same account.
 */
describe("what the grant is said to mean", () => {
  const undecided: Situation = {
    open: 0,
    firstUnsettled: undefined,
    pending: [],
    configured: false,
    missing: { signer: false, gas: true, account: true },
    readOnly: true,
    freeMargin: undefined,
    positions: 0,
    orders: 0,
    blockers: [],
    network: "mainnet",
    mode: "undecided",
  };

  const confirmed = (): ReturnType<typeof delegationStatus> =>
    delegationStatus({
      network: "mainnet",
      delegateAddress: AGENT,
      ownerAddress: OWNER,
      accountId: ACCOUNT,
      delegates: [grant()],
    });

  /**
   * Every surface that tells someone what the grant allows.
   *
   * A headline and its detail are one explanation in two parts — the sentence
   * that gets relayed every turn, and the account that gets read once — so the
   * claim they have to make between them is checked between them.
   */
  const explanations = (): [string, string][] => {
    const whole = (s: ReturnType<typeof delegationStatus>): string =>
      `${s.headline} ${s.detail ?? ""}`;
    const starting = decide(undecided);
    return [
      ["bootstrap's grant step", ownerGrantStep(AGENT).why],
      ["next, before anything is granted", `${starting.headline} ${starting.detail ?? ""}`],
      ["a confirmed grant", whole(confirmed())],
    ];
  };

  it("never says what a delegate cannot do without saying what WITHDRAW_COLLATERAL does", () => {
    for (const [where, text] of explanations()) expect(text, where).toContain(DELEGATE_BOUNDARY);
  });

  it("never starts that claim in the half that gets relayed and finishes it in the half that does not", () => {
    // The original defect, in the shape the split could bring back. One surface
    // said "this wallet cannot withdraw" while the next listed
    // WITHDRAW_COLLATERAL, and a real install stopped to reconcile the two
    // before letting anyone sign a mainnet account away. A headline may leave
    // the subject alone — that is the point of having a detail — but it may not
    // make half the claim.
    const relayed: [string, string][] = [
      ["awaiting a grant", delegationStatus({ network: "mainnet", delegateAddress: AGENT }).headline],
      ["a confirmed grant", confirmed().headline],
      ["next, before anything is granted", decide(undecided).headline],
      ["bootstrap's grant step", ownerGrantStep(AGENT).why],
    ];
    for (const [where, text] of relayed) {
      if (/cannot/iu.test(text)) expect(text, where).toContain(DELEGATE_BOUNDARY);
    }
  });

  it("never sends anyone to copy an account id or an owner address by hand", () => {
    const handshake: [string, string][] = [
      ["awaiting a grant", delegationStatus({ network: "mainnet", delegateAddress: AGENT }).headline],
      [
        "owner known, no account",
        delegationStatus({ network: "mainnet", delegateAddress: AGENT, ownerAddress: OWNER }).headline,
      ],
    ];
    for (const [where, text] of [...explanations(), ...handshake]) {
      expect(text, where).not.toMatch(/set WATERX_(ACCOUNT_ID|OWNER_ADDRESS)|put the id in/);
    }
  });

  it("gives every requested bit a meaning, and says where the margin bits move money", () => {
    for (const { name, meaning } of requestedPermissions()) {
      expect(PERMISSION_MEANINGS[name], name).toBeDefined();
      expect(meaning, name).not.toBe(name);
    }
    expect(PERMISSION_MEANINGS.WITHDRAW_COLLATERAL).toMatch(/back into the account's balance/);
    expect(PERMISSION_MEANINGS.WITHDRAW_COLLATERAL).toMatch(/never out of the account/);
    expect(PERMISSION_MEANINGS.DEPOSIT_COLLATERAL).toMatch(/open position/);
  });

  it("files the grant under the account owner, not a venue operator", () => {
    // "an operator" means a human at the venue, who cannot grant anything on
    // someone else's account.
    const step = ownerGrantStep(AGENT);
    expect(step.who).toBe("the account owner");
    expect(step.command).toContain("onboard");
    // And names what finishes it, so the owner's grant does not land somewhere
    // nobody goes looking for it.
    expect(step.why).toContain("onboard --wait");
  });

  it("puts the meanings and the boundary on the detailed screen, not just the names", () => {
    const lines = handshakeScreen(confirmed(), { details: true }).join("\n");

    for (const { name, meaning } of requestedPermissions()) {
      expect(lines, name).toContain(name);
      expect(lines, name).toContain(meaning);
    }
    expect(lines).toContain(DELEGATE_BOUNDARY);
  });
});

/**
 * What an operator is shown, and in what order.
 *
 * The screen was 23 lines with the link on line 3, competing with a second copy
 * of the agent address, a review URL that is no use until after the grant,
 * eight permission rows and a three-clause sentence about what a delegate
 * cannot do. All of that is addressed to the account OWNER, who is not at this
 * terminal and who reads the same things on the page where they sign. The
 * person reading this has one job: send someone a link.
 */
describe("the screen an operator reads", () => {
  const LINK = `https://waterx.app/en/agent/authorize/perp?agent=${AGENT}`;

  afterEach(() => {
    delete process.env.WATERX_CONSOLE_URL;
    delete process.env.WATERX_PERP_AUTHORIZE_URL;
  });

  const awaiting = (): ReturnType<typeof delegationStatus> =>
    delegationStatus({
      network: "mainnet",
      delegateAddress: AGENT,
      grantCommand: "npx waterx add-delegate --delegate 0xagent --yes --json",
    });

  it("leads with the link, on a line of its own, with nothing above it", () => {
    const printed = handshakeScreen(awaiting()).filter((line) => line.trim() !== "");

    expect(printed[0]).toContain("Give this link to the account owner");
    // On its own line: a URL wrapped inside a paragraph is a URL nobody can
    // double-click, and this one is 110 characters because the address is in it.
    expect(printed[1]).toBe(`  ${LINK}`);
  });

  it("does not reprint the consent form the owner is about to read on the page", () => {
    const lines = handshakeScreen(awaiting()).join("\n");

    expect(lines).not.toContain("OPEN_POSITION");
    expect(lines).not.toContain(DELEGATE_BOUNDARY);
    // It says where that account is, rather than pretending it does not exist.
    expect(lines).toContain("onboard --details");
  });

  it("gives the owner something cheap to check the link against", () => {
    // They compare what the page shows against what the operator sent. Nobody
    // compares two 66-character addresses by eye; six characters is a check a
    // person will actually make, and the page shows the address in full for
    // anyone who wants to make the real one.
    const lines = handshakeScreen(awaiting()).join("\n");

    expect(lines).toContain(addressTail(AGENT));
  });

  it("carries the whole account one flag away", () => {
    const lines = handshakeScreen(awaiting(), { details: true }).join("\n");

    for (const name of ALL) expect(lines, name).toContain(name);
    expect(lines).toContain(DELEGATE_BOUNDARY);
    expect(lines).toContain(PERMISSION_MEANINGS.WITHDRAW_COLLATERAL);
    expect(lines).toContain("npx waterx add-delegate");
  });

  it("draws a code under the link, never instead of it", () => {
    // Whoever is at this terminal may be the one who signs, and a link they can
    // click beats a code they cannot. The code is for the owner who is
    // somewhere else, so it goes below, and the link stays where it was.
    const lines = handshakeScreen(awaiting(), { qr: ["##CODE-TOP##", "##CODE-BOTTOM##"] });
    const link = lines.findIndex((line) => line.includes("agent/authorize/perp"));
    const code = lines.findIndex((line) => line.includes("##CODE-TOP##"));

    expect(link).toBeGreaterThanOrEqual(0);
    expect(code).toBeGreaterThan(link);
    expect(lines.filter((line) => line.includes("##CODE"))).toHaveLength(2);
  });

  it("draws nothing when nobody asked for a code", () => {
    const lines = handshakeScreen(awaiting()).join("\n");

    expect(lines).toContain("agent/authorize/perp");
    expect(lines).not.toContain("##CODE");
  });

  it("labels the next command for where the handshake actually is", () => {
    const next = "node bin/waterx.mjs onboard --wait 300 --json";
    expect(handshakeScreen(awaiting(), { next }).join("\n")).toContain("when they have signed");

    const granted = delegationStatus({
      network: "mainnet",
      delegateAddress: AGENT,
      ownerAddress: OWNER,
      accountId: ACCOUNT,
      delegates: [grant()],
    });
    const done = handshakeScreen(granted, { next: "node bin/waterx.mjs next --json" }).join("\n");
    expect(done).not.toContain("when they have signed");
    expect(done).toContain("node bin/waterx.mjs next --json");
  });

  it("falls back to the sentence when there is no page to lead with", () => {
    // A private console gets no guessed route, so the CLI sentence is the whole
    // screen — and it is the headline, which already names the command.
    process.env.WATERX_CONSOLE_URL = "https://console.internal";
    const status = awaiting();

    const lines = handshakeScreen(status).join("\n");

    expect(lines).toContain(status.headline);
    expect(lines).not.toContain("Give this link");
  });
});

/**
 * The grant that was already there.
 *
 * Every surface asked "is this wallet a delegate of WATERX_ACCOUNT_ID?" — a
 * question with no answer until an account has been adopted, which is the very
 * thing the grant is needed to find. `signsAsDelegate` gates the same check on
 * WATERX_OWNER_ADDRESS, which is also only set after adoption. So the circle
 * closed, and a wallet that had been granted minutes earlier was told "nothing
 * is granted to you yet" — with the owner handed a link they had already used.
 *
 * The grant is keyed on the delegate address. It is findable before any of
 * that, in one call, which is what these hold in place.
 */
describe("a grant made before anyone asked", () => {
  const OTHER = `0x${"d".repeat(64)}`;
  const found = (accountId: string): { accountId: string; ownerAddress: string; expiresAtMs: null } => ({
    accountId,
    ownerAddress: OWNER,
    expiresAtMs: null,
  });

  it("reports the account that already grants this wallet, with no account id configured", () => {
    const status = delegationStatus({
      network: "mainnet",
      delegateAddress: AGENT,
      discovered: [found(ACCOUNT)],
    });

    expect(status.state).toBe("granted-not-adopted");
    expect(status.headline).toContain(ACCOUNT);
    expect(status.headline).toContain(OWNER);
    expect(status.grants).toHaveLength(1);
  });

  it("does not send the owner back to a link they have already used", () => {
    const status = delegationStatus({
      network: "mainnet",
      delegateAddress: AGENT,
      grantCommand: "npx waterx add-delegate --delegate 0xagent --yes --json",
      discovered: [found(ACCOUNT)],
    });

    expect(status.headline).not.toContain("agent/authorize");
    expect(status.headline).not.toContain("add-delegate");
  });

  it("keeps bootstrap's relayed step honest about which question was answered", () => {
    // `bootstrap` prints this verbatim under "1 thing(s) still needed", and it
    // said "nothing has been granted to 0x… yet" without anything having
    // looked. The wallet in the install report had been granted.
    expect(ownerGrantStep(AGENT).why).toContain("recorded here");
    expect(ownerGrantStep(AGENT).why).not.toMatch(/nothing grants/iu);
    expect(ownerGrantStep(AGENT, { checked: true }).why).toMatch(/nothing grants/iu);
  });

  it("makes no claim about the chain when nothing asked the chain", () => {
    // The defect itself. "Nothing is granted to this wallet" is a statement
    // about the chain; the branch that made it had never read the chain. What
    // it may honestly say is that no grant is recorded HERE.
    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT });

    expect(status.state).toBe("awaiting-grant");
    expect(status.headline).toContain("recorded here");
    expect(status.headline).not.toMatch(/nothing grants/iu);
  });

  it("says so plainly once the index has answered 'none'", () => {
    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT, discovered: [] });

    expect(status.state).toBe("awaiting-grant");
    expect(status.headline).toMatch(/nothing grants/iu);
  });

  it("never picks between several accounts that grant the same wallet", () => {
    const status = delegationStatus({
      network: "mainnet",
      delegateAddress: AGENT,
      discovered: [found(ACCOUNT), found(OTHER)],
    });

    expect(status.state).toBe("granted-not-adopted");
    expect(status.grants).toHaveLength(2);
    expect(status.headline).toMatch(/choice, not a guess/u);
  });

  it("leaves a configured account to the delegate list, which knows the permissions", () => {
    // Discovery answers "who grants me?". Once an account is adopted the
    // question is "what does this grant allow?", and only the delegate list
    // carries that — including whether it landed in the superseded slot.
    const status = delegationStatus({
      network: "mainnet",
      delegateAddress: AGENT,
      ownerAddress: OWNER,
      accountId: ACCOUNT,
      delegates: [grant({ stale: true })],
      discovered: [found(ACCOUNT)],
    });

    expect(status.state).toBe("stale-grant");
  });

  it("asks the index in the surfaces that report the state, not only in `discover`", () => {
    // `discover` always knew how to find this. The bug was that nothing on the
    // default path called it, so the answer existed and was never fetched.
    for (const path of ["agent/onboard.ts", "agent/next.ts", "setup/bootstrap.ts"]) {
      const source = readFileSync(new URL(`../scripts/${path}`, import.meta.url), "utf8");
      expect(source, path).toContain("discoverGrants(");
    }
  });
});
