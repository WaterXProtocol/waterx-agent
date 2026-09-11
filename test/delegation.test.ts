/**
 * The delegate handshake, state by state.
 *
 * Every one of these is a claim made to a person about what a wallet may do
 * with their money, so the dangerous direction is always the same: reporting a
 * grant that is not there, or not usable. Two cases carry most of the weight —
 * a grant in the superseded authority slot, which reads as fully permissioned
 * and aborts on chain, and a failed lookup, which is not a revocation.
 */
import { describe, expect, it, vi } from "vitest";

import {
  CONSOLE_ENDPOINTS,
  delegatesUrl,
  delegationStatus,
  perpAuthorizeUrl,
  REQUESTED_PERMISSION_NAMES,
} from "../src/agent/delegation.ts";
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
  it("asks the owner for trading, and never for funds-out", () => {
    // The entire reason a delegate arrangement is a bounded risk: funds-out and
    // authority changes stayed owner-only on chain. An agent that asked for
    // them would be asking to remove the guarantee.
    expect(ALL).toContain("OPEN_POSITION");
    expect(ALL).toContain("CANCEL_ORDER");
    expect(ALL).not.toContain("DEPOSIT_COLLATERAL");
    expect(ALL).not.toContain("WITHDRAW_COLLATERAL");
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

  it("says an account id cannot be looked up from a delegate key", () => {
    // The backend has no reverse lookup, so this is a fact about the deployment
    // rather than a missing feature here — and an agent told to "find it" would
    // go looking for an endpoint that does not exist.
    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT, ownerAddress: OWNER });
    expect(status.state).toBe("awaiting-grant");
    expect(status.headline).toContain("no way to look one up");
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
    expect(status.headline).toContain("cannot");
    expect(status.headline).toContain("withdraw");
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
