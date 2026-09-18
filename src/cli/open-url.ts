/**
 * Open a URL in whatever this platform calls a browser.
 *
 * For the one case where it genuinely helps: the operator IS the account owner,
 * with their wallet in a browser on this machine. That is the local case — a
 * demo, a laptop — and there it removes a copy-paste from a flow whose whole
 * point is to be short.
 *
 * It is opt-in for the reason it is useful: `open` opens a browser HERE, and
 * the arrangement this package is built for is one where the owner is somewhere
 * else. An agent on a server would open a page nobody can see; an agent driving
 * this from a chat window would open a page on the wrong desk. So the caller
 * asks for it, and the link is printed either way — a failed open costs
 * nothing, because the thing that matters was already on the screen.
 *
 * ## Two rules that are not style
 *
 * **Never through a shell.** The URL can come from `WATERX_PERP_AUTHORIZE_URL`,
 * which is environment a caller controls. `sh -c "open " + url` would hand that
 * string to a shell; the argv form cannot be talked into running a second
 * command, whatever is in it. The external signer spawns the same way, for the
 * same reason.
 *
 * **http and https only.** Even argv-safe, an opener will happily hand `file://`
 * or a platform's own scheme to whatever is registered for it. A consent page
 * is a web page; nothing else needs opening.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type OpenOutcome =
  /** The opener started. Whether a human then saw a window is not knowable from here. */
  | { opened: true; command: string }
  /** It did not start, and why — for a line of output, never for a failure. */
  | { opened: false; reason: string };

export interface OpenDeps {
  platform?: NodeJS.Platform;
  spawn?: typeof nodeSpawn;
}

/** Schemes an opener may be handed. */
const WEB = new Set(["http:", "https:"]);

/**
 * The opener each platform ships, as a command and its arguments.
 *
 * Windows goes through `cmd /c start` because `start` is a shell builtin rather
 * than a program, and the empty string after it is the window title `start`
 * would otherwise take the URL for.
 */
function opener(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Start the platform's opener on `url`.
 *
 * Resolves when the child has actually spawned, or with the reason it could
 * not: a spawn failure arrives as an `error` EVENT rather than a throw — the
 * same trap that made the CLI shim's "build is missing" message unreachable —
 * so a synchronous return would have reported success for a machine with no
 * `xdg-open` on it.
 */
export function openUrl(url: string, deps: OpenDeps = {}): Promise<OpenOutcome> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve({ opened: false, reason: `${url} is not a URL` });
  }
  if (!WEB.has(parsed.protocol)) {
    return Promise.resolve({
      opened: false,
      reason: `refusing to open a ${parsed.protocol} URL — an authorize page is http or https`,
    });
  }

  const { command, args } = opener(deps.platform ?? process.platform, url);
  const spawn = deps.spawn ?? nodeSpawn;

  return new Promise<OpenOutcome>((resolve) => {
    let settled = false;
    const done = (outcome: OpenOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    try {
      // Detached and with no stdio: the browser outlives this process, and
      // nothing it prints lands in the middle of a JSON document.
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      child.on("error", (error: Error) => {
        done({ opened: false, reason: `${command} could not be started — ${error.message}` });
      });
      child.on("spawn", () => {
        child.unref();
        done({ opened: true, command });
      });
    } catch (error) {
      done({
        opened: false,
        reason: `${command} could not be started — ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}

// --- Opening it once ---------------------------------------------------------

/**
 * Which links have already been opened here, so running `onboard` again does
 * not open another tab.
 *
 * It is run again constantly: an agent asks `next`, is told to run `onboard
 * --wait`, that times out, it runs it again. Opening every time turns a
 * five-minute wait into a browser full of the same page. Beside the other
 * ledgers in `.waterx/`, which `bootstrap` already keeps out of git.
 */
export const OPENED_FILE = process.env.WATERX_OPENED_FILE?.trim() || ".waterx/opened.json";

/** How long an opened link counts as still open. */
export const REOPEN_AFTER_MS = 60 * 60 * 1000;

export interface OpenMemory {
  path?: string;
  now?: number;
  windowMs?: number;
}

const readOpened = (path: string): Record<string, number> => {
  try {
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, number>) : {};
  } catch {
    // A corrupt note about browser tabs is not worth failing a handshake over.
    return {};
  }
};

/** Whether this exact link was opened here recently enough not to open again. */
export function openedRecently(url: string, memory: OpenMemory = {}): boolean {
  const at = readOpened(memory.path ?? OPENED_FILE)[url];
  if (at === undefined) return false;
  return (memory.now ?? Date.now()) - at < (memory.windowMs ?? REOPEN_AFTER_MS);
}

/** Write down that it was opened. Never throws: this is a convenience, not a record. */
export function rememberOpened(url: string, memory: OpenMemory = {}): void {
  const path = memory.path ?? OPENED_FILE;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...readOpened(path), [url]: memory.now ?? Date.now() }), "utf8");
  } catch {
    // Then it opens twice next time, which is the smallest possible harm.
  }
}

/**
 * Whether something in the environment says not to open a browser here, and
 * what said it.
 *
 * The escape hatch that makes opening-by-default defensible: a server, a
 * container and a CI runner all have no browser and no one watching, and they
 * are exactly the places that set these.
 */
export function browserSuppressed(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const off = (value: string | undefined): boolean =>
    value !== undefined && value.trim() !== "" && value.trim() !== "0" && value.trim().toLowerCase() !== "false";
  if (off(env.WATERX_NO_BROWSER)) return "WATERX_NO_BROWSER is set";
  if (off(env.CI)) return "CI is set";
  return undefined;
}
