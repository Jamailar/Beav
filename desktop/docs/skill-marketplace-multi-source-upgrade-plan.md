---
doc_type: plan
execution_status: completed
last_updated: 2026-06-28
owner: codex
scope:
  - desktop/src-tauri/src/commands/skills_ai.rs
  - desktop/src-tauri/src/commands/skills_ai/marketplace.rs
  - desktop/src-tauri/src/skills/installer.rs
  - desktop/src/bridge/domains/skillsBridge.ts
  - desktop/src/pages/Settings.tsx
  - desktop/src/pages/Skills.tsx
  - desktop/redbox-market/
reference_repos:
  - /Users/Jam/LocalDev/GitHub/lobehub
  - /Users/Jam/LocalDev/GitHub/codex
---

# Skill Market Multi-Source Upgrade Plan

## 0. Implementation Status

Implemented in this pass:

- `skills:marketplace:list` and legacy `skills:marketplace` now aggregate enabled market sources and fail open per source.
- `skills:market-sources:*` now persists multiple market sources in settings under `skill_market_sources`.
- Legacy Thrive registries, local RedBox market folders, and GitHub RedBox market repositories are supported as source kinds.
- 小红书 RedSkill 官方市场 is supported as a CLI-backed source kind, using `redskill install <identifier>` after the user provides an explicit identifier.
- RedBox `skill-pack` registry entries can resolve package metadata, install paths, and package manifests when available.
- Installed marketplace skills now get a `.redbox-market.json` provenance sidecar for later audit/update checks.
- Settings keeps the existing compact skill-market modal and adds a low-noise source selector/source manager.
- `skills.manage` now exposes marketplace list/source/install operations to the AI runtime without adding a new top-level tool.

## 1. Current State

RedBox already has a lightweight skill market path, but it is not yet a full RedBox marketplace product.

Existing implementation:

- Renderer bridge exposes `skills.marketplace`, `skills.marketInstall`, and `skills.installFromRepo` through `desktop/src/bridge/domains/skillsBridge.ts`.
- Host command dispatch lives in `desktop/src-tauri/src/commands/skills_ai.rs`.
- Market listing and default registry are implemented in `desktop/src-tauri/src/commands/skills_ai/marketplace.rs`.
- Settings has a small `技能市场` modal under the `skills` tab.
- The main `Skills` page only supports installed skill list, create, edit, refresh, enable, and disable.
- The default market URL is still `https://raw.githubusercontent.com/ThrivingOS/Thrive-release/main/community-skills.json`.
- `desktop/redbox-market/` is a RedBox market contract skeleton and local reference mirror. It is not the current runtime source. Its `registry/kinds/skill-pack.json` is currently empty.

Current limitations:

- Only one default registry is used unless caller passes an ad hoc URL.
- Market sources are not persisted as first-class user settings.
- There is no multi-market aggregation, source priority, source trust level, or per-market enable/disable.
- The old registry format is a flat skill array with `id/name/author/description/repo`.
- RedBox `skill-pack` contract is not used during install.
- Installed skills do not record enough market provenance for reliable upgrade, rollback, or source audit.
- Market load failures clear the current list instead of being treated as per-source recoverable errors.
- Installed/uninstalled detail preview is minimal compared with LobeHub and Codex.

## 2. Reference Findings

### 2.1 LobeHub

Relevant paths:

- `/Users/Jam/LocalDev/GitHub/lobehub/apps/cli/src/commands/skill.ts`
- `/Users/Jam/LocalDev/GitHub/lobehub/src/features/SkillStore/SkillStoreContent.tsx`
- `/Users/Jam/LocalDev/GitHub/lobehub/src/features/SkillStore/SkillList/MarketSkills/index.tsx`
- `/Users/Jam/LocalDev/GitHub/lobehub/src/features/SkillStore/SkillList/Community/MarketSkillItem.tsx`
- `/Users/Jam/LocalDev/GitHub/lobehub/src/features/SkillStore/SkillList/MarketSkills/MarketSkillDetail.tsx`
- `/Users/Jam/LocalDev/GitHub/lobehub/packages/builtin-tool-skill-store/src/systemRole.ts`
- `/Users/Jam/LocalDev/GitHub/lobehub/packages/builtin-tool-skill-store/src/ExecutionRuntime/index.ts`

Useful patterns:

