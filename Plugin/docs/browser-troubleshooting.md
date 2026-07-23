# Browser Troubleshooting

The complete production error-action matrix, state/log locations, compatibility table, release gate, and rollback procedure are in [`../../desktop/docs/browser-control-production-runbook.md`](../../desktop/docs/browser-control-production-runbook.md).

Use `pnpm diagnose:browser-control -- --no-fail` from `Plugin/` to inspect the local browser-control chain.

The expected chain is:

```text
agent typed browser action -> Browser Client/MCP adapter -> authenticated loopback endpoint -> Beav Native Host -> Chrome native messaging -> Beav extension -> page/content script
```

Privacy boundary:

- Browser-control tests must use a temporary profile and `--use-mock-keychain`; they must not ask for the macOS login keychain or a real browser safe-storage secret.
- If macOS shows a prompt such as `Chromium wants to use Chromium Safe Storage`, deny it and fix the launch flags/profile isolation.
- Stable Google Chrome is not used by smoke tests unless explicitly requested with `--allow-stable-chrome`.
- The smoke test overrides `HOME`, endpoint state, registry, Native Messaging manifests, and the browser profile into one temporary root. It never writes a test manifest into the real user profile.
- Clipboard reads, history search, and broad browser context reads expose local user data. They require explicit typed user intent in the App and should not be marked as no-approval tools in external MCP configs.
- A web fetch, HTTP reader, search API, or screenshot-only flow is not browser control. Browser control is only healthy when the Native Host `ping` handshake and an extension-forwarded action both succeed.

Native Host installation:

- 正式桌面端启动时会在 macOS / Windows / Linux 对账 Chrome、Edge、Brave 的 manifest；manifest 直接指向当前 Beav 可执行文件，不依赖 GUI 浏览器的 Node/PATH。
- 宿主只接受 `browser-control.identity.json` 声明的官方扩展 origin。扩展 ID 由 manifest 固定公钥稳定生成，开发构建与商店构建必须一致。
- 每个浏览器连接生成独立 `instanceId`、随机 loopback 端口和 auth token。descriptor 在 `~/Library/Application Support/RedBox/native-host/browser-control-agent-endpoints/`，聚合 registry 为 `browser-control-hosts-v2.json`；旧 singleton endpoint 只用于兼容读取。
- 扩展只有收到 Native Host `ping` 回包后才显示 `connected`。单纯获得 `chrome.runtime.Port` 不再视为连接成功。
- `pnpm install:native-host` 只用于开发态 Node fallback 或旧版本排障。

Common failure states:

- `extension_not_found`: Beav is not loaded in a known Chrome, Chromium, Edge, or Brave profile.
- `no_native_host_manifest`: Chrome cannot launch `com.redbox.browser_control`.
- `host_missing` / `host_not_executable`: manifest 存在，但指向的 Beav 可执行文件已移动或不可执行。
- `endpoint_state_missing`: Native Host 尚未完成握手并发布端点。
- `endpoint_state_stale`: heartbeat 过期；一次 repair 会清理 stale descriptor 并重新对账 manifest。
- `endpoint_registry_stale`: v2 registry 包含已关闭实例；客户端会跳过过期/不可连接端点，不会盲选 singleton。
- `endpoint_auth_failed`: descriptor token 与端点不匹配；禁止无 token 访问 loopback RPC。
- `extension_forwarding_failed`: Native Host 可响应，但扩展没有回答 browser-control action。
- Tool results that show only `capabilities.toolsResponse.tools` and end with `[truncated by ToolResultBudget]` are not page-read failures. They mean the App facade returned a full MCP capability snapshot before the action result, so the model never saw the real `tab.info` / `page.queryElements` payload.

Typed runtime errors are not interchangeable with the diagnostic labels above. In particular, `BROWSER_EXTENSION_NOT_INSTALLED`, `NATIVE_HOST_NOT_REGISTERED`, `BROWSER_EXTENSION_RELOAD_REQUIRED`, `BROWSER_INSTANCE_SELECTION_REQUIRED`, `BROWSER_INSTANCE_DISCONNECTED`, `BROWSER_PROTOCOL_MISMATCH`, `BROWSER_LOGIN_REQUIRED`, `BROWSER_SECURITY_CHALLENGE`, `BROWSER_CLEANUP_INCOMPLETE`, and `BROWSER_AUTHENTICATION_FAILED` each have a distinct recovery path. Do not collapse them into “socket missing” or repeat repair indefinitely.

