---
doc_type: plan
execution_status: in_progress
last_updated: 2026-05-16
owner: product-engineering
scope: desktop
source_of_truth: false
related_docs:
  - desktop/docs/app-optimization-roadmap.md
  - desktop/docs/ipc-optimization-plan.md
  - desktop/docs/runtime-optimization-test-plan.md
---

# UI Jank Performance Audit Plan

## Conclusion

RedConvert 的 UI 卡顿不应先归因成 Tauri WebView 的硬伤。当前技术架构的主要风险来自 `React renderer`、`Tauri IPC event fanout`、`AI/runtime token stream`、`media job updates`、`large media grids` 和 `markdown rendering` 叠加在同一个 WebView 主线程上。

WebView 是约束，不是根因。最优解是继续保留 `Tauri + React + Rust`，把高频事件、重媒体处理、列表渲染和页面刷新策略治理掉。只有在 profiler 证明某个特定视图的 paint/composite 已经超过 WebView 能力边界时，才考虑局部原生化或 canvas/WebGL。

## External Findings

| Area | External consensus | RedConvert implication |
| --- | --- | --- |
| Tauri process model | Tauri UI runs in the platform WebView, while privileged/heavy work belongs in Rust Core. | 文件扫描、媒体处理、缩略图、AI runtime、数据库聚合继续放 Rust，不让 renderer 承担重计算。 |
| Tauri IPC | IPC is async message passing with serialization overhead. | 高频 `runtime:event`、`generation:job-updated`、`generation:job-log` 需要合批、限频、patch 化。 |
| Web main thread | Long tasks above 50ms cause visible interaction delay. | markdown parse、large JSON normalize、media list layout、message append 都要减少主线程占用。 |
| React rendering | Frequent state updates and unstable subscriptions cause repeated commits. | token/log/progress 不应每个 chunk 都直接 `setMessages` 或刷新整页数据。 |
| Large DOM | Long lists should be virtualized. | chat messages、media grid、knowledge/subject assets、runtime logs 应使用现成 virtual list。 |
| Media rendering | Images/videos should lazy load, async decode, and use cached thumbnails/posters. | 素材库和选题素材列表不能直接把大量原图/video metadata 同时挂进 DOM。 |

References:

- https://v2.tauri.app/concept/process-model/
- https://v2.tauri.app/concept/inter-process-communication/
- https://web.dev/articles/optimize-long-tasks
- https://web.dev/articles/optimize-inp
- https://react.dev/reference/react/Profiler
- https://web.dev/articles/virtualize-long-lists-react-window
- https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing
- https://web.dev/learn/performance/image-performance
- https://web.dev/learn/performance/video-performance

## Current Architecture Risk Map

### P0: Runtime event stream drives too many UI updates

Evidence:

- `desktop/src-tauri/src/events/mod.rs` emits every unified runtime event to `runtime:event`, then also logs and emits legacy chat compatibility events.
- `desktop/src/runtime/runtimeEventStream.ts` normalizes every envelope in renderer and dispatches token/log/tool callbacks synchronously.
- `desktop/src/pages/Chat.tsx` subscribes to `runtime:event` and routes `runtime:text-delta` into `handleThoughtDelta` / `handleResponseChunk`.
- `handleResponseChunk`, `handleThoughtDelta`, and `handleCliExecutionLog` each call `setMessages`, copying message arrays and timeline arrays.
- `desktop/src/components/chat/StreamingMarkdown.tsx` reparses the current content through `ReactMarkdown` whenever streaming content changes.

Risk:

- Token-level updates can trigger full chat message list reconciliation.
- Markdown is reparsed on streaming content changes.
- CLI output chunks can mutate timeline previews at log frequency.
- Legacy compatibility events may duplicate renderer work for old listeners.

Recommended fix:

1. Add a renderer-side stream buffer for chat deltas.
2. Flush response/thought/CLI log deltas on `requestAnimationFrame` or a 50ms timer.
3. Keep a single pending message draft in refs, then commit batched state.
4. Render streaming markdown in a cheaper streaming mode until finalization, then run full `ReactMarkdown`.
5. Add event counters in dev mode: event type, session id, payload byte size, handler count, flush count.

Must use existing library:

- React Profiler / Chrome Performance for proof.

Can self-build:

- Runtime event batching and patch protocol, because it is RedConvert-specific.

### P0: Chat history is not virtualized

Evidence:

- `desktop/src/pages/Chat.tsx` renders `messages.map(...)` directly.
- Every message is wrapped in `ErrorBoundary` and `MessageItem`.
- `MessageItem` can include markdown, attachments, preview cards, timelines, images, video blocks, process timelines, todo lists, and copy controls.

