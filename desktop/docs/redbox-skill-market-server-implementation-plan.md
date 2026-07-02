---
doc_type: plan
execution_status: not_started
last_updated: 2026-06-29
owner: codex
scope:
  - RedBox Market backend service
  - Aliyun OSS package mirror
  - desktop/src-tauri/src/commands/skills_ai/marketplace.rs
  - desktop/src/bridge/domains/skillsBridge.ts
  - desktop/src/pages/Settings.tsx
related_docs:
  - desktop/docs/skill-marketplace-multi-source-upgrade-plan.md
  - desktop/redbox-market/docs/repo-architecture.md
  - private/Docs/repository-functional-architecture.md
---

# RedBox Skill Market Server Implementation Plan

## 1. Product Decision

RedBox should own the public skill marketplace layer.

Desktop clients should not directly depend on third-party registries, GitHub repos, RedSkill identifiers, or random package URLs as the primary market surface. They should query RedBox Market API, receive normalized package metadata and an explicit install plan, then download only approved artifacts from RedBox-controlled mirrors whenever possible.

Recommended model:

```text
RedBox Desktop
  -> RedBox Market API
      -> DB metadata, categories, review state, install plans
      -> Aliyun OSS package mirror
      -> upstream adapters
          -> RedBox official packages
          -> Xiaohongshu RedSkill identifier catalog
          -> GitHub/community skill packages
          -> future third-party markets
```

The server becomes the governance layer:

- It decides what appears in the market.
- It normalizes all upstream sources into RedBox package records.
- It stores files in Aliyun OSS, not in the database.
- It returns signed, checksummed download/install plans.
- It records install telemetry and source provenance.

## 2. Why This Is Better Than Client-Side Multi-Source

Current desktop-side multi-source support is useful for development and fallback, but it should not be the final product surface.

| Option | Pros | Cons | Recommendation |
| --- | --- | --- | --- |
| Desktop reads every upstream directly | Fast to prototype, no backend needed | Unstable, no unified review, hard to mirror, exposes random URLs, poor China reliability | Keep only as developer/fallback mode |
| Bundle all skills in desktop app | Offline, simple install | App grows fast, release required for every skill update, no dynamic marketplace | Only for critical builtin skills |
| Store all skill files in DB | Simple deployment | DB bloat, slow backup, poor CDN, bad for binary/assets/scripts | Do not use |
| DB metadata + Aliyun OSS artifacts + Market API | Scalable, fast in China, auditable, supports third-party aggregation | Requires backend and sync jobs | Recommended |

## 3. Storage Model

### 3.1 Database Stores Metadata Only

Database is for queryable state:

- package identity
- category and tags
- version state
- upstream source identity
- review/audit status
- install policy
- OSS object keys
- checksum and signature
- dependency summary
- install/download metrics

Do not store package archives, skill folders, scripts, images, or binary resources as DB blobs.

### 3.2 Aliyun OSS Stores Package Artifacts

Aliyun OSS is the canonical artifact mirror for RedBox Market.

Recommended bucket layout:

```text
redbox-market/
  manifests/
    latest.json
    skill-pack.json
    categories.json

  packages/
    skill-pack/
      redbox-official/
        xhs-title/
          1.0.0/
            manifest.json
            package.tar.gz
            package.tar.gz.sha256
            package.tar.gz.minisig
      xiaohongshu/
        abc/
          1.0.0/
            manifest.json
            install-plan.json
      community/
        author-name/
          skill-slug/
            1.0.0/
              manifest.json
              package.tar.gz
              package.tar.gz.sha256
              package.tar.gz.minisig

  upstream-cache/
    redskill/
      catalog-snapshot-2026-06-29.json
    github/
      owner/
        repo/
          ref/
            package.tar.gz
```

Rules:

- Every downloadable package has `sha256`.
- Every approved package should have a signature.
- OSS keys are immutable by version. Never overwrite `1.0.0/package.tar.gz`.
- Mutable pointers live in DB and `manifests/latest.json`.
- Deletion is soft-delete in DB; OSS objects are retained until retention expiry.

## 4. Package Model

### 4.1 Core Package Identity

Use stable package identity:

```text
package_id = <source_namespace>/<slug>
version = semver or upstream revision
kind = skill-pack
```

Examples:

```text
redbox/xhs-title
xiaohongshu/abc
github-owner/some-skill
community/creator-copywriter
```

### 4.2 Skill Package Manifest

Each package version has a normalized manifest:

```json
{
  "schemaVersion": 1,
  "kind": "skill-pack",
  "packageId": "xiaohongshu/abc",
  "version": "1.0.0",
  "displayName": "小红书官方技能 ABC",
  "description": "用于...",
  "sourceMarket": "xiaohongshu-redskill",
  "sourceType": "redskill-cli",
  "categoryIds": ["xiaohongshu", "content-creation"],
  "tags": ["小红书", "官方"],
  "riskLevel": "medium",
  "installPolicy": {
    "type": "redskill-cli",
    "requiresCli": ["redskill"],
    "upstreamIdentifier": "abc"
  },
  "artifacts": [],
  "dependencies": [],
  "review": {
    "status": "approved",
    "reviewedAt": "2026-06-29T00:00:00Z"
  }
}
```

For mirrored RedBox/community packages:

```json
{
  "installPolicy": {
    "type": "artifact",
    "artifactKey": "redbox-market/packages/skill-pack/redbox-official/xhs-title/1.0.0/package.tar.gz",
    "sha256": "...",
    "signatureKey": "redbox-market/packages/skill-pack/redbox-official/xhs-title/1.0.0/package.tar.gz.minisig",
    "installPaths": ["."]
  }
}
```

### 4.3 Install Plan Returned To Desktop

Desktop should not infer install mechanics from package metadata. It requests an install plan:

```json
{
  "packageId": "redbox/xhs-title",
  "version": "1.0.0",
  "kind": "skill-pack",
  "installType": "artifact",
  "download": {
    "url": "https://oss-domain/redbox-market/packages/...",
    "expiresAt": "2026-06-29T10:00:00Z",
    "sha256": "...",
    "signatureUrl": "https://oss-domain/redbox-market/packages/....minisig"
  },
  "install": {
    "scope": "user",
    "paths": ["."]
  },
  "provenance": {
    "marketId": "redbox-market",
    "sourceMarket": "redbox-official",
    "upstreamId": null
  }
}
```

For RedSkill:

```json
{
  "packageId": "xiaohongshu/abc",
  "version": "1.0.0",
  "kind": "skill-pack",
  "installType": "redskill-cli",
  "requiresCli": {
    "name": "redskill",
    "installCommand": "curl -fsSL https://fe-video-qc.xhscdn.com/fe-platform-file/104101b8320fbjem2620653u0hejenq0004pf88g6ask5i.sh | bash"
  },
  "install": {
    "command": "redskill",
    "args": ["install", "abc"],
    "cwd": "workspace"
  },
  "provenance": {
    "marketId": "redbox-market",
    "sourceMarket": "xiaohongshu-redskill",
    "upstreamIdentifier": "abc"
  }
}
```

## 5. Database Schema

Use existing production DB if it already powers RedBox account/API services. Tables below are logical; adapt naming to current backend conventions.

### 5.1 `skill_market_sources`

Stores upstream market definitions.

```sql
create table skill_market_sources (
  id text primary key,
  display_name text not null,
  source_type text not null, -- redbox-official, redskill-cli, github, url, manual
  source_url text,
  auth_type text not null default 'none',
  enabled boolean not null default true,
  trust_level text not null default 'community',
  sync_mode text not null default 'manual', -- manual, scheduled, webhook
  sync_interval_minutes integer,
  last_sync_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
```

### 5.2 `skill_categories`

```sql
create table skill_categories (
  id text primary key,
  parent_id text,
  display_name text not null,
  description text,
  sort_order integer not null default 0,
  visible boolean not null default true
);
```

Initial categories:

```text
featured
redbox-official
xiaohongshu
content-creation
video
ecommerce
research
automation
community
developer-tools
```

### 5.3 `skill_packages`

One row per package identity.

```sql
create table skill_packages (
  id text primary key,
  kind text not null default 'skill-pack',
  source_id text not null references skill_market_sources(id),
  slug text not null,
  display_name text not null,
  short_description text,
  long_description text,
  author_name text,
  homepage_url text,
  icon_url text,
  license text,
  trust_level text not null,
  risk_level text not null,
  status text not null, -- draft, pending_review, approved, hidden, blocked
  latest_version text,
  install_count bigint not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
```

