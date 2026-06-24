# RedBox ACP Agent Gateway Usage

This guide is for external agents such as Codex, Hermes, OpenClaw, or a shell-based automation agent that wants to talk to RedBox Creator Agent.

## Enable Gateway

1. Open RedBox Settings.
2. Go to Remote / API.
3. Enable ACP Gateway.
4. Keep Local Only enabled unless you are explicitly testing network access.
5. If Require Token is enabled, create a client token and pass it as `REDBOX_ACP_TOKEN` or `Authorization: Bearer <token>`.

Default endpoint:

```bash
http://127.0.0.1:31937/acp/v1
```

The port can be changed in RedBox settings. External agents should not hard-code it when discovery data is available.

## Discovery

Stable local discovery file:

```bash
# macOS
~/Library/Application Support/RedBox/acp-gateway.json

# Windows
%APPDATA%\RedBox\acp-gateway.json

# Linux
$XDG_CONFIG_HOME/RedBox/acp-gateway.json
# or ~/.config/RedBox/acp-gateway.json
```

RedBox updates this file when the assistant daemon starts or stops. It contains:

- `endpointUrl`: the current ACP base endpoint, such as `http://127.0.0.1:31937/acp/v1`
- `manifestUrl`: machine-readable capability contract
- `guideUrl`: LLM-readable conversation procedure
- `listening`: whether the local daemon was listening when the file was written
- `authRequired`: whether the caller must pass `REDBOX_ACP_TOKEN` / `Authorization: Bearer <token>`

Recommended discovery flow:

1. Read `REDBOX_ACP_DISCOVERY_FILE` if it is set.
2. Otherwise read the platform default `acp-gateway.json`.
3. If the file is absent, try the default local endpoint.
4. Read `manifestUrl`, then `guideUrl`.
5. Use `endpointUrl + /runs` for normal turns.

Machine-readable manifest:

```bash
curl http://127.0.0.1:31937/.well-known/redbox-agent.json
```

LLM-readable guide:

```bash
curl http://127.0.0.1:31937/acp/v1/guide
```

External agents should read both. The manifest gives endpoints and capabilities; the guide gives the conversation procedure.

## CLI Helper

The thin helper lives at:

```bash
node desktop/scripts/redbox-acp-client.mjs
```

From the repo root:

```bash
node desktop/scripts/redbox-acp-client.mjs discover
node desktop/scripts/redbox-acp-client.mjs manifest
node desktop/scripts/redbox-acp-client.mjs guide
```

The helper automatically prefers the discovery file before falling back to `http://127.0.0.1:31937/acp/v1`.

With token enforcement:

```bash
export REDBOX_ACP_TOKEN="rbacp_..."
node desktop/scripts/redbox-acp-client.mjs manifest
```

Create a session:

```bash
node desktop/scripts/redbox-acp-client.mjs session create \
  --client-name Codex \
  --title "Xiaohongshu video material plan" \
  --objective "Plan a short video from RedBox materials"
```

Send a message into an existing ACP session:

```bash
node desktop/scripts/redbox-acp-client.mjs send \
  --client-name Codex \
  --session-id acp-session-... \
  --prompt "Use recent collected comments to draft a topic brief."
```

Start a run. Omit `--session-id` to auto-create an ACP session:

```bash
node desktop/scripts/redbox-acp-client.mjs run \
  --client-name Codex \
  --prompt "Create a brief, outline, references, and next actions for a 60-second video."
```

Poll status and events:

```bash
node desktop/scripts/redbox-acp-client.mjs run get --run-id acp-run-...
node desktop/scripts/redbox-acp-client.mjs events --run-id acp-run-... --limit 100
```

Continue from a cursor:

```bash
node desktop/scripts/redbox-acp-client.mjs events \
  --run-id acp-run-... \
  --cursor acp-event-... \
  --limit 100
```

Read an artifact:

```bash
node desktop/scripts/redbox-acp-client.mjs artifact --artifact-id acp-artifact-...
```

## Session Rules

- If no target is provided, RedBox creates a new ACP session and chat projection. It may also create an internal coordination record for runtime delivery, but that record is not a user-facing Team item.
- Reuse `sessionId` or `acpSessionId` to continue a conversation.
- Use `attachTo.type=collab_session` to bind to an existing RedBox collaboration session.
- Use `attachTo.type=project_ref` to bind to an existing project reference.
- Direct writes to arbitrary normal chat/runtime sessions are rejected in ACP v1.

## Codex Prompt

Use this instruction inside Codex when you want it to collaborate with RedBox:

```md
You can collaborate with RedBox Creator Agent through the local ACP gateway.

Endpoint: http://127.0.0.1:31937/acp/v1
Manifest: http://127.0.0.1:31937/.well-known/redbox-agent.json
Guide: http://127.0.0.1:31937/acp/v1/guide

Prefer discovering the current endpoint from ~/Library/Application Support/RedBox/acp-gateway.json. If it is absent, use the default local endpoint above. First read the manifest and guide. Create or reuse an ACP session, send creator tasks as messages or runs, poll run events with cursor/limit, and reuse returned sessionId/acpSessionId for follow-up turns. Use RedBox for self-media material context, topic briefs, manuscript planning, cover/video planning, and project packaging.
```

If token enforcement is enabled, provide the token through the shell environment rather than embedding it in prompts:

```bash
export REDBOX_ACP_TOKEN="rbacp_..."
```

## Expected Output

For P0, external agents should expect:

- run status: `queued`, `running`, `completed`, `failed`, `cancelled`, or `expired`
- approval status: `awaiting_approval` with `run.approval.id` and `run.approval.requestedCapability`
- event polling through `nextCursor` and `hasMore`
- artifact references through `artifactRefs`
- a user-visible RedBox conversation row with a source label such as `<client>`
- no auto-created Team / Workboard row; external-agent communication belongs in the conversation list

When Creator Agent returns JSON or fenced JSON with `artifact` / `artifacts`, RedBox creates structured artifact refs and also keeps the full text response as a `text_response` artifact.

Media generation, publishing, paid generation, deletion, browser control, and external file writes remain approval-gated or future capabilities.
