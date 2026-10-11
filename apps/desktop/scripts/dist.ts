// Release builds. `pnpm dist <step>`, run in this order; release.yml runs the same steps.
//
//   runtime                      web app + bundled server and CLI + Electron's main, in apps/desktop/dist
//   cli <os-arch>...             self-contained `getmyprof` tarballs (zips for Windows) with Node
//   desktop <mac|linux|win> <arch>...  dmg + zip, AppImage + deb, or setup .exe + .msi, and the
//                                updater's latest*.yml
//   npm                          the `getmyprof` npm package, packed (never published from here)
//   sums                         SHA256SUMS over the release assets in dist/release
//   manifests                    the Homebrew cask for this release, in dist/publish
//
// The version is the root package.json's. GETMYPROF_RELEASES (owner/name) moves the public update
// feed; GETMYPROF_UPDATE_URL points the desktop app at any static folder instead, for testing.
// The Mac app is signed and notarized when CSC_LINK and Apple's API key are set, else ad-hoc.
import { build as pack } from "vite-plus/pack";
import { build, type Configuration } from "electron-builder";
import * as NodeChild from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "../../..");
const desktop = NodePath.join(root, "apps/desktop");
const runtime = NodePath.join(desktop, "dist/runtime");
const release = NodePath.join(root, "dist/release");
const cache = NodePath.join(root, "dist/cache");

const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(NodeFS.readFileSync(file, "utf8"));
const version = String(readJson(NodePath.join(root, "package.json")).version);
const releases = process.env.GETMYPROF_RELEASES ?? "EhsanulHaqueSiam/getmyprof";
// The CLI's Node: the LTS line Electron 44 runs the server on, so both run the same runtime.
const NODE = "24.21.0";
// The Agent SDK's native binary is one npm package per platform at the SDK's version. Its license
// reserves redistribution, so no download carries it: the runtime pins this version and the
// user's machine fetches it (apps/server/src/agent/binary.ts); the npm package depends on it.
const sdk = String(
  readJson(
    NodePath.join(root, "apps/server/node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
  ).version,
);
const CLI_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
];

const run = (cmd: string, args: string[], cwd = root) => {
  const r = NodeChild.spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
};
const sha256 = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

/** Downloads `url` into the cache once; later builds reuse it. */
async function cached(url: string, name = NodePath.basename(url)) {
  const file = NodePath.join(cache, name);
  if (NodeFS.existsSync(file)) return file;
  NodeFS.mkdirSync(cache, { recursive: true });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url}: ${r.status}`);
  NodeFS.writeFileSync(`${file}.part`, Buffer.from(await r.arrayBuffer()));
  NodeFS.renameSync(`${file}.part`, file);
  return file;
}

/** The web app, the server and CLI bundles, and the Electron main and preload. */
async function buildRuntime() {
  run("pnpm", ["--filter", "@getmyprof/web", "build"]);
  NodeFS.rmSync(NodePath.join(desktop, "dist"), { recursive: true, force: true });
  const common = {
    config: false,
    cwd: root,
    platform: "node",
    target: "node24",
    dts: false,
  } as const;
  // cwd is the root, whose package.json has no dependencies, so every import is bundled.
  await pack({
    ...common,
    entry: { server: "apps/server/src/bin.ts", cli: "apps/server/src/cli.ts" },
    outDir: runtime,
    format: "esm",
    fixedExtension: true,
    deps: { onlyBundle: false },
    define: { "process.env.GETMYPROF_CLAUDE_SDK": JSON.stringify(sdk) },
  });
  NodeFS.cpSync(NodePath.join(root, "apps/web/dist"), NodePath.join(runtime, "web"), {
    recursive: true,
  });
  NodeFS.writeFileSync(
    NodePath.join(runtime, "package.json"),
    `${JSON.stringify({ name: "getmyprof", version, type: "module", getmyprof: { releases } }, null, 2)}\n`,
  );
  await pack({
    ...common,
    entry: { main: "apps/desktop/src/main.ts" },
    outDir: NodePath.join(desktop, "dist"),
    format: "esm",
    fixedExtension: true,
    clean: false,
    deps: { neverBundle: ["electron"], onlyBundle: false },
  });
  await pack({
    ...common,
    entry: { preload: "apps/desktop/src/preload.ts" },
    outDir: NodePath.join(desktop, "dist"),
    format: "cjs",
    fixedExtension: true,
    clean: false,
    deps: { neverBundle: ["electron"], onlyBundle: false },
  });
}

/** Official Node for one os-arch (a zip for Windows), checked against nodejs.org's SHASUMS256.txt. */
async function nodeFor(target: string, win: boolean) {
  const folder = `node-v${NODE}-${target.replace(/^win32-/, "win-")}`;
  const name = `${folder}.${win ? "zip" : "tar.gz"}`;
  const base = `https://nodejs.org/dist/v${NODE}`;
  const archive = await cached(`${base}/${name}`);
  const sums = NodeFS.readFileSync(
    await cached(`${base}/SHASUMS256.txt`, `node-${NODE}-SHASUMS256.txt`),
    "utf8",
  );
  if (!sums.includes(`${sha256(archive)}  ${name}`))
    throw new Error(`${name} doesn't match SHASUMS256.txt`);
  return { archive, binary: win ? `${folder}/node.exe` : `${folder}/bin/node` };
}

