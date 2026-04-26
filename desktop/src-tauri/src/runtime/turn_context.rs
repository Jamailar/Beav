use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

use crate::skills::build_skill_runtime_state;
use crate::tools::plan::base_tool_names_for_metadata;
use crate::AppStore;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    pub parallel_tool_calls: bool,
    pub vision_input: bool,
    pub audio_input: bool,
    pub reasoning_split: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BoundContext {
    pub context_type: String,
    pub context_id: Option<String>,
    pub project_id: Option<String>,
    pub source_title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedboxTurnContext {
    pub runtime_mode: String,
    pub session_id: Option<String>,
    pub current_date: String,
    pub workspace_root: Option<PathBuf>,
    pub session_metadata: Option<Value>,
    pub active_skills: Vec<String>,
    pub allowed_tool_names: Vec<String>,
    pub bound_context: Option<BoundContext>,
    pub task_intent: Option<String>,
    pub model_capabilities: ModelCapabilities,
}

pub fn resolve_redbox_turn_context(
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
    current_date: String,
    workspace_root: Option<PathBuf>,
    model_capabilities: ModelCapabilities,
) -> RedboxTurnContext {
    let metadata = session_id
        .and_then(|id| {
            store
                .chat_sessions
                .iter()
                .find(|item| item.id == id)
                .and_then(|item| item.metadata.as_ref())
        })
        .cloned();
    let base_tools = base_tool_names_for_metadata(runtime_mode, metadata.as_ref());
    let skill_state =
        build_skill_runtime_state(&store.skills, runtime_mode, metadata.as_ref(), &base_tools);
    let active_skills = skill_state
        .active_skills
        .iter()
        .map(|skill| skill.name.clone())
        .collect::<Vec<_>>();
    let bound_context = metadata.as_ref().and_then(bound_context_from_metadata);
    let task_intent = metadata.as_ref().and_then(|value| {
        string_field(value, "taskIntent").or_else(|| string_field(value, "toolIntent"))
    });
    RedboxTurnContext {
        runtime_mode: normalize_runtime_mode(runtime_mode).to_string(),
        session_id: session_id.map(ToString::to_string),
        current_date,
        workspace_root,
        session_metadata: metadata,
        active_skills,
        allowed_tool_names: skill_state.allowed_tools,
        bound_context,
        task_intent,
        model_capabilities,
    }
}

fn bound_context_from_metadata(metadata: &Value) -> Option<BoundContext> {
    let context_type = string_field(metadata, "contextType")?;
    Some(BoundContext {
        context_type,
        context_id: string_field(metadata, "contextId"),
        project_id: string_field(metadata, "projectId"),
        source_title: string_field(metadata, "sourceTitle"),
    })
}

fn string_field(metadata: &Value, field: &str) -> Option<String> {
    metadata
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn normalize_runtime_mode(runtime_mode: &str) -> &str {
    match runtime_mode.trim() {
        "" | "default" | "chat" => "chatroom",
        "image_generation" => "image-generation",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn turn_context_resolves_session_metadata_and_tools() {
        let mut store = AppStore::default();
        store.chat_sessions.push(crate::ChatSessionRecord {
            id: "session-1".to_string(),
            title: "Session".to_string(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            metadata: Some(json!({
                "allowedTools": ["redbox_fs", "app_cli"],
                "contextType": "manuscript",
                "contextId": "draft-1",
                "taskIntent": "image"
            })),
        });

        let context = resolve_redbox_turn_context(
            &store,
            "redclaw",
            Some("session-1"),
            "2026-04-25".to_string(),
            None,
            ModelCapabilities::default(),
        );

        assert_eq!(context.runtime_mode, "redclaw");
        assert_eq!(context.task_intent.as_deref(), Some("image"));
        assert!(context.allowed_tool_names.contains(&"app_cli".to_string()));
        assert_eq!(
            context
                .bound_context
                .as_ref()
                .map(|item| item.context_type.as_str()),
            Some("manuscript")
        );
    }
}
