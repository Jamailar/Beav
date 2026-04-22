# Repository Guidelines


# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.


## Project Structure And Ownership

- `src/` is the React renderer. App bootstrap lives in `src/main.tsx`, top-level view switching lives in `src/App.tsx`, and product surfaces live in `src/pages/`.
- `src/bridge/ipcRenderer.ts` is the compatibility bridge exposed as `window.ipcRenderer`. Renderer code should route host access through this bridge instead of calling Tauri APIs ad hoc from pages.
- `src/runtime/` contains runtime event consumption and session-facing frontend helpers. Use it when wiring streaming/runtime UI behavior.
- `src/components/` contains reusable renderer UI. Keep page-specific orchestration in `src/pages/` unless the pattern is already shared.
- `src/features/` holds larger vertical features such as official publishing and video editor flows.
- `src-tauri/src/main.rs` is the Tauri host entry and still carries important routing/state glue. Treat it as host composition code, not a dumping ground for new business logic.
- `src-tauri/src/commands/` is the main host command surface, organized by domain (`chat`, `runtime`, `manuscripts`, `library`, `redclaw`, `subjects`, `spaces`, etc.).
- `src-tauri/src/events/` owns event emission and compatibility event mapping. New runtime-style events should start here.
- `src-tauri/src/persistence/` and `src-tauri/src/workspace_loaders.rs` own local state persistence and workspace hydration. Do not duplicate scanning/hydration logic in commands or renderer code.
- `src-tauri/src/scheduler/` owns schedule calculation and derived task timing state, not model execution itself.
- `skills/`, `builtin-skills/`, and `prompts/` contain agent-facing assets. Preserve naming and file formats because runtime code expects them.
- `docs/` stores migration notes, architecture references, and IPC inventory. Update these when a structural change would otherwise become tribal knowledge.

## Architecture Map

- Renderer flow: `src/main.tsx` -> `src/App.tsx` -> `src/pages/*` / `src/components/*`.
- Host call path: renderer code -> `window.ipcRenderer` bridge -> Tauri `ipc_invoke` / `ipc_send` -> host routing in `src-tauri/src/main.rs` and `src-tauri/src/commands/*`.
- Event path: host code emits through `src-tauri/src/events/` -> renderer subscribes through `window.ipcRenderer.on(...)` or runtime stream helpers.
- Persistence path: command/runtime code reads minimal in-memory state, performs file/workspace I/O in persistence/loaders, then applies final in-memory mutation.
- Runtime/AI work should be traced across page -> bridge -> commands -> runtime/persistence. Avoid fixing only one layer when the behavior crosses boundaries.

## Build, Run, And Verification

- `pnpm install` installs the renderer and Tauri workspace dependencies.
- `pnpm build` runs the TypeScript renderer build.
- `pnpm tauri:dev` starts the Tauri desktop app in development.
- `pnpm tauri:build` builds the desktop bundle.
- `pnpm ipc:inventory` regenerates the IPC inventory documentation when channel coverage changes.
- `cd src-tauri && cargo fmt --check && cargo check` is the baseline Rust verification when host code changes.
- There is no standard automated frontend test runner configured yet. If you add tests, place them near the code they cover and document how to run them.

## Coding And Change Rules

