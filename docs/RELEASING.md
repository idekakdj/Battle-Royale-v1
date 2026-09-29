# Releasing Gladiator Kingdom

Gladiator Kingdom ships two ways from the same `dist/` build:

- **Browser** — every push to `main` deploys to GitHub Pages (`.github/workflows/deploy.yml`).
- **Windows desktop app** — every pushed `vX.Y.Z` tag builds a versioned installer and a
  portable zip and publishes them as a GitHub Release (`.github/workflows/release.yml`).

## Single sources of truth

| What | Where | Used by |
| --- | --- | --- |
| Version number | `package.json` → `version` | Vite `define` → `__APP_VERSION__` (lobby footer, Version History badge), Electron `app.getVersion()`, installer/zip file names, exe file version |
| Version history | `CHANGELOG.md` ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)) | In-game **Version History / What's New** panel, GitHub Release body (`npm run release:notes`) |

Rules for `CHANGELOG.md`: newest version first; one `## [x.y.z] - YYYY-MM-DD` heading per
release; bullets grouped under `### Added`, `### Changed`, `### Fixed` (optionally `### Removed`);
keep an empty `## [Unreleased]` block on top for work in progress. The parser
(`src/version/changelog.ts`, tested in `tests/version/`) ignores HTML comments and link
references, and a test fails if the `package.json` version has no dated, non-empty entry.

## Cutting a release (step by step)

