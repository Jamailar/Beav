# `src/features/capture/`

Clipboard and background capture UI for the open-source Electron app.

This feature mirrors the formal desktop capture boundary where possible, but the current Electron archive only exposes the YouTube local capture path. Xiaohongshu, Douyin, and server-side capture jobs should stay hidden until their backend adapters are migrated.
The renderer bridge exposes the formal server-capture method names as unavailable fallbacks only.

- `ClipboardCapturePrompt.tsx`: self-contained clipboard prompt shown by the app shell.
- `CaptureJobsBar.tsx`: low-noise capture queue indicator used by Knowledge. The Electron version follows the formal queue UI and also accepts the existing YouTube processing list.
- `captureQueue.ts`: local serial queue for confirmed YouTube clipboard capture tasks.
- `serverCaptureClient.ts`: formal server-capture client boundary. Electron currently receives unavailable fallbacks from the bridge, so server jobs stay hidden until backend adapters are migrated.
- `clipboardDetector.ts`, `clipboardUrlExtractor.ts`, `detectors/`: pure URL detection helpers. Xiaohongshu and Douyin detectors are present for parity but are not registered until their server capture adapters exist.
- `youtubeClipboard.ts`: compatibility wrapper around the detector registry for older YouTube-only callers.
- `captureDedupeStore.ts`: local prompt dedupe state.

Do not add platform download logic to detectors. Network capture should live behind a dedicated Electron bridge or existing knowledge IPC.
