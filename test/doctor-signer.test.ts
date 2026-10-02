/**
 * Whether the program a signer would spawn is actually here.
 *
 * Constructing an external signer stores an argv and checks nothing, so
 * `WATERX_SIGNER_COMMAND=/nonexistent/signer` passed the preflight and failed
 * at the first signature — with an order priced and a person waiting. A
 * preflight that cannot catch a typed path is a preflight for the one case
 * that never goes wrong.
 */
import { describe, expect, it } from "vitest";

import { signerCommandCheck } from "../src/doctor.ts";

const external = (executable: string) => ({ kind: "external-command", executable });

describe("the program a signature depends on", () => {
  it("fails a path that is not there, naming when it would have been noticed", () => {
    const check = signerCommandCheck(external("/nonexistent/signer"), () => false);
    expect(check?.status).toBe("fail");
    expect(check?.detail).toMatch(/at the moment one is needed/u);
  });

  it("passes a path that is", () => {
    expect(signerCommandCheck(external("/usr/local/bin/signer"), () => true)?.status).toBe("ok");
  });

  it("will not call a bare name broken, because that is about the wrong machine", () => {
    // It is resolved against the PATH of whatever spawns it, which this
    // process may not share. Unknown is the honest answer, and unknown is not
    // the same as wrong.
    const check = signerCommandCheck(external("waterx-signer"), () => false);
    expect(check?.status).toBe("warn");
    expect(check?.detail).toMatch(/cannot confirm/u);
  });

  it("says nothing about a key held in this process", () => {
    // There is no program to find: the signature happens here.
    expect(signerCommandCheck({ kind: "in-process-keypair" })).toBeUndefined();
  });
});