- Source detection is explicit: GitHub URL/shorthand, arbitrary URL/ZIP, and marketplace identifier are different import routes.
- The marketplace UI is a compact modal with tabs, search, paginated virtualized grids, install status, and detail preview.
- Uninstalled market skill detail can be previewed before install by fetching package content or ZIP content.
- Installed skill detail prefers local installed content, while uninstalled detail falls back to market metadata.
- Skill Store is also available as an AI-callable built-in tool with `searchSkill`, `importFromMarket`, and `importSkill`.
- AI tool instructions distinguish discovery from installation and require confirmation before installation.

What RedBox should borrow:

- Keep installed skill management separate from market discovery.
- Support direct import from GitHub/URL/ZIP as separate flows, not as hidden variants of market install.
- Give AI a narrow skill-store capability for discovery and install, but keep installation as a guarded operation.
- Add detail preview for uninstalled skills, including `SKILL.md`, references, resources, repository, version, and dependency summary.
- Use virtualized/paginated lists for market browsing.

What RedBox should not copy directly:

- LobeHub depends on a central market backend and auth flow. RedBox should first support local/GitHub registry sources and keep backend market service optional.
- LobeHub's current market install is identifier-centric for one market. RedBox needs `marketId + packageId` because the user wants many skill markets.

### 2.2 Codex

Relevant paths:

- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/app-server/README.md`
- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/app-server-protocol/src/protocol/v2/plugin.rs`
- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/core-plugins/src/marketplace.rs`
- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/core-plugins/src/installed_marketplaces.rs`
- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/core-plugins/src/marketplace_add.rs`
- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/core-plugins/src/marketplace_upgrade.rs`
- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/ext/skills/src/catalog.rs`
- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/ext/skills/src/sources.rs`

Useful patterns:

- Marketplace lifecycle is explicit: `marketplace/add`, `marketplace/remove`, `marketplace/upgrade`.
- Marketplace sources are persisted in user config and installed under a controlled cache root.
- Git marketplaces support source, ref, sparse paths, last revision, and upgrade.
- Plugin listing is fail-open: it returns usable marketplaces plus `marketplaceLoadErrors`.
- Install requires an explicit source identity: local `marketplacePath` or remote `remoteMarketplaceName`.
- Marketplace entries carry install policy and auth policy, including unavailable entries.
- Remote skill contents can be read on demand without installing the whole plugin.
- Skill catalog uses opaque `authority + package id + resource id`; callers should not parse local paths as protocol.

What RedBox should borrow:

- Add source lifecycle commands instead of overloading `skills:marketplace`.
- Persist marketplace source records and installation metadata.
- Use fail-open aggregation with per-market errors.
- Require `marketId + packageId` for market install.
- Separate list/search/read-preview/install/update/uninstall operations.
- Use an opaque package/resource identity in UI and AI contracts; local paths stay host-internal.

What RedBox should adapt:

- Codex marketplace is plugin-oriented. RedBox marketplace should be package-kind-oriented and start with `skill-pack`, while leaving room for member, workflow, cover template, motion, and React element packs.
- Codex installs Git marketplace roots into `.tmp/marketplaces`; RedBox can cache under the RedBox app data dir and continue installing actual skills into user/workspace skill roots.

## 3. Product Goal

Upgrade RedBox skill market into a multi-source marketplace system that can aggregate official, community, local, and third-party skill markets.

The first production target is:

- Multiple user-configurable skill markets.
- Official RedBox market enabled by default.
- Legacy Thrive market kept as an optional compatibility source.
- Market browsing, search, preview, install, update, disable source, and remove source.
- Install provenance and version metadata written into installed skills.
- AI can search and propose installable skills without hardcoded natural language routing.
- Skill installation remains a controlled host operation, not an implicit runtime side effect.

Non-goals for the first pass:

- Paid marketplace checkout.
- Full community submission workflow inside desktop.
- Ratings, comments, creator pages, or social ranking.
- Automatic installation of external CLI runtimes.
- Forcing skill activation after install.

## 4. Recommended Architecture

Use a RedBox-local multi-market aggregator.

