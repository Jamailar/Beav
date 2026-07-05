# Capture Feature

Owns lightweight capture entry points initiated from the app shell.

- `ClipboardCapturePrompt.tsx`: user-facing prompt for detected clipboard captures.
- `useClipboardCapturePrompt.ts`: prompt state and app-shell wiring for clipboard capture.
- `clipboardDetector.ts`: detector registry that turns clipboard text into typed capture candidates.
- `clipboardUrlExtractor.ts`: bounded URL extraction and URL sanitization.
- `detectors/`: pure platform templates for YouTube, Xiaohongshu, Douyin, Bilibili, and TikTok URLs.
- `captureDedupeStore.ts`: short-lived duplicate suppression across paste and poll events.
- `captureQueue.ts`: local serial queue for confirmed capture tasks.
- `serverCaptureClient.ts`: server capture API contract boundary for creating, polling, and ingesting capture jobs.
- `youtubeClipboard.ts`: compatibility wrapper around the detector registry for older YouTube-only callers.

The app shell mounts the prompt, but does not parse clipboard text or call capture channels directly.
Platform download logic must stay behind `serverCaptureClient.ts` or existing knowledge IPC executors; URL detectors only normalize candidates and must not perform network requests.
