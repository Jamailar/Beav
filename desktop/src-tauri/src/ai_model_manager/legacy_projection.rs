use serde_json::Value;
use std::path::Path;

pub(crate) fn normalize_settings_projection(settings: &mut Value) {
    let config = crate::ai_model_manager::legacy_config::settings_to_model_config(settings);
    crate::ai_model_manager::store::apply_model_config_to_settings(&config, settings);
}

pub(crate) fn sync_projection_file(store_path: &Path, settings: &mut Value) -> Result<(), String> {
    normalize_settings_projection(settings);
    crate::ai_model_manager::store::sync_model_config_file(store_path, settings)
}
