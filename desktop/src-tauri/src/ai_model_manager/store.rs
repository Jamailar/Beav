use serde_json::Value;
use std::path::Path;

pub(crate) fn sync_model_config_file(store_path: &Path, settings: &Value) -> Result<(), String> {
    crate::ai_model_manager::legacy_config::sync_model_config_file(store_path, settings)
}

pub(crate) fn apply_model_config_to_settings(config: &Value, settings: &mut Value) {
    crate::ai_model_manager::legacy_config::apply_model_config_to_settings(config, settings);
}
