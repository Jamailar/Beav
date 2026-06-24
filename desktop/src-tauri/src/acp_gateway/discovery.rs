use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::json_util::write_json_pretty;
use crate::persistence::with_store;
use crate::{app_brand_display_name, now_i64, AppState, AppStore};

use super::manifest::assistant_base_url;

pub(crate) fn acp_discovery_file_path(store_path: &Path) -> Result<PathBuf, String> {
    let root = store_path
        .parent()
        .ok_or_else(|| format!("{} store root is unavailable", app_brand_display_name()))?;
    Ok(root.join("acp-gateway.json"))
}

pub(crate) fn acp_discovery_value(store: &AppStore, listening: bool) -> Value {
    let base_url = assistant_base_url(store);
    let acp = &store.acp_gateway;
    let endpoint_url = format!("{base_url}{}", acp.endpoint_path);
    let manifest_url = format!("{base_url}/.well-known/redbox-agent.json");
    let guide_url = format!("{base_url}{}", acp.guide_path);
    json!({
        "schemaVersion": "redbox.acp.discovery.v1",
        "agentId": "redbox.creator-agent",
        "name": "RedBox Creator Agent",
        "description": "Local ACP discovery entry for external agents such as Codex, Hermes, and OpenClaw.",
        "baseUrl": base_url,
        "endpointUrl": endpoint_url,
        "manifestUrl": manifest_url,
        "guideUrl": guide_url,
        "enabled": acp.enabled,
        "listening": listening,
        "localOnly": acp.local_only,
        "authRequired": acp.require_token,
        "updatedAt": now_i64(),
        "nextSteps": [
            "GET manifestUrl to read the machine-readable capability contract.",
            "GET guideUrl to read the LLM-facing conversation procedure.",
            "POST endpointUrl + /runs with client.name and prompt to talk to RedBox Creator Agent.",
            "Reuse returned sessionId/acpSessionId for follow-up turns."
        ],
        "environment": {
            "baseUrl": "REDBOX_ACP_BASE_URL",
            "token": "REDBOX_ACP_TOKEN"
        }
    })
}

pub(crate) fn refresh_acp_discovery_file(
    app: &AppHandle,
    listening: bool,
) -> Result<PathBuf, String> {
    let state = app.state::<AppState>();
    let path = acp_discovery_file_path(&state.store_path)?;
    let value = with_store(&state, |store| Ok(acp_discovery_value(&store, listening)))?;
    write_json_pretty(&path, &value)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_value_points_to_manifest_and_guide() {
        let store = crate::persistence::default_store();
        let discovery = acp_discovery_value(&store, true);

        assert_eq!(discovery["schemaVersion"], "redbox.acp.discovery.v1");
        assert_eq!(
            discovery["manifestUrl"],
            "http://127.0.0.1:31937/.well-known/redbox-agent.json"
        );
        assert_eq!(discovery["guideUrl"], "http://127.0.0.1:31937/acp/v1/guide");
        assert_eq!(discovery["endpointUrl"], "http://127.0.0.1:31937/acp/v1");
        assert_eq!(discovery["listening"], true);
    }
}
