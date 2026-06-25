# Browser Troubleshooting

Use `pnpm diagnose:browser-control -- --no-fail` from `Plugin/` to inspect the local browser-control chain.

The expected chain is:

```text
agent browser-client or MCP server -> native-host socket -> Chrome native messaging -> Beav extension -> page/content script
```

Privacy boundary:

- Browser-control tests must use a temporary profile and `--use-mock-keychain`; they must not ask for the macOS login keychain or a real browser safe-storage secret.
- If macOS shows a prompt such as `Chromium wants to use Chromium Safe Storage`, deny it and fix the launch flags/profile isolation.
- Stable Google Chrome is not used by smoke tests unless explicitly requested with `--allow-stable-chrome`.
- The smoke test overrides the endpoint-state path and restores native messaging manifests after it exits.
- Clipboard reads, history search, and broad browser context reads expose local user data. They require explicit typed user intent in the App and should not be marked as no-approval tools in external MCP configs.
- A web fetch, HTTP reader, search API, or screenshot-only flow is not browser control. Browser control is only healthy when calls flow through the Beav MCP/native-host socket into the installed Chrome extension.

Native host launcher:

- Real Google Chrome is often launched from Finder with a minimal PATH. Its native messaging manifest must point to the generated launcher at `~/Library/Application Support/RedBox/native-host/com.redbox.browser_control.launcher.sh`, not directly to `native-host/host.mjs`.
- The launcher executes `host.mjs` with an absolute Node path. Install with `pnpm install:native-host -- --node /absolute/path/to/node` when the current shell Node is not the runtime Chrome should use.
- If extension storage shows `Native host has exited.` immediately after `connect.started` / `connected`, check for a manifest that points directly at `host.mjs` or a launcher whose Node path no longer exists.
- `host_path_uses_env_node_script` means the manifest still depends on `#!/usr/bin/env node`; reinstall the native host.

Common failure states:

- `extension_not_found`: Beav is not loaded in a known Chrome, Chromium, Edge, or Brave profile.
- `no_native_host_manifest`: Chrome cannot launch `com.redbox.browser_control`.
- `launcher_missing` / `launcher_not_executable`: native messaging manifest may be valid, but GUI Chrome cannot start the host launcher.
- `host_path_uses_env_node_script`: manifest points directly at `host.mjs`; GUI Chrome may start it without a Node PATH and the host exits immediately.
- `endpoint_state_missing`: the native host has not published its current socket state.
- `endpoint_state_stale`: the socket state is old; restart the extension/native host connection.
- `socket_missing`: the endpoint points to a socket that no longer exists.
- `extension_forwarding_failed`: the native host socket responded, but the extension did not answer browser-control tool calls.
- Tool results that show only `capabilities.toolsResponse.tools` and end with `[truncated by ToolResultBudget]` are not page-read failures. They mean the App facade returned a full MCP capability snapshot before the action result, so the model never saw the real `tab.info` / `page.queryElements` payload.

Validation commands:

```bash
pnpm build
pnpm verify
pnpm install:native-host -- --node /absolute/path/to/node
pnpm diagnose:browser-control -- --json --no-fail
pnpm diagnose:browser-control -- --require-connected
```

For development, load `Plugin/dist/extension` as an unpacked extension, install the native host with the actual extension id or let the installer discover it, then run the connected diagnosis. Reload the unpacked extension after rebuilding `dist/extension`; Chrome does not reliably reload changed service-worker code just because files changed on disk.

Real Chrome acceptance:

- `pnpm smoke:browser-control` proves the isolated regression path only.
- A real Chrome acceptance run must use the user's installed Google Chrome profile, the installed Beav extension, the native host launcher, and `pnpm diagnose:browser-control -- --require-connected`.
- At least one MCP/tool call should verify `tabs.list`, `tab.info`, `page.queryElements`, and one controlled interaction such as `page.click` or `page.type` on a safe test page.
- Active controlled tabs should show the in-page `Beav 控制中` badge and an active favicon marker. If DOM actions work but the badge is missing, check `AGENT_CONTROL_BADGE`, `GET_AGENT_CONTROL_BADGE_STATE`, and tab lease events.
