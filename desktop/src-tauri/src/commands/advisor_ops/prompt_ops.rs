use crate::persistence::with_store;
use crate::store::settings as settings_store;
use crate::{
    load_redbox_prompt_or_embedded, payload_string, render_redbox_prompt,
    run_model_structured_task_with_settings, run_model_text_task_with_settings, AppState,
};
use serde_json::{json, Value};
use tauri::State;

pub(super) fn handle_prompt_channel(
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    Some(match channel {
        "advisors:optimize-prompt" => optimize_prompt_value(state, payload),
        "advisors:optimize-prompt-deep" => optimize_prompt_deep_value(state, payload),
        _ => return None,
    })
}

fn optimize_prompt_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let settings_snapshot =
        with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    let info = payload_string(payload, "info").unwrap_or_default();
    let system_prompt = load_redbox_prompt_or_embedded(
        "runtime/advisors/optimize_system.txt",
        include_str!("../../../../prompts/library/runtime/advisors/optimize_system.txt"),
    );
    let optimized = run_model_structured_task_with_settings(
        &settings_snapshot,
        None,
        &system_prompt,
        &info,
        false,
    )
    .or_else(|_| run_model_text_task_with_settings(&settings_snapshot, None, &info))?;
    Ok(json!({ "success": true, "prompt": optimized }))
}

fn optimize_prompt_deep_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let settings_snapshot =
        with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    let name = payload_string(payload, "name").unwrap_or_else(|| "智囊团成员".to_string());
    let personality = payload_string(payload, "personality").unwrap_or_default();
    let current_prompt = payload_string(payload, "currentPrompt").unwrap_or_default();
    let system_prompt = load_redbox_prompt_or_embedded(
        "runtime/advisors/optimize_deep_system.txt",
        include_str!("../../../../prompts/library/runtime/advisors/optimize_deep_system.txt"),
    );
    let user_prompt = render_redbox_prompt(
        &load_redbox_prompt_or_embedded(
            "runtime/advisors/optimize_deep_user.txt",
            include_str!("../../../../prompts/library/runtime/advisors/optimize_deep_user.txt"),
        ),
        &[
            ("name", name.clone()),
            ("personality", personality.clone()),
            ("current_prompt", current_prompt.clone()),
            ("search_summary", "".to_string()),
            ("knowledge_summary", "".to_string()),
        ],
    );
    let optimized = run_model_structured_task_with_settings(
        &settings_snapshot,
        None,
        &system_prompt,
        &user_prompt,
        false,
    )
    .or_else(|_| run_model_text_task_with_settings(&settings_snapshot, None, &user_prompt))?;
    Ok(json!({ "success": true, "prompt": optimized }))
}
