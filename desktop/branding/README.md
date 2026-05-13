# Brand & Theme System

This app supports multi-brand builds from a single codebase. All page content — displays names, logos, colors, and URLs — follows the active brand variant defined in `brand.config.json`.

## Quick start: add a new brand

1. **Define the variant** — add a new entry under `variants` in `brand.config.json`:

```jsonc
{
  "defaultVariant": "redbox",
  "variants": {
    "mynana": {
      "displayName": "MyNana",
      "aiDisplayName": "MyNana AI",
      "windowTitle": "MyNana",
      "identifier": "com.redconvert.mynana",
      "htmlTitle": "MyNana",
      "downloadUrl": "https://mynana.example.com/download",
      "appIcon": { "png": "branding/variants/mynana/icons/icon.png", ... },
      "logo": "branding/variants/mynana/logo.png",
      "theme": {
        "light": { "accentPrimary": "44 126 88", ... },
        "dark":  { "accentPrimary": "72 210 140", ... }
      }
    }
  }
}
```

2. **Place assets** — drop the icon files and logo in `branding/variants/mynana/`.

3. **Sync & build:**

```bash
pnpm brand:sync -- --variant mynana
pnpm tauri:build
# or for dev:
REDBOX_BRAND=mynana pnpm tauri:dev
```

That's it. Every page picks up the new name, logo, and colors.

---

## brand.config.json reference

### Required fields per variant

| Field | Type | Description |
|-------|------|-------------|
| `displayName` | string | User-facing app name (sidebar, settings, onboarding) |
| `aiDisplayName` | string | Name used in AI-feature contexts (RedClaw, AI panel) |
| `windowTitle` | string | Native window title bar |
| `identifier` | string | Bundle identifier (e.g. `com.redconvert.mynana`) |
| `htmlTitle` | string | HTML `<title>` tag |
| `appIcon` | object | Paths to `.png` / `.icns` / `.ico` icon files |
| `logo` | string | Path to in-app logo PNG |
| `theme` | object | `{ light: {...}, dark: {...} }` color tokens (see below) |

### Optional fields per variant

| Field | Type | Description |
|-------|------|-------------|
| `tagline` | string | Login page tagline (e.g. "自媒体AI工作台") |
| `downloadUrl` | string | App download page (used in Settings > Version) |
| `githubIssuesUrl` | string | GitHub Issues link |
| `githubRepoUrl` | string | GitHub repo link |
| `cargoPackageName` | string | Rust package name in Cargo.toml (defaults to variant key) |

---

## Color theme tokens

Each variant defines `theme.light` and `theme.dark`. Theme values use **space-separated RGB channels** (e.g. `"52 214 107"`) so they work with Tailwind's `rgb(var(--color-xxx) / <alpha-value>)` pattern.

### Only 6 tokens are truly mandatory

A minimal brand (like `redbox`) only needs:

| Token | CSS Variable | Purpose |
|-------|-------------|---------|
| `accentPrimary` | `--color-accent-primary` | Buttons, links, active states |
| `accentHover` | `--color-accent-hover` | Accent hover state |
| `accentMuted` | `--color-accent-muted` | Subtle accent backgrounds |
| `brandRed` | `--color-brand-red` | Brand accent color (secondary) |
| `brandRedText` | `--color-brand-red-text` | Text on brand-red backgrounds |

All other tokens fall back gracefully — the UI uses these only when present.

### Full token set (used by `thrive`-style rich themes)

#### Core surfaces

| Token | CSS Variable | Usage |
|-------|-------------|-------|
| `background` | `--color-background` | Page background |
| `surfacePrimary` | `--color-surface-primary` | Cards, panels, main surfaces |
| `surfaceSecondary` | `--color-surface-secondary` | Secondary surfaces, hover states |
| `surfaceTertiary` | `--color-surface-tertiary` | Elevated subtle surfaces |
| `surfaceElevated` | `--color-surface-elevated` | Highest-elevation surfaces |

#### Text hierarchy

