# Beav plugin for external Agents

Connect Codex Desktop or WorkBuddy to local Beav through `beav mcp serve`.
The plugin provides direct workspace resources and native typed business tools,
plus optional messaging and task delegation to the Beav Agent.

Give your Agent the installation instruction at <https://beav.ziz.hk/agent>
or <https://beav.ziz.hk/workbuddy>. It runs `beav extension prepare <host> --output json`,
installs/updates the prepared marketplace through its own supported plugin manager,
and verifies `creator_status`, `workspace_list` and `creator_capabilities`.
Preparing the package is not proof of installation or a live MCP connection.

Preparation starts the local runtime, enables the gateway and creates an independent,
revocable client grant for that host. The default installation authorizes all Beav
business workspaces. Direct calls currently require the session workspace to be active in Beav.
An existing grant is preserved during updates. Use `--reauthorize` only when the
user explicitly requests replacing a missing/revoked grant; replacement revokes the previous host grant.
The private credential file stays outside the plugin package. MCP configuration
contains its path, never a token. Calls cannot silently undo revocation or gateway disablement.

Open the human workspace with `beav open`. This local stdio plugin requires the
host Agent and Beav on the same computer; it does not expose a cloud API.
