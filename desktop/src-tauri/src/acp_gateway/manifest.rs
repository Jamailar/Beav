use serde_json::{json, Value};

use crate::AppStore;

pub(crate) fn assistant_base_url(store: &AppStore) -> String {
    let host = store.assistant_state.host.trim();
    if host.is_empty() || store.assistant_state.port <= 0 {
        return "http://127.0.0.1:31937".to_string();
    }
    format!("http://{}:{}", host, store.assistant_state.port)
}

pub(crate) fn manifest_value(store: &AppStore) -> Value {
    let base_url = assistant_base_url(store);
    let acp = &store.acp_gateway;
    json!({
        "schemaVersion": "redbox.acp.v1",
        "agent": {
            "id": "redbox.creator-agent",
            "name": "RedBox Creator Agent",
            "description": "A local creator agent for self-media asset management, material retrieval, drafting, cover/video planning, and project packaging.",
            "home": base_url,
            "localOnly": acp.local_only,
            "enabled": acp.enabled
        },
        "protocol": {
            "kind": "agent-communication",
            "version": "v1",
            "baseUrl": base_url,
            "auth": {
                "required": acp.require_token,
                "schemes": ["Bearer", "X-Auth-Token"]
            }
        },
        "capabilities": [
            "conversation.session.auto_create",
            "conversation.session.attach_acp",
            "conversation.session.attach_collab",
            "conversation.message.inbound",
            "run.async",
            "run.cancel",
            "approval.awaiting_approval",
            "events.audit_stream",
            "artifacts.text_response",
            "artifacts.structured_response",
            "materials.media_library_context",
            "creator.draft_and_plan"
        ],
        "endpoints": {
            "manifest": format!("{base_url}{}", acp.manifest_path),
            "wellKnown": format!("{base_url}/.well-known/redbox-agent.json"),
            "guide": format!("{base_url}{}", acp.guide_path),
            "sessions": format!("{base_url}{}/sessions", acp.endpoint_path),
            "runs": format!("{base_url}{}/runs", acp.endpoint_path),
            "artifacts": format!("{base_url}{}/artifacts/{{artifact_id}}", acp.endpoint_path)
        },
        "howToTalk": {
            "summary": "Read /acp/v1/guide, then create or attach a session, send user-level requests, and poll run status/events until completed.",
            "recommendedFlow": [
                "GET /.well-known/redbox-agent.json",
                "GET /acp/v1/guide",
                "POST /acp/v1/runs with client.name and prompt; omit sessionId to auto-create an ACP-labeled RedBox conversation",
                "GET /acp/v1/runs/{run_id} until status is completed, failed, or cancelled",
                "Read artifactRefs from the completed run"
            ],
            "conversationRules": [
                "Be explicit about the creator task, platform, audience, and expected output artifact.",
                "Reference existing material IDs or projectRef when available.",
                "Do not ask RedBox to perform paid, destructive, or publishing actions without approval."
            ]
        },
        "sessionRouting": {
            "autoCreate": "Omit sessionId/acpSessionId to create a new ACP session, a Chat projection, and a collaboration session.",
            "explicitAttach": "Pass acpSessionId/sessionId to continue an ACP session, or attachTo.type=collab_session with attachTo.id to bind a collaboration session.",
            "chatProjection": "Every ACP session appears in RedBox chat history with metadata.source=acp and sourceLabel such as Codex."
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_advertises_creator_agent_and_required_routes() {
        let store = crate::persistence::default_store();
        let manifest = manifest_value(&store);

        assert_eq!(manifest["schemaVersion"], "redbox.acp.v1");
        assert_eq!(manifest["agent"]["name"], "RedBox Creator Agent");
        assert_eq!(
            manifest["endpoints"]["wellKnown"],
            "http://127.0.0.1:31937/.well-known/redbox-agent.json"
        );
        assert_eq!(
            manifest["sessionRouting"]["chatProjection"],
            "Every ACP session appears in RedBox chat history with metadata.source=acp and sourceLabel such as Codex."
        );
        assert!(manifest["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item == "run.async"));
    }
}
