use crate::commands::chat_state::ensure_chat_session;
use crate::session_manager::{ensure_context_session, update_metadata};
use crate::{slug_from_relative_path, title_from_relative_path, AppStore, ChatSessionRecord};
use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorChatBindingRequest {
    pub session: EditorChatSessionBinding,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorChatSessionBinding {
    pub scope: String,
    pub file_path: Option<String>,
    pub context_type: String,
    pub context_id: String,
    pub title: Option<String>,
    pub mode_label: Option<String>,
    pub target_type_label: Option<String>,
    pub target_path: Option<String>,
    pub initial_context: Option<String>,
}

pub(crate) fn bind_editor_session(
    store: &mut AppStore,
    request: EditorChatBindingRequest,
) -> Result<ChatSessionRecord, String> {
    let binding = request.session;
    let scope = binding.scope.trim().to_ascii_lowercase();
    let mut metadata = normalize_metadata(request.metadata);
    let context_type = non_empty_or_default(&binding.context_type, "file");
    let target_path = binding
        .target_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    let session = match scope.as_str() {
        "context" => {
            let context_id = binding.context_id.trim();
            if context_id.is_empty() {
                return Err("contextId is required for context-bound editor chat".to_string());
            }
            let initial_context = derive_initial_context(&binding, target_path.as_deref(), None);
            ensure_context_session(
                store,
                &context_type,
                context_id,
                binding
                    .title
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| "New Chat".to_string()),
                initial_context.as_deref(),
            )
        }
        "file" => {
            let file_path = binding
                .file_path
                .clone()
                .unwrap_or_else(|| binding.context_id.clone());
            let normalized_file_path = file_path.trim().to_string();
            if normalized_file_path.is_empty() {
                return Err("filePath is required for file-bound editor chat".to_string());
            }
            let session_key = format!(
                "file-session:{}",
                slug_from_relative_path(&normalized_file_path)
            );
            let title = binding
                .title
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| title_from_relative_path(&normalized_file_path));
            let (session, _) =
                ensure_chat_session(&mut store.chat_sessions, Some(session_key), Some(title));
            session.clone()
        }
        _ => {
            return Err(format!(
                "unsupported editor chat binding scope: {}",
                binding.scope
            ));
        }
    };

    metadata.insert("contextType".to_string(), Value::String(context_type));
    metadata.insert(
        "contextId".to_string(),
        Value::String(binding.context_id.clone()),
    );
    metadata.insert("isContextBound".to_string(), Value::Bool(true));
    metadata.insert(
        "editorBindingVersion".to_string(),
        metadata
            .get("editorBindingVersion")
            .cloned()
            .unwrap_or_else(|| Value::from(1)),
    );
    metadata.insert(
        "editorBindingScope".to_string(),
        Value::String(scope.clone()),
    );
    if metadata
        .get("associatedFilePath")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        if let Some(path) = target_path.clone() {
            metadata.insert("associatedFilePath".to_string(), Value::String(path));
        }
    }
    if let Some(initial_context) =
        derive_initial_context(&binding, target_path.as_deref(), Some(&metadata))
    {
        metadata.insert("initialContext".to_string(), Value::String(initial_context));
    }

    let session_id = session.id.clone();
    let _ = update_metadata(store, &session_id, Some(Value::Object(metadata)));
    store
        .chat_sessions
        .iter()
        .find(|item| item.id == session_id)
        .cloned()
        .ok_or_else(|| "failed to persist editor chat binding".to_string())
}

fn normalize_metadata(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn non_empty_or_default(value: &str, fallback: &str) -> String {
    let normalized = value.trim();
    if normalized.is_empty() {
        fallback.to_string()
    } else {
        normalized.to_string()
    }
}

fn derive_initial_context(
    binding: &EditorChatSessionBinding,
    target_path: Option<&str>,
    metadata: Option<&Map<String, Value>>,
) -> Option<String> {
    if let Some(explicit) = binding
        .initial_context
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(explicit.to_string());
    }

    let mode_label = binding
        .mode_label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            metadata.and_then(|item| map_string(item, "associatedPackageWorkspaceModeLabel"))
        })
        .or_else(|| metadata.and_then(|item| map_string(item, "associatedPackageWorkspaceMode")))
        .or_else(|| Some("文件".to_string()))?;
    let target_type_label = binding
        .target_type_label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| metadata.and_then(|item| map_string(item, "associatedPackageKind")))
        .unwrap_or_else(|| "文件".to_string());
    let normalized_target_path = target_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| metadata.and_then(|item| map_string(item, "associatedFilePath")))
        .or_else(|| {
            binding
                .file_path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
        .or_else(|| {
            let context_id = binding.context_id.trim();
            (!context_id.is_empty()).then(|| context_id.to_string())
        })?;

    Some(format!(
        "当前聊天窗口正处于{}模式，正在编辑的{}文件路径是{}",
        mode_label, target_type_label, normalized_target_path
    ))
}

fn map_string(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn derive_initial_context_uses_binding_fields() {
        let binding = EditorChatSessionBinding {
            scope: "file".to_string(),
            file_path: Some("manuscripts/demo.redpost".to_string()),
            context_type: "file".to_string(),
            context_id: "manuscripts/demo.redpost".to_string(),
            title: Some("Demo".to_string()),
            mode_label: Some("稿件编辑".to_string()),
            target_type_label: Some("图文稿件".to_string()),
            target_path: Some("manuscripts/demo.redpost".to_string()),
            initial_context: None,
        };
        assert_eq!(
            derive_initial_context(&binding, binding.target_path.as_deref(), None).as_deref(),
            Some("当前聊天窗口正处于稿件编辑模式，正在编辑的图文稿件文件路径是manuscripts/demo.redpost")
        );
    }

    #[test]
    fn bind_editor_session_merges_initial_context_into_metadata() {
        let mut store = AppStore::default();
        let result = bind_editor_session(
            &mut store,
            EditorChatBindingRequest {
                session: EditorChatSessionBinding {
                    scope: "file".to_string(),
                    file_path: Some("manuscripts/demo.redpost".to_string()),
                    context_type: "file".to_string(),
                    context_id: "manuscripts/demo.redpost".to_string(),
                    title: Some("Demo".to_string()),
                    mode_label: Some("稿件编辑".to_string()),
                    target_type_label: Some("图文稿件".to_string()),
                    target_path: Some("manuscripts/demo.redpost".to_string()),
                    initial_context: None,
                },
                metadata: json!({
                    "associatedFilePath": "manuscripts/demo.redpost",
                    "associatedPackageKind": "richpost"
                }),
            },
        )
        .expect("bind session");

        let metadata = result.metadata.expect("metadata");
        assert_eq!(
            metadata.get("initialContext").and_then(Value::as_str),
            Some("当前聊天窗口正处于稿件编辑模式，正在编辑的图文稿件文件路径是manuscripts/demo.redpost")
        );
        assert_eq!(
            metadata.get("editorBindingScope").and_then(Value::as_str),
            Some("file")
        );
    }
}
