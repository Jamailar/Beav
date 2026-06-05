use super::app_update::{app_update_arch, app_update_platform};
use crate::logging::{create_feedback_report, mark_feedback_report_uploaded};
use crate::persistence::with_store;
use crate::store::settings as settings_store;
use crate::{payload_string, AppState};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect::<String>()
}

fn current_os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = crate::background_command("sw_vers")
            .arg("-productVersion")
            .output()
        {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !value.is_empty() {
                return value;
            }
        }
    }
    String::new()
}

fn feedback_priority(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "low" | "medium" | "high" | "urgent" => value.trim().to_ascii_lowercase(),
        _ => "medium".to_string(),
    }
}

fn feedback_category(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return "desktop_bug".to_string();
    }
    normalized
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .take(64)
        .collect::<String>()
}

fn feedback_source(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return "desktop".to_string();
    }
    normalized
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .take(64)
        .collect::<String>()
}

pub(super) fn create_feedback_report_command(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let content = truncate_chars(
        &payload_string(payload, "content")
            .or_else(|| payload_string(payload, "message"))
            .unwrap_or_default(),
        4000,
    );
    if content.chars().count() < 2 {
        return Err("请填写问题描述".to_string());
    }
    let title = truncate_chars(
        &payload_string(payload, "title").unwrap_or_else(|| {
            content
                .lines()
                .next()
                .unwrap_or("用户反馈")
                .chars()
                .take(40)
                .collect::<String>()
        }),
        120,
    );
    let category = feedback_category(
        &payload_string(payload, "category").unwrap_or_else(|| "desktop_bug".to_string()),
    );
    let priority = feedback_priority(
        &payload_string(payload, "priority").unwrap_or_else(|| "medium".to_string()),
    );
    let source = feedback_source(
        &payload_string(payload, "source").unwrap_or_else(|| "desktop".to_string()),
    );
    let include_advanced_context = payload
        .get("includeAdvancedContext")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let context = payload
        .get("context")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let contact = truncate_chars(&payload_string(payload, "contact").unwrap_or_default(), 256);
    let upload_now = payload
        .get("uploadNow")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let (report, log_text) = create_feedback_report(
        state,
        &title,
        &content,
        &category,
        &priority,
        &source,
        include_advanced_context,
        json!({
            "context": context,
            "contact": contact,
            "includeAdvancedContext": include_advanced_context,
        }),
    )?;
    if !upload_now {
        return Ok(json!({
            "success": true,
            "uploaded": false,
            "report": report,
        }));
    }

    let settings = with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    let mut feedback_context = context.as_object().cloned().unwrap_or_default();
    if !contact.is_empty() {
        feedback_context.insert("contact".to_string(), json!(contact));
    }
    feedback_context.insert("report_id".to_string(), json!(report.id.clone()));
    feedback_context.insert(
        "include_advanced_context".to_string(),
        json!(include_advanced_context),
    );

    let request_body = json!({
        "title": title,
        "content": content,
        "category": category,
        "priority": priority,
        "source": source,
        "client": {
            "app_version": env!("CARGO_PKG_VERSION"),
            "platform": app_update_platform().unwrap_or(std::env::consts::OS),
            "os_version": current_os_version(),
            "arch": app_update_arch().unwrap_or(std::env::consts::ARCH),
            "trace_id": report.id.clone(),
        },
        "log_text": log_text,
        "attachments": [],
        "context": Value::Object(feedback_context),
    });

    match crate::run_official_json_request_response(
        &settings,
        "POST",
        "/users/me/feedback",
        Some(request_body),
    ) {
        Ok(response) if (200..300).contains(&response.status) => {
            let uploaded_report = mark_feedback_report_uploaded(&report.id, response.body.clone())?;
            Ok(json!({
                "success": true,
                "uploaded": true,
                "report": uploaded_report,
                "response": response.body,
            }))
        }
        Ok(response) => Ok(json!({
            "success": true,
            "uploaded": false,
            "report": report,
            "error": format!("反馈提交失败：HTTP {}", response.status),
            "response": response.body,
        })),
        Err(error) => Ok(json!({
            "success": true,
            "uploaded": false,
            "report": report,
            "error": error,
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::{feedback_category, feedback_priority, feedback_source, truncate_chars};

    #[test]
    fn feedback_priority_defaults_to_medium_for_unknown_values() {
        assert_eq!(feedback_priority("urgent"), "urgent");
        assert_eq!(feedback_priority("not-real"), "medium");
    }

    #[test]
    fn feedback_category_and_source_are_ascii_protocol_values() {
        assert_eq!(feedback_category(" Bug/Crash! "), "bugcrash");
        assert_eq!(feedback_category(" "), "desktop_bug");
        assert_eq!(feedback_source(" Plugin UI "), "pluginui");
        assert_eq!(feedback_source(" "), "desktop");
    }

    #[test]
    fn truncate_chars_trims_and_limits_by_chars() {
        assert_eq!(truncate_chars("  你好世界  ", 2), "你好");
    }
}
