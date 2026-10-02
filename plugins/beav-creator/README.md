# Beav plugin for external Agents

Connect Codex Desktop or WorkBuddy to local Beav through `beav mcp serve`.
The plugin provides direct workspace resources and native typed business tools,
plus optional messaging and task delegation to the Beav Agent.

Give your Agent the installation instruction at <https://beav.ziz.hk/agent>
or <https://beav.ziz.hk/workbuddy>. It runs `beav extension prepare <host> --output json`,
installs/updates the prepared marketplace through its own supported plugin manager,
and verifies `creator_status`, `workspace_list` and `creator_capabilities`.
Preparing the package is not proof of installation or a live MCP connection.
For WorkBuddy, validate the prepared marketplace and plugin, add the marketplace
if needed, then install `beav-creator@beav-local` with its bundled CodeBuddy CLI.
After a Beav upgrade, update that marketplace and plugin, run `/reload-plugins`,
and verify the installed cache's manifest version and MCP command against the
prepare result. The prepared plugin version follows the Beav release because
WorkBuddy keeps immutable versioned plugin snapshots. If only Beav's install
path changed, reinstall the same plugin through WorkBuddy's plugin manager.

Codex preparation can start the local runtime when the host permits it. If the
Codex command sandbox blocks runtime startup or local file writes, run the
installed Beav executable's `open --output json` and then
`extension prepare codex --output json` from a normal terminal, and give Codex
only the returned `marketplacePath`. WorkBuddy preparation requires an already
responding runtime; use those same two terminal commands with `workbuddy` as
the prepare target before continuing installation in WorkBuddy. Preparation
enables the gateway and creates an independent, revocable client grant for
that host. The default installation authorizes all Beav
business workspaces. Direct calls currently require the session workspace to be active in Beav.
An existing grant is preserved during updates. Use `--reauthorize` only when the
user explicitly requests replacing a missing/revoked grant; replacement revokes the previous host grant.
The private credential file stays outside the plugin package. MCP configuration
contains its path, never a token. Calls cannot silently undo revocation or gateway disablement.

Open the human workspace with `beav open`. This local stdio plugin requires the
host Agent and Beav on the same computer; it does not expose a cloud API.
