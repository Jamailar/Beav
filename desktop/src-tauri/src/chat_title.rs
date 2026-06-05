use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::events::emit_runtime_task_checkpoint_saved;
use crate::persistence::{with_store, with_store_mut};
use crate::store::settings as settings_store;
use crate::{
    app_brand_display_name, now_iso, parse_json_value_from_text, payload_string,
    run_model_structured_task_with_settings, session_title_from_message, AppState,
};

const NEW_CHAT_TITLE: &str = "New Chat";
const MAX_SESSION_TITLE_CHARS: usize = 24;
const TITLE_PROMPT_CHAR_LIMIT: usize = 600;

pub fn spawn_chat_session_auto_title(
    app: AppHandle,
    session_id: String,
    display_content: String,
    attachment: Option<Value>,
    model_config: Option<Value>,
) {
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = run_chat_session_auto_title(
            &app,
            &session_id,
            &display_content,
            attachment.as_ref(),
            model_config.as_ref(),
        ) {
            eprintln!("[chat title] failed for session {}: {}", session_id, error);
        }
    });
}

fn run_chat_session_auto_title(
    app: &AppHandle,
    session_id: &str,
    display_content: &str,
    attachment: Option<&Value>,
    model_config: Option<&Value>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let (settings_snapshot, should_generate) = with_store(&state, |store| {
        let Some(session) = store
            .chat_sessions
            .iter()
            .find(|item| item.id == session_id)
        else {
            return Ok((Value::Null, false));
        };
        let user_message_count = store
            .chat_messages
            .iter()
            .filter(|item| item.session_id == session_id && item.role == "user")
            .count();
        Ok((
            settings_store::settings_snapshot(&store),
            is_placeholder_session_title(&session.title) && user_message_count == 1,
        ))
    })?;
    if !should_generate {
        return Ok(());
    }

    let fallback_title = fallback_session_title(display_content, attachment);
    if is_placeholder_session_title(&fallback_title) {
        return Ok(());
    }

    let next_title = generate_session_title(
        &settings_snapshot,
        model_config,
        display_content,
        attachment,
    )
    .ok()
    .and_then(|value| sanitize_generated_session_title(&value))
    .unwrap_or(fallback_title);

    let updated_title = with_store_mut(&state, |store| {
        let Some(session_index) = store
            .chat_sessions
            .iter()
            .position(|item| item.id == session_id)
        else {
            return Ok(None);
        };
        let session = &mut store.chat_sessions[session_index];
        if !is_placeholder_session_title(&session.title) {
            return Ok(None);
        }
        if session.title == next_title {
            return Ok(None);
        }
        session.title = next_title.clone();
        session.updated_at = now_iso();
        Ok(Some(session.title.clone()))
    })?;

    if let Some(title) = updated_title {
        emit_runtime_task_checkpoint_saved(
            app,
            None,
            Some(session_id),
            "chat.session_title_updated",
            "session title updated",
            Some(json!({
                "sessionId": session_id,
                "title": title,
            })),
        );
    }
    Ok(())
}

fn generate_session_title(
    settings: &Value,
    model_config: Option<&Value>,
    display_content: &str,
    attachment: Option<&Value>,
) -> Result<String, String> {
    let attachment_title = attachment_title(attachment).unwrap_or_default();
    let user_prompt = format!(
        "用户首条消息：\n{}\n\n附件标题：\n{}\n\n输出格式：{{\"title\":\"...\"}}",
        truncate_for_prompt(display_content, TITLE_PROMPT_CHAR_LIMIT),
        truncate_for_prompt(&attachment_title, 120),
    );
    let raw = run_model_structured_task_with_settings(
        settings,
        model_config,
        &format!(
            "你是 {} 的会话命名器。请根据用户首条消息生成一个简短自然的中文会话标题。要求：1. 只输出严格 JSON。2. JSON 只有 title 字段。3. 标题突出任务目标或对象。4. 不要使用引号、句号、emoji、序号、前缀。5. 长度尽量控制在 8 到 18 个中文字符内，必要时可以更短。",
            app_brand_display_name()
        ),
        &user_prompt,
        true,
    )?;
    let parsed = parse_json_value_from_text(&raw).unwrap_or(Value::Null);
    parsed
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "模型未返回有效标题".to_string())
}

fn fallback_session_title(display_content: &str, attachment: Option<&Value>) -> String {
    let first_text_line = display_content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    let from_message = sanitize_generated_session_title(first_text_line)
        .unwrap_or_else(|| session_title_from_message(first_text_line));
    if !is_placeholder_session_title(&from_message) {
        return from_message;
    }
    attachment_title(attachment)
        .and_then(|value| sanitize_generated_session_title(&value))
        .unwrap_or_else(|| NEW_CHAT_TITLE.to_string())
}

fn attachment_title(attachment: Option<&Value>) -> Option<String> {
    let attachment = attachment?;
    payload_string(attachment, "title")
        .or_else(|| payload_string(attachment, "name"))
        .or_else(|| payload_string(attachment, "fileName"))
        .or_else(|| payload_string(attachment, "filename"))
        .or_else(|| payload_string(attachment, "label"))
        .or_else(|| payload_string(attachment, "path"))
        .map(|value| strip_path_and_extension(&value))
        .filter(|value| !value.trim().is_empty())
}

fn strip_path_and_extension(value: &str) -> String {
    let filename = value.rsplit(['/', '\\']).next().unwrap_or(value).trim();
    let without_extension = filename
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(filename);
    without_extension.trim().to_string()
}

fn sanitize_generated_session_title(raw: &str) -> Option<String> {
    let first_line = raw.lines().map(str::trim).find(|line| !line.is_empty())?;
    let collapsed = first_line.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed
        .trim_matches(|ch: char| {
            matches!(
                ch,
                '"' | '\'' | '`' | '“' | '”' | '‘' | '’' | '。' | '，' | '！' | '？' | ':' | '：'
            )
        })
        .trim_start_matches(|ch: char| matches!(ch, '#' | '-' | '*' | '•' | '>' | ' '))
        .trim();
    if trimmed.is_empty() || is_placeholder_session_title(trimmed) {
        return None;
    }
    let limited = trimmed
        .chars()
        .take(MAX_SESSION_TITLE_CHARS)
        .collect::<String>();
    Some(limited)
}

fn truncate_for_prompt(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect::<String>()
}

fn is_placeholder_session_title(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.is_empty() || trimmed.eq_ignore_ascii_case(NEW_CHAT_TITLE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sanitize_generated_session_title_trims_quotes_and_prefixes() {
        assert_eq!(
            sanitize_generated_session_title("  \"# 修复 Rust 会话标题问题。\"  "),
            Some("修复 Rust 会话标题问题".to_string())
        );
    }

    #[test]
    fn fallback_session_title_uses_attachment_when_message_is_empty() {
        let attachment = json!({
            "fileName": "/tmp/小红书投放复盘Q2.pdf"
        });
        assert_eq!(
            fallback_session_title("", Some(&attachment)),
            "小红书投放复盘Q2".to_string()
        );
    }

    #[test]
    fn strip_path_and_extension_handles_local_paths() {
        assert_eq!(
            strip_path_and_extension("/tmp/demo/session-title.md"),
            "session-title".to_string()
        );
    }
}
