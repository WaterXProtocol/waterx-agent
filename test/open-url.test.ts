/**
 * Opening a consent page, and the two things that are not style.
 *
 * The URL can arrive from `WATERX_PERP_AUTHORIZE_URL`, which is environment the
 * caller controls, and it is handed to a platform opener that will run whatever
 * is registered for the scheme. So: argv, never a shell string; and http(s)
 * only.
 */
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { openUrl } from "../src/cli/open-url.ts";

const LINK = `https://waterx.app/en/agent/authorize/perp?agent=0x${"a".repeat(64)}`;

/** A child that reports what the real one reports: an event, not a return value. */
const child = (event: "spawn" | "error", error?: Error): EventEmitter & { unref: () => void } => {
  const emitter = Object.assign(new EventEmitter(), { unref: vi.fn() });
  setImmediate(() => emitter.emit(event, error));
  return emitter;
};

const spawnFake = (event: "spawn" | "error" = "spawn", error?: Error) => {
  const calls: { command: string; args: string[]; options: unknown }[] = [];
  const spawn = ((command: string, args: string[], options: unknown) => {
    calls.push({ command, args, options });
    return child(event, error);
  }) as unknown as NonNullable<Parameters<typeof openUrl>[1]>["spawn"];
  return { spawn, calls };
};

describe("openUrl", () => {
  it("uses each platform's opener, with the URL as an argument", async () => {
    for (const [platform, command, args] of [
      ["darwin", "open", [LINK]],
      ["linux", "xdg-open", [LINK]],
      // `start` is a shell builtin, and the empty string is the window title it
      // would otherwise take the URL for.
      ["win32", "cmd", ["/c", "start", "", LINK]],
    ] as const) {
      const fake = spawnFake();
      const outcome = await openUrl(LINK, { platform, spawn: fake.spawn });

      expect(outcome, platform).toEqual({ opened: true, command });
      expect(fake.calls[0]?.command, platform).toBe(command);
      expect(fake.calls[0]?.args, platform).toEqual(args);
    }
  });

  it("never asks a shell to run it", async () => {
    // The URL is environment a caller controls. `sh -c "open " + url` would
    // hand that string to a shell; argv cannot be talked into a second command.
    const fake = spawnFake();

    await openUrl(`${LINK}&x=$(whoami)`, { platform: "darwin", spawn: fake.spawn });

    expect(fake.calls[0]?.args).toEqual([`${LINK}&x=$(whoami)`]);
    expect(fake.calls[0]?.options).not.toMatchObject({ shell: true });
  });

  it("refuses a scheme that is not a web page, and spawns nothing", async () => {
    // Argv-safe is not enough: an opener hands `file://` to whatever is
    // registered for it. A consent page is http or https.
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "javascript:alert(1)"]) {
      const fake = spawnFake();
      const outcome = await openUrl(url, { platform: "darwin", spawn: fake.spawn });

      expect(outcome.opened, url).toBe(false);
      expect(fake.calls, url).toHaveLength(0);
    }
  });

  it("refuses something that is not a URL at all", async () => {
    const fake = spawnFake();
    const outcome = await openUrl("not a url", { platform: "darwin", spawn: fake.spawn });

    expect(outcome).toEqual({ opened: false, reason: "not a url is not a URL" });
    expect(fake.calls).toHaveLength(0);
  });

  it("reports a machine with no opener on it, rather than claiming it worked", async () => {
    // A spawn failure arrives as an `error` EVENT, not a throw — the same trap
    // that left the CLI shim's "the build is missing" message unreachable. A
    // synchronous return would have reported success on a box with no
    // `xdg-open`.
    const fake = spawnFake("error", new Error("spawn xdg-open ENOENT"));

    const outcome = await openUrl(LINK, { platform: "linux", spawn: fake.spawn });

    expect(outcome.opened).toBe(false);
    expect(outcome.opened === false && outcome.reason).toContain("ENOENT");
  });

  it("lets the browser outlive this process", async () => {
    // Detached, no stdio, unref'd: the CLI exits when it is done, and nothing
    // the browser prints lands in the middle of a JSON document.
    const fake = spawnFake();

    await openUrl(LINK, { platform: "darwin", spawn: fake.spawn });

    expect(fake.calls[0]?.options).toMatchObject({ stdio: "ignore", detached: true });
  });
});
