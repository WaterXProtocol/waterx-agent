/**
 * Where this installation keeps what it has already learned.
 *
 * `.env` and `.waterx/` were resolved against the CURRENT WORKING DIRECTORY, so
 * the answer to "is this set up?" depended on where somebody stood when they
 * asked. Run from a subdirectory, `next` found no `.env`, reported `not-set-up`
 * and suggested `bootstrap` — and an agent doing what it was told generated a
 * SECOND key, abandoning the one the owner had already granted. The same cwd
 * made `approvals` and `next` read different ledgers and report different
 * numbers for the same question.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { stateRoot } from "../src/state-root.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "waterx-state-"));
});

describe("finding the state an install already has", () => {
  it("answers the same from a subdirectory as from the install", () => {
    writeFileSync(join(root, ".env"), "SUI_PRIVATE_KEY=x\n");
    const deep = join(root, "src", "nested");
    mkdirSync(deep, { recursive: true });

    expect(stateRoot(deep)).toBe(stateRoot(root));
  });

  it("finds it by `.waterx/` as well as by `.env`", () => {
    // Either marker means this directory is already somebody's install. A
    // wallet without ledgers and ledgers without a wallet are both real states.
    mkdirSync(join(root, ".waterx"));
    const deep = join(root, "a", "b");
    mkdirSync(deep, { recursive: true });

    expect(stateRoot(deep)).toBe(root);
  });

  it("stops at the NEAREST one, so two projects do not share a wallet", () => {
    writeFileSync(join(root, ".env"), "SUI_PRIVATE_KEY=outer\n");
    const inner = join(root, "inner");
    mkdirSync(inner);
    writeFileSync(join(inner, ".env"), "SUI_PRIVATE_KEY=inner\n");
    const deep = join(inner, "src");
    mkdirSync(deep);

    expect(stateRoot(deep)).toBe(inner);
  });

  it("creates nothing and moves nothing when there is no state yet", () => {
    // A fresh install must write where it always did. Walking up to somebody
    // else's project would be worse than the bug being fixed.
    const fresh = join(root, "brand", "new");
    mkdirSync(fresh, { recursive: true });

    expect(stateRoot(fresh)).toBe(fresh);
  });
});

describe("the home directory is a boundary", () => {
  /**
   * The walk accepted any `.waterx`, and `~/.waterx` exists on any machine that
   * has installed the PREDICT agent — a different product with a different
   * wallet. So every project under `$HOME` with no marker of its own resolved to
   * `$HOME`, putting two agents' approval ledgers in one directory. Measured on
   * a real machine, where `stateRoot()` from a checkout answered `/Users/<user>`
   * and the approvals file answered `~/.waterx/approvals.jsonl`.
   *
   * Which is the same failure as the bug above, reached from the other side: an
   * install's state has to belong to the install.
   */
  it("does not walk out of a project into the home directory", () => {
    const home = homedir();
    // A real subdirectory of home that holds no marker. `$HOME` itself holds
    // `.waterx` on this machine or it does not; either way the answer for a
    // project must be the project.
    const project = mkdtempSync(join(home, ".waterx-agent-test-"));
    const deep = join(project, "src", "nested");
    mkdirSync(deep, { recursive: true });
    try {
      expect(stateRoot(deep)).toBe(deep);
      expect(stateRoot(project)).toBe(project);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("still answers the home directory when that is where it was asked from", () => {
    // A boundary, not a refusal. Somebody who ran the agent in their home
    // directory meant their home directory, and sending them elsewhere would be
    // a second surprise rather than a fix.
    expect(stateRoot(homedir())).toBe(homedir());
  });
});
