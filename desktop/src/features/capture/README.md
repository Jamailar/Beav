# Capture Feature

Owns lightweight capture entry points initiated from the app shell.

- `ClipboardCapturePrompt.tsx`: user-facing prompt for detected clipboard captures.
- `useClipboardCapturePrompt.ts`: clipboard polling, YouTube URL parsing, duplicate suppression, and save orchestration.

The app shell mounts the prompt, but does not parse clipboard text or call capture channels directly.
