# FreeCut Vendoring Notes

RedBox vendors FreeCut timeline code directly under `src/vendor/freecut/**`.

## Source Of Truth

- Upstream local mirror: `/Users/Jam/LocalDev/GitHub/freecut`
- RedBox integration seam:
  - `src/components/manuscripts/VendoredFreecutTimeline.tsx`
  - `src/components/manuscripts/freecutTimelineBridge.ts`
  - `src/components/manuscripts/freecutTimelineCapabilities.ts`

## Update Rules

- Prefer copying upstream changes into `src/vendor/freecut/**` with minimal reshaping.
- Keep RedBox-specific behavior in the bridge, capability, and theme files above.
- Do not mix RedBox business logic into arbitrary vendored files unless the change is a narrow capability gate that cannot live at the seam.

## Phase 1 Boundaries

- Video workbench uses vendored FreeCut timeline as the primary timeline UI.
- Audio workbench still uses the legacy editable timeline.
- RedBox only commits to round-tripping:
  - media items
  - subtitle/text items
  - track UI state
  - markers
  - transitions
  - keyframes
- Compound clips / sub-compositions stay disabled in the RedBox video workbench until `EditorProjectFile` can persist them safely.
