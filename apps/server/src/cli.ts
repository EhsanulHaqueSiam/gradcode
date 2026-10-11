#!/usr/bin/env node
// The `getmyprof` command, from install.sh's tarball (with its own Node) or from npm. It runs the
// bundled server (server.mjs) and the built web app (web/) that ship beside it; the release
// build writes the version and the public releases repo into the package.json there.
import type { ClaudeBinary } from "@getmyprof/contracts";
import * as NodeChild from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { z } from "zod";
import { ensureClaude, findClaude } from "./agent/binary.ts";
import {
  findRunning,
  homeDir,
  INSTALLER,
  latestRelease,
  newer,
  releaseInstaller,
  orphaned,
  releasesUrl,
  type Running,
  startServer,
  stopServer,
  urlOf,
} from "./launch.ts";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const Pkg = z.object({ version: z.string(), getmyprof: z.object({ releases: z.string() }) });
const pkg = Pkg.parse(JSON.parse(NodeFS.readFileSync(NodePath.join(here, "package.json"), "utf8")));
const releases = releasesUrl(pkg.getmyprof.releases);
// The tarball puts its Node beside cli.mjs; an npm install runs on the user's own Node. Resolved,
// since Windows' getmyprof.cmd starts it through a "bin\..\<version>" path.
const bundledNode = NodePath.resolve(NodePath.dirname(process.execPath)) === here;

const HELP = `getmyprof ${pkg.version}: find professors who can fund your degree

  getmyprof           start it and open it in your browser (Ctrl-C stops it)
  getmyprof serve     keep it running in the background
  getmyprof stop      stop the background server
  getmyprof login     sign in to Claude; your subscription runs the agent
  getmyprof update    install the newest release
  getmyprof --version

Your data lives in ${homeDir()} (set GETMYPROF_HOME to move it).`;

const launch = (detached: boolean) =>
  startServer({
    node: process.execPath,
    entry: NodePath.join(here, "server.mjs"),
    webDir: NodePath.join(here, "web"),
    owner: "cli",
    detached,
  });

function openBrowser(url: string) {
  // `start`'s first quoted argument is a window title, so it gets an empty one.
  const [command, args]: [string, string[]] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
  NodeChild.spawn(command, args, {
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  })
    .on("error", () => console.log(`Open ${url} in your browser.`))
    .unref();
}

async function tellIfOutdated() {
  const latest = await latestRelease(releases).catch(() => null);
  if (latest && newer(latest, pkg.version))
    console.log(`getmyprof ${latest} is out (you have ${pkg.version}). Run: getmyprof update`);
}

const already = (r: Running) =>
  console.log(
    `getmyprof is already running at ${urlOf(r)}${r.owner === "desktop" && !orphaned(r) ? " (the desktop app)" : ""}`,
  );

/** One line that counts up on a terminal; a few lines when the output is a log. */
function progressLine() {
  let shown = -25;
  return (s: ClaudeBinary) => {
    if (s.state !== "downloading") return;
    if (process.stdout.isTTY) process.stdout.write(`\rDownloading Claude Code · ${s.percent}%`);
    else if (s.percent >= shown + 25)
      console.log(`Downloading Claude Code · ${(shown = s.percent)}%`);
  };
}

/** The first run fetches the agent's binary here, where its progress shows. Offline, it says so. */
async function fetchAgent() {
  if (process.env.GETMYPROF_AGENT === "fake" || findClaude()) return;
  try {
    await ensureClaude(progressLine());
    if (process.stdout.isTTY) process.stdout.write("\n");
  } catch (error) {
    if (process.stdout.isTTY) process.stdout.write("\n");
    console.log(
      `${error instanceof Error ? error.message : String(error)} getmyprof starts anyway.`,
    );
  }
}

async function start() {
  void tellIfOutdated();
  const running = await findRunning();
  if (running) {
    already(running);
    openBrowser(urlOf(running));
    return;
  }
  await fetchAgent();
  const server = await launch(false);
  console.log(`getmyprof on ${urlOf(server)} · Ctrl-C stops it`);
  openBrowser(urlOf(server));
  const end = () => stopServer(server);
  process.once("SIGINT", end).once("SIGTERM", end);
  server.child.once("exit", (code) => {
    end();
    process.exit(code ?? 0);
  });
}

async function serve() {
  const running = await findRunning();
  if (running) return already(running);
  await fetchAgent();
  const server = await launch(true);
  console.log(`getmyprof on ${urlOf(server)} · getmyprof stop stops it`);
  await tellIfOutdated();
}

async function stop() {
  const running = await findRunning();
  if (!running) return console.log("getmyprof isn't running.");
  if (running.owner === "desktop" && !orphaned(running))
    return console.log("The desktop app runs it; quit the app.");
  stopServer(running);
  console.log("Stopped.");
}

/** Claude Code's own sign-in, in this terminal. */
async function login() {
  const binary = await ensureClaude(progressLine());
  if (process.stdout.isTTY) process.stdout.write("\n");
  const r = NodeChild.spawnSync(binary, ["auth", "login"], { stdio: "inherit" });
  process.exitCode = r.status ?? 1;
}

/**
 * Installs the newest release with that release's own installer (install.ps1 on Windows), after
 * checking it against the release's SHA256SUMS. Any failure says what and leaves the installed
 * version in place.
 */
async function update() {
  if (!bundledNode) return console.log("Installed with npm: run npm install -g getmyprof@latest");
  const latest = await latestRelease(releases, 10_000).catch(() => {
    throw new Error(`Couldn't reach ${releases}. Check the connection and try again.`);
  });
  if (!latest) throw new Error(`No getmyprof release is published yet at ${releases}.`);
  if (!newer(latest, pkg.version)) return console.log(`getmyprof ${pkg.version} is the newest.`);
  const script = await releaseInstaller(releases, latest);
  const file = NodePath.join(NodeOS.tmpdir(), `getmyprof-${process.pid}-${INSTALLER}`);
  NodeFS.writeFileSync(file, script);
  const [command, args]: [string, string[]] =
    process.platform === "win32"
      ? ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file]]
      : ["sh", [file]];
  const r = NodeChild.spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, GETMYPROF_VERSION: latest },
  });
  NodeFS.rmSync(file, { force: true });
  if (r.status !== 0) throw new Error(`The update didn't install; getmyprof ${pkg.version} stays.`);
  if (await findRunning())
    console.log("The running server keeps the old version until: getmyprof stop");
}

const commands: Record<string, () => unknown> = {
  serve,
  stop,
  login,
  update,
  "--version": () => console.log(pkg.version),
  "--help": () => console.log(HELP),
};
const arg = process.argv[2];
const unknown = () => {
  console.log(HELP);
  process.exitCode = 1;
};
const run = arg === undefined ? start : (commands[arg] ?? unknown);
try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
