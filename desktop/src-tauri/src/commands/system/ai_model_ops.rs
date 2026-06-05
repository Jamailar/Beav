use crate::persistence::with_store;
use crate::store::settings as settings_store;
use crate::{payload_string, AppState};
use serde_json::{json, Value};
use tauri::State;

pub(super) fn snapshot(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| {
        let runtime = state
            .auth_runtime
            .lock()
            .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
        let settings = settings_store::settings_snapshot(&store);
        let projected = crate::auth::project_settings_for_runtime(&settings, &runtime);
        serde_json::to_value(crate::ai_model_manager::AiModelManager::snapshot(
            &projected,
        ))
        .map_err(|error| error.to_string())
    })
}

pub(super) fn resolve(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let runtime_mode =
        payload_string(payload, "runtimeMode").or_else(|| payload_string(payload, "runtime_mode"));
    let scope = payload_string(payload, "scope");
    let action = payload_string(payload, "action");
    with_store(state, |store| {
        let runtime = state
            .auth_runtime
            .lock()
            .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
        let settings = settings_store::settings_snapshot(&store);
        let projected = crate::auth::project_settings_for_runtime(&settings, &runtime);
        let resolved = if let Some(action) = action.as_deref() {
            crate::ai_model_manager::AiModelManager::resolve_for_tool(
                &projected,
                action,
                Some(payload),
            )
        } else {
            let scope = scope
                .as_deref()
                .map(crate::ai_model_manager::AiModelScope::from_route_scope)
                .unwrap_or_else(|| {
                    crate::ai_model_manager::scope_for_runtime_mode(runtime_mode.as_deref())
                });
            crate::ai_model_manager::AiModelManager::resolve(&projected, scope, Some(payload))
        };
        Ok(resolved
            .as_ref()
            .map(crate::ai_model_manager::resolved_value_for_debug)
            .unwrap_or_else(|| json!({ "success": false, "error": "unresolved" })))
    })
}
