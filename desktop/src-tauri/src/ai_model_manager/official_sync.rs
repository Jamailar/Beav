use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) enum AiAuthEvent {
    SettingsProjected,
}

#[allow(dead_code)]
pub(crate) fn apply_auth_event(
    store_path: &Path,
    settings: &mut Value,
    _event: AiAuthEvent,
) -> Result<(), String> {
    crate::ai_model_manager::legacy_projection::sync_projection_file(store_path, settings)
}
