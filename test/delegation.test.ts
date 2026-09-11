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
  AUTHORIZE_PATH,
  authorizeUrl,
  CONSOLE_ENDPOINTS,
  delegationStatus,
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

describe("the link an owner opens", () => {
  it("points at the console paired with the deployment, per network", () => {
    // A guess is worse than nothing here. An earlier revision pointed at a page
    // found by probing for a 200; it does not grant anything, and an owner sent
    // there concludes the product is broken rather than that the link was
    // wrong.
    expect(CONSOLE_ENDPOINTS.mainnet).toBe("https://waterx.app");
    expect(CONSOLE_ENDPOINTS.testnet).toBe("https://testnet.waterx.app");
    expect(AUTHORIZE_PATH).toBe("/agent/authorize");
  });

  it("carries the agent wallet, and a label and account when given", () => {
    const url = new URL(
      authorizeUrl({ network: "mainnet", agentWallet: AGENT, label: "my-bot", accountId: ACCOUNT }),
    );
    expect(url.origin).toBe("https://waterx.app");
    expect(url.pathname).toBe("/agent/authorize");
    expect(url.searchParams.get("agent")).toBe(AGENT);
    expect(url.searchParams.get("label")).toBe("my-bot");
    expect(url.searchParams.get("account")).toBe(ACCOUNT);
  });

  it("lets nothing else ride along", () => {
    // The link confers no authority — it is a page to visit, not a credential —
    // which is what makes it safe to paste into a chat. A token here would turn
    // every paste into a leak.
    const url = new URL(authorizeUrl({ network: "testnet", agentWallet: AGENT }));
    expect([...url.searchParams.keys()]).toEqual(["agent"]);
  });

  it("can be pointed at a private console", () => {
    vi.stubEnv("WATERX_CONSOLE_URL", "https://console.internal/");
    expect(authorizeUrl({ network: "mainnet", agentWallet: AGENT })).toBe(
      `https://console.internal/agent/authorize?agent=${AGENT}`,
    );
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

  it("tells the agent to hand its address to the owner", () => {
    const status = delegationStatus({ network: "mainnet", delegateAddress: AGENT });
    expect(status.state).toBe("awaiting-grant");
    expect(status.headline).toContain(AGENT);
    expect(status.headline).toContain(status.grantUrl);
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