- Preserve the local style of the file you touch. This repo mixes older and newer code; do not restyle unrelated sections.
- Every self-contained small feature fix or bug fix must be committed immediately as its own Git commit once the code change and local verification are complete. Do not batch multiple unrelated small fixes into one commit unless the user explicitly asks for that.
- The product name is `RedBox`. User-visible UI text, settings copy, documentation titles, bundle metadata, runtime labels, temp-file prefixes, local persistence paths, aliases, and internal identifiers should use `RedBox` / `redbox` consistently.
- Do not introduce or reintroduce any legacy pre-rename product name anywhere in repo content unless the user explicitly asks for a one-time migration compatibility exception.
- Prefer existing `window.ipcRenderer` helpers over direct `invoke()`/`listen()` usage in page code. If a new host channel is needed, add or extend the bridge instead of scattering raw channel strings.
- Keep channel and event naming aligned with existing domain groupings such as `chat:*`, `runtime:*`, `manuscripts:*`, `knowledge:*`, and `redclaw:*`.
- New compatibility events should be emitted from `src-tauri/src/events/`, not handcrafted in random command handlers.
- Keep renderer pages responsive by preserving existing data during refresh. Use stale-while-revalidate behavior by default.
- For routine UI actions, prefer existing icon-first affordances and avoid helper text unless the action is ambiguous or risky.
- UI copy must stay user-facing. Do not put design rationale, reference-project notes, implementation plans, internal module names, technical stack details, page-layout explanations, or backend business-flow explanations into visible UI text.
- When writing UI copy, keep only what helps the user decide, configure, or recover from an error. Developer reasoning belongs in code comments or docs, not on the page.
- Hard rule for headings/descriptions: visible UI text must describe only user-facing capability, current state, required input, consequence, or recovery action. It must never describe how the page is organized or how the designer implemented it.
- Forbidden visible UI patterns include:
  - explaining layout choices such as “按操作顺序组织”, “不再拆成左右两栏”, “统一管理”
  - explaining implementation intent such as “这里用于…管理…模块”, “该页面负责…”, “先做 A 再做 B”
  - exposing developer abstractions such as “模块”, “编排”, “工作流”, “内部状态”, “运行时” unless the term is itself the product feature name
- UI copy self-check before finishing any frontend change:
  - remove any sentence that would still make sense in a PR description or design review
  - if the sentence helps the developer more than the end user, it does not belong in the UI
  - settings页标题优先写功能名，描述优先写“用户能配置什么/会产生什么效果”，不要写“这个页面怎么组织”
- Do not hardcode secrets, model keys, endpoints, or machine-specific paths.

## AI System Design Rules

- This is an AI product. Avoid hardcoded message-text or keyword heuristics for user-intent routing whenever possible.
- Prefer this order of responsibility:
  - skills and prompts define capability boundaries
  - structured metadata, typed payloads, or explicit mode flags carry routing intent
  - runtime/tool layers enforce validation and safety
- If a constraint is necessary, prefer typed state, explicit contracts, and narrow validation over brittle string matching on user messages.

## Tool Governance Rules

- Keep the top-level AI tool surface small and general-purpose. Default to these canonical tools:
  - `bash` for read-only shell inspection
  - `redbox_fs` for structured file access
  - `app_cli` for app/business operations
  - `redbox_editor` only for editor-native mutations
- Do not add a new top-level tool when an existing canonical tool can express the job with a subcommand, action, scope, or typed payload.
- Theme, template, layout, manuscript, profile, skill, MCP, runtime, and similar domain features must not become new top-level tools by default. They belong under `app_cli` or `redbox_editor`, and file reads/writes belong under `redbox_fs`.
- Do not split one capability into multiple sibling tools just because the UI has multiple panels or the data lives in different files. UI structure is not a valid reason to create more AI tools.
- Prefer one generic file tool over many domain-specific read/list/search tools. If the only difference is scope, path root, or file kind, model it as parameters on `redbox_fs` instead of a new tool.
- Prefer one generic app command surface over many domain-specific action tools. If the capability routes to existing host commands, expose it as a namespaced `app_cli` command instead of a new top-level tool.
- Compatibility aliases are temporary migration shims, not product surface. Do not expose new aliases in prompts, skills, or runtime packs, and remove old aliases once callers migrate.
- Skill `allowedTools` should reference canonical tool names only. Do not pin skills to temporary aliases or narrowly-scoped domain tools unless there is a hard runtime boundary that cannot be represented by the canonical set.
- Tool packs must stay minimal. A runtime should receive the fewest tools needed for that mode; diagnostics may inspect more, but diagnostics breadth must not leak into normal runtime packs.
- Before introducing any new tool or action family, document why `bash`, `redbox_fs`, `app_cli`, or `redbox_editor` cannot represent it safely and clearly. Without that proof, do not add the new surface.
- When a capability looks fragmented, fix the abstraction first:
  - merge top-level tools before adding more prompts or skills
  - merge domain-specific file tools into `redbox_fs`
  - merge domain-specific host tools into `app_cli`
  - keep editor-only protocol inside `redbox_editor`

## State, Loading, And Lock Rules

- Existing visible data must not be replaced by a blocking loading screen just because a refresh starts.
- Default to stale-while-revalidate:
  - render cached or already-loaded data immediately
  - refresh in the background
  - show local refresh indicators only
