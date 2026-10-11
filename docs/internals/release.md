# Releases

One version, in the root `package.json`. A `vX.Y.Z` tag runs `.github/workflows/release.yml`,
which builds everything and publishes it as this repo's GitHub release, with the workflow's own
token. Installed apps and `getmyprof update` look there.

## What ships

| Asset                                                         | Who uses it                                                                                          | Updates                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `getmyprof-X.Y.Z-{darwin,linux}-{arm64,x64}.tar.gz`           | `install.sh`: the `getmyprof` command, with its own Node 24                                          | `getmyprof update` runs the release's install.sh  |
| `getmyprof-X.Y.Z-{arm64,x64}.dmg` and `.zip`                  | the Mac app; the cask; the zip is Squirrel's                                                         | Update runs the release's install.sh over it      |
| `getmyprof-X.Y.Z-{x86_64,arm64}.AppImage`                     | `install.sh --desktop` on Linux                                                                      | downloads and replaces itself                     |
| `getmyprof_X.Y.Z_{amd64,arm64}.deb`                           | `apt install`                                                                                        | a notice; the package manager installs            |
| `getmyprof-X.Y.Z-win32-{x64,arm64}.zip`                       | `install.ps1`: the `getmyprof` command on Windows, with its own Node                                 | `getmyprof update` runs the release's install.ps1 |
| `getmyprof-X.Y.Z-x64-setup.exe`                               | the Windows app, installed per user                                                                  | downloads and replaces itself                     |
| `getmyprof-X.Y.Z-x64.msi`                                     | the Windows app for managed installs                                                                 | a notice; install the new .msi                    |
| `latest-mac.yml`, `latest-linux*.yml`, `latest.yml` (Windows) | electron-updater's feed                                                                              |                                                   |
| `SHA256SUMS`                                                  | the installers and `getmyprof update` check every download against it                                |                                                   |
| `install.sh`                                                  | `curl -fsSL https://github.com/EhsanulHaqueSiam/getmyprof/releases/latest/download/install.sh \| sh` | always the latest release's                       |
| `install.ps1`                                                 | `irm https://github.com/EhsanulHaqueSiam/getmyprof/releases/latest/download/install.ps1 \| iex`      | always the latest release's                       |

The npm package `getmyprof` (`npx getmyprof@latest`, its page's README is `packaging/npm/README.md`)
and the Homebrew cask are built every release and published only when their secret is set. There
is no AUR package; Arch runs the AppImage. The Windows app is x64 only (Windows on Arm runs it
emulated); its command line has an arm64 zip.

## How the pieces run

- `pnpm dist runtime` bundles `apps/server/src/bin.ts` and `cli.ts` with `vp pack` into
  `apps/desktop/dist/runtime` beside the built web app. The server serves `web/` itself when
  `GETMYPROF_WEB_DIR` is set (`apps/server/src/static.ts`); dev doesn't set it.
- The desktop app runs that server on Electron's own Node (`ELECTRON_RUN_AS_NODE`, Node 24.21
  in Electron 44, with `node:sqlite` and FTS5). The CLI tarball ships the official Node 24.21.
- **No download carries the Claude Code binary**: its license reserves redistribution.
  `apps/server/src/agent/binary.ts` uses the SDK's own platform package when node_modules has it
  (dev, npm installs), else fetches `@anthropic-ai/claude-agent-sdk-<os>-<arch>` at the version
  `pnpm dist runtime` pins from registry.npmjs.org into `GETMYPROF_HOME/claude/<version>`,
  checked against the registry's sha512. The CLI does that on its first run with a progress
  line; the server starts it at boot and Setup's Connect step shows the percent, or the error
  with a Download button. When it can't be fetched, a `claude` on PATH stands in. Sign-in runs
  that binary's own `auth login`: `getmyprof login`, or Setup's Sign in (browser, or a pasted code).
- One server per `GETMYPROF_HOME`: the launcher records it in `server.json` with the process
  that answers for it, and the desktop app and the CLI open a running one instead of starting a
  second (two would both run loops and the send queue). A server whose app crashed is adopted by
  the next app launch (which stops it on quit) and can be stopped with `getmyprof stop`. Port
  4350 when free, so the page's origin and its localStorage stay put.
- The app's Electron profile and its one-instance lock live in `GETMYPROF_HOME/desktop`, so a run
  on a temp home never touches a real install's.
