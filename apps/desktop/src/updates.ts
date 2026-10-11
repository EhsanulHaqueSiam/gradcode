// In-app updates from the public release feed: app-update.yml, which electron-builder writes from
// the publish target in scripts/dist.ts. Checks at launch and every 6 hours.
import type { DesktopUpdate } from "@getmyprof/contracts";
import { releaseInstaller, releasesUrl } from "@getmyprof/server/launch";
import { app, ipcMain, shell } from "electron";
import electronUpdater from "electron-updater";
import * as NodeChild from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const { autoUpdater } = electronUpdater;

/** The running getmyprof.app; process.execPath is its Contents/MacOS binary. */
const bundle = () => NodePath.resolve(process.execPath, "../../..");

/**
 * How this install moves to a new version. `feed`: electron-updater downloads and swaps it (an
 * AppImage, the Windows setup .exe, or a Mac app with the Developer ID signature Squirrel.Mac
 * requires). `script`: an unsigned Mac app runs the release's install.sh over itself. `page`: a
 * .deb or .msi, which only their package manager may replace, so the release opens to download
 * the new one.
 */
function updateWay() {
  if (process.platform === "linux") return process.env.APPIMAGE ? "feed" : "page";
  // The setup .exe leaves its uninstaller beside the app; an .msi install doesn't.
  if (process.platform === "win32")
    return NodeFS.existsSync(
      NodePath.join(NodePath.dirname(process.execPath), `Uninstall ${app.getName()}.exe`),
    )
      ? "feed"
      : "page";
  if (process.platform !== "darwin") return "page";
  const r = NodeChild.spawnSync("codesign", ["-dv", "--verbose=2", bundle()], { encoding: "utf8" });
  return (r.stderr ?? "").includes("Authority=Developer ID Application") ? "feed" : "script";
}

/**
 * Replaces this unsigned Mac app with `version`: the release's install.sh, checked against its
 * SHA256SUMS, downloads the dmg and copies getmyprof.app over this bundle. Reports curl's percent.
 */
async function installOver(releases: string, version: string, progress: (percent: number) => void) {
  const script = await releaseInstaller(releasesUrl(releases), version, "install.sh");
  const file = NodePath.join(app.getPath("temp"), `getmyprof-install-${process.pid}.sh`);
  NodeFS.writeFileSync(file, script);
  const child = NodeChild.spawn("sh", [file, "--desktop"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      GETMYPROF_VERSION: version,
      GETMYPROF_APP_DIR: NodePath.dirname(bundle()),
    },
  });
  let log = "";
  child.stderr.on("data", (chunk: Buffer) => {
    log += chunk;
    const percent = /([\d.]+)%[^%]*$/.exec(String(chunk))?.[1];
    if (percent) progress(Number(percent));
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  NodeFS.rmSync(file, { force: true });
  if (code !== 0)
    throw new Error(
      log
        .trim()
        .split(/[\r\n]/)
        .at(-1) || `install.sh exited ${code}`,
    );
}

/** Pushes every change to the window, and answers the page's Update, Download or Restart. */
export function watchUpdates(push: (update: DesktopUpdate) => void, releases: string) {
  let current: DesktopUpdate = { state: "none" };
  const set = (update: DesktopUpdate) => {
    current = update;
    push(update);
  };
  const way = app.isPackaged ? updateWay() : "page";
  const openRelease = (version: string) =>
    void shell.openExternal(`https://github.com/${releases}/releases/tag/v${version}`);

  ipcMain.on("update:get", (event) => event.sender.send("update", current));
  ipcMain.on("update:act", () => {
    if (current.state === "ready" && way === "feed") autoUpdater.quitAndInstall();
    if (current.state === "ready" && way === "script") {
      app.relaunch();
      app.quit();
    }
    if (current.state === "available" && way === "page") openRelease(current.version);
    if (current.state === "available" && way === "script") {
      const { version } = current;
      set({ state: "downloading", version, percent: 0 });
      installOver(releases, version, (percent) => set({ state: "downloading", version, percent }))
        .then(() => set({ state: "ready", version }))
        .catch((error: unknown) => {
          // The app is untouched; the release page is the way through by hand.
          console.error(`update: ${error instanceof Error ? error.message : error}`);
          set({ state: "available", version, inPlace: true });
          openRelease(version);
        });
    }
  });
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = way === "feed";
  autoUpdater.autoInstallOnAppQuit = way === "feed";
  autoUpdater.on("update-available", ({ version }) => {
    // A later check doesn't reset an update already on its way.
    if (current.state === "downloading" || current.state === "ready") return;
    set(
      way === "feed"
        ? { state: "downloading", version, percent: 0 }
        : { state: "available", version, inPlace: way === "script" },
    );
  });
  autoUpdater.on("download-progress", ({ percent }) => {
    if (current.state === "downloading" && way === "feed") set({ ...current, percent });
  });
  autoUpdater.on("update-downloaded", ({ version }) => set({ state: "ready", version }));
  autoUpdater.on("error", (error) => console.error(`update check: ${error.message}`));
  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}