| Token | CSS Variable | Usage |
|-------|-------------|-------|
| `textPrimary` | `--color-text-primary` | Headings, body text |
| `textSecondary` | `--color-text-secondary` | Secondary labels, descriptions |
| `textTertiary` | `--color-text-tertiary` | Muted captions, placeholders |

#### Borders & focus

| Token | CSS Variable | Usage |
|-------|-------------|-------|
| `border` | `--color-border` | Default border color |
| `divider` | `--color-divider` | Subtle dividers |
| `focusRing` | `--color-focus-ring` | Focus ring color |
| `accentBorder` | `--color-accent-border` | Accent-colored border |

#### Primary action colors

| Token | CSS Variable | Usage |
|-------|-------------|-------|
| `primary` | `--color-primary` | Primary button background |
| `primaryHover` | `--color-primary-hover` | Primary button hover |
| `primaryPressed` | `--color-primary-pressed` | Primary button pressed |
| `primaryText` | `--color-primary-text` | Text on primary backgrounds |

#### Status colors

| Token | CSS Variable | Usage |
|-------|-------------|-------|
| `statusSuccess` | `--color-status-success` | Success indicators |
| `statusWarning` | `--color-status-warning` | Warning indicators |
| `statusError` | `--color-status-error` | Error indicators |
| `info` | `--color-info` | Info indicators |

#### Status backgrounds

| Token | CSS Variable |
|-------|-------------|
| `successBg` / `successText` | `--color-success-bg` / `--color-success-text` |
| `warningBg` / `warningText` | `--color-warning-bg` / `--color-warning-text` |
| `dangerBg` / `dangerText` | `--color-danger-bg` / `--color-danger-text` |
| `infoBg` / `infoText` | `--color-info-bg` / `--color-info-text` |

#### App shell (sidebar, cards, AI panel)

| Token | CSS Variable | Value format |
|-------|-------------|-------------|
| `appShellBackground` | `--app-shell-background` | CSS gradient string |
| `sidebarBackground` | `--app-sidebar-background` | rgba or hex |
| `sidebarItemColor` | `--app-sidebar-item-color` | hex |
| `sidebarItemHoverBackground` | `--app-sidebar-item-hover-background` | rgba |
| `sidebarItemHoverColor` | `--app-sidebar-item-hover-color` | hex |
| `sidebarItemActiveBackground` | `--app-sidebar-item-active-background` | rgba |
| `sidebarItemActiveColor` | `--app-sidebar-item-active-color` | hex |
| `sidebarItemActiveIconColor` | `--app-sidebar-item-active-icon-color` | hex |
| `cardShadow` | `--app-card-shadow` | CSS box-shadow string |
| `cardHoverShadow` | `--app-card-hover-shadow` | CSS box-shadow string |
| `aiPanelBackground` | `--ai-panel-background` | CSS gradient string |
| `aiPanelBorder` | `--ai-panel-border` | rgba |
| `aiPanelShadow` | `--ai-panel-shadow` | CSS box-shadow string |
| `aiChipBackground` | `--ai-chip-background` | rgba |
| `aiChipColor` | `--ai-chip-color` | hex |
| `aiChipBorder` | `--ai-chip-border` | rgba |

#### Module-specific accents

| Token | CSS Variable |
|-------|-------------|
| `moduleIdeateBg` / `moduleIdeateIcon` | `--module-ideate-bg` / `--module-ideate-icon` |
| `moduleWriteBg` / `moduleWriteIcon` | `--module-write-bg` / `--module-write-icon` |
| `moduleRepurposeBg` / `moduleRepurposeIcon` | `--module-repurpose-bg` / `--module-repurpose-icon` |
| `moduleScheduleBg` / `moduleScheduleIcon` | `--module-schedule-bg` / `--module-schedule-icon` |
| `moduleAnalyticsBg` / `moduleAnalyticsIcon` | `--module-analytics-bg` / `--module-analytics-icon` |
| `moduleBrandBg` / `moduleBrandIcon` | `--module-brand-bg` / `--module-brand-icon` |

---

## Using brand values in code

### React components

