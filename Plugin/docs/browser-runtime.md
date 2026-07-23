# Beav Browser Runtime

Desktop/Extension production compatibility, diagnostics, release gates, and privacy boundaries are documented in [`../../desktop/docs/browser-control-production-runbook.md`](../../desktop/docs/browser-control-production-runbook.md). This file defines the developer-facing browser facade; it is not a second discovery/retry/selection truth.

Use this as the supported agent-side browser surface. It mirrors Codex Browser Use shape while routing through Beav Browser Control.

```js
const { setupBrowserRuntime } = await import("/Users/Jam/LocalDev/GitHub/RedConvert/Plugin/scripts/browser-client.mjs");
await setupBrowserRuntime({ globals: globalThis });
const browser = await agent.browsers.get("extension");
await browser.nameSession("inspect trends");
const tab = await browser.tabs.new();
await tab.goto("https://trends.google.com/trends/");
const snapshot = await tab.playwright.domSnapshot();
await browser.tabs.finalize({ keep: [] });
```

## API

- `agent.browsers.list()` discovers every live Native Messaging host endpoint and returns one browser per connected Chrome extension instance. Each browser id is the stable `extensionInstanceId` when available, otherwise its host instance id.
- `agent.browsers.get("extension")` is accepted only when discovery finds exactly one browser instance. With multiple profiles/browsers it throws `BROWSER_INSTANCE_SELECTION_REQUIRED`; pass an id returned by `list()` to bind explicitly.
- A browser facade binds to the stable `extensionInstanceId`, not a transient Native Host endpoint. Host rotation therefore preserves the selected profile, while a missing bound instance fails with `BROWSER_INSTANCE_DISCONNECTED` and never falls back to another account.
- `agent.documentation.get("api")`, `agent.documentation.get("playwright")`, and `agent.documentation.get("browser-troubleshooting")` return packaged docs.
- `browser.documentation()` returns this document.
- `browser.nameSession(name)` names the current browser-control session before tab work.
- `browser.user.openTabs()` lists current user tabs.
- `browser.user.claimTab(tab)` claims a tab returned by `openTabs()`.
- `browser.user.history({ query, limit })` reads bounded browser history metadata.
- `browser.tabs.new({ url, active })` creates a controlled tab.
- Claimed or newly created active tabs show a small non-interactive `Beav 控制中` page badge until the tab is finalized, released, or the turn ends.
- `browser.tabs.get(id)` returns a controlled tab facade.
- `browser.tabs.selected()` returns the active tab when available.
- `browser.tabs.finalize({ keep })` closes or releases tabs at the end of the task.
- `tab.goto(url)`, `tab.back()`, `tab.forward()`, `tab.reload()`, `tab.close()`, `tab.url()`, `tab.title()`, and `tab.screenshot()` map to Beav browser-control tools.
- `tab.playwright.locator(selector)`, `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`, and `getByTestId` create locator facades.
- Locator methods include `count`, `allTextContents`, `innerText`, `textContent`, `isEnabled`, `isVisible`, `getAttribute`, `click`, `dblclick`, `fill`, `type`, `press`, `check`, `uncheck`, `setChecked`, `selectOption`, and `waitFor`.
- `tab.cua` exposes coordinate mouse and keyboard primitives.
- `tab.dom_cua` exposes DOM snapshot and node-id actions.
- `tab.clipboard` exposes browser clipboard reads and writes.
- `tab.dev.logs()` reads captured console logs.

## Site research

Production Agent work uses Desktop `capture.collect` with `mode: "browser_research"`. The Desktop Research Runner owns navigation, login/security handoff, typed filters, bounded scrolling, item opening/restoration, partial failure, media handoff, artifact persistence, Knowledge ingest, Resume, and terminal tab cleanup.

```json
{
  "action": "capture.collect",
  "payload": {
    "mode": "browser_research",
    "researchOperation": "search",
    "site": "xiaohongshu",
    "query": "AI 浏览器",
    "filters": { "publishTime": "week" },
    "limit": 10,
    "depth": "standard"
  }
}
```

The extension-side `research.run` contract exposes `submit_search`, `extract`, `apply_filters`, `open_item`, `close_item`, and `download_media` execution modes for the Desktop Runner. `open_item` re-locates the exact card on the source page and dispatches a visible UI click; it may observe and claim a child tab created by the site, but it never constructs or directly navigates to the card URL. `close_item` closes the child tab or restores the original result surface. Extension `macro` mode remains only for old Desktop/JS facade compatibility and must not become a second production state machine.

Current capability contract `6` supports:

- Xiaohongshu and Douyin: `search`, `author_scan`, `content_scan`;
- YouTube and generic Web: `content_scan`;
- typed Xiaohongshu/Douyin filters: `sort`, `contentType`, `publishTime`.
- Xiaohongshu/Douyin detail opening mode `page_click`; direct-card-URL fallback is forbidden.

Media collection is candidate-first. Extractors attach dimensions, visibility, semantic role, article context, and a relevance score; Desktop applies the typed `mediaTypes`, `mediaLimit`, `minMediaWidth`, and `minMediaHeight` policy before invoking `download_media`. Downloads use a run-owned staging path, reserve time to return before the outer browser action deadline, cancel and remove timed-out files, and are removed from staging after Desktop has copied them into the controlled browser-run artifact directory. Desktop writes an evidence checkpoint before the first download, so a later media failure still leaves a readable partial manifest.

Every response carries `capabilityVersion` and `extractorSchemaHash`. Desktop fails closed on drift, so rebuilding the extension is not enough: reload `Plugin/dist/extension` in the target browser before current-build acceptance. Site research is read-only at the browser layer; it never publishes, submits, likes, follows, comments, or changes remote content.

## Discipline

- 普通 Agent 优先调用 `browser.connection.status/repair`、`browser.tabs.list`、`browser.tab.open/claim`、`browser.page.inspect/click/type` 和 `browser.tabs.finalize`；本页 JS facade 主要用于运行时与开发集成。
- 连接失败时只允许先调用一次 `browser.connection.repair` 再重试原动作一次；仍失败就返回结构化 blocker，不要让 Agent 用 shell 搜索 socket、manifest 或浏览器进程。
- Name a session before sustained browser work.
- Prefer DOM snapshots and locator reads before screenshots.
- Before click, fill, select, or press, verify the locator is unique unless uniqueness is obvious.
- After interactions, collect the cheapest state check that answers the next decision.
- Call `browser.tabs.finalize({ keep })` before ending a browser task.

## Compatibility contract

The current checkout uses descriptor schema `2`, browser protocol `3`, site-research contract `6`, and published extension id `dhfphfekcjahljnefpdjoidehnhhoeie`. A protocol or site-capability mismatch fails closed. The Rust BrowserClient owns production discovery, instance binding, repair, retry, cancellation, and lifecycle state; Desktop Research Runner owns research macro orchestration; this JavaScript facade remains a development/external adapter.
