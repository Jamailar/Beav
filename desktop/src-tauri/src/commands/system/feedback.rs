use super::app_update::{app_update_arch, app_update_platform};
use crate::logging::{create_feedback_report, mark_feedback_report_uploaded};
use crate::persistence::with_store;
use crate::store::settings as settings_store;
use crate::{payload_field, payload_string, AppState, AppStore, SessionToolResultRecord};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, State};

const AUTHORING_EVIDENCE_SCHEMA: &str = "redbox.authoringToolEvidence.v1";
const AUTHORING_ACTION_CREATE_PROJECT: &str = "manuscripts.createProject";
const AUTHORING_ACTION_WRITE_CURRENT: &str = "manuscripts.writeCurrent";
const AUTHORING_TOOL_RESULT_LIMIT: usize = 12;
const AUTHORING_RUNTIME_EVENT_LIMIT: usize = 12;
const AUTHORING_CHECKPOINT_LIMIT: usize = 8;

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

fn value_path_string(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current
        .as_str()
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
}

fn value_path_bool(value: &Value, path: &[&str]) -> Option<bool> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_bool()
}

fn string_alias(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| payload_string(value, key))
}

fn i64_alias(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .find_map(|key| payload_field(value, key).and_then(Value::as_i64))
}

fn parse_json_object(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text)
        .ok()
        .filter(Value::is_object)
}

fn tool_record_result_value(record: &SessionToolResultRecord) -> Option<Value> {
    if let Some(payload) = record.payload.as_ref() {
        if let Some(result) = payload.get("result").filter(|value| value.is_object()) {
            return Some(result.clone());
        }
        if payload.get("action").is_some() || payload.get("data").is_some() {
            return Some(payload.clone());
        }
    }
    record
        .result_text
        .as_deref()
        .and_then(parse_json_object)
        .or_else(|| record.summary_text.as_deref().and_then(parse_json_object))
}

fn tool_record_arguments_value(record: &SessionToolResultRecord) -> Option<&Value> {
    record
        .payload
        .as_ref()
        .and_then(|payload| payload.get("arguments"))
        .filter(|value| value.is_object())
}

fn tool_record_action(record: &SessionToolResultRecord) -> Option<String> {
    record
        .payload
        .as_ref()
        .and_then(|payload| {
            payload_string(payload, "action")
                .or_else(|| {
                    payload
                        .get("arguments")
                        .and_then(|value| payload_string(value, "action"))
                })
                .or_else(|| {
                    payload
                        .get("result")
                        .and_then(|value| payload_string(value, "action"))
                })
        })
        .or_else(|| {
            record
                .result_text
                .as_deref()
                .and_then(parse_json_object)
                .and_then(|value| payload_string(&value, "action"))
        })
}

fn is_authoring_action(action: &str) -> bool {
    matches!(
        action,
        AUTHORING_ACTION_CREATE_PROJECT | AUTHORING_ACTION_WRITE_CURRENT
    )
}

fn content_chars_from_value(value: &Value) -> Option<usize> {
    value_path_string(value, &["payload", "content"])
        .or_else(|| value_path_string(value, &["input", "content"]))
        .or_else(|| payload_string(value, "content"))
        .map(|content| content.chars().count())
}

fn result_data(value: &Value) -> &Value {
    value.get("data").unwrap_or(value)
}

fn normalized_authoring_tool_result(record: &SessionToolResultRecord) -> Option<Value> {
    let action = tool_record_action(record)?;
    if !is_authoring_action(&action) {
        return None;
    }
    let result = tool_record_result_value(record).unwrap_or_else(|| json!({}));
    let data = result_data(&result);
    let arguments = tool_record_arguments_value(record);
    let mut output = Map::new();
    if let Some(value) =
        value_path_bool(&result, &["ok"]).or_else(|| value_path_bool(data, &["ok"]))
    {
        output.insert("ok".to_string(), json!(value));
    }
    if let Some(value) = string_alias(data, &["projectPath", "path"]) {
        output.insert("projectPath".to_string(), json!(value));
    }
    if let Some(value) = string_alias(data, &["contentPath", "entryPath"]) {
        output.insert("contentPath".to_string(), json!(value));
    }
    if let Some(value) = i64_alias(data, &["savedBytes", "saved_bytes"]) {
        output.insert("savedBytes".to_string(), json!(value));
    }
    if let Some(error) = result.get("error").and_then(Value::as_object) {
        if let Some(value) = error.get("code").and_then(Value::as_str) {
            output.insert("errorCode".to_string(), json!(value));
        }
        if let Some(value) = error.get("message").and_then(Value::as_str) {
            output.insert(
                "errorMessage".to_string(),
                json!(truncate_chars(value, 500)),
            );
        }
        if let Some(value) = error.get("retryable").and_then(Value::as_bool) {
            output.insert("retryable".to_string(), json!(value));
        }
    } else if !record.success {
        if let Some(value) = record
            .summary_text
            .as_deref()
            .or(record.result_text.as_deref())
        {
            output.insert(
                "errorMessage".to_string(),
                json!(truncate_chars(value, 500)),
            );
        }
    }
    let mut input = Map::new();
    if let Some(chars) = arguments.and_then(content_chars_from_value) {
        input.insert("contentChars".to_string(), json!(chars));
    }
    Some(json!({
        "id": record.id,
        "sessionId": record.session_id,
        "runtimeId": record.runtime_id,
        "sourceTaskId": record.source_task_id,
        "callId": record.call_id,
        "toolName": record.tool_name,
        "action": action,
        "success": record.success,
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
        "truncated": record.truncated,
        "input": Value::Object(input),
        "output": Value::Object(output),
    }))
}

