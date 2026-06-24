use std::collections::HashMap;
use std::io::Read;

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::AcpClientRecord;
use crate::AppStore;

use super::errors::AcpHttpError;
use super::make_acp_id;
use super::normalize_acp_path;

fn bearer_or_token(headers: &HashMap<String, String>) -> String {
    let auth = headers
        .get("authorization")
        .or_else(|| headers.get("x-auth-token"))
        .cloned()
        .unwrap_or_default();
    auth.strip_prefix("Bearer ")
        .unwrap_or(&auth)
        .trim()
        .to_string()
}

pub(crate) fn is_public_acp_path(path: &str) -> bool {
    let normalized = normalize_acp_path(path);
    matches!(
        normalized.as_str(),
        "/.well-known/redbox-agent.json" | "/acp/v1/manifest" | "/acp/v1/guide"
    )
}

pub(crate) fn authorize_acp_request(
    store: &AppStore,
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
) -> Result<(), AcpHttpError> {
    if method.eq_ignore_ascii_case("OPTIONS") || is_public_acp_path(path) {
        return Ok(());
    }
    if !store.acp_gateway.enabled {
        return Err(AcpHttpError::forbidden(
            "gateway_disabled",
            "RedBox ACP gateway is disabled.",
        ));
    }
    if !store.acp_gateway.require_token {
        return Ok(());
    }
    let token = bearer_or_token(headers);
    if token.is_empty() {
        return Err(AcpHttpError::unauthorized(
            "ACP gateway requires Authorization: Bearer <token> or X-Auth-Token.",
        ));
    }
    let matched = store.acp_clients.iter().any(|client| {
        !client.disabled
            && client
                .token_hash
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                == Some(token_hash(&token).as_str())
    });
    if !matched {
        return Err(AcpHttpError::unauthorized("ACP token is invalid."));
    }
    Ok(())
}

pub(crate) fn token_hash(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn generate_token_bytes() -> [u8; 32] {
    let mut bytes = [0_u8; 32];
    if let Ok(mut file) = std::fs::File::open("/dev/urandom") {
        if file.read_exact(&mut bytes).is_ok() {
            return bytes;
        }
    }
    let fallback = format!(
        "{}:{}:{}",
        make_acp_id("token"),
        std::process::id(),
        crate::now_i64()
    );
    let digest = Sha256::digest(fallback.as_bytes());
    bytes.copy_from_slice(&digest[..32]);
    bytes
}

pub(crate) fn generate_client_token() -> String {
    let bytes = generate_token_bytes();
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    format!("rbx_acp_{encoded}")
}

fn token_preview(token: &str) -> String {
    let tail = token
        .chars()
        .rev()
        .take(6)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("rbx_acp_...{tail}")
}

pub(crate) fn acp_gateway_public_value(store: &AppStore) -> Value {
    let base_url = format!(
        "http://{}:{}",
        store.assistant_state.host.trim(),
        store.assistant_state.port
    );
    json!({
        "enabled": store.acp_gateway.enabled,
        "requireToken": store.acp_gateway.require_token,
        "localOnly": store.acp_gateway.local_only,
        "endpointPath": store.acp_gateway.endpoint_path,
        "manifestPath": store.acp_gateway.manifest_path,
        "guidePath": store.acp_gateway.guide_path,
        "defaultRuntimeMode": store.acp_gateway.default_runtime_mode,
        "defaultClientLabel": store.acp_gateway.default_client_label,
        "lastError": store.acp_gateway.last_error,
        "activeRunCount": store.acp_gateway.active_run_count,
        "baseUrl": base_url,
        "manifestUrl": format!("{base_url}/.well-known/redbox-agent.json"),
        "guideUrl": format!("{base_url}{}", store.acp_gateway.guide_path),
        "clients": store.acp_clients.iter().map(|client| {
            json!({
                "id": client.id.clone(),
                "name": client.name.clone(),
                "kind": client.kind.clone(),
                "tokenPreview": client.token_preview.clone(),
                "allowedScopes": client.allowed_scopes.clone(),
                "disabled": client.disabled,
                "metadata": client.metadata.clone(),
                "createdAt": client.created_at,
                "updatedAt": client.updated_at,
                "lastSeenAt": client.last_seen_at
            })
        }).collect::<Vec<_>>()
    })
}

pub(crate) fn apply_acp_gateway_config(store: &mut AppStore, payload: Option<&Value>) {
    let Some(payload) = payload.and_then(Value::as_object) else {
        return;
    };
    if let Some(enabled) = payload.get("enabled").and_then(Value::as_bool) {
        store.acp_gateway.enabled = enabled;
    }
    if let Some(require_token) = payload.get("requireToken").and_then(Value::as_bool) {
        store.acp_gateway.require_token = require_token;
    }
    if let Some(local_only) = payload.get("localOnly").and_then(Value::as_bool) {
        store.acp_gateway.local_only = local_only;
    }
    if let Some(value) = payload
        .get("endpointPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        store.acp_gateway.endpoint_path = value.to_string();
    }
    if let Some(value) = payload
        .get("manifestPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        store.acp_gateway.manifest_path = value.to_string();
    }
    if let Some(value) = payload
        .get("guidePath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        store.acp_gateway.guide_path = value.to_string();
    }
    if let Some(value) = payload
        .get("defaultRuntimeMode")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        store.acp_gateway.default_runtime_mode = value.to_string();
    }
    if let Some(value) = payload
        .get("defaultClientLabel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        store.acp_gateway.default_client_label = value.to_string();
    }
}