Risk:

- Long sessions pay DOM, layout, and markdown cost for offscreen messages.
- Token streaming into the last message can still force reconciliation over the whole mapped list.

Recommended fix:

1. Add `@tanstack/react-virtual` or `react-virtuoso`.
2. Preserve bottom-stick scrolling and manual scrollback behavior.
3. Keep the streaming message mounted and visible; virtualize older messages first.
4. Measure before/after with a 200-message transcript and a streaming response.

Must use existing library:

- Use `@tanstack/react-virtual` or `react-virtuoso`; do not self-build virtual scrolling.

### P0: Media job store updates are too broad

Evidence:

- `desktop/src/features/media-jobs/useMediaJobSubscription.ts` listens to global `generation:job-updated` and `generation:job-log`.
- `desktop/src/features/media-jobs/useMediaJobsStore.ts` stores all jobs in one `jobsById` object and all logs in one `logsByJobId` object.
- Generation Studio, RedClaw, Manuscript Editor, and Subjects subscribe to `state.jobsById`.
- Any job update replaces `jobsById`, so every subscriber selecting all jobs sees a new object.
- Rust `emit_job_updated` sends a full job projection, not a small patch or revision.

Risk:

- One media job progress update can re-render unrelated pages/components that only care about a subset.
- Log updates are capped to 50, but still notify all listeners.

Recommended fix:

1. Add selector-level subscriptions: `useMediaJob(jobId)`, `useMediaJobs(jobIds)`, `useMediaJobLogs(jobId)`.
2. Do not expose all `jobsById` to pages unless the page is a dashboard.
3. Change Rust event shape to `{ jobId, revision, changedFields }` for high-frequency updates, with `getJob(jobId)` as snapshot recovery.
4. Batch multiple job/log events in renderer before notifying subscribers.

Must use existing library:

- `useSyncExternalStore` is fine, but selectors need equality and narrow snapshots. Zustand is already installed and is also acceptable.

Can self-build:

- Job revision/patch protocol and media queue truth model.

### P1: Media and subject grids are not virtualized and are inconsistent about lazy loading

Evidence:

- `desktop/src/pages/MediaLibrary.tsx` renders masonry/grid cards directly and measures cards with `requestAnimationFrame`.
- Some media images lack `loading="lazy"` and `decoding="async"`.
- `desktop/src/pages/Subjects.tsx` renders videos with `preload="metadata"` in grids/lists.
- `desktop/src/pages/Knowledge.tsx` already uses lazy/async image loading in some visual preview areas, proving this pattern exists locally.

Risk:

- Large media libraries decode many images and video metadata at once.
- Masonry measurement can cascade layout work.
- Video nodes in grids are heavier than poster images.

Recommended fix:

1. Use cached Rust-generated thumbnails/posters for all media cards.
2. Add `loading="lazy"` and `decoding="async"` to card images.
3. Replace grid/list direct maps with virtualized rows or sections.
4. Do not render `<video>` in dense grids; render poster images and open video only in preview overlay.

Must use existing library:

- Virtual list/grid library.
- ffmpeg or existing media runtime for poster generation.

Can self-build:

- Thumbnail cache keys, invalidation, and media metadata revision.

### P1: Foreground refresh and focus hooks can still cause unnecessary work

Evidence:

- `desktop/src/hooks/usePageRefresh.ts` attaches focus, visibility, `space:changed`, `settings:updated`, and `data:changed` listeners per active page.
- The hook debounces, but many pages can still issue full refreshes when becoming active or foregrounded.
- `desktop/src/App.tsx` still contains clipboard polling through `clipboard:read-text`, though it now uses backoff and paste handling.
- `desktop/src/pages/Settings.tsx` has runtime observability listeners plus polling when developer tooling tabs are active.

Risk:

- Foregrounding the app can trigger multiple IPC reads and page refreshes together.
- Developer/tooling pages can amplify runtime event traffic during AI runs.

Recommended fix:

1. Add a foreground refresh coordinator so only visible active surfaces refresh.
2. Make `usePageRefresh` accept stable typed scopes and return refresh diagnostics.
3. Add slow refresh logs for calls over 100ms and grouped foreground refresh traces.
4. Keep clipboard detection event-driven first; polling should remain low-frequency and disabled outside eligible views if possible.

Can self-build:

- Refresh coordinator and diagnostics.

### P1: Sidebar resizing still commits full layout state every animation frame

Evidence:

- `desktop/src/components/Layout.tsx` uses `requestAnimationFrame` during sidebar pointer move and persists width with a delayed localStorage write.
- This is better than raw pointermove state writes, but each frame still updates `sidebarWidth` on the top-level `Layout`, causing the shell and children to reconcile.