- On Linux the command line is `getmyprof` and the app is `getmyprof-desktop`.
- On Windows, install.ps1 unpacks each version under `%LOCALAPPDATA%\getmyprof\<version>` and
  writes `bin\getmyprof.cmd` (on the user's PATH) pointing at it, so an update never overwrites the
  `node.exe` a running server holds open. The setup .exe installs per user under
  `%LOCALAPPDATA%\Programs`; the uninstaller beside the app is how `updates.ts` tells it from an
  .msi install.

## Cutting a release

`pnpm release minor` (or `patch`, `major`, `X.Y.Z`; `--dry-run` shows the plan, `--watch` follows
the build) does it from any checkout with a clean tree: a `chore/release-X.Y.Z` branch from
`origin/main` bumps the root `package.json`, its PR waits for CI and squash-merges, and
`origin/main` gets the `vX.Y.Z` tag, which runs the workflow. The workflow fails if the tag and
the version differ. `pnpm release status` shows main's version, the last tag, what main holds since
and that tag's run; `pnpm release watch [X.Y.Z]` follows a run. The release's notes are the
install link and GitHub's list of PRs merged since the previous tag, so PR titles are the changelog.

A PR that changes the release build (release.yml lists the paths) runs the whole workflow except
publish. Its Windows job installs every Windows download on a Windows runner and starts it, since
nobody tests on Windows by hand.

`pnpm release build` builds this machine's command line and desktop app into `dist/release`, no
publishing. Other platforms and the npm package use the same steps: `pnpm dist runtime`, then
`pnpm dist cli darwin-arm64` (Windows zips need `zip` and `unzip`), `pnpm dist desktop mac arm64`
(`win x64` only on Windows), `pnpm dist npm`, `pnpm dist sums` into `dist/release`. `GETMYPROF_UPDATE_URL=http://host/feed` points a test build's updater at
any folder holding a `latest-*.yml`. From a checkout, `pnpm dist runtime` then
`pnpm --filter @getmyprof/desktop start` runs the app unpackaged.

## Secrets (Settings, Secrets and variables, Actions)

The release itself needs none. Each secret below turns on one more channel.

| Secret                                                  | What                                                                          | Without it                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------- |
| `HOMEBREW_TAP_KEY`                                      | private half of a write deploy key on `EhsanulHaqueSiam/homebrew-tap`         | the cask stays in the run artifact |
| `NPM_TOKEN`                                             | npm token that can publish `getmyprof`                                        | the package stays in the artifact  |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                          | Developer ID Application certificate as base64 `.p12`, and its password       | ad-hoc signed Mac app              |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect API key (`.p8` contents), its id and issuer, for notarizing | not notarized                      |

A channel that failed or was skipped (say `NPM_TOKEN` was added after the tag) comes back with "Re-run all jobs" on that release's run: the published release and
an unchanged cask are left alone. A rerun uses the workflow as it was at the tag.

## Traps

- **An unsigned Mac app.** Squirrel.Mac only installs updates into a Developer ID signed app, so
  `apps/desktop/src/updates.ts` checks the signature, and an unsigned app's Update runs the
  release's install.sh (checked against SHA256SUMS) with `--desktop` over its own bundle, then
  restarts. Gatekeeper blocks an ad-hoc app downloaded in a browser; curl (install.sh) sets no
  quarantine and the cask strips it. With a browser download:
  `xattr -dr com.apple.quarantine /Applications/getmyprof.app`.
- **An unsigned Windows app.** SmartScreen says "Windows protected your PC" the first time the
  setup .exe or .msi runs: More info, then Run anyway. A code-signing certificate would end that;
  none is set up. electron-updater installs unsigned updates, since the app names no publisher.
- **Testing an update.** Build with `GETMYPROF_UPDATE_URL=http://127.0.0.1:<port>/feed`, serve a
  folder whose `feed/latest-mac.yml` names a higher version and whose
  `releases/download/v<that>/` holds its dmg, install.sh and SHA256SUMS, and start the app's
  binary with `GETMYPROF_RELEASE_URL=http://127.0.0.1:<port>/releases` and a temp `GETMYPROF_HOME`.
- **The first run needs the network** for the Claude Code binary (about 100 MB to download).
  Offline with no `claude` on PATH, the app and the CLI still start and say why the agent can't.
- **Ubuntu 24.04 and AppImages.** Its AppArmor blocks Chromium's sandbox in any AppImage; the
  `.deb` ships a setuid sandbox and works. Arch is fine.
- **`ELECTRON_RUN_AS_NODE` in your shell** (some terminals inside Electron apps set it) makes
  the packaged app start as plain Node. Unset it to launch from there.