### 5.4 `skill_package_versions`

One row per version/revision.

```sql
create table skill_package_versions (
  id text primary key,
  package_id text not null references skill_packages(id),
  version text not null,
  upstream_identifier text,
  upstream_revision text,
  manifest_json jsonb not null,
  install_policy_json jsonb not null,
  oss_manifest_key text,
  oss_artifact_key text,
  oss_signature_key text,
  sha256 text,
  size_bytes bigint,
  dependency_summary_json jsonb not null default '{}',
  review_status text not null,
  review_notes text,
  published_at timestamptz,
  created_at timestamptz not null,
  unique(package_id, version)
);
```

### 5.5 `skill_package_categories`

```sql
create table skill_package_categories (
  package_id text not null references skill_packages(id),
  category_id text not null references skill_categories(id),
  primary key (package_id, category_id)
);
```

### 5.6 `skill_package_tags`

```sql
create table skill_package_tags (
  package_id text not null references skill_packages(id),
  tag text not null,
  primary key (package_id, tag)
);
```

### 5.7 `skill_package_reviews`

```sql
create table skill_package_reviews (
  id text primary key,
  package_version_id text not null references skill_package_versions(id),
  reviewer_id text,
  status text not null, -- approved, rejected, needs_changes
  risk_level text not null,
  checklist_json jsonb not null,
  notes text,
  created_at timestamptz not null
);
```

### 5.8 `skill_install_events`

```sql
create table skill_install_events (
  id text primary key,
  user_id text,
  workspace_id text,
  package_id text not null,
  version text,
  install_type text not null,
  client_version text,
  platform text,
  status text not null, -- started, succeeded, failed
  error_code text,
  error_message text,
  created_at timestamptz not null
);
```

## 6. Server API

Use versioned API namespace:

```text
/{app}/v1/skill-market/...
```

If RedBox backend already uses tenant path `/{app}/v1`, keep that pattern.

### 6.1 Public Client APIs

#### List Categories

```http
GET /redbox/v1/skill-market/categories
```

Response:

```json
{
  "categories": [
    { "id": "xiaohongshu", "displayName": "小红书", "count": 12 }
  ]
}
```

#### List Packages

```http
GET /redbox/v1/skill-market/packages?category=xiaohongshu&q=title&page=1&pageSize=30
```

Response:

```json
{
  "items": [
    {
      "packageId": "xiaohongshu/abc",
      "displayName": "小红书官方技能 ABC",
      "description": "...",
      "sourceMarket": "xiaohongshu-redskill",
      "latestVersion": "1.0.0",
      "riskLevel": "medium",
      "trustLevel": "official",
      "installType": "redskill-cli",
      "tags": ["小红书", "官方"]
    }
  ],
  "page": 1,
  "pageSize": 30,
  "total": 120
}
```

#### Read Package Detail

```http
GET /redbox/v1/skill-market/packages/:packageId
```

Return metadata, current version, screenshots/docs if any, dependencies, install policy summary, risk summary, and changelog.

#### Create Install Plan

```http
POST /redbox/v1/skill-market/packages/:packageId/install-plan
```

Request:

```json
{
  "version": "1.0.0",
  "scope": "user",
  "client": {
    "platform": "macos",
    "arch": "arm64",
    "appVersion": "2.5.2"
  }
}
```

Response is the install plan described above.

#### Record Install Event

```http
POST /redbox/v1/skill-market/install-events
```

Desktop calls this before/after install. This is telemetry and auditing; it must not block local install if the event endpoint fails.

### 6.2 Admin APIs

#### Upstream Sources

```http
GET    /redbox/v1/admin/skill-market/sources
POST   /redbox/v1/admin/skill-market/sources
PATCH  /redbox/v1/admin/skill-market/sources/:id
POST   /redbox/v1/admin/skill-market/sources/:id/sync
```

#### Package Review

```http
GET   /redbox/v1/admin/skill-market/review-queue
GET   /redbox/v1/admin/skill-market/packages/:packageId/versions/:version
POST  /redbox/v1/admin/skill-market/packages/:packageId/versions/:version/review
POST  /redbox/v1/admin/skill-market/packages/:packageId/versions/:version/publish
POST  /redbox/v1/admin/skill-market/packages/:packageId/hide
POST  /redbox/v1/admin/skill-market/packages/:packageId/block
```

