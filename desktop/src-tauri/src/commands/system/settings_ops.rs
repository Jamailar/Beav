use crate::persistence::{
    apply_workspace_hydration_snapshot, load_workspace_hydration_snapshot, with_store,
    with_store_mut,
};
use crate::store::{settings as settings_store, spaces as spaces_store};
use crate::{
    is_same_path, now_iso, payload_field, payload_string, refresh_runtime_warm_state,
    update_workspace_root_cache, workspace_root_from_snapshot, AppState,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

const OFFICIAL_SOURCE_ID: &str = "redbox_official_auto";
const OFFICIAL_PRESET_ID: &str = "redbox-official";

fn is_official_source_id(source_id: &str) -> bool {
    let normalized = source_id.trim().to_ascii_lowercase();
    normalized == OFFICIAL_SOURCE_ID || normalized.ends_with("_official_auto")
}

fn canonical_source_id(source_id: &str) -> String {
    let normalized = source_id.trim();
    if is_official_source_id(normalized) {
        OFFICIAL_SOURCE_ID.to_string()
    } else {
        normalized.to_string()
    }
}

fn source_is_official(source: &Value) -> bool {
    source
        .get("id")
        .and_then(Value::as_str)
        .map(is_official_source_id)
        .unwrap_or(false)
        || source
            .get("presetId")
            .or_else(|| source.get("preset_id"))
            .and_then(Value::as_str)
            .map(|value| value.trim().eq_ignore_ascii_case(OFFICIAL_PRESET_ID))
            .unwrap_or(false)
}

fn parse_ai_sources(settings: &Value) -> Vec<Value> {
    payload_string(settings, "ai_sources_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default()
}

fn source_id_value(source: &Value) -> String {
    canonical_source_id(source.get("id").and_then(Value::as_str).unwrap_or_default())
}

fn source_model_value(source: &Value) -> String {
    source
        .get("model")
        .or_else(|| source.get("modelName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn source_model_for_id(settings: &Value, source_id: &str) -> String {
    let normalized_source_id = canonical_source_id(source_id);
    parse_ai_sources(settings)
        .iter()
        .find(|source| source_id_value(source) == normalized_source_id)
        .map(source_model_value)
        .unwrap_or_default()
}

fn changed_default_source_model(
    current: &Value,
    payload: &Value,
    next: &Value,
) -> Option<(String, String)> {
    let payload_object = payload.as_object()?;
    if !payload_object.contains_key("ai_sources_json") {
        return None;
    }
    let default_source_id =
        canonical_source_id(&payload_string(next, "default_ai_source_id").unwrap_or_default());
    if default_source_id.is_empty() {
        return None;
    }
    let previous_model = source_model_for_id(current, &default_source_id);
    let next_model = source_model_for_id(next, &default_source_id);
    if next_model.is_empty() || previous_model == next_model {
        return None;
    }
    Some((default_source_id, next_model))
}

fn sync_chat_family_routes_to_source_model(settings: &mut Value, source_id: &str, model: &str) {
    let normalized_model = model.trim();
    if normalized_model.is_empty() {
        return;
    }
    let normalized_source_id = canonical_source_id(source_id);
    let route_mode = if is_official_source_id(&normalized_source_id) {
        "official"
    } else {
        "custom"
    };
    let mut routes = payload_string(settings, "ai_model_routes_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    for scope in ["chat", "wander", "team", "knowledge", "redclaw"] {
        routes.insert(
            scope.to_string(),
            json!({
                "mode": route_mode,
                "sourceId": normalized_source_id,
                "model": normalized_model,
            }),
        );
    }
    if let Some(object) = settings.as_object_mut() {
        object.insert("model_name".to_string(), json!(normalized_model));
        object.insert("model_name_wander".to_string(), json!(normalized_model));
        object.insert("model_name_chatroom".to_string(), json!(normalized_model));
        object.insert("model_name_knowledge".to_string(), json!(normalized_model));
        object.insert("model_name_redclaw".to_string(), json!(normalized_model));
        object.insert(
            "ai_model_routes_json".to_string(),
            json!(
                serde_json::to_string(&Value::Object(routes)).unwrap_or_else(|_| "{}".to_string())
            ),
        );
    }
}

fn route_chat_model(settings: &Value) -> String {
    payload_string(settings, "ai_model_routes_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|routes| {
            routes
                .get("chat")
                .and_then(|route| {
                    route
                        .get("model")
                        .or_else(|| route.get("modelName"))
                        .or_else(|| route.get("model_name"))
                })
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
        .unwrap_or_default()
}

fn official_root_fields(settings: &Value) -> (String, String, String) {
    (
        crate::official_base_url_from_settings(settings),
        crate::official_ai_api_key_from_settings(settings).unwrap_or_default(),
        route_chat_model(settings),
    )
}

fn normalize_default_ai_route_settings(settings: &mut Value) {
    let default_source_id =
        canonical_source_id(&payload_string(settings, "default_ai_source_id").unwrap_or_default());
    let Some(raw_sources) = payload_string(settings, "ai_sources_json") else {
        if is_official_source_id(&default_source_id) {
            let (official_base_url, official_api_key, official_model) =
                official_root_fields(settings);
            if let Some(object) = settings.as_object_mut() {
                object.insert(
                    "default_ai_source_id".to_string(),
                    json!(OFFICIAL_SOURCE_ID),
                );
                object.insert("api_endpoint".to_string(), json!(official_base_url));
                object.insert("api_key".to_string(), json!(official_api_key));
                object.insert("model_name".to_string(), json!(official_model));
            }
        }
        return;
    };
    let mut sources = serde_json::from_str::<Vec<Value>>(&raw_sources).unwrap_or_default();
    let mut sources_changed = false;
    for source in &mut sources {
        let source_id = source
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if is_official_source_id(&source_id) && source_id != OFFICIAL_SOURCE_ID {
            if let Some(object) = source.as_object_mut() {
                object.insert("id".to_string(), json!(OFFICIAL_SOURCE_ID));
                sources_changed = true;
            }
        }
    }
    let default_source = sources.iter().find(|source| {
        source
            .get("id")
            .and_then(Value::as_str)
            .map(|value| canonical_source_id(value) == default_source_id)
            .unwrap_or(false)
            || (is_official_source_id(&default_source_id) && source_is_official(source))
    });
    let Some(source) = default_source else {
        if is_official_source_id(&default_source_id) {
            let (official_base_url, official_api_key, official_model) =
                official_root_fields(settings);
            if let Some(object) = settings.as_object_mut() {
                object.insert(
                    "default_ai_source_id".to_string(),
                    json!(OFFICIAL_SOURCE_ID),
                );
                object.insert("api_endpoint".to_string(), json!(official_base_url));
                object.insert("api_key".to_string(), json!(official_api_key));
                object.insert("model_name".to_string(), json!(official_model));
            }
        }
        return;
    };

    let base_url = source
        .get("baseURL")
        .or_else(|| source.get("baseUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let api_key = source
        .get("apiKey")
        .or_else(|| source.get("key"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let model_name = route_chat_model(settings);
    let model_name = if model_name.is_empty() {
        source
            .get("model")
            .or_else(|| source.get("modelName"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string()
    } else {
        model_name
    };

    if let Some(object) = settings.as_object_mut() {
        if sources_changed {
            object.insert(
                "ai_sources_json".to_string(),
                json!(serde_json::to_string(&sources).unwrap_or_else(|_| "[]".to_string())),
            );
        }
        object.insert("default_ai_source_id".to_string(), json!(default_source_id));
        object.insert("api_endpoint".to_string(), json!(base_url));
        object.insert("api_key".to_string(), json!(api_key.clone()));
        object.insert("model_name".to_string(), json!(model_name));
        let current_video_api_key = object
            .get("video_api_key")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if current_video_api_key.is_empty() && !api_key.is_empty() {
            object.insert("video_api_key".to_string(), json!(api_key));
        }
    }
}

fn payload_updates_ai_model_selection(payload: &Value) -> bool {
    let Some(object) = payload.as_object() else {
        return false;
    };
    object.keys().any(|key| {
        matches!(
            key.as_str(),
            "ai_model_routes_json"
                | "ai_sources_json"
                | "default_ai_source_id"
                | "model_name"
                | "model_name_wander"
                | "model_name_chatroom"
                | "model_name_knowledge"
                | "model_name_redclaw"
                | "transcription_model"
                | "embedding_model"
                | "image_model"
                | "video_model"
                | "visual_index_model"
                | "video_analysis_model"
                | "voice_tts_model"
                | "voice_clone_model"
        )
    })
}

fn merged_settings_payload(current: &Value, payload: &Value) -> Value {
    let mut next =
        if let (Some(current), Some(payload)) = (current.as_object(), payload.as_object()) {
            let mut merged = current.clone();
            for (key, value) in payload {
                if matches!(key.as_str(), "redbox_auth_session_json") {
                    continue;
                }
                merged.insert(key.to_string(), value.clone());
            }
            Value::Object(merged)
        } else {
            payload.clone()
        };
    normalize_default_ai_route_settings(&mut next);
    if let Some((source_id, model)) = changed_default_source_model(current, payload, &next) {
        sync_chat_family_routes_to_source_model(&mut next, &source_id, &model);
    }
    if payload_updates_ai_model_selection(payload) {
        if let Some(object) = next.as_object_mut() {
            object
                .entry(crate::official_support::AI_MODEL_DEFAULTS_INITIALIZED_AT_KEY.to_string())
                .or_insert_with(|| json!(now_iso()));
        }
    }
    if let Some(object) = next.as_object_mut() {
        object
            .entry("visual_index_enabled".to_string())
            .or_insert_with(|| json!(false));
        object.insert("video_analysis_enabled".to_string(), json!(true));
    }
    next
}

fn payload_requests_visual_index_backfill(payload: &Value) -> bool {
    payload_field(payload, "visual_index_enabled")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            payload
                .as_object()
                .map(|object| object.keys().any(|key| key.starts_with("visual_index_")))
                .unwrap_or(false)
        })
}

pub(super) fn get_settings(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| {
        let runtime = state
            .auth_runtime
            .lock()
            .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
        let settings = settings_store::settings_snapshot(&store);
        let mut projected = crate::auth::project_settings_for_runtime(&settings, &runtime);
        crate::ai_model_manager::legacy_projection::normalize_settings_projection(&mut projected);
        normalize_default_ai_route_settings(&mut projected);
        Ok(projected)
    })
}

pub(super) fn save_settings(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let previous_workspace_root = with_store(state, |store| {
        let settings = settings_store::settings_snapshot(&store);
        let active_space_id = spaces_store::active_space_id(&store);
        Ok(workspace_root_from_snapshot(&settings, &active_space_id, &state.store_path).ok())
    })?;
    let (active_space_id, settings_snapshot, store_snapshot) = with_store_mut(state, |store| {
        let settings_snapshot = settings_store::update_settings(store, |settings| {
            *settings = merged_settings_payload(settings, payload);
            crate::ai_model_manager::legacy_projection::normalize_settings_projection(settings);
        });
        Ok((
            spaces_store::active_space_id(store),
            settings_snapshot,
            store.clone(),
        ))
    })?;
    crate::persist_store(&state.store_path, &store_snapshot)?;
    crate::ai_model_manager::store::sync_model_config_file(&state.store_path, &settings_snapshot)?;
    let _ = crate::ai_model_manager::defaults::repair_missing_official_defaults_for_store(
        Some(app),
        state,
        "settings-model-defaults-repair",
    );
    let workspace_root = update_workspace_root_cache(state, &settings_snapshot, &active_space_id)?;
    let workspace_changed = previous_workspace_root
        .as_ref()
        .map(|previous| !is_same_path(previous, &workspace_root))
        .unwrap_or(true);
    if workspace_changed {
        let snapshot = load_workspace_hydration_snapshot(&workspace_root);
        with_store_mut(state, |store| {
            apply_workspace_hydration_snapshot(store, snapshot);
            Ok(())
        })?;
    }
    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "team"]);
    let _ = app.emit(
        "settings:updated",
        json!({
            "updatedAt": now_iso(),
        }),
    );
    if payload_requests_visual_index_backfill(payload) {
        crate::knowledge_index::jobs::schedule_visual_backfill(app, "settings-visual-index");
    }
    if payload_string(payload, "analytics_consent").as_deref() == Some("none") {
        let _ = crate::analytics::clear_queue(state);
    } else if payload_string(payload, "analytics_consent").as_deref() == Some("approved") {
        let _ = crate::analytics::flush_pending_now(app, state);
    }
    Ok(json!({ "success": true }))
}

#[cfg(test)]
mod tests {
    use super::{merged_settings_payload, normalize_default_ai_route_settings};
    use serde_json::{json, Value};

    fn parsed_routes(settings: &Value) -> Value {
        settings
            .get("ai_model_routes_json")
            .and_then(Value::as_str)
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .unwrap_or_else(|| json!({}))
    }

    #[test]
    fn normalize_default_ai_route_settings_replaces_stale_root_fields_with_empty_values() {
        let mut settings = json!({
            "default_ai_source_id": "next",
            "api_endpoint": "https://old.example/v1",
            "api_key": "old-key",
            "model_name": "old-model",
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "next",
                "name": "Next",
                "baseURL": "",
                "apiKey": "",
                "model": ""
            })]).unwrap()
        });

        normalize_default_ai_route_settings(&mut settings);

        assert_eq!(settings["api_endpoint"], json!(""));
        assert_eq!(settings["api_key"], json!(""));
        assert_eq!(settings["model_name"], json!(""));
    }

    #[test]
    fn normalize_default_ai_route_settings_syncs_selected_source_to_root_fields() {
        let mut settings = json!({
            "default_ai_source_id": "next",
            "api_endpoint": "https://old.example/v1",
            "api_key": "old-key",
            "model_name": "old-model",
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "next",
                "name": "Next",
                "baseURL": "https://next.example/v1",
                "apiKey": "next-key",
                "model": "next-model"
            })]).unwrap()
        });

        normalize_default_ai_route_settings(&mut settings);

        assert_eq!(settings["api_endpoint"], json!("https://next.example/v1"));
        assert_eq!(settings["api_key"], json!("next-key"));
        assert_eq!(settings["model_name"], json!("next-model"));
    }

    #[test]
    fn normalize_default_ai_route_settings_prefers_chat_route_model_over_source_default() {
        let mut settings = json!({
            "default_ai_source_id": "next",
            "api_endpoint": "https://old.example/v1",
            "api_key": "old-key",
            "model_name": "old-model",
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "next",
                "name": "Next",
                "baseURL": "https://next.example/v1",
                "apiKey": "next-key",
                "model": "source-default-model"
            })]).unwrap(),
            "ai_model_routes_json": serde_json::to_string(&json!({
                "chat": { "mode": "custom", "sourceId": "next", "model": "chat-route-model" }
            })).unwrap()
        });

        normalize_default_ai_route_settings(&mut settings);

        assert_eq!(settings["api_endpoint"], json!("https://next.example/v1"));
        assert_eq!(settings["api_key"], json!("next-key"));
        assert_eq!(settings["model_name"], json!("chat-route-model"));
    }

    #[test]
    fn merged_settings_payload_syncs_chat_routes_when_default_source_model_changes() {
        let current_routes = json!({
            "chat": { "mode": "official", "sourceId": "redbox_official_auto", "model": "qwen3.5-plus" },
            "redclaw": { "mode": "official", "sourceId": "redbox_official_auto", "model": "qwen3.5-plus" },
            "image": { "mode": "official", "sourceId": "redbox_official_auto", "model": "gpt-image-2" },
        });
        let current = json!({
            "default_ai_source_id": "redbox_official_auto",
            "model_name": "qwen3.5-plus",
            "model_name_redclaw": "qwen3.5-plus",
            "ai_model_routes_json": serde_json::to_string(&current_routes).unwrap(),
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "redbox_official_auto",
                "model": "qwen3.5-plus",
                "models": ["qwen3.5-plus", "qwen3.7-plus"]
            })]).unwrap(),
        });
        let payload = json!({
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "redbox_official_auto",
                "model": "qwen3.7-plus",
                "models": ["qwen3.5-plus", "qwen3.7-plus"]
            })]).unwrap(),
        });

        let merged = merged_settings_payload(&current, &payload);
        let routes = parsed_routes(&merged);

        assert_eq!(merged["model_name"], json!("qwen3.7-plus"));
        assert_eq!(merged["model_name_redclaw"], json!("qwen3.7-plus"));
        assert_eq!(routes["chat"]["model"], json!("qwen3.7-plus"));
        assert_eq!(routes["redclaw"]["model"], json!("qwen3.7-plus"));
        assert_eq!(routes["image"]["model"], json!("gpt-image-2"));
    }

    #[test]
    fn merged_settings_payload_keeps_chat_route_when_source_model_is_unchanged() {
        let current_routes = json!({
            "chat": { "mode": "official", "sourceId": "redbox_official_auto", "model": "qwen3.5-plus" },
            "redclaw": { "mode": "official", "sourceId": "redbox_official_auto", "model": "qwen3.5-plus" },
        });
        let current_sources = vec![json!({
            "id": "redbox_official_auto",
            "model": "qwen3.7-plus",
            "models": ["qwen3.5-plus", "qwen3.7-plus"]
        })];
        let current = json!({
            "default_ai_source_id": "redbox_official_auto",
            "model_name": "qwen3.5-plus",
            "model_name_redclaw": "qwen3.5-plus",
            "ai_model_routes_json": serde_json::to_string(&current_routes).unwrap(),
            "ai_sources_json": serde_json::to_string(&current_sources).unwrap(),
        });
        let payload = json!({
            "ai_sources_json": serde_json::to_string(&current_sources).unwrap(),
        });

        let merged = merged_settings_payload(&current, &payload);
        let routes = parsed_routes(&merged);

        assert_eq!(merged["model_name"], json!("qwen3.5-plus"));
        assert_eq!(routes["chat"]["model"], json!("qwen3.5-plus"));
        assert_eq!(routes["redclaw"]["model"], json!("qwen3.5-plus"));
    }

    #[test]
    fn normalize_default_ai_route_settings_canonicalizes_legacy_official_source_id() {
        let mut settings = json!({
            "default_ai_source_id": "beav_official_auto",
            "api_endpoint": "https://old.example/v1",
            "api_key": "old-key",
            "model_name": "old-model",
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "beav_official_auto",
                "name": "Beav Official",
                "presetId": "redbox-official",
                "baseURL": "https://api.ziz.hk/beav/v1",
                "apiKey": "official-key",
                "model": "official-model"
            })]).unwrap()
        });

        normalize_default_ai_route_settings(&mut settings);

        assert_eq!(
            settings["default_ai_source_id"],
            json!("redbox_official_auto")
        );
        assert_eq!(
            settings["api_endpoint"],
            json!("https://api.ziz.hk/beav/v1")
        );
        assert_eq!(settings["api_key"], json!("official-key"));
        assert_eq!(settings["model_name"], json!("official-model"));

        let sources = settings
            .get("ai_sources_json")
            .and_then(Value::as_str)
            .and_then(|raw| serde_json::from_str::<Vec<Value>>(raw).ok())
            .unwrap_or_default();
        assert_eq!(
            sources
                .first()
                .and_then(|source| source.get("id"))
                .and_then(Value::as_str),
            Some("redbox_official_auto")
        );
    }

    #[test]
    fn normalize_default_ai_route_settings_does_not_keep_stale_custom_root_for_missing_official_source(
    ) {
        let mut settings = json!({
            "default_ai_source_id": "redbox_official_auto",
            "redbox_official_base_url": "https://api.ziz.hk/redbox/v1",
            "redbox_auth_session_json": serde_json::to_string(&json!({ "apiKey": "official-key" })).unwrap(),
            "api_endpoint": "https://custom.example/v1",
            "api_key": "custom-key",
            "model_name": "custom-model",
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "custom-source",
                "name": "Custom",
                "baseURL": "https://custom.example/v1",
                "apiKey": "custom-key",
                "model": "custom-model"
            })]).unwrap(),
            "ai_model_routes_json": serde_json::to_string(&json!({
                "chat": { "mode": "official", "sourceId": "redbox_official_auto", "model": "official-chat" }
            })).unwrap()
        });
        let official_base_url = crate::official_base_url_from_settings(&settings);

        normalize_default_ai_route_settings(&mut settings);

        assert_eq!(
            settings["default_ai_source_id"],
            json!("redbox_official_auto")
        );
        assert_eq!(settings["api_endpoint"], json!(official_base_url));
        assert_eq!(settings["api_key"], json!("official-key"));
        assert_eq!(settings["model_name"], json!("official-chat"));
    }

    #[test]
    fn merged_settings_payload_preserves_custom_workspace_dir_for_partial_updates() {
        let current = json!({
            "workspace_dir": "/Volumes/RedBox Workspace",
            "default_ai_source_id": "official",
            "theme": "dark"
        });
        let payload = json!({
            "theme": "light"
        });

        let merged = merged_settings_payload(&current, &payload);

        assert_eq!(
            merged.get("workspace_dir").and_then(Value::as_str),
            Some("/Volumes/RedBox Workspace")
        );
        assert_eq!(merged.get("theme").and_then(Value::as_str), Some("light"));
    }

    #[test]
    fn merged_settings_payload_defaults_visual_index_to_disabled() {
        let merged = merged_settings_payload(&json!({}), &json!({ "theme": "dark" }));

        assert_eq!(
            merged.get("visual_index_enabled").and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn merged_settings_payload_preserves_enabled_visual_index() {
        let current = json!({
            "visual_index_enabled": true,
            "theme": "light"
        });

        let merged = merged_settings_payload(&current, &json!({ "theme": "dark" }));

        assert_eq!(
            merged.get("visual_index_enabled").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(merged.get("theme").and_then(Value::as_str), Some("dark"));
    }

    #[test]
    fn merged_settings_payload_preserves_disabled_visual_index() {
        let current = json!({
            "visual_index_enabled": false,
            "theme": "light"
        });

        let merged = merged_settings_payload(&current, &json!({ "theme": "dark" }));

        assert_eq!(
            merged.get("visual_index_enabled").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(merged.get("theme").and_then(Value::as_str), Some("dark"));
    }

    #[test]
    fn merged_settings_payload_marks_model_defaults_initialized_on_model_save() {
        let current = json!({
            "theme": "dark"
        });
        let payload = json!({
            "model_name": "user-model"
        });

        let merged = merged_settings_payload(&current, &payload);

        assert_eq!(
            merged.get("model_name").and_then(Value::as_str),
            Some("user-model")
        );
        assert!(merged
            .get(crate::official_support::AI_MODEL_DEFAULTS_INITIALIZED_AT_KEY)
            .and_then(Value::as_str)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false));
    }

    #[test]
    fn merged_settings_payload_does_not_overwrite_auth_session_from_renderer_payload() {
        let current = json!({
            "workspace_dir": "/Volumes/RedBox Workspace",
            "redbox_auth_session_json": "{\"token\":\"current\"}"
        });
        let payload = json!({
            "redbox_auth_session_json": "{\"token\":\"stale\"}",
            "theme": "light"
        });

        let merged = merged_settings_payload(&current, &payload);

        assert_eq!(
            merged
                .get("redbox_auth_session_json")
                .and_then(Value::as_str),
            Some("{\"token\":\"current\"}")
        );
        assert_eq!(
            merged.get("workspace_dir").and_then(Value::as_str),
            Some("/Volumes/RedBox Workspace")
        );
    }
}
