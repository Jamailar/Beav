use serde_json::{json, Value};

use crate::AppStore;

pub(crate) fn guide_markdown(store: &AppStore) -> String {
    let base_url = format!(
        "http://{}:{}",
        store.assistant_state.host.trim(),
        store.assistant_state.port
    );
    format!(
        r#"# RedBox ACP Guide

RedBox exposes a local Agent Communication Protocol for general AI agents that need a creator-side material library and content production partner.

Base URL: `{base_url}`

## Discover

Preferred local discovery file:

- macOS: `~/Library/Application Support/RedBox/acp-gateway.json`
- Windows: `%APPDATA%\RedBox\acp-gateway.json`
- Linux: `$XDG_CONFIG_HOME/RedBox/acp-gateway.json` or `~/.config/RedBox/acp-gateway.json`

Read that file first when available. It contains the current `manifestUrl`, `guideUrl`, and `endpointUrl`, so external agents do not need to assume a fixed port.

- `GET /.well-known/redbox-agent.json`
- `GET /acp/v1/manifest`
- `GET /acp/v1/guide`

## Start Or Continue A Conversation

Create a new ACP-labeled RedBox conversation:

```json
POST /acp/v1/sessions
{{
  "client": {{ "name": "Codex", "kind": "coding_agent" }},
  "title": "Short video material plan",
  "objective": "Plan a Xiaohongshu video from existing RedBox materials"
}}
```

Continue a known ACP session by passing `sessionId` or `acpSessionId`.

Attach to an existing RedBox collaboration session:

```json
{{
  "attachTo": {{ "type": "collab_session", "id": "collab-session-..." }}
}}
```

Direct writes to arbitrary normal chat/runtime sessions are rejected in v1. Use ACP sessions or collaboration sessions.

## Ask RedBox AI To Work

```json
POST /acp/v1/runs
{{
  "client": {{ "name": "Codex", "kind": "coding_agent" }},
  "sessionId": "acp-session-...",
  "prompt": "Find reusable product images and draft a 60-second video outline. Return concrete material refs."
}}
```

If `sessionId` is omitted, RedBox auto-creates a session. The conversation appears in the RedBox chat list with a source label such as `<client>`.

Poll:

- `GET /acp/v1/runs/{{run_id}}`
- `GET /acp/v1/runs/{{run_id}}/events`

If a run returns `status=awaiting_approval`, wait for the RedBox user to resolve the approval before starting a new run. Paid generation, browser control, deletion, publishing, and external export are approval-gated.

Cancel:

- `POST /acp/v1/runs/{{run_id}}/cancel`

## Message Semantics

- External agent messages are stored as RedBox chat `user` messages with `metadata.senderKind=external_agent`.
- RedBox AI responses are stored as chat `assistant` messages with `metadata.senderKind=redbox_creator_agent`.
- ACP message and run IDs are preserved in chat metadata for traceability.

## Expected Prompts

Good prompts include platform, audience, asset references, constraints, and the requested output format. RedBox is best used for material retrieval, creative planning, drafts, cover/video plans, and packaging creator project context.
"#
    )
}

pub(crate) fn guide_value(store: &AppStore) -> Value {
    json!({
        "success": true,
        "contentType": "text/markdown",
        "guide": guide_markdown(store),
        "copyPrompts": {
            "codex": "Read ~/Library/Application Support/RedBox/acp-gateway.json when available, then read manifestUrl and guideUrl. Use /acp/v1/runs to talk to RedBox Creator Agent. Set client.name=Codex.",
            "hermes": "Discover RedBox from acp-gateway.json or http://127.0.0.1:31937/acp/v1. Read /guide first. Set client.name=Hermes.",
            "openclaw": "Connect to RedBox Creator Agent through discovered endpointUrl + /runs. Omit sessionId to auto-create an ACP-labeled RedBox session. Set client.name=OpenClaw.",
            "generic": "Discover RedBox from acp-gateway.json, then read manifestUrl and guideUrl, then POST endpointUrl + /runs with client.name and prompt."
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guide_includes_discovery_run_and_continuation_rules() {
        let store = crate::persistence::default_store();
        let guide = guide_markdown(&store);

        assert!(guide.contains("acp-gateway.json"));
        assert!(guide.contains("GET /.well-known/redbox-agent.json"));
        assert!(guide.contains("POST /acp/v1/runs"));
        assert!(guide.contains("sessionId"));
        assert!(
            guide.contains("Direct writes to arbitrary normal chat/runtime sessions are rejected")
        );
    }
}