Site-research failures:

- `SITE_CAPABILITY_VERSION_MISMATCH`: Desktop and the loaded extension disagree on `capabilityVersion` or `extractorSchemaHash`. Rebuild plus reload `Plugin/dist/extension`; changing files on disk does not reload the MV3 service worker.
- A run that repeats the same extract result after scrolling usually indicates sub-actions reused one `callId`. Current Desktop Runner assigns `<parent>:research:<step>:<action>`; inspect transcript and lifecycle ledger for duplicate child IDs before changing selectors.
- `waiting_for_user` with `login_required` or `security_verification_required` is not a failed connection. Complete the action in the retained handoff tab, then resume the same `runId` with `retryStage=browser`.
- `partial` with saved `redbox://browser-runs/<runId>/...` artifacts means browser evidence was preserved. Retry only Knowledge ingest when the failure is `knowledge_ingest_failed`; do not repeat paid download/OCR/ASR work.
- `BROWSER_CLEANUP_INCOMPLETE` after a successful result keeps the business result but marks the run partial. Check tab leases, debugger attachments, and terminal lifecycle records; cleanup is idempotent.
- `BROWSER_PAGE_INTERACTION_REQUIRED` means an observed Xiaohongshu/Douyin card URL was sent to direct navigation. Return to the originating results/author page and click the visible card; do not retry the href in a background tab.
- `content_unavailable` or a `/404` detail surface is a terminal item failure, not login/security handoff and never valid Knowledge evidence.

Desktop is the macro owner. A current Xiaohongshu/Douyin research trace should show source `tab.create/claim`, `page.waitForLoadState`, `research.run(submit_search|extract|apply_filters|open_item|close_item|download_media)`, bounded `page.scroll`, and terminal `tabs.finalize`. It must not show a detail `tab.create` using the extracted card href. One extension-side `research.run(macro)` call is a legacy path and is not current-build acceptance.

Validation commands:

```bash
pnpm build
pnpm verify
pnpm test:browser-control-faults
pnpm test:browser-control-binding
pnpm diagnose:browser-control -- --json --no-fail
pnpm diagnose:browser-control -- --require-connected
pnpm smoke:browser-control -- --host-path <path-to-beav> --fault-matrix --timeout-ms 30000
```

`smoke:browser-control` defaults to the built Rust `desktop/src-tauri/target/debug/beav` Host and fails closed when it is missing. `--allow-js-host` is an explicit compatibility-only fallback. The isolated fault matrix covers stale descriptor cleanup, timeout with a late response, Host kill/socket disconnect with endpoint rotation, and MV3 service-worker restart with stable `extensionInstanceId`. Full extension reload is intentionally reserved for the installed-extension acceptance path: Chromium's `--load-extension` mode unloads the command-line extension when its developer reload control is used, so that result cannot represent a store-installed extension reload.

For development, load `Plugin/dist/extension` as an unpacked extension, start Beav once so it reconciles the Native Host manifest, then run the connected diagnosis. Reload the unpacked extension after rebuilding `dist/extension`; Chrome does not reliably reload changed service-worker code just because files changed on disk.

Real Chrome acceptance:

- `pnpm smoke:browser-control` proves the isolated regression path only.
- A real Chrome acceptance run must use the user's installed Google Chrome profile, the official-ID Beav extension, the Beav Native Host binary, and `pnpm diagnose:browser-control -- --require-connected`.
- At least one MCP/tool call should verify `tabs.list`, `tab.info`, `page.queryElements`, and one controlled interaction such as `page.click` or `page.type` on a safe test page.
- Active controlled tabs should show the in-page `Beav 控制中` badge and an active favicon marker. If DOM actions work but the badge is missing, check `AGENT_CONTROL_BADGE`, `GET_AGENT_CONTROL_BADGE_STATE`, and tab lease events.
- With more than one Chrome profile, verify `agent.browsers.list()` reports distinct `extensionInstanceId` values and call `agent.browsers.get(id)` before the tab workflow. The default `extension` alias intentionally fails with `BROWSER_INSTANCE_SELECTION_REQUIRED` when discovery is ambiguous.
- For research acceptance, verify browser info reports site-research contract `6`, then run Xiaohongshu query/filter/limit, Xiaohongshu author/content/comments, Douyin search/author/content, and one Agent -> artifact -> Knowledge loop. Confirm each social detail was entered by `open_item`, restored by `close_item`, and every child `callId`, tab, and debugger reaches a terminal state.
