// Starting the server outside dev: the desktop app and the `getmyprof` command both come here.
// One server per GETMYPROF_HOME. Two on the same store would each run the loops and the send
// queue, so a launcher that finds one already running opens it instead of starting another.
import * as NodeChild from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import { z } from "zod";
import { homeDir } from "./db.ts";

/** Asked for first, so the page's origin (and what it keeps in localStorage) stays the same. */
export const PREFERRED_PORT = 4350;

/**
 * A started server: its process, port, and who answers for it. `ownerPid` is the app or terminal
 * that stops it on exit; null for `getmyprof serve`, which runs until `getmyprof stop`.
 */
const Running = z.object({
  pid: z.number(),
  port: z.number(),
  owner: z.enum(["desktop", "cli"]),
  ownerPid: z.number().nullable(),
});
export type Running = z.infer<typeof Running>;

const runFile = (home: string) => NodePath.join(home, "server.json");

export const urlOf = (r: Pick<Running, "port">) => `http://127.0.0.1:${r.port}`;

export { homeDir };

async function healthy(port: number) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The server a launcher recorded for this home, if its process is up and it answers. */
export async function findRunning(home = homeDir()) {
  try {
    const r = Running.parse(JSON.parse(NodeFS.readFileSync(runFile(home), "utf8")));
    return alive(r.pid) && (await healthy(r.port)) ? r : null;
  } catch {
    return null;
  }
}

/** `preferred` when it's free on loopback, else any free port. */
export function freePort(preferred = PREFERRED_PORT) {
  const listen = (port: number) =>
    new Promise<number | null>((resolve) => {
      const s = NodeNet.createServer();
      s.once("error", () => resolve(null));
      s.listen(port, "127.0.0.1", () => {
        const a = s.address();
        s.close(() => resolve(typeof a === "object" && a ? a.port : null));
      });
    });
  return listen(preferred).then(async (p) => p ?? (await listen(0)) ?? preferred);
}

export type Launch = {
  /** The Node that runs the server: the bundled one, or Electron's with ELECTRON_RUN_AS_NODE. */
  node: string;
  /** The bundled server (server.mjs) and the built web app beside it. */
  entry: string;
  webDir: string;
  owner: Running["owner"];
  env?: Record<string, string | undefined>;
  /** Outlives the launcher (`getmyprof serve`). */
  detached?: boolean;
};

/**
 * Starts the server on a free port, logging to GETMYPROF_HOME/server.log, and records it in
 * server.json once /api/health answers. Rejects if it exits or stays silent for 30 seconds.
 */
export async function startServer(o: Launch) {
  const home = homeDir({ ...process.env, ...o.env });
  NodeFS.mkdirSync(home, { recursive: true });
  const port = await freePort();
  const log = NodeFS.openSync(NodePath.join(home, "server.log"), "a");
  const child = NodeChild.spawn(o.node, [o.entry], {
    env: { ...process.env, ...o.env, SERVER_PORT: String(port), GETMYPROF_WEB_DIR: o.webDir },
    stdio: ["ignore", log, log],
    detached: o.detached ?? false,
    // On Windows a detached Node would open a console window of its own.
    windowsHide: true,
  });
  NodeFS.closeSync(log);
  let exited = false;
  child.once("exit", () => (exited = true));
  for (let waited = 0; !(await healthy(port)); waited += 200) {
    if (exited || waited > 30_000) {
      child.kill();
      throw new Error(`getmyprof's server didn't start. See ${NodePath.join(home, "server.log")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const running: Running = {
    pid: child.pid ?? 0,
    port,
    owner: o.owner,
    ownerPid: o.detached ? null : process.pid,
  };
  NodeFS.writeFileSync(runFile(home), JSON.stringify(running));
  if (o.detached) child.unref();
  return { ...running, child };
}

/** Whether the app or terminal that answered for this server died (a crash, a kill -9). */
export const orphaned = (r: Running) => r.ownerPid !== null && !alive(r.ownerPid);

/** Takes over an orphaned server, so this process stops it when it exits. */
export function adopt(r: Running, owner: Running["owner"], home = homeDir()) {
  const next: Running = { ...r, owner, ownerPid: process.pid };
  NodeFS.writeFileSync(runFile(home), JSON.stringify(next));
  return next;
}

/** Stops a server this home recorded, by its recorded pid, and forgets it. */
export function stopServer(r: Running, home = homeDir()) {
  try {
    process.kill(r.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  NodeFS.rmSync(runFile(home), { force: true });
}

/** Whether release `a` is newer than `b`, comparing x.y.z; a prerelease or odd tag never is. */
export function newer(a: string, b: string) {
  const parts = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** A repo's releases page; GETMYPROF_RELEASE_URL points at a mirror, as it does for install.sh. */
export const releasesUrl = (repo: string) =>
  process.env.GETMYPROF_RELEASE_URL ?? `https://github.com/${repo}/releases`;

/**
 * The newest version under a releases URL (its /latest redirects to /tag/v<version>), or null when
 * none is published yet. Throws when the feed can't be reached.
 */
export async function latestRelease(releases: string, timeoutMs = 3000) {
  // GitHub redirects /latest to the newest tag, or back to /releases when there is none yet.
  // A feed it can't reach throws, so "nothing published" and "offline" read differently.
  const r = await fetch(`${releases}/latest`, {
    method: "HEAD",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return /\/tag\/v?([^/?#]+)$/.exec(r.url)?.[1] ?? null;
}

/** A release asset, or an error naming the URL and why; never a silent half-download. */
async function releaseAsset(releases: string, version: string, name: string) {
  const url = `${releases}/download/v${version}/${name}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch((error: unknown) => {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    throw new Error(`Couldn't download ${url}: ${cause instanceof Error ? cause.message : cause}`);
  });
  if (!r.ok) throw new Error(`Couldn't download ${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** The release's installer for this machine: install.ps1 on Windows, install.sh elsewhere. */
export const INSTALLER = process.platform === "win32" ? "install.ps1" : "install.sh";

/**
 * A release's own installer, checked against that release's SHA256SUMS. `getmyprof update` runs
 * it, and so does an unsigned Mac app (install.sh `--desktop`) to replace itself.
 */
export async function releaseInstaller(releases: string, version: string, name = INSTALLER) {
  const [sums, script] = await Promise.all([
    releaseAsset(releases, version, "SHA256SUMS"),
    releaseAsset(releases, version, name),
  ]);
  const expected = sums
    .toString()
    .split("\n")
    .find((line) => line.slice(66) === name)
    ?.slice(0, 64);
  const actual = NodeCrypto.createHash("sha256").update(script).digest("hex");
  if (expected !== actual) throw new Error(`${name} doesn't match the release's SHA256SUMS.`);
  return script;
}