pub(crate) fn create_acp_client(
    store: &mut AppStore,
    name: &str,
    kind: &str,
) -> (AcpClientRecord, String) {
    let token = generate_client_token();
    let now = crate::now_i64();
    let client = AcpClientRecord {
        id: make_acp_id("acp-client"),
        name: name.trim().to_string(),
        kind: kind.trim().to_string(),
        token_hash: Some(token_hash(&token)),
        token_preview: Some(token_preview(&token)),
        allowed_scopes: vec![
            "manifest:read".to_string(),
            "guide:read".to_string(),
            "session:write".to_string(),
            "run:write".to_string(),
            "artifact:read".to_string(),
        ],
        disabled: false,
        metadata: None,
        created_at: now,
        updated_at: now,
        last_seen_at: None,
    };
    store.acp_clients.push(client.clone());
    (client, token)
}

pub(crate) fn revoke_acp_client(
    store: &mut AppStore,
    client_id: &str,
) -> Result<AcpClientRecord, String> {
    let now = crate::now_i64();
    let client = store
        .acp_clients
        .iter_mut()
        .find(|item| item.id == client_id)
        .ok_or_else(|| "ACP client not found.".to_string())?;
    client.disabled = true;
    client.updated_at = now;
    Ok(client.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_manifest_does_not_require_enabled_gateway_or_token() {
        let store = crate::persistence::default_store();
        let headers = HashMap::new();

        assert!(
            authorize_acp_request(&store, "GET", "/.well-known/redbox-agent.json", &headers)
                .is_ok()
        );
    }

    #[test]
    fn mutating_route_requires_valid_token_when_enabled() {
        let mut store = crate::persistence::default_store();
        store.acp_gateway.enabled = true;
        store.acp_gateway.require_token = true;
        let (_, token) = create_acp_client(&mut store, "Codex", "coding_agent");
        let mut headers = HashMap::new();

        let missing = authorize_acp_request(&store, "POST", "/acp/v1/runs", &headers)
            .expect_err("missing token should be rejected");
        assert_eq!(missing.status, 401);

        headers.insert("authorization".to_string(), "Bearer wrong".to_string());
        let invalid = authorize_acp_request(&store, "POST", "/acp/v1/runs", &headers)
            .expect_err("invalid token should be rejected");
        assert_eq!(invalid.status, 401);

        headers.insert("authorization".to_string(), format!("Bearer {token}"));
        assert!(authorize_acp_request(&store, "POST", "/acp/v1/runs", &headers).is_ok());
    }
}
