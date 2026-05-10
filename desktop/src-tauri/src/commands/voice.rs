use serde_json::Value;
use tauri::{AppHandle, State};

use crate::{voice_service, AppState};

pub fn handle_voice_channel(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "voice:list" => voice_service::list_voices(state, payload),
        "voice:get" => voice_service::get_voice(state, payload),
        "voice:clone" => voice_service::clone_voice(state, payload),
        "voice:speech" => voice_service::synthesize_speech(state, payload),
        "voice:delete" => voice_service::delete_voice(state, payload),
        _ => return None,
    };
    Some(result)
}
