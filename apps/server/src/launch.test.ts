import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { adopt, findRunning, latestRelease, newer, orphaned, releaseInstaller } from "./launch.ts";

const tempHome = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "gc-launch-"));
// No process has this pid on a test machine.
const GONE = 2 ** 22 + 7;

describe("launching outside dev", () => {
  it("compares release versions by number", () => {
    expect(newer("0.10.0", "0.9.3")).toBe(true);
    expect(newer("1.0.0", "1.0.0")).toBe(false);
    expect(newer("0.9.9", "0.10.0")).toBe(false);
    expect(newer("2.0.0-beta.1", "1.0.0")).toBe(false);
  });

  it("starts a new server when the recorded one is gone", async () => {
    const home = tempHome();
    expect(await findRunning(home)).toBeNull();
    NodeFS.writeFileSync(
      NodePath.join(home, "server.json"),
      JSON.stringify({ pid: GONE, port: 9, owner: "cli", ownerPid: null }),
    );
    expect(await findRunning(home)).toBeNull();
  });

  it("lets the next launch adopt a server whose app crashed", async () => {
    const health = NodeHttp.createServer((_, res) => res.end("{}"));
    await new Promise<void>((resolve) => health.listen(0, "127.0.0.1", resolve));
    const address = health.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const home = tempHome();
    NodeFS.writeFileSync(
      NodePath.join(home, "server.json"),
      JSON.stringify({ pid: process.pid, port, owner: "desktop", ownerPid: GONE }),
    );
    const running = await findRunning(home);
    expect(running && orphaned(running)).toBe(true);
    const mine = adopt(running!, "desktop", home);
    expect(orphaned(mine)).toBe(false);
    expect(await findRunning(home)).toEqual(mine);
    health.close();
  });
});

describe("the newest release", () => {
  const answer = (url: string) => {
    const r = new Response(null);
    Object.defineProperty(r, "url", { value: url });
    return r;
  };
  afterEach(() => vi.restoreAllMocks());

  it("reads the tag GitHub redirects to, null when nothing is published, and throws offline", async () => {
    const releases = "https://github.com/x/y/releases";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(answer(`${releases}/tag/v0.2.0`));
    expect(await latestRelease(releases)).toBe("0.2.0");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(answer(releases));
    expect(await latestRelease(releases)).toBeNull();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(latestRelease(releases)).rejects.toThrow("fetch failed");
  });

  it("hands over an installer only when it matches the release's SHA256SUMS", async () => {
    const script = "#!/bin/sh\necho installed\n";
    const sum = NodeCrypto.createHash("sha256").update(script).digest("hex");
    const serve = (sums: string) =>
      vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (url) =>
          String(url).endsWith("/SHA256SUMS") ? new Response(sums) : new Response(script),
        );
    serve(`${"0".repeat(64)}  getmyprof.dmg\n${sum}  install.sh\n`);
    expect(String(await releaseInstaller("https://x/releases", "0.2.0"))).toBe(script);
    serve(`${"f".repeat(64)}  install.sh\n`);
    await expect(releaseInstaller("https://x/releases", "0.2.0")).rejects.toThrow("SHA256SUMS");
    // Windows asks for install.ps1, checked against its own line.
    serve(`${sum}  install.sh\n`);
    await expect(releaseInstaller("https://x/releases", "0.2.0", "install.ps1")).rejects.toThrow(
      "install.ps1 doesn't match",
    );
  });
});
