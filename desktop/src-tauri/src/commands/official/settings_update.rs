use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use super::*;
use crate::persistence::with_store;
use crate::persistence::with_store_mut;
use crate::store::settings as settings_store;
use crate::{emit_redbox_auth_data_updated, emit_redbox_auth_session_updated, now_iso, AppState};

pub(super) fn apply_official_settings_update(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &Value,
    source: &str,
    data_payload: Option<Value>,
    expected_generation: Option<u64>,
) -> Result<(), String> {
    if let Some(expected_generation) = expected_generation {
        let matches = auth::auth_generation_matches(state, expected_generation)?;
        if !matches {
            log_official_auth(
                state,
                "stale-update-dropped",
                format!("source={source} expectedGeneration={expected_generation}"),
            );
            return Err("auth generation changed; stale update dropped".to_string());
        }
    }
    let mut next_settings = settings.clone();
    let model_config_exists =
        crate::ai_model_manager::legacy_config::model_config_path(&state.store_path).exists();
    let model_defaults_initialized = crate::model_defaults_initialized(&next_settings);
    let mut should_sync_model_config = model_config_exists || model_defaults_initialized;
    if !model_config_exists && !model_defaults_initialized {
        match crate::fetch_official_default_model_slots_for_settings(&next_settings) {
            Ok(default_slots) => {
                let catalog_models = official_settings_models(&next_settings);
                should_sync_model_config = crate::seed_official_default_models_into_settings(
                    &mut next_settings,
                    &default_slots,
                    &catalog_models,
                );
            }
            Err(error) => {
                log_official_auth(
                    state,
                    "default-models-fetch-failed",
                    format!("source={source} error={error}"),
                );
            }
        }
    }
    match crate::ai_model_manager::defaults::repair_missing_official_defaults_in_settings(
        &mut next_settings,
    ) {
        Ok(repaired) => {
            should_sync_model_config = should_sync_model_config || repaired;
        }
        Err(error) => {
            log_official_auth(
                state,
                "default-models-repair-failed",
                format!("source={source} error={error}"),
            );
        }
    }
    if let Some(expected_generation) = expected_generation {
        let matches = auth::auth_generation_matches(state, expected_generation)?;
        if !matches {
            log_official_auth(
                state,
                "stale-update-dropped-before-write",
                format!("source={source} expectedGeneration={expected_generation}"),
            );
            return Err("auth generation changed; stale update dropped".to_string());
        }
    }
    let previous_settings =
        with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    let merged_settings = with_store_mut(state, |store| {
        Ok(settings_store::update_settings(store, |settings| {
            merge_official_settings(settings, &next_settings);
            crate::ai_model_manager::legacy_projection::normalize_settings_projection(settings);
        }))
    })?;
    let settings_changed = merged_settings != previous_settings;
    crate::analytics::observe_official_settings_update(
        state,
        &previous_settings,
        &merged_settings,
        source,
    );
    if should_sync_model_config {
        if let Err(error) = crate::ai_model_manager::store::sync_model_config_file(
            &state.store_path,
            &merged_settings,
        ) {
            log_official_auth(
                state,
                "model-config-sync-failed",
                format!("source={source} error={error}"),
            );
        }
    }
    if !settings_changed {
        if let Some(payload) = data_payload {
            emit_redbox_auth_data_updated(app, payload);
        }
        return Ok(());
    }
    let _ = auth::sync_auth_runtime_from_settings(Some(app), state, &merged_settings);
    let _ = app.emit(
        "settings:updated",
        json!({
            "updatedAt": now_iso(),
            "source": source,
        }),
    );
    emit_redbox_auth_session_updated(app, official_settings_session(&merged_settings));
    if let Some(payload) = data_payload {
        emit_redbox_auth_data_updated(app, payload);
    }
    Ok(())
}