fn authoring_target_from_metadata(metadata: Option<&Value>) -> Value {
    let Some(metadata) = metadata else {
        return Value::Null;
    };
    let project_path = payload_string(metadata, "currentAuthoringProjectPath");
    let content_path = payload_string(metadata, "currentAuthoringContentPath");
    if project_path
        .as_deref()
        .unwrap_or_default()
        .trim()
        .is_empty()
        && content_path
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
    {
        return Value::Null;
    }
    json!({
        "projectPath": project_path,
        "contentPath": content_path,
        "entryPath": payload_string(metadata, "currentAuthoringEntryPath"),
        "kind": payload_string(metadata, "currentAuthoringProjectKind"),
        "title": payload_string(metadata, "currentAuthoringTitle"),
    })
}

fn session_has_authoring_target(metadata: Option<&Value>) -> bool {
    !authoring_target_from_metadata(metadata).is_null()
}

fn requested_feedback_session_id(context: &Value) -> Option<String> {
    payload_string(context, "sessionId")
        .or_else(|| payload_string(context, "chatSessionId"))
        .or_else(|| payload_string(context, "runtimeSessionId"))
        .or_else(|| value_path_string(context, &["runtime", "sessionId"]))
        .or_else(|| value_path_string(context, &["chat", "sessionId"]))
}

fn select_authoring_evidence_session(
    store: &AppStore,
    context: &Value,
) -> (Option<String>, String) {
    if let Some(session_id) = requested_feedback_session_id(context) {
        if store
            .chat_sessions
            .iter()
            .any(|session| session.id == session_id)
        {
            return (Some(session_id), "context.sessionId".to_string());
        }
    }
    let mut sessions = store.chat_sessions.iter().collect::<Vec<_>>();
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    if let Some(session) = sessions
        .iter()
        .find(|session| session_has_authoring_target(session.metadata.as_ref()))
    {
        return (
            Some(session.id.clone()),
            "latest_authoring_target".to_string(),
        );
    }
    if let Some(result) = store.session_tool_results.iter().rev().find(|item| {
        tool_record_action(item)
            .as_deref()
            .map(is_authoring_action)
            .unwrap_or(false)
    }) {
        return (
            Some(result.session_id.clone()),
            "latest_authoring_tool_result".to_string(),
        );
    }
    (None, "none".to_string())
}

fn summarize_authoring_runtime_event(event: &crate::runtime::RuntimeEventRecord) -> Option<Value> {
    if !matches!(
        event.event_type.as_str(),
        "runtime:tool-end" | "tool_result"
    ) {
        return None;
    }
    let payload = event.payload.as_ref()?;
    let name = payload_string(payload, "name").or_else(|| payload_string(payload, "toolName"));
    let content = value_path_string(payload, &["output", "content"]);
    let parsed = content.as_deref().and_then(parse_json_object);
    let action = parsed
        .as_ref()
        .and_then(|value| payload_string(value, "action"))
        .or_else(|| payload_string(payload, "action"));
    if !action.as_deref().map(is_authoring_action).unwrap_or(false) {
        return None;
    }
    let parsed = parsed.unwrap_or_else(|| json!({}));
    let data = result_data(&parsed);
    Some(json!({
        "id": event.id,
        "eventType": event.event_type,
        "category": event.category,
        "createdAt": event.created_at,
        "callId": event.tool_call_id,
        "name": name,
        "action": action,
        "success": value_path_bool(payload, &["output", "success"]),
        "savedBytes": i64_alias(data, &["savedBytes", "saved_bytes"]),
        "errorCode": value_path_string(&parsed, &["error", "code"]),
    }))
}

