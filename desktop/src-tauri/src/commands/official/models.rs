use super::*;
use crate::store::settings as settings_store;

pub(super) fn handle_models_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    _payload: &Value,
    request_generation: Option<u64>,
) -> Option<Result<Value, String>> {
    match channel {
        "official:models:list" => Some((|| -> Result<Value, String> {
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let mut models = official_settings_models(&settings);
            if models.is_empty() {
                models = fetch_official_models_with_recovery(
                    app,
                    state,
                    &mut settings,
                    request_generation,
                );
            }
            if let Some(object) = settings.as_object_mut() {
                object.insert(
                    "redbox_official_models_json".to_string(),
                    json!(serde_json::to_string(&models).unwrap_or_else(|_| "[]".to_string())),
                );
            }
            if !models.is_empty() {
                official_sync_source_into_settings(&mut settings, &models, false);
            }
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-models-list",
                None,
                request_generation,
            )?;
            Ok(json!({ "success": true, "models": models }))
        })()),
        _ => None,
    }
}