```text
Renderer UI
  Settings Skills tab
  Skills page installed-skill manager
  Chat/Runtime skill-store tool cards
        |
        v
desktop/src/bridge/domains/skillsBridge.ts
        |
        v
desktop/src-tauri/src/commands/skills_marketplace/
  sources.rs
  registry.rs
  package.rs
  preview.rs
  install.rs
  cache.rs
  security.rs
        |
        v
desktop/src-tauri/src/skills/installer.rs
desktop/src-tauri/src/skills/store_sync.rs
desktop/src-tauri/src/runtime/*
desktop/src-tauri/src/persistence/*
        |
        v
App data cache
User skill root
Workspace skill root
RedBox Market registry
GitHub/local/URL sources
```

Keep `desktop/src-tauri/src/commands/skills_ai.rs` as the command router, but move market business logic out of `skills_ai/marketplace.rs` into a dedicated module tree.

Recommended module layout:

```text
desktop/src-tauri/src/commands/skills_marketplace/
  mod.rs
  types.rs
  sources.rs
  registry.rs
  package.rs
  preview.rs
  install.rs
  cache.rs
  security.rs
  legacy_thrive.rs
```

Responsibilities:

- `types.rs`: request/response structs and serialized DTOs.
- `sources.rs`: add/list/update/remove marketplace sources.
- `registry.rs`: fetch and parse registries from enabled sources.
- `package.rs`: normalize RedBox `skill-pack` manifests and legacy Thrive entries.
- `preview.rs`: read package metadata, `SKILL.md`, resources, and dependency summaries without installing.
- `install.rs`: install package contents into user/workspace skill roots and write provenance.
- `cache.rs`: app-data cache, stale-while-revalidate, ETag/last-modified metadata, and per-market errors.
- `security.rs`: source URL rules, path traversal defense, package size limits, risk summary, and install policy.
- `legacy_thrive.rs`: adapter for the current flat Thrive-compatible registry.

## 5. Market Source Model

Marketplace sources must be persisted. Do not rely on caller-passed URLs for normal operation.

```json
{
  "id": "redbox-official",
  "name": "RedBox Official",
  "kind": "github",
  "enabled": true,
  "trustLevel": "official",
  "priority": 100,
  "source": "Jamailar/RedBox-Market",
  "refName": "main",
  "registryPath": "registry/index.json",
  "supportedKinds": ["skill-pack"],
  "lastSyncedAt": "2026-06-28T00:00:00Z",
  "lastRevision": "abc123",
  "lastError": null
}
```

Supported source kinds:

- `builtin`: bundled read-only market source shipped with app.
- `github`: GitHub owner/repo or HTTPS Git URL.
- `git`: generic HTTPS/SSH Git URL.
- `local`: local filesystem market repo for development.
- `url`: direct HTTPS registry index URL.
- `legacy-thrive`: adapter for the existing flat `community-skills.json`.

Recommended defaults:

- `redbox-official`: enabled by default when a real RedBox Market URL exists.
- `thrive-community`: disabled by default after migration, enabled only for compatibility or developer mode.
- `local-redbox-market`: only auto-added in developer mode when `/Users/Jam/LocalDev/GitHub/RedBox-Market` exists.

Source identity rules:

- `id` is stable and unique.
- A market source can be disabled without deleting cached packages.
- A market source can be removed; installed skills remain installed but keep provenance.
- Official/builtin sources cannot be edited into another URL. They can only be disabled if product policy allows.

## 6. Registry And Package Contract

### 6.1 RedBox Market Contract

Use the existing `desktop/redbox-market` architecture as the target contract.

```text
registry/index.json
registry/kinds/skill-pack.json
packages/official/skill-pack/<slug>/manifest.json
packages/official/skill-pack/<slug>/skills/<skill-name>/SKILL.md
packages/official/skill-pack/<slug>/README.md
```

`registry/index.json`:

```json
{
  "version": 1,
  "name": "redbox-market",
  "channels": ["official", "community"],
  "packageKinds": ["skill-pack"]
}
```

`registry/kinds/skill-pack.json`:

```json
[
  {
    "packageId": "social-cover-director",
    "name": "Social Cover Director",
    "version": "1.2.0",
    "channel": "official",
    "author": "RedBox",
    "summary": "Create social media covers with platform-aware layout and copy.",
    "category": "content-creation",
    "riskLevel": "medium",
    "manifestPath": "packages/official/skill-pack/social-cover-director/manifest.json",
    "updatedAt": "2026-06-28T00:00:00Z"
  }
]
```

`manifest.json`:

