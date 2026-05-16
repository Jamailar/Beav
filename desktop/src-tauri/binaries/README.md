# Bundled FFmpeg Binaries

Tauri bundles sidecar binaries from this directory through `bundle.externalBin`.

Current checked-in macOS arm64 binaries are FFmpeg 8.1 static Apple Silicon builds from OSXExperts:

- `ffmpeg-aarch64-apple-darwin`
  - source: `https://www.osxexperts.net/ffmpeg81arm.zip`
  - sha256: `9a08d61f9328e8164ba560ee7a79958e357307fcfeea6fe626b7d66cdc287028`
- `ffprobe-aarch64-apple-darwin`
  - source: `https://www.osxexperts.net/ffprobe81arm.zip`
  - sha256: `aab17ac7379c1178aaf400c3ef36cdb67db0b75b1a23eeef2cb9f658be8844e6`

Current checked-in macOS x64 binaries are FFmpeg 8.0 static Intel builds from OSXExperts:

- `ffmpeg-x86_64-apple-darwin`
  - source: `https://www.osxexperts.net/ffmpeg80intel.zip`
  - sha256: `df3f1e3facdc1ae0ad0bd898cdfb072fbc9641bf47b11f172844525a05db8d11`
- `ffprobe-x86_64-apple-darwin`
  - source: `https://www.osxexperts.net/ffprobe80intel.zip`
  - sha256: `5228e651e2bd67bb55819b27f6138351587b16d2b87446007bf35b7cf930d891`

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

Current checked-in Windows arm64 binaries are FFmpeg 8.1 GPL builds from BtbN:

- `ffmpeg-aarch64-pc-windows-msvc.exe`
  - archive source: `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-05-15-13-34/ffmpeg-n8.1.1-2-gfb216b5fac-winarm64-gpl-8.1.zip`
  - archive sha256: `adb8d1e22b2b23a68daa048ccfdbc0f01913f575709ec4ec5f06204343b790db`
  - binary sha256: `f24df5aa40c182bfa58d996b86e79eb78cc8995d374d3e079f9a89154b1d6fcc`
- `ffprobe-aarch64-pc-windows-msvc.exe`
  - archive source: `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-05-15-13-34/ffmpeg-n8.1.1-2-gfb216b5fac-winarm64-gpl-8.1.zip`
  - archive sha256: `adb8d1e22b2b23a68daa048ccfdbc0f01913f575709ec4ec5f06204343b790db`
  - binary sha256: `8e21555763024d0f6d714a4523e4a12e34933b713dd59443be77a4ca2d3aff2a`

Current checked-in Windows x86 binaries are FFmpeg GPL builds from sudo-nautilus:

- `ffmpeg-i686-pc-windows-msvc.exe`
  - archive source: `https://github.com/sudo-nautilus/FFmpeg-Builds-Win32/releases/download/latest/ffmpeg-master-latest-win32-gpl.zip`
  - archive sha256: `ed6fa7ba825f418bd56a9fd0b22f5869c1345096d04eb920e02e10dcd88de1b9`
  - binary sha256: `8b5f89884a2e26e348dde66cd11bed4ea7fcc37eaeeb3fe99992698ef727a2e0`
- `ffprobe-i686-pc-windows-msvc.exe`
  - archive source: `https://github.com/sudo-nautilus/FFmpeg-Builds-Win32/releases/download/latest/ffmpeg-master-latest-win32-gpl.zip`
  - archive sha256: `ed6fa7ba825f418bd56a9fd0b22f5869c1345096d04eb920e02e10dcd88de1b9`
  - binary sha256: `1211aa66a68ecbe68058840671b262f6b1f5e5438a5c1ba5f70fa6b91af129ad`

The Windows build license and upstream README are kept beside the binaries:

- `FFMPEG-WINDOWS-LICENSE.txt`
- `FFMPEG-WINDOWS-README.txt`
