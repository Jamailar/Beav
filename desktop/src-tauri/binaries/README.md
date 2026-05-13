# Bundled FFmpeg Binaries

Tauri bundles sidecar binaries from this directory through `bundle.externalBin`.

Current checked-in macOS arm64 binaries are FFmpeg 8.1 static Apple Silicon builds from OSXExperts:

- `ffmpeg-aarch64-apple-darwin`
  - source: `https://www.osxexperts.net/ffmpeg81arm.zip`
  - sha256: `9a08d61f9328e8164ba560ee7a79958e357307fcfeea6fe626b7d66cdc287028`
- `ffprobe-aarch64-apple-darwin`
  - source: `https://www.osxexperts.net/ffprobe81arm.zip`
  - sha256: `aab17ac7379c1178aaf400c3ef36cdb67db0b75b1a23eeef2cb9f658be8844e6`

They are resolved by `src/ffmpeg_runtime.rs`. Runtime code must call that resolver instead of invoking `"ffmpeg"` directly, so video thumbnails, media editing, transcription audio extraction, voice sample transcoding, and RedClaw rough cuts all use the same fixed app binary first and only fall back to `PATH` in development.

Release packaging should add equivalent reviewed binaries for each packaged target triple before enabling that platform.

Current checked-in Windows x64 binaries are FFmpeg 8.1.1 essentials builds from Gyan.dev:

- `ffmpeg-x86_64-pc-windows-msvc.exe`
  - archive source: `https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.1-essentials_build.7z`
  - archive sha256: `23ad8969fbe701d44e6e7e2b97c5fae4a71224fc33a2560a9034e5110d029d15`
  - binary sha256: `228d7a8556258de907fdb55f36850078ebc7680b84ec30d84ea02e99bec1d1eb`
- `ffprobe-x86_64-pc-windows-msvc.exe`
  - archive source: `https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.1-essentials_build.7z`
  - archive sha256: `23ad8969fbe701d44e6e7e2b97c5fae4a71224fc33a2560a9034e5110d029d15`
  - binary sha256: `0fde260f5abd35c9cafd96f594cc76365a780c1b73a90e35b6a3409ea1db1bf0`

The Windows build license and upstream README are kept beside the binaries:

- `FFMPEG-WINDOWS-LICENSE.txt`
- `FFMPEG-WINDOWS-README.txt`