```json
{
  "schemaVersion": 1,
  "kind": "skill-pack",
  "packageId": "social-cover-director",
  "name": "Social Cover Director",
  "version": "1.2.0",
  "description": "Platform-aware social cover planning and generation.",
  "author": {
    "name": "RedBox",
    "url": "https://github.com/Jamailar"
  },
  "license": "MIT",
  "skills": [
    {
      "name": "social-cover-director",
      "path": "skills/social-cover-director/SKILL.md"
    }
  ],
  "dependencies": {
    "tools": [
      {
        "type": "app_cli",
        "action": "cover.generate",
        "required": false,
        "description": "Generate cover image assets through the RedBox cover pipeline."
      }
    ],
    "runtimeRequirements": [
      {
        "kind": "cli",
        "name": "ffmpeg",
        "required": false,
        "reason": "Only needed when the skill exports video cover previews."
      }
    ]
  },
  "permissions": {
    "allowedTools": ["app_cli", "redbox_fs"],
    "allowedRuntimeModes": ["wander", "redclaw", "team"]
  },
  "installPolicy": "available",
  "riskLevel": "medium",
  "resources": [
    {
      "path": "README.md",
      "type": "markdown"
    }
  ]
}
```

### 6.2 Legacy Thrive Adapter

The existing flat registry format stays supported through an adapter:

```json
[
  {
    "id": "wwud",
    "name": "WWUD",
    "author": "Jamailar",
    "description": "What Would User Do decision modeling.",
    "repo": "Jamailar/wwud-skill"
  }
]
```

Normalize it into the internal package model:

```json
{
  "marketId": "thrive-community",
  "packageId": "wwud",
  "kind": "skill-pack",
  "version": null,
  "sourceKind": "legacy-thrive",
  "sourceRepo": "Jamailar/wwud-skill"
}
```

Legacy entries can be installed, but they should be labeled as compatibility packages and have weaker update metadata.

## 7. Public IPC Contract

Prefer new channels with explicit source lifecycle. Keep old channels as compatibility wrappers.

New channels:

- `skills:market-sources:list`
- `skills:market-sources:add`
- `skills:market-sources:update`
- `skills:market-sources:remove`
- `skills:market-sources:refresh`
- `skills:marketplace:list`
- `skills:marketplace:read-package`
- `skills:marketplace:install`
- `skills:marketplace:update-installed`
- `skills:marketplace:uninstall`

Compatibility channels:

- `skills:marketplace`: call `skills:marketplace:list`.
- `skills:market-install`: call `skills:marketplace:install`, accepting old `{ id, repo }` payloads.

`skills:marketplace:list` request:

```json
{
  "query": "cover",
  "marketIds": ["redbox-official"],
  "kinds": ["skill-pack"],
  "installed": "all",
  "updateStatus": "all",
  "limit": 50,
  "cursor": null,
  "forceRefresh": false
}
```

Response:

```json
{
  "success": true,
  "items": [],
  "nextCursor": null,
  "sources": [],
  "errors": [
    {
      "marketId": "community-a",
      "message": "request timed out",
      "cached": true
    }
  ],
  "cacheStatus": "fresh"
}
```

`skills:marketplace:install` request:

```json
{
  "marketId": "redbox-official",
  "packageId": "social-cover-director",
  "version": "1.2.0",
  "scope": "user"
}
```

Installation must reject ambiguous payloads. If two markets expose `social-cover-director`, the caller must specify `marketId`.

## 8. Installed Skill Provenance

Write a small market provenance block into each installed skill package. This can live in a sidecar JSON file to avoid rewriting third-party `SKILL.md`, and optionally be mirrored into frontmatter when RedBox owns the package.

Recommended sidecar:

```text
<skill-root>/.redbox-market.json
```

```json
{
  "schemaVersion": 1,
  "marketId": "redbox-official",
  "packageId": "social-cover-director",
  "packageVersion": "1.2.0",
  "sourceKind": "github",
  "source": "Jamailar/RedBox-Market",
  "sourceRevision": "abc123",
  "manifestPath": "packages/official/skill-pack/social-cover-director/manifest.json",
  "installedAt": "2026-06-28T00:00:00Z",
  "installScope": "user"
}
```

This enables:

- installed badge by source,
- update detection,
- rollback planning,
- uninstall safety,
- audit trail,
- duplicate package detection.

## 9. UI Design