- Page activation, tab switching, panel expansion, and route changes must commit UI first and only then start data refresh.
- Never await slow IPC, file I/O, workspace hydration, or daemon/network status reads on the critical path of a page/tab switch.
- If a newly opened page needs host data, render a safe local snapshot or placeholder immediately, then trigger the host read in the background via effect/timer/transition.
- For page-level refresh on activation, prefer fire-and-forget warmup with timeout/late-result ignore semantics over blocking awaits tied directly to the navigation gesture.
- Refresh failures must keep the last successful snapshot visible and report an inline error instead of clearing the UI.
- Renderer pages must tolerate partial or stale host payloads during refresh. Do not assume nested IPC fields always exist just because TypeScript types say they should.
- Any renderer that consumes nested host state must either normalize the payload at the bridge boundary or use defensive access/fallbacks in render so one missing nested field cannot crash the whole page.
- Global store locks must stay narrow and memory-only.
- Never hold a global store lock while doing file I/O, workspace scans, directory creation, hydration, serialization, or other slow work.
- Required pattern:
  - read the minimum state snapshot under lock
  - release the lock
  - perform file/workspace work outside the lock
  - reacquire only to apply the final in-memory mutation
- Commands, page activation flows, chat post-response maintenance, and workspace bootstrap should follow this pattern by default.

## UI Freeze And Page Blocking Rules

- In this repo, a page that becomes unclickable, shows a spinning cursor, or freezes on tab switch should be treated as an event-loop blockage first, not as a pure routing bug.
- For Tauri host code, any page-path command that might take more than roughly 10-20ms must not run as a synchronous `#[tauri::command] fn` on the UI-critical path.
- Page-facing host commands should default to `async`. CPU-heavy work must go to `spawn_blocking`; I/O work should be truly async where possible.
- Never put directory scans, large file reads, large SQLite queries, heavy JSON encode/decode, image/video processing, blocking HTTP, or `sleep` in a synchronous page-load command.
- Renderer navigation must follow `render shell first, hydrate later`. Showing the page must not wait for all of its data, widgets, or background setup to finish.
- Page enter must not trigger full initialization of every subpanel at once. Split first paint, essential data, and non-critical warmup into separate phases.
- Large lists, trees, transcripts, and tables must not be fully rendered on first paint. Use pagination, virtualization, incremental expansion, or summary-first loading.
- Frontend CPU-heavy parsing, transformation, and thumbnail-like work must not run on the main thread during navigation. Use workers or defer until after first paint.
- IPC payloads on page entry must stay minimal. Do not send whole project trees, full document bodies, full chat history, base64 images, or thousands of records if the page only needs a summary.
- Prefer IDs, paths, cursors, counts, and previews on first load. Fetch details lazily when the user expands or opens a specific item.
- Renderer code must tolerate partial host payloads. Any nested host field may be absent because of stale persistence, version skew, partial migration, or failed refresh.
- Locking rules are part of UI performance rules:
  - do not hold `Mutex`/`RwLock` guards across `await`
  - do not keep one coarse app-wide lock for unrelated page work
  - do not nest locks in inconsistent order
  - keep critical sections tiny and in-memory only
- When shared resources are hot or long-lived, prefer a dedicated task plus message passing over many callers contending on one lock.
- Page switch work must be cancellable or ignorable. When the user goes A -> B -> C quickly, stale A/B work must not still compete with C for UI-critical resources.
- Use request/version tokens for page loads so only the latest navigation result can commit UI state.
- Re-registering listeners, timers, polling loops, or subscriptions on every page entry without cleanup is treated as a page-blocking bug, because the accumulated callbacks will eventually freeze the UI.
- Thumbnail generation, media probing, and rich editor/chart initialization are high-risk page-entry work. They must be delayed, chunked, or moved off the main/UI-critical path.
- Dev-mode performance can mislead, but it is not an excuse for blocking architecture. Validate both dev behavior and release behavior before concluding the issue is solved.

## UI Freeze Diagnosis Rules

- When a page blocks on navigation, first isolate whether the freeze is renderer-side or host-side:
  - temporarily bypass page-entry `invoke` calls
  - if the page still freezes, suspect renderer render/JS/main-thread work
  - if the page stops freezing, suspect host command, IPC payload size, or lock contention