/**
 * getmyprof-<v>-<os>-<arch>.tar.gz, or .zip for Windows: the runtime, its Node and the `getmyprof`
 * script (getmyprof.cmd on Windows). Windows zips need `zip` and `unzip` on the building machine.
 */
async function buildCli(targets: string[]) {
  for (const target of targets) {
    if (!CLI_TARGETS.includes(target)) throw new Error(`cli targets: ${CLI_TARGETS.join(", ")}`);
    const win = target.startsWith("win32-");
    const stem = `getmyprof-${version}-${target}`;
    const dir = NodePath.join(root, "dist/stage", stem);
    NodeFS.rmSync(dir, { recursive: true, force: true });
    NodeFS.cpSync(runtime, dir, { recursive: true });
    const node = await nodeFor(target, win);
    NodeFS.mkdirSync(release, { recursive: true });
    if (win) {
      run("unzip", ["-q", "-j", node.archive, node.binary, "-d", dir]);
      NodeFS.copyFileSync(
        NodePath.join(root, "packaging/getmyprof.cmd"),
        NodePath.join(dir, "getmyprof.cmd"),
      );
      const zip = NodePath.join(release, `${stem}.zip`);
      // zip adds to an archive that's already there.
      NodeFS.rmSync(zip, { force: true });
      run("zip", ["-qr", zip, stem], NodePath.dirname(dir));
      continue;
    }
    run("tar", ["-xzf", node.archive, "-C", dir, "--strip-components=2", node.binary]);
    NodeFS.copyFileSync(
      NodePath.join(root, "packaging/getmyprof.sh"),
      NodePath.join(dir, "getmyprof"),
    );
    NodeFS.chmodSync(NodePath.join(dir, "getmyprof"), 0o755);
    run("tar", [
      "--no-xattrs",
      "-czf",
      NodePath.join(release, `${stem}.tar.gz`),
      "-C",
      NodePath.dirname(dir),
      stem,
    ]);
  }
}

function desktopConfig(os: string): Configuration {
  const [owner = "", repo = ""] = releases.split("/");
  const signed = Boolean(process.env.CSC_LINK);
  const entitlements = NodePath.join(desktop, "build/entitlements.mac.plist");
  return {
    appId: "dev.getmyprof.app",
    productName: "getmyprof",
    copyright: "Ehsanul Haque Siam",
    artifactName: "getmyprof-${version}-${arch}.${ext}",
    // desktopName is the window's app id on Linux, matching the menu entry getmyprof-desktop.desktop.
    extraMetadata: {
      version,
      homepage: `https://github.com/${releases}`,
      desktopName: "getmyprof-desktop.desktop",
      // Windows names the per-user install folder after the package ("@getmyprof/desktop"), and
      // updates keep that folder. Windows only: the .deb's package name comes from it too.
      ...(os === "win" ? { name: "getmyprof" } : {}),
    },
    directories: { output: release, buildResources: "build" },
    files: ["package.json", "dist/*.mjs", "dist/*.cjs"],
    extraResources: [{ from: "dist/runtime", to: "runtime" }],
    electronLanguages: ["en", "en-US"],
    publish: process.env.GETMYPROF_UPDATE_URL
      ? { provider: "generic", url: process.env.GETMYPROF_UPDATE_URL }
      : { provider: "github", owner, repo, releaseType: "release" },
    mac: {
      target: ["dmg", "zip"],
      category: "public.app-category.education",
      // Ad-hoc without a Developer ID: it runs, and updates arrive as a notice (updates.ts).
      ...(signed ? { entitlements, entitlementsInherit: entitlements } : { identity: "-" }),
      hardenedRuntime: signed,
      notarize: signed && Boolean(process.env.APPLE_API_KEY),
    },
    linux: {
      target: ["AppImage", "deb"],
      // `getmyprof` is the command line's name; the app is getmyprof-desktop on the PATH.
      executableName: "getmyprof-desktop",
      category: "Education",
      synopsis: "Find professors who can fund your degree",
      maintainer: "Ehsanul Haque Siam <EhsanulHaqueSiam@users.noreply.github.com>",
      desktop: { entry: { StartupWMClass: "getmyprof-desktop" } },
    },
    // The setup .exe installs per user and updates itself; the .msi is for managed installs, and
    // updates arrive as a notice (updates.ts). Unsigned, so Windows warns on first run.
    win: { target: ["nsis", "msi"] },
    nsis: { artifactName: "getmyprof-${version}-${arch}-setup.${ext}" },
    msi: { artifactName: "getmyprof-${version}-${arch}.${ext}" },
    // The static AppImage runtime needs no libfuse2, which Arch and others no longer install.
    toolsets: { appimage: "1.0.3" },
    appImage: { artifactName: "getmyprof-${version}-${arch}.${ext}" },
    deb: {
      artifactName: "getmyprof_${version}_${arch}.${ext}",
      depends: [
        "libasound2t64 | libasound2",
        "libatspi2.0-0t64 | libatspi2.0-0",
        "libgbm1",
        "libgtk-3-0t64 | libgtk-3-0",
        "libnotify4",
        "libnss3",
        "libsecret-1-0",
        "libuuid1",
        "libxss1",
        "libxtst6",
        "xdg-utils",
      ],
    },
  };
}

