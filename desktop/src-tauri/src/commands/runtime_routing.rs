use serde_json::Value;

use crate::runtime::{
    runtime_direct_route_record, runtime_route_from_llm_parsed, RuntimeRouteRecord,
    RUNTIME_INTENT_NAMES, RUNTIME_ROLE_IDS,
};
use crate::{
    load_redbox_prompt, parse_json_value_from_text, payload_field, render_redbox_prompt,
    run_model_structured_task_with_settings,
};

pub fn route_runtime_intent_with_settings(
    settings: &Value,
    runtime_mode: &str,
    user_input: &str,
    metadata: Option<&Value>,
) -> RuntimeRouteRecord {
    let fallback = runtime_direct_route_record(runtime_mode, user_input, metadata);
    let Some(system_template) = load_redbox_prompt("runtime/ai/route_intent_system.txt") else {
        return fallback;
    };
    let Some(user_template) = load_redbox_prompt("runtime/ai/route_intent_user.txt") else {
        return fallback;
    };
    let user_prompt = render_redbox_prompt(
        &user_template,
        &[
            ("runtime_mode", runtime_mode.to_string()),
            ("user_input", user_input.to_string()),
            (
                "context_type",
                metadata
                    .and_then(|value| payload_field(value, "contextType"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string(),
            ),
            (
                "context_id",
                metadata
                    .and_then(|value| payload_field(value, "contextId"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string(),
            ),
            (
                "associated_file_path",
                metadata
                    .and_then(|value| payload_field(value, "associatedFilePath"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string(),
            ),
            ("fallback_intent", fallback.intent.clone()),
            ("fallback_role", fallback.recommended_role.clone()),
            ("fallback_reasoning", fallback.reasoning.clone()),
            ("intent_names", RUNTIME_INTENT_NAMES.join(", ")),
            ("role_ids", RUNTIME_ROLE_IDS.join(", ")),
        ],
    );
    let raw = run_model_structured_task_with_settings(
        settings,
        None,
        &system_template,
        &user_prompt,
        true,
    );
    let Ok(content) = raw else {
        return fallback;
    };
    let Some(parsed) = parse_json_value_from_text(&content) else {
        return fallback;
    };
    runtime_route_from_llm_parsed(&fallback, &parsed, user_input).unwrap_or(fallback)
}
