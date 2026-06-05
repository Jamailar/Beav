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

fn normalize_default_ai_route_settings(settings: &mut Value) {
    let default_source_id = payload_string(settings, "default_ai_source_id").unwrap_or_default();
    let Some(raw_sources) = payload_string(settings, "ai_sources_json") else {
        return;
    };
    let sources = serde_json::from_str::<Vec<Value>>(&raw_sources).unwrap_or_default();
    let default_source = sources.iter().find(|source| {
        source
            .get("id")
            .and_then(Value::as_str)
            .map(|value| value.trim() == default_source_id)
            .unwrap_or(false)
    });
    let Some(source) = default_source else {
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
    let model_name = source
        .get("model")
        .or_else(|| source.get("modelName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();

    if let Some(object) = settings.as_object_mut() {
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
    if payload_updates_ai_model_selection(payload) {
        if let Some(object) = next.as_object_mut() {
            object
                .entry(crate::official_support::AI_MODEL_DEFAULTS_INITIALIZED_AT_KEY.to_string())
                .or_insert_with(|| json!(now_iso()));
        }
    }
    if let Some(object) = next.as_object_mut() {
        object.insert("visual_index_enabled".to_string(), json!(true));
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
    let (active_space_id, settings_snapshot) = with_store_mut(state, |store| {
        let settings_snapshot = settings_store::update_settings(store, |settings| {
            *settings = merged_settings_payload(settings, payload);
            crate::ai_model_manager::legacy_projection::normalize_settings_projection(settings);
        });
        Ok((spaces_store::active_space_id(store), settings_snapshot))
    })?;
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
    Ok(json!({ "success": true }))
}

#[cfg(test)]
mod tests {
    use super::{merged_settings_payload, normalize_default_ai_route_settings};
    use serde_json::{json, Value};

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