async function buildDesktop([os, ...archs]: string[]) {
  if ((os !== "mac" && os !== "linux" && os !== "win") || archs.length === 0)
    throw new Error("desktop <mac|linux|win> <x64|arm64>...");
  // CI passes an unset secret as "", which electron-builder reads as a certificate path.
  for (const name of ["CSC_LINK", "CSC_KEY_PASSWORD"])
    if (!process.env[name]) delete process.env[name];
  await build({
    projectDir: desktop,
    config: desktopConfig(os),
    publish: "never",
    [os]: [],
    x64: archs.includes("x64"),
    arm64: archs.includes("arm64"),
  });
}

/** The npm package: the runtime, with npm fetching the one Claude binary this machine needs. */
function buildNpm() {
  const dir = NodePath.join(root, "dist/npm/getmyprof");
  NodeFS.rmSync(dir, { recursive: true, force: true });
  NodeFS.cpSync(runtime, dir, { recursive: true });
  const platforms = [
    "darwin-arm64",
    "darwin-x64",
    "linux-x64",
    "linux-arm64",
    "linux-x64-musl",
    "linux-arm64-musl",
    "win32-x64",
    "win32-arm64",
  ];
  const pkg = {
    name: "getmyprof",
    version,
    description: "Find professors who can fund your degree. Runs on your own Claude Code login.",
    homepage: `https://github.com/${releases}#readme`,
    repository: { type: "git", url: `git+https://github.com/${releases}.git` },
    type: "module",
    bin: { getmyprof: "cli.mjs" },
    engines: { node: ">=24" },
    os: ["darwin", "linux", "win32"],
    optionalDependencies: Object.fromEntries(
      platforms.map((p) => [`@anthropic-ai/claude-agent-sdk-${p}`, sdk]),
    ),
    getmyprof: { releases },
  };
  NodeFS.writeFileSync(NodePath.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  NodeFS.copyFileSync(
    NodePath.join(root, "packaging/npm/README.md"),
    NodePath.join(dir, "README.md"),
  );
  const out = NodePath.join(release, "npm");
  NodeFS.mkdirSync(out, { recursive: true });
  run("npm", ["pack", "--pack-destination", out], dir);
}

/** What a release publishes; electron-builder's debug files and folders stay out. */
const RELEASE_ASSET =
  /\.(tar\.gz|dmg|zip|blockmap|AppImage|deb|exe|msi)$|^latest.*\.yml$|^install\.(sh|ps1)$/;

/** SHA256SUMS over the release's assets, as install.sh and `getmyprof update` check them. */
function writeSums() {
  const files = NodeFS.readdirSync(release).filter((f) => RELEASE_ASSET.test(f));
  const lines = files.toSorted().map((f) => `${sha256(NodePath.join(release, f))}  ${f}`);
  NodeFS.writeFileSync(NodePath.join(release, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

/**
 * The Homebrew cask for this release, from packaging/ with the version and SHA256SUMS filled in,
 * into dist/publish for release.yml to push to the tap.
 */
function writeManifests() {
  const sums = new Map(
    NodeFS.readFileSync(NodePath.join(release, "SHA256SUMS"), "utf8")
      .trim()
      .split("\n")
      .map((line) => [line.slice(66), line.slice(0, 64)]),
  );
  const values: Record<string, string | undefined> = {
    version,
    sha256_dmg_arm64: sums.get(`getmyprof-${version}-arm64.dmg`),
    sha256_dmg_x64: sums.get(`getmyprof-${version}-x64.dmg`),
  };
  const cask = NodeFS.readFileSync(NodePath.join(root, "packaging/homebrew/getmyprof.rb"), "utf8");
  const text = cask.replace(/\{\{(\w+)\}\}/g, (token, key: string) => {
    // Homebrew has templates of its own ({{appdir}}); they stay for brew to fill in.
    if (!(key in values)) return token;
    const value = values[key];
    if (!value) throw new Error(`getmyprof.rb: no ${key} in SHA256SUMS`);
    return value;
  });
  const out = NodePath.join(root, "dist/publish");
  NodeFS.mkdirSync(out, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(out, "getmyprof.rb"), text);
}

const [step, ...args] = process.argv.slice(2);
const steps: Record<string, () => unknown> = {
  runtime: buildRuntime,
  cli: () => buildCli(args.length ? args : CLI_TARGETS),
  desktop: () => buildDesktop(args),
  npm: buildNpm,
  sums: writeSums,
  manifests: writeManifests,
  version: () => console.log(version),
};
const fn = step ? steps[step] : undefined;
if (!fn) {
  console.error(`pnpm dist <${Object.keys(steps).join("|")}>`);
  process.exit(1);
}
await fn();