- Add timing around every page-entry phase on both sides before guessing:
  - route switch
  - first render
  - each `invoke`
  - large render blocks
  - host command duration
- Any single step above roughly 50ms should be treated as a likely contributor to visible jank; larger spikes are blockers for page-entry paths.
- On the renderer side, use the browser/WebView Performance tools and look for long tasks, scripting spikes, layout, style recalculation, and GC during navigation.
- On the host side, search page paths for these first:
  - synchronous `#[tauri::command] fn`
  - `std::fs`
  - large serialization/deserialization
  - blocking DB/file access
  - `Mutex` / `RwLock`
  - `block_on`
  - `sleep`
  - media/image/video processing
- When a page uses multiple page-entry requests, do not fire them all blindly in parallel. Decide which data is critical for first paint and defer the rest.
- Every new page or tab must be verified against these failure modes:
  - host call hangs
  - host call times out
  - host returns partial nested data
  - IPC payload is much larger than expected
  - user switches pages repeatedly before the previous load completes

## Common Change Playbooks

### Add Or Change A Host Capability

- Start from the consuming renderer page or component in `src/pages/` or `src/components/`.
- Add or extend the `window.ipcRenderer` helper in `src/bridge/ipcRenderer.ts`.
- Implement or route the host behavior in `src-tauri/src/commands/` or the relevant helper/runtime module.
- If the capability affects persistence or workspace files, move file access into `src-tauri/src/persistence/` or `src-tauri/src/workspace_loaders.rs` instead of embedding it in command code.
- If the change introduces events, emit them through `src-tauri/src/events/`.

### Add Or Change A Runtime/Streaming Flow

- Check the renderer consumer in `src/pages/Chat.tsx`, `src/pages/RedClaw.tsx`, `src/runtime/runtimeEventStream.ts`, or related runtime UI first.
- Prefer unified `runtime:event` transport for new event categories.
- Keep legacy `chat:*` or `creative-chat:*` compatibility only when an existing page still depends on it.
- Do not replace structured runtime state with message-text parsing.

### Add Or Change Workspace Data

- Keep workspace scanning and hydration in host persistence/loaders code.
- Do not scan directories directly from React pages.
- Preserve currently visible data while background refresh runs.
- If the feature touches spaces, manuscripts, media, archives, knowledge, or subjects, verify both the active space behavior and persisted reload behavior.

### Add Or Change Navigation Or A Page

- Wire the page in `src/App.tsx` and keep the current lazy-loading/view-switching pattern.
- Reuse `Layout` navigation patterns instead of creating a second navigation system.
- When a page has background refresh, preserve the last successful state during transitions and retries.
- Treat page/tab open as a render-first interaction:
  - update the navigation state immediately
  - render with existing/default snapshot
  - schedule host reads after paint
  - never gate the first render on slow page-specific data
- When adding a new tab/page backed by IPC data, explicitly verify that clicking into it still renders instantly if the host call hangs, times out, or returns an incomplete payload.

## Known Pitfalls

- Do not rely on old `desktop/` or Electron assumptions. This workspace runs through Tauri v2 + Rust host boundaries.
- Do not bypass `src/bridge/ipcRenderer.ts` from renderer code unless you are editing the bridge/bootstrap layer itself.
- Do not implement workspace/file hydration in command handlers or React hooks when persistence/loaders already own that concern.
- Do not clear visible page data on routine refresh failures.
- Do not hold store locks across disk or workspace operations.
- Do not introduce user-intent routing based on ad hoc string matching when structured flags or metadata can carry intent.
- Do not add broad refactors to `src-tauri/src/main.rs` unless they directly support the task; prefer moving new logic into domain modules.
- Do not make a new page/tab depend on an awaited activation-time IPC call for first paint. This is a common cause of “click tab -> page blocks”.
- Do not dereference nested host payload fields in render without a fallback path. Persisted old data, partial migrations, and stale daemon snapshots can omit sub-objects and crash the page on navigation.

## Documentation Expectations

- When you add or significantly change IPC surfaces, update `docs/ipc-inventory.md` or rerun `pnpm ipc:inventory` if that document is expected to stay current.
- When you split or move major Rust modules, update the nearby `README.md` or `*.README.md` files in `src-tauri/src/`.
- When a new architectural rule is learned from a bug, add it here as a narrow, explicit rule or pitfall instead of leaving it implicit.
