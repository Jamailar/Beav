# Hybrid Release (Local macOS + Remote Linux for Windows)

This folder provides a repeatable release pipeline without GitHub-hosted build minutes.

## Flow

1. Build Windows package on remote Linux host over SSH (`jamdebian` by default)
2. Build macOS package on local Mac
3. Upload all artifacts to `Jamailar/RedBox` release
4. Git tag + push (trigger cloud sync workflow for open-source mirror)

Release notes are auto-populated from `README.md` changelog section matching the tag (fallback: recent git commits).

Artifacts location:
- macOS: `desktop/release/`
- remote Windows: `artifacts/win-remote/`

## One-time setup

### 1) Remote Linux host

```bash
ssh jamdebian
bash ~/path/to/RedConvert/scripts/hybrid-release/remote-setup.sh
```

Then login once for release upload capability:

```bash
gh auth login
```

### 2) Local Mac

- Ensure `pnpm`, `gh`, Xcode command line tools are installed
- Ensure SSH alias works: `ssh jamdebian`
- Ensure Apple Developer signing certificate is installed in login keychain
- For full notarized release, configure one of these notarization auth methods:

```bash
# Option A: keychain profile (recommended)
xcrun notarytool store-credentials REDBOX \
  --apple-id "<apple-id>" \
  --team-id "N9KF8X5S99" \
  --password "<app-specific-password>"

export APPLE_KEYCHAIN_PROFILE=REDBOX
```

Or use the helper script in this repo:

```bash
bash private/scripts/hybrid-release/setup-notary-profile.sh
export APPLE_KEYCHAIN_PROFILE=REDBOX
```

```bash
# Option B: Apple ID + app-specific password
export APPLE_ID="<apple-id>"
export APPLE_APP_SPECIFIC_PASSWORD="<app-specific-password>"
export APPLE_TEAM_ID="N9KF8X5S99"
```

```bash
# Option C: App Store Connect API key
export APPLE_API_KEY="/absolute/path/AuthKey_XXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXX"
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

## Usage

Run from repository root:

```bash
bash scripts/hybrid-release/publish-hybrid.sh v1.7.6
```

or shorter:

```bash
bash scripts/release-all.sh v1.7.6
```

Optional env vars:

- `REDBOX_REMOTE_HOST` (default: `jamdebian`)
- `REDBOX_REMOTE_WORKDIR` (default: `/home/jam/build/redconvert-release`)
- `REDBOX_PUBLIC_REPO` (default: `Jamailar/RedBox`)
- `REDBOX_RELEASE_NOTES_FILE` (optional: use custom notes file instead of README extraction)
- `REDBOX_SKIP_WIN=1` (skip remote win build)
- `REDBOX_SKIP_MAC=1` (skip local mac build)
- `REDBOX_MAC_MODE=signed|full|nosign` (local mac build mode; release pipeline defaults to `full`)
- `REDBOX_SYNC_PUBLIC=1` (after release upload, rely on the GitHub Actions sync workflow to update the public mirror after push)
- `REDBOX_GIT_PUSH=0` (disable final git tag/push step)

## Individual commands

```bash
bash scripts/hybrid-release/build-win-on-remote.sh
bash scripts/hybrid-release/build-mac-local.sh
bash scripts/hybrid-release/upload-release.sh v1.7.6
push 当前分支和 tag 后，由 `.github/workflows/sync-public-assets.yml` 自动同步公开镜像
```

Examples:

```bash
# Local signed test build
REDBOX_MAC_MODE=signed bash scripts/hybrid-release/build-mac-local.sh

# Local full notarized build
APPLE_KEYCHAIN_PROFILE=REDBOX REDBOX_MAC_MODE=full bash scripts/hybrid-release/build-mac-local.sh
```