#### Manual Package Upload

```http
POST /redbox/v1/admin/skill-market/packages/upload-url
POST /redbox/v1/admin/skill-market/packages/complete-upload
```

Flow:

1. Admin requests signed OSS upload URL.
2. Browser uploads package archive directly to OSS staging key.
3. Backend validates package, extracts metadata, writes DB draft.
4. Reviewer approves and publishes.

## 7. Backend Business Flows

### 7.1 RedBox Official Skill Publication

```text
Developer submits package
  -> CI validates manifest and package layout
  -> CI builds package.tar.gz
  -> CI computes sha256
  -> CI uploads to OSS staging
  -> Backend creates package_version pending_review
  -> Reviewer approves
  -> Backend promotes OSS object to immutable public key
  -> Backend sets latest_version
  -> Package appears in market
```

Validation checklist:

- `SKILL.md` exists.
- Frontmatter parses.
- `allowedTools`, `allowedRuntimeModes`, hook mode, activation hint are valid.
- Package has no symlink.
- Package size under limit.
- No blocked file names: `.env`, private key, token files, `.git`.
- Scripts are either absent or declared in manifest.
- Network/tool permissions are explicit.

### 7.2 RedSkill Upstream Catalog Curation

RedSkill currently exposes identifier install, not a list API. Therefore RedBox maintains a curated catalog.

```text
Operator adds RedSkill identifier in admin
  -> Backend validates identifier format
  -> Backend stores package with sourceType=redskill-cli
  -> Operator fills display name, category, description, risk level
  -> Optional: backend runs redskill install in sandbox workspace to inspect output
  -> Reviewer approves
  -> Package appears under category "小红书"
```

Important:

- If RedSkill later provides a registry API, add a sync adapter.
- Until then, RedBox owns the visible catalog and metadata.
- Install plan still uses `redskill install <identifier>` unless RedSkill allows package mirroring.

### 7.3 GitHub/Community Package Ingestion

```text
Admin submits repo/ref/path
  -> Backend clones repo in sandbox
  -> Scans for SKILL.md
  -> Builds normalized skill-pack archive
  -> Generates manifest
  -> Runs policy checks
  -> Uploads archive to OSS staging
  -> Creates pending_review version
  -> Reviewer approves
  -> Publishes immutable artifact key
```

Use existing libraries:

- Git operations: use system `git` or `isomorphic-git` only if current backend is Node-only and sandboxed.
- Archive: `tar`/`zlib` or Node `tar` package.
- Hash: platform crypto library.
- YAML/frontmatter: `yaml` and a frontmatter parser.

Do not hand-roll:

- tar archive parsing
- signature verification
- YAML parser
- semver comparison
- object storage multipart upload

Self-build:

- RedBox package schema
- review workflow
- install-plan generator
- upstream adapter abstraction
- RedBox-specific risk policy
- Desktop provenance contract

### 7.4 Artifact Mirror Publish

```text
Approved version
  -> Copy OSS staging object to final immutable key
  -> Write manifest.json to final key
  -> Write sha256 and signature files
  -> Update DB package latest_version
  -> Refresh category counters/search index
  -> Invalidate CDN cache for manifest/list endpoints if needed
```

Never publish DB state before final OSS objects are available.

### 7.5 Desktop Install Flow

```text
User opens skill market
  -> Desktop calls list packages
  -> User selects package
  -> Desktop requests install-plan
  -> If artifact:
       download package from OSS
       verify sha256/signature
       extract to user/workspace skills root
       write .redbox-market.json provenance
       refresh skill catalog
  -> If redskill-cli:
       check redskill status
       if missing, ask user to install CLI
       run redskill install <identifier> in workspace
       refresh skill catalog
       write install event
```

Desktop should still enforce local safety:

- path traversal protection
- symlink refusal
- max file count/size
- no overwrite outside skill root
- provenance sidecar write

Server approval does not replace client-side extraction safety.

## 8. Admin Console Workflows

### 8.1 Source Management

Admin can create sources:

- RedBox official
- RedSkill curated identifiers
- GitHub repo
- URL registry
- manual upload

Fields:

- source name
- source type
- sync mode
- auth config
- trust level
- default category
- enabled/disabled

### 8.2 Package Review Queue

Reviewer sees:

