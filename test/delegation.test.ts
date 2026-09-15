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
  CONSOLE_ENDPOINTS,
  DELEGATE_BOUNDARY,
  PERMISSION_MEANINGS,
  REQUESTED_PERP_PERMISSIONS,
  delegatesUrl,
  delegationStatus,
  ownerGrantStep,
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

  it("has no perp authorize page to point at, and does not invent one", () => {
    // The console's `/agent/authorize` grants prediction markets and says, on
    // the page itself, that it does not grant perps. Sending a perp owner there
    // is worse than sending them nowhere: they connect a wallet, sign, and have
    // granted nothing this package can use.
    expect(perpAuthorizeUrl()).toBeUndefined();
  });

  it("uses it once WaterX ships one, without a code change", () => {
    vi.stubEnv("WATERX_PERP_AUTHORIZE_URL", "https://waterx.app/agent/authorize-perp");
    expect(perpAuthorizeUrl()).toBe("https://waterx.app/agent/authorize-perp");
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

  it("tells the agent to hand its address to the owner, with the command that works", () => {
    const status = delegationStatus({
      network: "mainnet",
      delegateAddress: AGENT,
      grantCommand: "npx waterx add-delegate --delegate 0xa --yes --json",
    });
    expect(status.state).toBe("awaiting-grant");
    expect(status.headline).toContain(AGENT);
    // The command, not a web page that cannot grant perps.
    expect(status.headline).toContain("add-delegate");
    expect(status.headline).toContain("does not grant perps");
  });

  it("sends a delegate whose owner is known to discover, not to copy an id", () => {
    // This said there was no way to look an account up from a delegate key and
    // told the agent to ask for the id — true until `discover` existed, and then
    // the one surface still sending people to copy it by hand.
    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT, ownerAddress: OWNER });
    expect(status.state).toBe("awaiting-grant");
    expect(status.headline).toContain("discover");
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
  });

  it("sends the owner to the browser instead of a terminal", () => {
    process.env.WATERX_PERP_AUTHORIZE_URL = PAGE;

    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT });

    expect(status.headline).toContain(PAGE);
    expect(status.headline).toContain("signs with their wallet");
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

  it("has no authorizeUrl when no page is configured", () => {
    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT });

    expect(status.authorizeUrl).toBeUndefined();
    expect(status.grantUrl).toBe("https://waterx.app/en/account");
  });

  it("prints review/revoke from reviewUrl on the onboard screen, never from grantUrl", () => {
    const source = readFileSync(new URL("../scripts/agent/onboard.ts", import.meta.url), "utf8");
    const line = source.split("\n").find((l) => l.includes("review/revoke"));

    expect(line).toBeDefined();
    expect(line).toContain("status.reviewUrl");
    expect(line).not.toContain("grantUrl");
  });

  it("does not promise a number of signatures", () => {
    // It cannot keep that promise: when sponsorship fails the transaction is
    // rebuilt as self-pay and the wallet asks again. The authorize page's own
    // copy was corrected for exactly this; the agent must not reintroduce it.
    process.env.WATERX_PERP_AUTHORIZE_URL = PAGE;

    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT });

    expect(status.headline).not.toMatch(/one signature/iu);
  });

  it("carries the agent address in the link, so the page cannot be aimed at the wrong one", () => {
    process.env.WATERX_PERP_AUTHORIZE_URL = PAGE;

    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT });

    expect(status.headline).toContain(`${PAGE}?agent=${AGENT}`);
  });

  it("carries this agent's pairing code in the link, as the label the page shows", () => {
    // The page reads `label` and shows it to the owner; a page that writes it
    // into the grant brings the code back on chain, where `adopt` checks it.
    process.env.WATERX_PERP_AUTHORIZE_URL = PAGE;
    const alias = "waterx-agent:K7Q2M9XDP4R8";

    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT, alias });

    expect(status.authorizeUrl).toBe(`${PAGE}?agent=${AGENT}&label=${encodeURIComponent(alias)}`);
    expect(status.headline).toContain(status.authorizeUrl);
    expect(status.headline).toContain(alias);
  });

  it("still names the CLI, because a browser is not always wanted", () => {
    process.env.WATERX_PERP_AUTHORIZE_URL = PAGE;

    const status = delegationStatus({
      network: "mainnet",
      delegateAddress: AGENT,
      grantCommand: "npx waterx add-delegate --delegate 0xagent --yes --json",
    });

    expect(status.headline).toContain("npx waterx add-delegate");
  });

  it("prescribes the CLI when no page is configured, and says why", () => {
    // No default: the console's own authorize page grants prediction markets
    // and states that it does not grant perps, so there is nothing to point at.
    const status = delegationStatus({
      network: "mainnet",
      delegateAddress: AGENT,
      grantCommand: "npx waterx add-delegate --delegate 0xagent --yes --json",
    });

    expect(status.headline).toContain("npx waterx add-delegate");
    expect(status.headline).toContain("does not grant perps");
    expect(status.headline).not.toContain("signs with their wallet");
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
    // first. Collapsing them is what made it inert.
    process.env.WATERX_PERP_AUTHORIZE_URL = PAGE;

    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT });

    expect(status.headline).toContain("https://waterx.app/en/account");
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

  /** Every sentence that tells someone what the grant allows. */
  const explanations = (): [string, string][] => [
    ["bootstrap's grant step", ownerGrantStep(AGENT).why],
    ["next, before anything is granted", decide(undecided).headline],
    [
      "a confirmed grant",
      delegationStatus({
        network: "mainnet",
        delegateAddress: AGENT,
        ownerAddress: OWNER,
        accountId: ACCOUNT,
        delegates: [grant()],
      }).headline,
    ],
  ];

  it("never says what a delegate cannot do without saying what WITHDRAW_COLLATERAL does", () => {
    for (const [where, text] of explanations()) expect(text, where).toContain(DELEGATE_BOUNDARY);
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
    expect(step.why).toContain("discover");
  });

  it("puts the meanings and the boundary on the onboard screen, not just the names", () => {
    const source = readFileSync(new URL("../scripts/agent/onboard.ts", import.meta.url), "utf8");
    expect(source).toContain("requestedPermissions()");
    expect(source).toContain("DELEGATE_BOUNDARY");
  });
});
