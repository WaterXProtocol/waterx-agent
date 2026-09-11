/**
 * The delegate handshake, state by state.
 *
 * Every one of these is a claim made to a person about what a wallet may do
 * with their money, so the dangerous direction is always the same: reporting a
 * grant that is not there, or not usable. Two cases carry most of the weight —
 * a grant in the superseded authority slot, which reads as fully permissioned
 * and aborts on chain, and a failed lookup, which is not a revocation.
 */
import { describe, expect, it } from "vitest";

import { delegationStatus, REQUESTED_PERMISSION_NAMES } from "../src/agent/delegation.ts";
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
    expect(delegationStatus({}).state).toBe("no-wallet");
  });

  it("tells the agent to hand its address to the owner", () => {
    const status = delegationStatus({ delegateAddress: AGENT });
    expect(status.state).toBe("awaiting-grant");
    expect(status.headline).toContain(AGENT);
    expect(status.headline).toContain(status.grantUrl);
  });

  it("says an account id cannot be looked up from a delegate key", () => {
    // The backend has no reverse lookup, so this is a fact about the deployment
    // rather than a missing feature here — and an agent told to "find it" would
    // go looking for an endpoint that does not exist.
    const status = delegationStatus({ delegateAddress: AGENT, ownerAddress: OWNER });
    expect(status.state).toBe("awaiting-grant");
    expect(status.headline).toContain("no way to look one up");
  });

  it("recognises when it is holding the owner's own key", () => {
    // Legal, and it removes the guarantee. Saying so is the difference between
    // a delegate arrangement and one that only looks like it.
    const status = delegationStatus({
      delegateAddress: AGENT,
      ownerAddress: AGENT,
      accountId: ACCOUNT,
    });
    expect(status.state).toBe("owner-key");
    expect(status.headline).toContain("cannot withdraw");
  });

  it("calls an ungranted wallet ungranted", () => {
    const status = delegationStatus({
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
    const status = delegationStatus({
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
    const status = delegationStatus({
      delegateAddress: AGENT,
      ownerAddress: OWNER,
      accountId: ACCOUNT,
      delegates: [grant({ stale: true })],
    });
    expect(status.state).toBe("stale-grant");
    expect(status.headline).toContain("EUnauthorized");
  });

  it("names the permissions a partial grant is missing", () => {
    const status = delegationStatus({
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
    const status = delegationStatus({
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
    const status = delegationStatus({
      delegateAddress: AGENT.toUpperCase().replace("0X", "0x"),
      ownerAddress: OWNER,
      accountId: ACCOUNT,
      delegates: [grant()],
    });
    expect(status.state).toBe("granted");
  });
});