```tsx
import { APP_BRAND } from '../config/brand';

// Display name
<h1>{APP_BRAND.displayName}</h1>

// AI brand name
<span>{APP_BRAND.aiDisplayName} 正在生成...</span>

// Logo
<img src={APP_BRAND.logoSrc} alt={APP_BRAND.displayName} />

// Brand-aware URLs
<a href={APP_BRAND.downloadUrl}>下载</a>
<a href={APP_BRAND.githubRepoUrl}>GitHub</a>

// Variant slug (for API calls, identifiers)
const slug = APP_BRAND.variant; // "redbox" | "thrive" | "mynana"
```

### CSS — Tailwind

```html
<!-- Surfaces -->
<div className="bg-[rgb(var(--color-surface-primary))]">
<div className="bg-[rgb(var(--color-surface-secondary))]">

<!-- Text -->
<p className="text-[rgb(var(--color-text-primary))]">
<span className="text-[rgb(var(--color-text-secondary))]">

<!-- Borders -->
<div className="border border-[rgb(var(--color-border))]">

<!-- Accent (buttons, links) -->
<button className="bg-[rgb(var(--color-accent-primary))] hover:bg-[rgb(var(--color-accent-hover))]">

<!-- With alpha -->
<div className="bg-[rgb(var(--color-accent-primary)/0.12)]">

<!-- Status -->
<span className="text-[rgb(var(--color-status-error))]">
<span className="bg-[rgb(var(--color-success-bg))] text-[rgb(var(--color-success-text))]">
```

### CSS — inline styles

```tsx
<div style={{ background: 'var(--app-shell-background)' }}>
<div style={{ boxShadow: 'var(--app-card-shadow)' }}>
```

### Source ID pattern

```ts
import { OFFICIAL_AUTO_SOURCE_ID } from '../config/aiSources';
// OFFICIAL_AUTO_SOURCE_ID === "redbox_official_auto" (or "thrive_official_auto", etc.)
```

---

## How the sync pipeline works

```
brand.config.json  ──→  sync-brand.mjs  ──→  7+ generated files
```

The script (`desktop/scripts/sync-brand.mjs`) picks the active variant and writes:

| Output | What it sets |
|--------|-------------|
| `src/config/brand.generated.json` | variant, displayName, logoSrc, theme, downloadUrl |
| `src-tauri/tauri.conf.json` | productName, identifier, window title, bundle icons |
| `package.json` | `productName` field |
| `index.html` | `<title>` tag |
| `Cargo.toml` / `Cargo.lock` | package name |
| `public/branding/logo.png` | copies the variant's logo |
| `src-tauri/icons/` | generates `.icns` (macOS) and `.ico` (Windows) |

The generated files are **not committed** for variants other than the default — they're build artifacts.

---

## Commands cheat sheet

```bash
# Sync to default variant (redbox)
pnpm brand:sync

# Sync to thrive
pnpm brand:sync -- --variant thrive
pnpm brand:sync:thrive              # shortcut

# Dev with brand
pnpm dev                            # default (redbox)
pnpm dev:thrive                     # thrive
REDBOX_BRAND=thrive pnpm tauri:dev  # any variant

# Build with brand
pnpm build                          # default
pnpm build:thrive                   # thrive
REDBOX_BRAND=thrive pnpm tauri:build
```

---

## Internal namespaces (do not change)

These identifiers are internal constants — they do NOT affect what brand the user sees and must remain static to avoid breaking existing installs:

- localStorage keys: `redbox:theme-mode:v1`, `redbox:language:v1`, `redbox:layout-sidebar-collapsed:v1`, etc.
- IPC channels: `redbox-auth:*`, `redbox:open-feedback-report`, etc.
- CSS class namespace: `.redbox-editable-timeline__*`
- Rust paths: `~/.redbox/` directory, `redbox-asset://` protocol
- Rust function names: `redbox_project_root()`, `load_redbox_prompt()`
- Rust source ID constant: uses variant name computed at runtime

These were originally named after the first brand (RedBox) and act as stable namespace prefixes. Changing them would orphan user data from prior installs.