- package diff from previous version
- manifest
- `SKILL.md`
- requested tools and runtime modes
- scripts/resources list
- upstream source
- risk checklist
- validation logs
- sandbox inspection result

Reviewer actions:

- approve
- reject
- request changes
- block package/source
- publish approved version

### 8.3 Category Management

Operators can assign package to multiple categories. For Xiaohongshu:

```text
小红书
  - 官方技能
  - 标题/选题
  - 评论洞察
  - 内容合规
  - 图文创作
  - 视频创作
```

The desktop market modal can keep UI compact:

- left/category tabs
- search
- package list
- detail drawer
- install button

Do not build a heavy marketplace homepage inside desktop.

## 9. Search And Indexing

Start with database search:

- `display_name`
- `short_description`
- tags
- category
- source market

If using Postgres:

- Use `tsvector` or trigram index for fuzzy search.
- Add B-tree indexes on `status`, `source_id`, `latest_version`, category join.

If the existing backend database is not Postgres, use the equivalent full-text feature, but do not introduce Elasticsearch in the first version.

Search response should include only list-card fields. Detail fields load on demand.

## 10. Security And Compliance

### 10.1 Package Risk Levels

```text
low:
  pure prompt/skill markdown, no scripts, no broad tools

medium:
  declares tools, references external CLI, or workflow execution

high:
  scripts, code assets, shell commands, network/file mutation, generated binaries
```

### 10.2 Review Must Block

Block publish if:

- package contains secrets
- package contains symlink
- manifest missing
- undeclared scripts
- unsafe path
- package exceeds limits
- source license unknown for public redistribution
- install plan references unapproved remote URL

### 10.3 Signatures

Use a signing key controlled by RedBox release infrastructure.

Minimum first version:

- sha256 required
- signature recommended for official packages

Target version:

- signature required for all artifact installs
- desktop verifies signature before extraction

### 10.4 RedSkill Boundary

RedSkill CLI install is not a mirrored artifact install unless Xiaohongshu provides package content and redistribution rights.

Rules:

- RedBox can list curated RedSkill identifiers.
- RedBox can produce install plans using `redskill install`.
- RedBox should not claim it mirrors RedSkill packages unless it actually stores package content in OSS.
- CLI bootstrap must require explicit user confirmation.

## 11. Performance Strategy

### 11.1 API

- Paginate package list.
- Keep list response small.
- Load detail/install plan on demand.
- Cache approved package list for 60-300 seconds.
- Cache category counts separately.

### 11.2 OSS

- Use immutable keys by version.
- Use CDN/domain in front of OSS.
- Set long cache headers for package archives.
- Set short cache headers for manifests.
- Prefer signed temporary URLs only if packages are private or paid.

### 11.3 Sync Jobs

- Run upstream sync asynchronously.
- Deduplicate by `source_id + upstream_identifier + upstream_revision`.
- Do not block client list APIs on upstream sync.
- Store sync errors in DB and surface in admin only.

### 11.4 Desktop

- Use stale-while-revalidate for market list.
- Keep last successful list if refresh fails.
- Verify archive while streaming if possible.
- Do extraction outside global store locks.

## 12. Upstream Adapter Interface

All upstream markets should implement:

```ts
interface SkillMarketUpstreamAdapter {
  sourceType: string;
  discover(sourceConfig): Promise<UpstreamPackageSummary[]>;
  fetchPackage(summary): Promise<UpstreamPackagePayload | InstallOnlyPackage>;
  normalize(payload): Promise<NormalizedSkillPackage>;
  validate(normalized): Promise<ValidationResult>;
}
```

Adapters:

### 12.1 `redbox-official`

- Source: internal repo/package upload
- Install: artifact from OSS
- Review: required, but can auto-approve from trusted CI branch if signed

### 12.2 `redskill-cli`

- Source: curated identifiers now, registry later
- Install: `redskill install <identifier>`
- Artifact: none unless allowed by upstream
- Category: Xiaohongshu

### 12.3 `github`

- Source: repo/ref/path
- Install: mirror artifact from OSS after review
- Never have desktop install directly from arbitrary GitHub by default

### 12.4 `legacy-thrive`

- Source: existing flat JSON registry
- Install: mirror by cloning repo server-side and packaging, not direct client install
- Use as migration compatibility, not strategic source

