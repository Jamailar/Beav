# Beav Browser Runtime

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
- `agent.browsers.get("extension")` keeps the previous default behavior; pass an id returned by `list()` to bind to a specific Chrome profile/extension instance.
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

Use `research.run` for bounded site work instead of guessing selectors in an agent prompt. It is navigation/read-only only and always returns a source tab plus a bounded DOM evidence snapshot.

```js
const research = await browser.research({
  site: 'xiaohongshu',
  operation: 'search',
  query: 'AI 浏览器',
});
```

Current operations are Xiaohongshu `search`, `author_scan`, and `content_scan`, plus Douyin/YouTube `content_scan`. The macro does not publish, submit, or mutate remote content. Persist results through the desktop `capture.collect` action with `mode: "browser_research"`; that path writes the evidence into Knowledge with a stable dedupe key.

## Discipline

- Name a session before sustained browser work.
- Prefer DOM snapshots and locator reads before screenshots.
- Before click, fill, select, or press, verify the locator is unique unless uniqueness is obvious.
- After interactions, collect the cheapest state check that answers the next decision.
- Call `browser.tabs.finalize({ keep })` before ending a browser task.
