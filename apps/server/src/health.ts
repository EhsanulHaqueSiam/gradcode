import type { Check, Health } from "@getmyprof/contracts";
import { z } from "zod";
import * as NodeChild from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { findClaude } from "./agent/binary.ts";

type Env = Record<string, string | undefined>;

/** The gradhunt checkout the server reads. e2e and /verify point GRADHUNT_DIR at a copy. */
export const gradhuntDir = (env: Env) =>
  env.GRADHUNT_DIR ?? NodePath.join(NodeOS.homedir(), "Personal/gradhunt");

// On Windows a command is bin.exe, or bin.cmd from npm.
const names = (bin: string) =>
  process.platform === "win32" ? [`${bin}.exe`, `${bin}.cmd`] : [bin];
const onPath = (env: Env, bin: string) =>
  (env.PATH ?? "")
    .split(NodePath.delimiter)
    .some((dir) => dir !== "" && names(bin).some((n) => NodeFS.existsSync(NodePath.join(dir, n))));

/**
 * Which local tools exist. File checks only: it never spawns a process or spends money. Claude
 * counts when it's on PATH or its binary was already fetched (`found`).
 */
export function health(env: Env = process.env, found: () => string | null = findClaude): Health {
  const checks = {
    claude: onPath(env, "claude") || found() !== null,
    scout: NodeFS.existsSync(NodePath.join(gradhuntDir(env), "scout.py")),
    treg: onPath(env, "treg"),
  } satisfies Record<Check, boolean>;
  return { host: NodeOS.hostname(), checks, scripted: env.GETMYPROF_AGENT === "fake" };
}

const ClaudeConfig = z.object({
  oauthAccount: z.object({ emailAddress: z.string() }).optional(),
});

/**
 * Whether Claude Code can run here: an API key in the environment, or the login `claude` keeps
 * in ~/.claude.json (CLAUDE_CONFIG_DIR moves it). A file read; it never calls Claude.
 */
export function claudeLogin(env: Env = process.env, home = NodeOS.homedir()) {
  if (env.ANTHROPIC_API_KEY) return { signedIn: true, who: "an API key" };
  try {
    const file = NodePath.join(env.CLAUDE_CONFIG_DIR ?? home, ".claude.json");
    const c = ClaudeConfig.parse(JSON.parse(NodeFS.readFileSync(file, "utf8")));
    const who = c.oauthAccount?.emailAddress ?? "";
    return { signedIn: who !== "", who };
  } catch {
    return { signedIn: false, who: "" };
  }
}

const TailStatus = z.object({ Self: z.object({ DNSName: z.string() }) });
const ServeStatus = z.object({ Web: z.record(z.string(), z.unknown()).optional() });
let cached: { at: number; link: { url: string; served: boolean } | null } | null = null;

/**
 * The address another device on the tailnet opens: https://<this machine>:<SHARE_PORT>, and
 * whether `scripts/dev-local.sh share` is serving it. Null without Tailscale. Cached a minute.
 */
export function tailnetLink(env: Env = process.env) {
  if (cached && Date.now() - cached.at < 60_000) return cached.link;
  const port = Number(env.SHARE_PORT ?? 8443);
  const run = (args: string[]) =>
    JSON.parse(NodeChild.execFileSync("tailscale", args, { timeout: 3000 }).toString() || "{}");
  let link: { url: string; served: boolean } | null = null;
  try {
    const host = TailStatus.parse(run(["status", "--json"])).Self.DNSName.replace(/\.$/, "");
    const serve = ServeStatus.parse(run(["serve", "status", "--json"]));
    link = { url: `https://${host}:${port}`, served: Boolean(serve.Web?.[`${host}:${port}`]) };
  } catch {
    link = null;
  }
  cached = { at: Date.now(), link };
  return link;
}
