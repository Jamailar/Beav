# Capture Feature

Owns lightweight capture entry points initiated from the app shell.

- `ClipboardCapturePrompt.tsx`: user-facing prompt for detected clipboard captures.
- `useClipboardCapturePrompt.ts`: clipboard polling, duplicate suppression, prompt state, and save orchestration.
- `youtubeClipboard.ts`: pure YouTube clipboard URL parsing and candidate normalization.

The app shell mounts the prompt, but does not parse clipboard text or call capture channels directly.