fn authoring_checkpoint_summary(checkpoint: &crate::runtime::SessionCheckpointRecord) -> Value {
    let payload = checkpoint.payload.as_ref().unwrap_or(&Value::Null);
    json!({
        "id": checkpoint.id,
        "checkpointType": checkpoint.checkpoint_type,
        "summary": checkpoint.summary,
        "createdAt": checkpoint.created_at,
        "projectPath": payload_string(payload, "projectPath"),
        "contentPath": payload_string(payload, "contentPath"),
        "entryPath": payload_string(payload, "entryPath"),
        "kind": payload_string(payload, "kind"),
        "title": payload_string(payload, "title"),
    })
}

fn recent_values(mut values: Vec<Value>, limit: usize) -> Vec<Value> {
    if values.len() > limit {
        let split_at = values.len().saturating_sub(limit);
        values.drain(..split_at);
    }
    values
}

fn feedback_authoring_tool_evidence_from_store(store: &AppStore, context: &Value) -> Value {
    let (session_id, selected_reason) = select_authoring_evidence_session(store, context);
    let requested_session_id = requested_feedback_session_id(context);
    let Some(session_id) = session_id else {
        return json!({
            "schema": AUTHORING_EVIDENCE_SCHEMA,
            "selectedSessionId": Value::Null,
            "requestedSessionId": requested_session_id,
            "selectedReason": selected_reason,
            "matched": false,
        });
    };
    let session = store
        .chat_sessions
        .iter()
        .find(|item| item.id == session_id);
    let mut tool_results = store
        .session_tool_results
        .iter()
        .filter(|item| item.session_id == session_id)
        .filter_map(normalized_authoring_tool_result)
        .collect::<Vec<_>>();
    tool_results.sort_by_key(|item| {
        item.get("createdAt")
            .and_then(Value::as_i64)
            .unwrap_or_default()
    });
    let latest_create = tool_results
        .iter()
        .rev()
        .find(|item| {
            payload_string(item, "action").as_deref() == Some(AUTHORING_ACTION_CREATE_PROJECT)
        })
        .cloned()
        .unwrap_or(Value::Null);
    let latest_write = tool_results
        .iter()
        .rev()
        .find(|item| {
            payload_string(item, "action").as_deref() == Some(AUTHORING_ACTION_WRITE_CURRENT)
        })
        .cloned()
        .unwrap_or(Value::Null);
    let successful_write_saved_bytes = latest_write
        .get("output")
        .and_then(|output| output.get("savedBytes"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let mut runtime_events = store
        .runtime_events
        .iter()
        .filter(|item| item.session_id.as_deref() == Some(&session_id))
        .filter_map(summarize_authoring_runtime_event)
        .collect::<Vec<_>>();
    runtime_events.sort_by_key(|item| {
        item.get("createdAt")
            .and_then(Value::as_i64)
            .unwrap_or_default()
    });
    let mut checkpoints = store
        .session_checkpoints
        .iter()
        .filter(|item| item.session_id == session_id)
        .filter(|item| item.checkpoint_type == "chat.authoring_target_bound")
        .map(authoring_checkpoint_summary)
        .collect::<Vec<_>>();
    checkpoints.sort_by_key(|item| {
        item.get("createdAt")
            .and_then(Value::as_i64)
            .unwrap_or_default()
    });
    let transcript_record_count = store
        .session_transcript_records
        .iter()
        .filter(|item| item.session_id == session_id)
        .count();
    json!({
        "schema": AUTHORING_EVIDENCE_SCHEMA,
        "requestedSessionId": requested_session_id,
        "selectedSessionId": session_id,
        "selectedReason": selected_reason,
        "matched": true,
        "session": session.map(|item| json!({
            "id": item.id,
            "title": item.title,
            "createdAt": item.created_at,
            "updatedAt": item.updated_at,
            "runtimeId": item.metadata.as_ref().and_then(|metadata| payload_string(metadata, "runtimeId")),
            "parentRuntimeId": item.metadata.as_ref().and_then(|metadata| payload_string(metadata, "parentRuntimeId")),
            "sourceTaskId": item.metadata.as_ref().and_then(|metadata| payload_string(metadata, "sourceTaskId")),
        })).unwrap_or(Value::Null),
        "authoringTarget": authoring_target_from_metadata(session.and_then(|item| item.metadata.as_ref())),
        "summary": {
            "toolResultCount": tool_results.len(),
            "runtimeEventCount": runtime_events.len(),
            "authoringCheckpointCount": checkpoints.len(),
            "transcriptRecordCount": transcript_record_count,
            "hasCreateProject": !latest_create.is_null(),
            "hasWriteCurrent": !latest_write.is_null(),
            "writeCurrentSavedBytes": successful_write_saved_bytes,
            "writeCurrentSavedContent": successful_write_saved_bytes > 0,
        },
        "latestCreateProject": latest_create,
        "latestWriteCurrent": latest_write,
        "toolResults": recent_values(tool_results, AUTHORING_TOOL_RESULT_LIMIT),
        "runtimeEvents": recent_values(runtime_events, AUTHORING_RUNTIME_EVENT_LIMIT),
        "authoringCheckpoints": recent_values(checkpoints, AUTHORING_CHECKPOINT_LIMIT),
    })
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
    let mut feedback_context = context.as_object().cloned().unwrap_or_default();
    let authoring_evidence = with_store(state, |store| {
        Ok(feedback_authoring_tool_evidence_from_store(
            &store,
            &Value::Object(feedback_context.clone()),
        ))
    })?;
    feedback_context.insert("authoringEvidence".to_string(), authoring_evidence);
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
            "context": Value::Object(feedback_context.clone()),
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
    use super::{
        feedback_authoring_tool_evidence_from_store, feedback_category, feedback_priority,
        feedback_source, truncate_chars, AUTHORING_ACTION_CREATE_PROJECT,
        AUTHORING_ACTION_WRITE_CURRENT,
    };
    use crate::{AppStore, ChatSessionRecord, SessionToolResultRecord};
    use serde_json::json;

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

    #[test]
    fn authoring_evidence_includes_write_status_without_raw_content() {
        let mut store = AppStore::default();
        store.chat_sessions.push(ChatSessionRecord {
            id: "session-1".to_string(),
            title: "稿件生成".to_string(),
            created_at: "2026-06-24T09:00:00Z".to_string(),
            updated_at: "2026-06-24T09:10:00Z".to_string(),
            metadata: Some(json!({
                "runtimeId": "runtime-1",
                "currentAuthoringProjectPath": "wander/demo",
                "currentAuthoringContentPath": "wander/demo/content.md",
                "currentAuthoringEntryPath": "wander/demo/content.md",
                "currentAuthoringProjectKind": "post",
                "currentAuthoringTitle": "demo"
            })),
            deleted_at: None,
            starred: false,
            archived: false,
            archived_at: None,
        });
        store.session_tool_results.push(SessionToolResultRecord {
            id: "tool-create".to_string(),
            session_id: "session-1".to_string(),
            runtime_id: Some("runtime-1".to_string()),
            parent_runtime_id: None,
            source_task_id: None,
            call_id: "call-create".to_string(),
            tool_name: "workflow".to_string(),
            command: None,
            success: true,
            result_text: None,
            summary_text: None,
            prompt_text: None,
            original_chars: None,
            prompt_chars: None,
            truncated: false,
            payload: Some(json!({
                "arguments": {
                    "action": AUTHORING_ACTION_CREATE_PROJECT,
                    "payload": { "kind": "post", "title": "demo" }
                },
                "result": {
                    "ok": true,
                    "action": AUTHORING_ACTION_CREATE_PROJECT,
                    "data": {
                        "projectPath": "wander/demo",
                        "contentPath": "wander/demo/content.md"
                    }
                }
            })),
            created_at: 1,
            updated_at: 1,
        });
        store.session_tool_results.push(SessionToolResultRecord {
            id: "tool-write".to_string(),
            session_id: "session-1".to_string(),
            runtime_id: Some("runtime-1".to_string()),
            parent_runtime_id: None,
            source_task_id: None,
            call_id: "call-write".to_string(),
            tool_name: "workflow".to_string(),
            command: None,
            success: true,
            result_text: None,
            summary_text: None,
            prompt_text: None,
            original_chars: None,
            prompt_chars: None,
            truncated: false,
            payload: Some(json!({
                "arguments": {
                    "action": AUTHORING_ACTION_WRITE_CURRENT,
                    "payload": { "content": "正文内容" }
                },
                "result": {
                    "ok": true,
                    "action": AUTHORING_ACTION_WRITE_CURRENT,
                    "data": {
                        "projectPath": "wander/demo",
                        "contentPath": "wander/demo/content.md",
                        "savedBytes": 12
                    }
                }
            })),
            created_at: 2,
            updated_at: 2,
        });

        let evidence = feedback_authoring_tool_evidence_from_store(
            &store,
            &json!({ "sessionId": "session-1" }),
        );
        let serialized = serde_json::to_string(&evidence).unwrap();

        assert_eq!(evidence["selectedSessionId"], "session-1");
        assert_eq!(evidence["summary"]["hasCreateProject"], true);
        assert_eq!(evidence["summary"]["hasWriteCurrent"], true);
        assert_eq!(evidence["summary"]["writeCurrentSavedBytes"], 12);
        assert_eq!(evidence["latestWriteCurrent"]["input"]["contentChars"], 4);
        assert!(!serialized.contains("正文内容"));
    }
}
