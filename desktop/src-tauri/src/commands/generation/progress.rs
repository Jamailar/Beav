use crate::events::emit_runtime_tool_partial;
use crate::{append_debug_log_state, normalize_optional_string, payload_string, AppState};
use serde_json::Value;
use tauri::{AppHandle, State};

#[derive(Debug, Clone, Default)]
pub(super) struct RuntimeToolLogContext {
    session_id: Option<String>,
    tool_call_id: Option<String>,
    tool_name: String,
}

pub(super) fn summarize_json_for_log(value: &Value) -> String {
    let raw = serde_json::to_string(value).unwrap_or_else(|_| value.to_string());
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "<empty>".to_string();
    }
    let snippet = trimmed.chars().take(400).collect::<String>();
    if snippet.chars().count() == trimmed.chars().count() {
        snippet
    } else {
        format!("{snippet}...")
    }
}

pub(super) fn runtime_tool_log_context_from_payload(payload: &Value) -> RuntimeToolLogContext {
    RuntimeToolLogContext {
        session_id: normalize_optional_string(
            payload_string(payload, "sessionId").or_else(|| payload_string(payload, "session_id")),
        ),
        tool_call_id: normalize_optional_string(
            payload_string(payload, "toolCallId")
                .or_else(|| payload_string(payload, "tool_call_id")),
        ),
        tool_name: payload_string(payload, "toolName").unwrap_or_else(|| "workflow".to_string()),
    }
}

pub(super) fn emit_video_generation_progress(
    app: &AppHandle,
    context: &RuntimeToolLogContext,
    message: &str,
) {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return;
    }
    println!("[video-gen] {trimmed}");
    let Some(tool_call_id) = context.tool_call_id.as_deref() else {
        return;
    };
    emit_runtime_tool_partial(
        app,
        context.session_id.as_deref(),
        tool_call_id,
        context.tool_name.as_str(),
        trimmed,
    );
}

pub(super) fn emit_image_generation_log(state: &State<'_, AppState>, line: impl Into<String>) {
    let line = line.into();
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    eprintln!("{trimmed}");
    append_debug_log_state(state, trimmed.to_string());
}

pub(super) fn video_generation_asset_label(index: i64, count: i64) -> String {
    if count > 1 {
        format!("第 {}/{} 个视频", index + 1, count)
    } else {
        "视频任务".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn summarize_json_for_log_reports_empty_string() {
        assert_eq!(summarize_json_for_log(&json!("")), "\"\"");
    }

    #[test]
    fn summarize_json_for_log_truncates_long_payload() {
        let long_text = "x".repeat(500);
        let summary = summarize_json_for_log(&json!({ "text": long_text }));

        assert!(summary.ends_with("..."));
        assert!(summary.chars().count() <= 403);
    }

    #[test]
    fn video_generation_asset_label_includes_position_for_batch() {
        assert_eq!(video_generation_asset_label(1, 3), "第 2/3 个视频");
        assert_eq!(video_generation_asset_label(0, 1), "视频任务");
    }

    #[test]
    fn runtime_tool_log_context_accepts_legacy_and_snake_case_ids() {
        let context = runtime_tool_log_context_from_payload(&json!({
            "session_id": "session-1",
            "tool_call_id": "tool-1"
        }));

        assert_eq!(context.session_id.as_deref(), Some("session-1"));
        assert_eq!(context.tool_call_id.as_deref(), Some("tool-1"));
        assert_eq!(context.tool_name, "workflow");
    }
}