1. **Changelog.** In `CHANGELOG.md`, move the bullets from `## [Unreleased]` under a new heading
   `## [1.1.0] - 2026-10-01` (today's date), directly below an empty `## [Unreleased]`. Update the
   link references at the bottom (`[Unreleased]: …compare/v1.1.0...HEAD`, `[1.1.0]: …/releases/tag/v1.1.0`).
2. **Version.** Bump `package.json` (this also updates `package-lock.json`):
   ```bash
   npm version 1.1.0 --no-git-tag-version
   ```
3. **Verify locally.**
   ```bash
   npm run typecheck && npm test && npm run build
   npm run release:notes          # prints the 1.1.0 section — must not be empty
   npm run dist                   # optional: build the installer locally → release/
   npm run desktop:smoke          # optional: boots release/win-unpacked with --smoke-test
   ```
4. **Commit** the changelog + version bump: `git commit -am "Release v1.1.0"` and push `main`
   (this also redeploys the browser build).
5. **Tag and push the tag:**
   ```bash
   git tag v1.1.0
   git push origin v1.1.0
   ```
6. The **Release desktop app** workflow (Actions tab, `windows-latest`, Node 22) checks that the tag
   matches `package.json`, typechecks, runs the tests, builds with `npm run dist`, smoke-tests the
   packaged exe, and creates the GitHub Release **"Gladiator Kingdom v1.1.0"** with the changelog
   section as its notes and these assets attached:
   - `Gladiator-Kingdom-Setup-1.1.0.exe` — installer
   - `Gladiator-Kingdom-1.1.0-win-x64.zip` — portable build (unzip, run `Gladiator Kingdom.exe`)

   Tags containing a `-` (e.g. `v1.2.0-beta.1`) are published as pre-releases, which the in-game
   update check ignores.

## Where versions live (version history)

- **Every past version stays downloadable** at
  <https://github.com/idekakdj/Battle-Royale-v1/releases> — each release keeps its own installer,
  zip and notes. Never delete or re-use a tag; ship a new patch version instead.
- **In game**, the lobby footer shows the running version and a **What's New** button that opens the
  full version history (all changelog entries, newest first, current version badged). After an
  update the panel opens automatically once (tracked in `localStorage['gk-last-seen-version']`).
- The panel's "All releases & downloads" link opens the Releases page.

## Update notifications (notify-only)

A few seconds after launch the packaged desktop app makes one request to
`https://api.github.com/repos/idekakdj/Battle-Royale-v1/releases/latest` (main process, 5 s timeout,
silent when offline, rate-limited, or when no release exists yet). If that release's tag is a newer
semver than the running version, the lobby shows **"Update vX.Y.Z available — Download"**, which
opens the release page in the browser. Nothing is downloaded or installed automatically. Players can
turn the check off under **Settings → Desktop → Check for updates at launch**
(`gk-settings.checkUpdates`). The browser build never checks. For a local test against the real
endpoint in an unpackaged build (PowerShell): `$env:GK_UPDATE_CHECK="force"; npm run desktop`.

Note: the check can only see releases of a **public** repository.

## Installing, updating and uninstalling (players)

- **Install:** download `Gladiator-Kingdom-Setup-<version>.exe` from the Releases page and run it.
  It installs per user (no administrator prompt) — by default to
  `%LOCALAPPDATA%\Programs\Gladiator Kingdom` — lets you choose another folder, and creates Desktop and
  Start Menu shortcuts.
- **Portable:** unzip `Gladiator-Kingdom-<version>-win-x64.zip` anywhere and run `Gladiator Kingdom.exe`.
- **Update:** run the newer installer over the existing install (same folder). Settings, selected
  gladiator, difficulty and window position live in `%APPDATA%\Gladiator Kingdom` and are kept.
- **Uninstall:** Windows Settings → Apps → Installed apps → *Gladiator Kingdom* → Uninstall (or the
  uninstaller in the install folder). Player data in `%APPDATA%\Gladiator Kingdom` is kept by default;
  delete that folder manually for a clean slate.
- **Controls in the desktop app:** F11 (or Alt+Enter) toggles fullscreen; Esc still pauses the game;
  the lobby has a **Quit** button.

## Unsigned installers and SmartScreen

The installers are **not code-signed**. On first run Windows SmartScreen shows
*"Windows protected your PC"*; players click **More info → Run anyway**. Browsers may also flag the
download as uncommon. This is expected for unsigned apps and fades as a signed publisher builds
reputation.

### Adding a code-signing certificate later

electron-builder signs automatically when certificate environment variables are present:

- `WIN_CSC_LINK` (or `CSC_LINK`) — path, https URL, or base64 of a `.pfx`/`.p12` certificate
- `WIN_CSC_KEY_PASSWORD` (or `CSC_KEY_PASSWORD`) — its password

In CI, add repository secrets `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`
(Settings → Secrets and variables → Actions); `release.yml` already passes them to `npm run dist`.
Locally: `$env:WIN_CSC_LINK="C:\certs\gk.pfx"; $env:WIN_CSC_KEY_PASSWORD="…"; npm run dist`.
For cloud HSM / Azure Trusted Signing, see electron-builder's `win.azureSignOptions` /
`win.signtoolOptions`. An EV certificate (or Trusted Signing) gives immediate SmartScreen reputation.

## Build notes and troubleshooting

- `npm run dist` = `vite build` + `scripts/dist.mjs`, which runs electron-builder with
  `electronDist` pointed at the Electron that `npm run desktop` already uses
  (`node_modules/electron/dist`, downloaded on first use). This sidesteps an EPERM failure when
  electron-builder renames its extraction folder inside OneDrive-synced / antivirus-scanned folders.
  Output goes to `release/` (git-ignored); `release/win-unpacked/` is the unpacked app.
- Icons are generated, not drawn: `npm run icons` rewrites `build/icon.png` and `build/icon.ico`
  from `scripts/make-icons.mjs`. Commit the results.
- **winCodeSign "A required privilege is not held by the client":** older electron-builder versions
  fail to extract the winCodeSign archive (it contains macOS symlinks) without symlink privilege.
  electron-builder 26 tolerates it. If it ever returns, do **not** change system settings — set
  `"signAndEditExecutable": false` under `build.win` in `package.json`; the `afterPack` hook
  (`scripts/after-pack.cjs`) then stamps the icon and version resources onto the exe with `rcedit`
  instead. (Signing requires `signAndEditExecutable` to stay enabled.)
- Only `dist/**` (without source maps), `electron/**` and `package.json` are packaged, in an asar
  archive. `three` is a devDependency on purpose: it is bundled into `dist/` by Vite, so the app
  needs no `node_modules` at runtime.
- The desktop shell (`electron/main.cjs`) serves `dist/` over a private `app://gk/` protocol with a
  strict Content-Security-Policy, context isolation, the renderer sandbox and no Node access; its
  `--smoke-test` flag boots the app hidden with a throwaway profile, checks the lobby, the version,
  the preload bridge, the Version History panel and Esc handling, starts a match, and exits 0.