### 9.1 Settings Skills Tab

Keep Settings as the main market management surface.

Add:

- `技能市场` button stays in the skills tab.
- Market modal gains source filter, search, installed/update filters, and source management.
- Source management is a small secondary drawer/modal, not a full settings page.

Modal layout:

```text
Header: 技能市场 | Search | Refresh | Source settings | Close
Left rail: All, Official, Community, Local, Installed, Updates
Main list: virtualized package rows/cards
Detail pane/modal: package metadata, files, dependencies, permissions, install/update
```

Each item shows only decision-critical metadata:

- name,
- summary,
- market badge,
- official/community/local trust badge,
- installed/update state,
- risk badge only for non-low-risk packages,
- install/update button.

Avoid explanatory text in the main surface. Put detailed warnings inside the package detail and install confirmation.

### 9.2 Skills Page

The main `Skills` page remains installed-skill management.

Add at most one icon button in the left header:

- Store icon opens the same marketplace modal.
- Do not duplicate full marketplace browsing inside the page.

### 9.3 Package Detail

Borrow LobeHub's preview pattern:

- Header: icon/name/version/source/repository.
- Left file tree: `SKILL.md`, references, README, resources.
- Right viewer: markdown content.
- Bottom or side summary: permissions, runtime requirements, install/update action.

Uninstalled package preview must not install or execute anything. It only reads registry/package files.

### 9.4 AI Tool Cards

When AI searches or proposes a skill, show a compact tool result:

- found packages,
- source,
- risk,
- installed state,
- install button requiring user confirmation.

AI should not silently install skills.

## 10. AI Runtime Integration

Add a canonical app CLI action rather than a new top-level tool:

```text
app_cli(action="skills.marketplace")
```

Operations:

- `search`
- `readPackage`
- `install`
- `listSources`

Do not add many top-level tools. Keep RedBox's existing tool-surface rule.

AI workflow:

1. User asks for a capability or names a skill.
2. Model may call `skills.marketplace` with `operation=search`.
3. Model summarizes candidates and asks for confirmation if install is needed.
4. User confirms.
5. Model calls `operation=install` with exact `marketId + packageId`.
6. Host installs skill, refreshes skill catalog, and emits runtime event.
7. Skill activation remains model-driven through catalog, activation hints, explicit user request, runtime mode, and tool contract.

Prohibited:

- Do not infer `activeSkills` from package category words.
- Do not install a skill because a market result matches the user's text.
- Do not install external CLI dependencies as part of skill install.
- Do not let market package metadata directly mutate prompt routing or role selection.

## 11. Video, Media, And External Runtime Handling

Some market skills will target video or media workflows. The marketplace should expose requirements, not execute them.

Rules:

- Skill install copies skill package files only.
- Video processing stays in the existing media/video runtime and CLI runtime.
- `ffmpeg`, `remotion`, `python`, `node`, and platform CLIs are runtime requirements declared by the package manifest.
- Missing optional dependencies are shown as package detail warnings.
- Required external dependencies trigger a post-install readiness check, not hidden installation.
- AI can use existing `cli_runtime` paths to detect or install dependencies after user confirmation.

Example:

```json
{
  "runtimeRequirements": [
    {
      "kind": "cli",
      "name": "ffmpeg",
      "required": true,
      "installHint": "Use CLI Runtime managed install or system package manager."
    },
    {
      "kind": "node-package",
      "name": "remotion",
      "required": false
    }
  ]
}
```

This keeps skill market, video runtime, and CLI runtime boundaries clean.

## 12. Libraries Vs Self-Build

Use existing libraries:

- `reqwest`: HTTP fetch in Rust.
- `serde` / `serde_json`: registry and manifest parsing.
- `semver`: version comparison.
- `git` CLI or existing clone helper: Git source staging and update. Reuse patterns from `skills/installer.rs`; do not invent a Git implementation.
- `sha2` or existing hash utility: package identity and cache validation.
- `tokio::task::spawn_blocking`: Git clone, archive extraction, and filesystem-heavy install.
- Existing React/SWR/state patterns in Settings. Keep stale-while-revalidate.
- Existing lucide icons and current RedBox UI components.

Self-build:

- RedBox marketplace source model.
- RedBox `skill-pack` manifest validator.
- Multi-market aggregator and deduplication.
- Provenance sidecar format.
- Trust/risk policy.
- Install/update/rollback logic.
- AI-facing `skills.marketplace` action contract.

