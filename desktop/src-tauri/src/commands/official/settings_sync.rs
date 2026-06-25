use serde_json::{json, Value};

use super::{official_session_logged_in, session_access_token};
use crate::{
    app_brand_display_name, normalize_base_url, official_access_token_from_settings,
    official_ai_api_key_from_settings, official_base_url_for_realm,
    official_base_url_from_settings, payload_string, upsert_official_settings_session,
};

const OFFICIAL_SETTINGS_SYNC_KEYS: [&str; 24] = [
    "redbox_official_realm",
    "redbox_official_base_url",
    "redbox_auth_session_json",
    "redbox_auth_sessions_json",
    "redbox_auth_api_keys_json",
    "redbox_auth_orders_json",
    "redbox_auth_points_json",
    "redbox_official_models_json",
    "redbox_auth_call_records_json",
    "redbox_official_pricing_json",
    "redbox_auth_wechat_login_json",
    "ai_sources_json",
    "default_ai_source_id",
    "api_endpoint",
    "api_key",
    "model_name",
    "model_name_wander",
    "model_name_chatroom",
    "model_name_knowledge",
    "model_name_redclaw",
    "ai_model_routes_json",
    "video_endpoint",
    "video_api_key",
    "video_model",
];

pub(super) fn is_official_ai_request(
    settings: &Value,
    request_url: &str,
    api_key: Option<&str>,
) -> bool {
    let official_base_url = normalize_base_url(&official_base_url_from_settings(settings));
    let request_url = normalize_base_url(request_url);
    if official_base_url.is_empty() || request_url.is_empty() {
        return false;
    }
    if !request_url.starts_with(&official_base_url) {
        return false;
    }
    let official_token = official_ai_api_key_from_settings(settings).unwrap_or_default();
    let official_access_token = official_access_token_from_settings(settings).unwrap_or_default();
    let provided_token = api_key.unwrap_or_default().trim();
    if official_token.trim().is_empty() {
        return session_access_token(settings).is_some();
    }
    provided_token.is_empty()
        || provided_token == official_token
        || provided_token == official_access_token
}

