/**
 * A private key written into someone's project must not be committable.
 *
 * `bootstrap` writes one to `.env` in the working directory, which is usually a
 * git repository, and a freshly `npm init`-ed one has no `.gitignore` at all —
 * so the first `git add .` after setup stages the key. That happened to the
 * first person who installed this: they noticed and wrote the `.gitignore`
 * themselves, which says something about them rather than about this package.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { ensureEnvIgnored } from "../src/chain/secrets.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "waterx-secrets-"));
});

const asRepo = (at: string): void => {
  mkdirSync(join(at, ".git"), { recursive: true });
};

describe("keeping the key out of git", () => {
  it("creates a .gitignore when a repository has none", () => {
    asRepo(dir);
    const result = ensureEnvIgnored(dir);
    expect(result.kind).toBe("added");
    const written = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(written).toContain(".env");
    expect(written).toContain(".waterx/");
  });

  it("appends to one that exists, without disturbing what is there", () => {
    asRepo(dir);
    writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n");
    expect(ensureEnvIgnored(dir).kind).toBe("added");
    const after = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(after).toContain("node_modules/");
    expect(after).toContain("dist/");
    expect(after).toContain(".env");
  });

  it("leaves a project that already ignores both alone", () => {
    asRepo(dir);
    writeFileSync(join(dir, ".gitignore"), "# mine\n.env\n.waterx/\n");
    expect(ensureEnvIgnored(dir).kind).toBe("already");
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("# mine\n.env\n.waterx/\n");
  });

  it("still adds .waterx/ to a project that already ignored .env", () => {
    // The gap a real install fell into: its agent wrote this .gitignore before
    // the key existed, `.env` read as handled, and the ledger of who adopted
    // which account was one `git add .` from being committed.
    asRepo(dir);
    const theirs = ".env\n.env.*\n!.env.example\nnode_modules/\n";
    writeFileSync(join(dir, ".gitignore"), theirs);
    const result = ensureEnvIgnored(dir);
    expect(result).toMatchObject({ kind: "added", added: [".waterx/"] });
    const after = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(after.startsWith(theirs)).toBe(true);
    expect(after.match(/^\.env$/gmu)).toHaveLength(1);
    expect(after).toContain(".waterx/");
  });

  it("recognises the spellings people actually use, for both", () => {
    for (const rule of ["*.env", ".env*"]) {
      const at = mkdtempSync(join(tmpdir(), "waterx-secrets-"));
      asRepo(at);
      writeFileSync(join(at, ".gitignore"), `${rule}\n.waterx/\n`);
      expect(ensureEnvIgnored(at).kind, rule).toBe("already");
    }
    for (const rule of [".waterx", "/.waterx/", ".waterx/**"]) {
      const at = mkdtempSync(join(tmpdir(), "waterx-secrets-"));
      asRepo(at);
      writeFileSync(join(at, ".gitignore"), `.env\n${rule}\n`);
      expect(ensureEnvIgnored(at).kind, rule).toBe("already");
    }
  });

  it("finds the repository from a subdirectory, where the .gitignore belongs", () => {
    asRepo(dir);
    const nested = join(dir, "packages", "thing");
    mkdirSync(nested, { recursive: true });
    expect(ensureEnvIgnored(nested).kind).toBe("added");
    // At the repository root, not beside the working directory — a rule in a
    // subdirectory would not cover a `.env` written at the root later.
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    expect(existsSync(join(nested, ".gitignore"))).toBe(false);
  });

  it("writes nothing outside a repository, because nothing can be committed", () => {
    expect(ensureEnvIgnored(dir).kind).toBe("not-a-repo");
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });
});