Risk:

- During resize, a heavy active page can re-render along with the shell.

Recommended fix:

1. During drag, update a CSS custom property on the sidebar/root element imperatively.
2. Commit React state only on pointerup.
3. Keep localStorage persistence after commit.

Can self-build:

- This is simple shell-level behavior and should stay local.

## Recommended Execution Order

### Step 1: Instrument before broad changes

Add dev-only counters:

- `runtime:event` count by `eventType`
- average payload size
- media job event count
- foreground refresh count
- React commit duration around Chat, Generation Studio, Media Library, Layout

Acceptance:

- A single AI response produces visible event counts.
- A media generation job shows update/log frequency.
- A 200-message chat transcript profile has before numbers.

### Step 2: Batch runtime stream updates

Scope:

- `desktop/src/pages/Chat.tsx`
- `desktop/src/runtime/runtimeEventStream.ts` only if needed

Acceptance:

- Streaming response still appears live.
- UI commits no more than roughly 20 per second for text deltas.
- Tool confirmation and error events remain immediate.

### Step 3: Narrow media job subscriptions

Scope:

- `desktop/src/features/media-jobs/useMediaJobsStore.ts`
- `desktop/src/features/media-jobs/useMediaJobSubscription.ts`
- active consumers in `GenerationStudio`, `RedClaw`, `Subjects`, `ManuscriptEditorHost`

Acceptance:

- Updating one job does not re-render consumers unrelated to that job.
- Logs update only panels that display that job's logs.

### Step 4: Virtualize chat and media surfaces

Scope:

- Chat message list first.
- Media Library / Subjects second.

Acceptance:

- 200+ messages remain scrollable without long commits.
- 500+ media assets do not mount 500 image/video nodes.

### Step 5: Media preview hygiene

Scope:

- Media card images/videos across `MediaLibrary`, `Subjects`, `Knowledge`, `GenerationStudio`, `CoverStudio`.

Acceptance:

- Dense grids use images/posters, not video elements.
- Images use lazy/async where they are not first-viewport critical.
- Preview overlay remains full fidelity.

## Non-Recommendations

Do not switch to Electron as the first solution. Electron may give a more uniform Chromium baseline, but it will not fix token-level React updates, full-list rendering, or media grid decode pressure.

Do not rewrite the whole UI as native. RedConvert's current issue profile is more likely architecture and data-flow pressure than a fundamental WebView ceiling.

Do not add more explanatory UI to hide slowness. The fix should be structural: fewer commits, smaller IPC payloads, less DOM, lazy media.

## Validation Matrix

| Scenario | Before metric | Target after fix |
| --- | --- | --- |
| AI chat streaming 1,000 tokens | React commits per second, long tasks | No long tasks over 100ms during normal stream; commits batched |
| Chat session with 200 messages | scroll FPS, commit duration | Smooth scroll, old messages virtualized |
| Media library with 500 assets | mounted image/video node count | Only viewport-near assets mounted |
| Media generation job | job event count, subscriber renders | Only affected job cards/log panels update |
| App foreground | number of IPC refreshes within 1s | Single coordinated refresh wave, stale UI preserved |
| Sidebar resize | layout commit duration | visual drag remains smooth, React commit on pointerup |

## Final Recommendation

The highest ROI path is:

1. Instrument runtime/media/UI commit frequency.
2. Batch Chat runtime deltas.
3. Narrow media job store subscriptions.
4. Virtualize Chat and media grids.
5. Move dense media cards to poster-only lazy rendering.

This keeps the current Tauri architecture, avoids UI bloat, and addresses the actual bottleneck pattern shown by both external guidance and the current RedConvert code.

## Implementation Log

### 2026-05-16

Completed:

- Batched Chat thought deltas and CLI execution log chunks with the existing streaming update cadence.
- Preserved immediate flush on response end, cancellation, error, and clear-session paths so tail content is not dropped.
- Added selector equality caching to the media job external store.
- Replaced broad `jobsById` subscriptions in RedClaw, Subjects, and Manuscript Editor with filtered or ID-based subscriptions.
- Kept Generation Studio on an all-jobs selector because it is the media queue surface.

Verification:

- `PATH=/opt/homebrew/bin:$PATH pnpm exec tsc --noEmit`
- `PATH=/opt/homebrew/bin:$PATH pnpm exec vite build`

Notes:

- Plain `pnpm` was not available in the default Codex shell PATH.
- Direct `./node_modules/.bin/vite build` under the Codex bundled Node failed because macOS rejected Rollup's native optional dependency signature in that process; the system Homebrew Node path built successfully.