pub(super) fn sync_official_route_credentials(settings: &mut Value) {
    let token = official_ai_api_key_from_settings(settings).unwrap_or_default();
    let base_url = official_base_url_from_settings(settings);
    let mut sources = payload_string(settings, "ai_sources_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default();
    let mut changed = false;

    for source in &mut sources {
        let source_id = source
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if source_id != "redbox_official_auto" {
            continue;
        }
        if let Some(object) = source.as_object_mut() {
            object.insert("apiKey".to_string(), json!(token));
            object.insert("baseURL".to_string(), json!(base_url));
            changed = true;
        }
    }

    if let Some(object) = settings.as_object_mut() {
        if changed {
            object.insert(
                "ai_sources_json".to_string(),
                json!(serde_json::to_string(&sources).unwrap_or_else(|_| "[]".to_string())),
            );
        }
        object.insert("api_key".to_string(), json!(token.clone()));
        object.insert("video_api_key".to_string(), json!(token));
        object.insert("api_endpoint".to_string(), json!(base_url));
    }
}

pub(super) fn switch_official_realm(settings: &mut Value, realm: &str) -> Result<(), String> {
    if official_session_logged_in(settings) {
        return Err("切换账号区前请先退出当前账号".to_string());
    }

    let normalized = crate::normalize_official_realm(realm);
    if normalized.is_empty() {
        return Err("未知账号区".to_string());
    }

    let base_url = official_base_url_for_realm(&normalized).to_string();
    let mut sessions = payload_string(settings, "redbox_auth_sessions_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    sessions.remove(&normalized);

    if let Some(object) = settings.as_object_mut() {
        object.insert("redbox_official_realm".to_string(), json!(normalized));
        object.insert("redbox_official_base_url".to_string(), json!(base_url));
        object.insert("redbox_auth_session_json".to_string(), json!(""));
        object.insert(
            "redbox_auth_sessions_json".to_string(),
            json!(serde_json::to_string(&Value::Object(sessions))
                .unwrap_or_else(|_| "{}".to_string())),
        );
        object.insert("redbox_auth_points_json".to_string(), json!(""));
        object.insert("redbox_auth_call_records_json".to_string(), json!("[]"));
        object.insert("redbox_auth_wechat_login_json".to_string(), json!(""));
        object.insert("redbox_official_models_json".to_string(), json!("[]"));
    }
    sync_official_route_credentials(settings);
    Ok(())
}

fn clear_official_source_binding(settings: &mut Value, previous_official_token: &str) {
    let official_base_url = official_base_url_from_settings(settings);
    let normalized_official_base_url = normalize_base_url(&official_base_url);
    let mut fallback_source_id = String::new();
    let mut fallback_base_url = String::new();
    let mut fallback_api_key = String::new();
    let mut fallback_model = String::new();
    let mut sources = payload_string(settings, "ai_sources_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default();
    let mut changed = false;

    for source in &mut sources {
        let source_id = source
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if source_id == "redbox_official_auto" {
            if let Some(object) = source.as_object_mut() {
                object.insert(
                    "name".to_string(),
                    json!(format!("{}官方", app_brand_display_name())),
                );
                object.insert("presetId".to_string(), json!("redbox-official"));
                object.insert("baseURL".to_string(), json!(official_base_url.clone()));
                object.insert("apiKey".to_string(), json!(""));
                object.insert("models".to_string(), json!(Vec::<String>::new()));
                object.insert("modelsMeta".to_string(), json!(Vec::<Value>::new()));
                object.insert("model".to_string(), json!(""));
                object.insert("protocol".to_string(), json!("openai"));
                changed = true;
            }
            continue;
        }

        if fallback_source_id.is_empty() {
            fallback_source_id = source_id;
            fallback_base_url = payload_string(source, "baseURL").unwrap_or_default();
            fallback_api_key = payload_string(source, "apiKey").unwrap_or_default();
            fallback_model = payload_string(source, "model").unwrap_or_default();
        }
    }

    let current_default_source_id =
        payload_string(settings, "default_ai_source_id").unwrap_or_default();
    let current_api_endpoint =
        normalize_base_url(&payload_string(settings, "api_endpoint").unwrap_or_default());
    let current_api_key = payload_string(settings, "api_key").unwrap_or_default();
    let current_video_api_key = payload_string(settings, "video_api_key").unwrap_or_default();
    let should_reset_default_source = current_default_source_id == "redbox_official_auto";
    let should_reset_root_route = should_reset_default_source
        || (!current_api_endpoint.is_empty()
            && current_api_endpoint == normalized_official_base_url)
        || (!previous_official_token.trim().is_empty()
            && current_api_key == previous_official_token);
    let should_clear_video_api_key = !current_video_api_key.is_empty()
        && (should_reset_root_route
            || (!previous_official_token.trim().is_empty()
                && current_video_api_key == previous_official_token));

    if let Some(object) = settings.as_object_mut() {
        if changed {
            object.insert(
                "ai_sources_json".to_string(),
                json!(serde_json::to_string(&sources).unwrap_or_else(|_| "[]".to_string())),
            );
        }

        if should_reset_default_source {
            object.insert(
                "default_ai_source_id".to_string(),
                json!(if fallback_source_id.is_empty() {
                    "redbox_official_auto".to_string()
                } else {
                    fallback_source_id.clone()
                }),
            );
        }

        if should_reset_root_route {
            if fallback_source_id.is_empty() {
                object.insert("api_endpoint".to_string(), json!(""));
                object.insert("api_key".to_string(), json!(""));
                object.insert("model_name".to_string(), json!(""));
            } else {
                object.insert("api_endpoint".to_string(), json!(fallback_base_url));
                object.insert("api_key".to_string(), json!(fallback_api_key));
                object.insert("model_name".to_string(), json!(fallback_model));
            }
        }

        if should_clear_video_api_key || should_reset_root_route {
            object.insert("video_api_key".to_string(), json!(""));
        }
    }
}

pub(super) fn clear_official_auth_state(settings: &mut Value) {
    let previous_official_token = official_ai_api_key_from_settings(settings).unwrap_or_default();
    upsert_official_settings_session(settings, None);
    clear_official_source_binding(settings, &previous_official_token);
    if let Some(object) = settings.as_object_mut() {
        object.insert("redbox_auth_points_json".to_string(), json!(""));
        object.insert("redbox_auth_call_records_json".to_string(), json!("[]"));
        object.insert("redbox_auth_wechat_login_json".to_string(), json!(""));
        object.insert("redbox_official_models_json".to_string(), json!("[]"));
    }
}

fn default_route_uses_custom_ai_source(settings: &Value) -> bool {
    let source_id = payload_string(settings, "default_ai_source_id").unwrap_or_default();
    let source_id = source_id.trim();
    !source_id.is_empty() && source_id != "redbox_official_auto"
}

fn merge_official_ai_source(settings: &mut Value, source: &Value) {
    let source_sources = payload_string(source, "ai_sources_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default();
    let Some(mut official_source) = source_sources
        .into_iter()
        .find(|item| payload_string(item, "id").as_deref() == Some("redbox_official_auto"))
    else {
        return;
    };

    let mut target_sources = payload_string(settings, "ai_sources_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default();
    let existing_official_source = target_sources
        .iter()
        .find(|item| payload_string(item, "id").as_deref() == Some("redbox_official_auto"))
        .cloned();
    let default_source_id = payload_string(settings, "default_ai_source_id").unwrap_or_default();
    let selected_model = if default_source_id.trim() == "redbox_official_auto" {
        existing_official_source
            .as_ref()
            .and_then(|item| payload_string(item, "model"))
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                payload_string(settings, "model_name").filter(|value| !value.trim().is_empty())
            })
    } else {
        None
    };
    if let Some(selected_model) = selected_model {
        let incoming_models = official_source
            .get("models")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::trim))
                    .filter(|item| !item.is_empty())
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if let Some(object) = official_source.as_object_mut() {
            if incoming_models.iter().any(|model| model == &selected_model) {
                object.insert("model".to_string(), json!(selected_model));
            }
        }
    }
    target_sources
        .retain(|item| payload_string(item, "id").as_deref() != Some("redbox_official_auto"));
    target_sources.insert(0, official_source);

    if let Some(target) = settings.as_object_mut() {
        target.insert(
            "ai_sources_json".to_string(),
            json!(serde_json::to_string(&target_sources).unwrap_or_else(|_| "[]".to_string())),
        );
    }
}

pub(super) fn merge_official_settings(settings: &mut Value, source: &Value) {
    if !settings.is_object() {
        *settings = source.clone();
        return;
    }
    let preserve_custom_route = default_route_uses_custom_ai_source(settings);
    let source_object = source.as_object().cloned().unwrap_or_default();
    for key in OFFICIAL_SETTINGS_SYNC_KEYS {
        if key == "ai_sources_json" {
            merge_official_ai_source(settings, source);
            continue;
        }
        if preserve_custom_route
            && matches!(
                key,
                "default_ai_source_id"
                    | "api_endpoint"
                    | "api_key"
                    | "model_name"
                    | "model_name_wander"
                    | "model_name_chatroom"
                    | "model_name_knowledge"
                    | "model_name_redclaw"
                    | "ai_model_routes_json"
            )
        {
            continue;
        }
        if let Some(value) = source_object.get(key) {
            if let Some(target) = settings.as_object_mut() {
                target.insert(key.to_string(), value.clone());
            }
        }
    }
}
