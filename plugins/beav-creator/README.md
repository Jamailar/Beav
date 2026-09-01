# Beav Creator Agent Plugin

This host-compatible plugin connects Codex Desktop or WorkBuddy to a locally running Beav workspace through `beav mcp serve`. Its first Creator MCP call uses Beav's owner-authenticated loopback control channel to ensure the Creator Gateway is enabled; browser IPC cannot change that setting.

Install Beav, then give the host Agent the one-line instruction published at <https://beav.ziz.hk/agent> for Codex or <https://beav.ziz.hk/workbuddy> for WorkBuddy. The host asks Beav to prepare its user-local marketplace, installs the returned plugin through its own bundled CLI, and verifies the MCP connection. Beav never searches for or invokes a bare host CLI command from the user's shell.

Open the user interface with `beav open`.

The host Agent delegates work over MCP. The browser UI is a shared user-visible workspace, not an automation channel.
