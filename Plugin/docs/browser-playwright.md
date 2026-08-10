# Browser Playwright

Beav exposes a limited Playwright-shaped API through `tab.playwright`. It is not full upstream Playwright.

- Use `domSnapshot()` for orientation and locator construction.
- Use locators for scoped checks and actions.
- Use `count()` before actions when a locator may match multiple elements.
- Do not retry a failing locator without a fresh `domSnapshot()`.
- Prefer stable attributes in this order: `data-testid`, stable `data-*`, stable `href`, role plus accessible name, scoped text, scoped CSS.
- `evaluate()` is routed through browser-control policy and may require approval because arbitrary JavaScript can mutate state.

Locator composition is serialized as a bounded data AST and resolved inside the content runtime; it never sends a generated JavaScript selector chain through the Native Host. Supported roots are CSS, role/name, text, label, placeholder, and test id. A locator may be scoped with `filter`, combined with `and`/`or`, or indexed with `first`/`last`/`nth`.

Singleton reads and mutations are strict by default: zero or multiple matches return `locator_strict_mode_violation`. Collection methods (`count`, `all`, `allTextContents`) explicitly disable singleton strictness. Keep composed locators in the same tab/frame scope; do not use a locator result after navigation or a DOM-changing action without another bounded read.

Supported page methods:

- `domSnapshot()`
- `evaluate(pageFunction, arg, options)`
- `expectNavigation(action, options)`
- `frameLocator(selector)`
- `getByLabel(text, options)`
- `getByPlaceholder(text, options)`
- `getByRole(role, options)`
- `getByTestId(testId)`
- `getByText(text, options)`
- `locator(selector)`
- `waitForLoadState(options)`
- `waitForTimeout(timeoutMs)`
- `waitForURL(url, options)`

Supported locator methods:

- `all`, `allTextContents`, `count`, `filter`, `and`, `or`, `first`, `last`, `nth`
- `innerText`, `textContent`, `isEnabled`, `isVisible`, `getAttribute`
- `click`, `dblclick`, `fill`, `type`, `press`
- `check`, `uncheck`, `setChecked`, `selectOption`, `waitFor`