Do not self-build:

- Git protocol implementation.
- ZIP/tar low-level extraction if a safe existing dependency is already present.
- Full-text search engine for the first pass. Start with indexed lowercase token matching; add Tantivy/SQLite FTS only if the package count justifies it.

## 13. Security Model

Source safety:

- Allow `https://github.com/`, `https://raw.githubusercontent.com/`, GitHub shorthand, configured local paths, and explicitly allowed enterprise Git hosts.
- Block arbitrary HTTP by default.
- Local sources require developer mode unless user explicitly adds them.
- Source id and package id must pass safe segment validation.

Package safety:

- All package paths must stay inside the staged market root.
- Reject `..`, absolute paths, symlink escapes, and Windows-reserved unsafe paths.
- Enforce max package count, max file count, max file size, and total copy bytes.
- Validate `SKILL.md` exists for each skill entry.
- Validate manifest `kind=skill-pack`.
- Validate allowed tools against canonical RedBox tools/actions.
- Validate `allowedRuntimeModes`.
- Mark packages with scripts, external requirements, broad filesystem permissions, or MCP/server dependencies as medium/high risk.

Install safety:

- Install atomically through staging then rename.
- Never hold global app store locks during clone, fetch, file scan, archive extraction, or copy.
- Install requires user confirmation for community, local, URL, or high-risk packages.
- Official low-risk updates can be one-click but still visible.

Runtime safety:

- Installed skill does not auto-run.
- Installed skill does not auto-enable external runtime dependencies.
- Any tool permission still goes through RedBox runtime/tool guardrails.

## 14. Performance Strategy

Listing:

- Load installed skills immediately from current catalog.
- Show cached marketplace entries first.
- Refresh enabled market sources in background.
- Return partial results with per-market errors.
- Use pagination/cursor from the host API even when registry is local.
- Deduplicate by `marketId/packageId`; only use name for display.

Fetching:

- Cache registry index, kind registry, and manifest files separately.
- Store `lastRevision`, `etag`, `lastModified`, and `syncedAt` when available.
- For Git sources, use sparse checkout or targeted file reads when possible.
- For URL sources, cap response size and request timeout.

UI:

- Virtualize market item list.
- Do not parse all package previews on initial list.
- Fetch `readPackage` detail on demand.
- Preserve existing list while refresh runs.
- On refresh failure, keep stale cache and show source-level warning.

Install:

- Use blocking thread for filesystem-heavy work.
- Use existing `install_skills_from_repo` copy limits as baseline.
- Refresh skill catalog once after batch install, not per file.
- Emit one runtime/UI event for install start, progress summaries, and completion.

## 15. Option Comparison

| Option | Description | Pros | Cons | Recommendation |
| --- | --- | --- | --- | --- |
| A | Keep current `skills:marketplace({ url })` and add URL selector in UI | Minimal code | No persistent sources, no aggregation, no upgrade, no provenance, weak security | Do not use except as temporary debug path |
| B | Desktop multi-market aggregator with RedBox package contract | Supports many markets, offline cache, provenance, update path, no backend dependency | More host work than A | Recommended first production path |
| C | Central RedBox market backend service | Best for auth, review workflow, paid packages, analytics, recommendations | Requires backend, ops, accounts, policy, and migration | Later layer after B |

Recommendation: implement Option B now. Keep the source contract compatible with a future backend so Option C can replace or augment registry fetch without rewriting install/provenance/UI.

## 16. Migration Plan

### Commit 1: Marketplace Source Model

Add persisted market source records and default source initialization.

Files:

- `desktop/src-tauri/src/commands/skills_marketplace/types.rs`
- `desktop/src-tauri/src/commands/skills_marketplace/sources.rs`
- relevant persistence settings/store model
- `desktop/src/bridge/domains/skillsBridge.ts`
- `desktop/src/types.d.ts`

Acceptance:

- Can list default sources.
- Can add/disable/remove non-builtin source.
- No market listing behavior changes yet.

### Commit 2: Aggregated Listing And Cache

Move current `skills_ai/marketplace.rs` into the new module and support multiple enabled sources.

Acceptance:

- `skills:marketplace:list` returns combined items.
- Per-source failures are returned in `errors`.
- Existing `skills:marketplace` still works.
- Current Thrive registry still appears through legacy adapter.