## 13. AI Runtime Integration

AI should not choose upstream-specific install mechanics.

Expose these app_cli actions:

```text
skills.manage operation=marketplaceList
skills.manage operation=readMarketPackage
skills.manage operation=installFromMarket
```

AI receives normalized package cards:

- package id
- name
- description
- category
- risk level
- install type
- whether user confirmation is required

AI can recommend a skill, but installation remains a user-confirmed host operation.

No natural-language hardcoding:

- Do not force Xiaohongshu skill by matching "小红书" in host layer.
- Use category/package metadata and model decision.
- Host validates package id and install plan.

## 14. Desktop Changes Required

The desktop already has a multi-source modal. After RedBox Market API exists, simplify the product path:

- Default source becomes `RedBox Market`.
- Developer/fallback sources stay behind an advanced section.
- Category tabs come from server.
- Package cards come from server.
- Install button requests server install plan.
- Artifact install uses OSS download URL.
- RedSkill install uses server-provided identifier.

Do not make the desktop UI a full admin marketplace.

## 15. Initial Milestone Plan

### Milestone 1: Backend Schema And Read APIs

Deliver:

- DB migrations
- category seed data
- package list API
- package detail API
- install-plan API
- OSS key conventions

No admin console yet. Seed data manually.

### Milestone 2: OSS Artifact Publish Pipeline

Deliver:

- package validator
- package archive builder
- OSS upload
- sha256 generation
- publish final immutable object
- install plan returns OSS URL

Start with RedBox official packages only.

### Milestone 3: RedSkill Curated Catalog

Deliver:

- `redskill-cli` source type
- admin/manual insert flow
- Xiaohongshu category
- install plan with `redskill install <identifier>`
- desktop CLI status and bootstrap confirmation

This makes Xiaohongshu visible as a category even though upstream has no list API.

### Milestone 4: Review Workflow

Deliver:

- pending review queue
- validation log viewer
- approve/reject/publish actions
- status gating for public list API

### Milestone 5: Community/GitHub Ingestion

Deliver:

- GitHub source adapter
- server-side clone/package
- sandbox validation
- OSS mirror artifact
- review then publish

### Milestone 6: Desktop Simplification

Deliver:

- desktop points to RedBox Market API by default
- advanced local/GitHub source section hidden by default
- package detail drawer
- install event telemetry
- provenance sidecar includes server package id/version

## 16. Verification Matrix

### Backend Tests

- package list filters by category/search/status
- hidden/blocked packages never appear publicly
- install-plan refuses unapproved versions
- OSS key is immutable
- checksum mismatch blocks publish
- RedSkill identifier validation rejects unsafe input
- GitHub package with symlink is rejected
- package with `.env` is rejected
- package over size limit is rejected

### OSS Tests

- upload staging object
- promote/copy to final key
- public/signed URL works
- sha256 object matches artifact
- manifest object is readable
- old version remains available after new version publish

### Desktop Tests

- market list loads from API
- stale list remains on refresh failure
- artifact package installs after sha256 verification
- RedSkill package asks for CLI if missing
- RedSkill install runs only after user action
- provenance sidecar records package id/source/version

### Admin Tests

- reviewer can approve/reject
- approved package appears publicly
- blocked source hides packages
- sync error does not break public market list

## 17. Open Decisions

Need confirm before implementation:

1. Which backend repository owns RedBox Market API.
2. Current production DB engine and migration framework.
3. Existing Aliyun OSS bucket name, region, CDN domain, and credential injection method.
4. Whether packages are public downloads or require signed temporary URLs.
5. Whether RedSkill redistribution is allowed or only identifier install is allowed.
6. Whether market installs require logged-in users in desktop, or anonymous install is allowed.

## 18. Final Recommendation

Build RedBox Market as a server-side marketplace and mirror system:

- DB stores metadata, review state, source identity, install policy, and OSS keys.
- Aliyun OSS stores package artifacts and manifests.
- RedBox Market API returns normalized package cards and explicit install plans.
- Xiaohongshu RedSkill is first integrated as a curated identifier-based category.
- Community/GitHub sources are mirrored server-side after validation and review.
- Desktop becomes a thin installer and browser for RedBox-approved packages.

This gives RedBox control over reliability, auditability, China download speed, and future marketplace expansion without locking the client to any single upstream market.
