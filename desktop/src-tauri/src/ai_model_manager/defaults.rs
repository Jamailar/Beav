use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::{now_iso, persist_store, with_store, with_store_mut, AppState};

pub(crate) fn repair_missing_official_defaults_in_settings(
    settings: &mut Value,
) -> Result<bool, String> {
    if !crate::official_support::has_missing_official_default_models(settings) {
        return Ok(false);
    }
    if crate::official_support::official_ai_api_key_from_settings(settings).is_none() {
        return Ok(false);
    }
    let default_slots =
        crate::official_support::fetch_official_default_model_slots_for_settings(settings)
            .map_err(|error| format!("获取官方默认模型失败：{error}"))?;
    let catalog_models = crate::official_support::fetch_official_models_for_settings(settings);
    Ok(
        crate::official_support::repair_missing_official_default_models_into_settings(
            settings,
            &default_slots,
            &catalog_models,
        ),
    )
}

pub(crate) fn repair_missing_official_defaults_for_store(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    source: &str,
) -> Result<bool, String> {
    let settings = with_store(state, |store| Ok(store.settings.clone()))?;
    let mut next_settings = settings;
    if !repair_missing_official_defaults_in_settings(&mut next_settings)? {
        return Ok(false);
    }

    let store_snapshot = with_store_mut(state, |store| {
        store.settings = next_settings.clone();
        crate::ai_model_manager::legacy_projection::normalize_settings_projection(
            &mut store.settings,
        );
        Ok(store.clone())
    })?;
    persist_store(&state.store_path, &store_snapshot)?;
    crate::ai_model_manager::store::sync_model_config_file(
        &state.store_path,
        &store_snapshot.settings,
    )?;
    if let Some(app) = app {
        let _ = app.emit(
            "settings:updated",
            json!({ "updatedAt": now_iso(), "source": source }),
        );
    }
    Ok(true)
}