### Commit 3: RedBox Skill-Pack Parser

Implement RedBox `registry/index.json`, `registry/kinds/skill-pack.json`, and `manifest.json` parsing.

Acceptance:

- Local `desktop/redbox-market` style registry can be read.
- Empty `skill-pack.json` returns empty list without error.
- Invalid package manifests are skipped with source/package errors.

### Commit 4: Package Preview

Add `skills:marketplace:read-package`.

Acceptance:

- Preview returns metadata, `SKILL.md` content, resource tree, dependencies, and permissions.
- Preview does not install or execute anything.
- Legacy Thrive entries show metadata-only preview unless repo content is fetched explicitly.

### Commit 5: Market Install With Provenance

Install by `marketId + packageId`.

Acceptance:

- Installs RedBox skill-pack into user skill root.
- Writes `.redbox-market.json`.
- Existing old `skills:market-install({ id, repo })` remains compatible.
- Installed list shows market source and version.

### Commit 6: Update Detection And Upgrade

Compare installed provenance version/revision with market package version/revision.

Acceptance:

- Market list shows `updateAvailable`.
- Update operation installs atomically and preserves rollback metadata.
- Disabled/removed market sources do not offer updates.

### Commit 7: UI Upgrade

Update Settings skill market modal and add minimal Skills page entry.

Acceptance:

- Source filter, search, installed/update filters.
- Detail preview modal.
- Source management drawer.
- Stale cache remains visible during refresh.

### Commit 8: AI-Facing Action

Add canonical `skills.marketplace` action through existing `app_cli`.

Acceptance:

- AI can search and read package detail.
- Install operation requires confirmation.
- No automatic activation after install.
- Tool descriptions avoid keyword routing.

### Commit 9: Documentation And Regression

Update docs and tests.

Acceptance:

- `desktop/docs/ipc-inventory.md` updated via `pnpm ipc:inventory` if IPC inventory changes.
- Rust targeted tests cover source parsing, aggregation, manifest parsing, install provenance, path safety, and legacy adapter.
- TypeScript type check covers bridge/UI payloads.

## 17. Verification Matrix

Host tests:

- Multi-source list with one success and one failure.
- Duplicate package ids across different markets.
- Disabled source excluded.
- Legacy Thrive adapter still works.
- RedBox `skill-pack` parser handles empty and invalid registries.
- Path traversal rejection.
- Install provenance sidecar written.
- Update detection by semver and revision.

Renderer checks:

- Settings skills tab opens immediately with stale/installed data.
- Marketplace modal preserves cached list during refresh.
- Search and filters do not block the UI.
- Detail preview loads on demand.
- Install updates installed skill list and market row state.
- Main Skills page remains installed-skill focused.

Runtime checks:

- Installed skill appears in `skills:list`.
- Runtime warm state refreshes after install.
- AI skill-store search does not activate skill automatically.
- Install action requires confirmation.

Manual source checks:

- Official RedBox source.
- Local RedBox Market path.
- Legacy Thrive source.
- Invalid URL source.
- Slow/offline source with stale cache.

## 18. Open Decisions

1. Official market location: confirm whether the first real source is `/Users/Jam/LocalDev/GitHub/RedBox-Market`, a GitHub repo, or an OSS-hosted JSON endpoint.
2. Default compatibility: decide whether the old Thrive market remains enabled, disabled, or developer-only.
3. Package signing: decide whether first pass requires checksums only, or signed manifests.
4. Update policy: decide whether official package updates can be one-click, or always require confirmation.
5. Market source UI: decide whether source management belongs only in Settings or also in developer mode.

## 19. Final Recommendation

Build the multi-market aggregator in the desktop host first. It gives RedBox the most useful marketplace capability without committing to a backend service too early.

The design should follow Codex for marketplace lifecycle, source persistence, explicit install source identity, fail-open listing, and opaque package/resource handles. It should follow LobeHub for skill-store UX, market search/detail preview, import source separation, and AI-accessible discovery/install workflow.

The product boundary is:

- Market installs skill packages.
- Skill catalog exposes capabilities.
- Runtime/model chooses skills through existing activation hints and tool contracts.
- CLI/runtime dependencies are declared and checked, not silently installed.
- UI stays compact and operational, with details available only when the user asks for them.
