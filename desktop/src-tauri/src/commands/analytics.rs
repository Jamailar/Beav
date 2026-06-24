use serde_json::Value;
use tauri::{AppHandle, State};

use crate::{analytics, payload_string, AppState};

pub fn handle_analytics_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "analytics:status" => analytics::status_value(state),
        "analytics:set-consent" => {
            let consent =
                payload_string(payload, "consent").unwrap_or_else(|| "prompt".to_string());
            analytics::set_consent(state, &consent)
        }
        "analytics:track" => analytics::track_event(app, state, payload),
        "analytics:flush" => analytics::flush_pending_now(app, state),
        "analytics:clear-queue" => analytics::clear_queue(state),
        _ => return None,
    };
    Some(result)
}
