use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::agent::{
    build_runtime_context_bundle, context_bundle_checkpoint_payload,
    render_runtime_context_bundle_prompt, runtime_context_bundle_enabled,
};
use crate::persistence::with_store;
use crate::runtime::{load_session_bundle_messages, runtime_context_messages_for_session};
use crate::tools::capabilities::resolve_capability_set_value;
use crate::tools::registry::{openai_schemas_for_runtime_mode, openai_schemas_for_session};
use crate::{lexbox_project_root, workspace_root, AppState};

pub(crate) fn legacy_interactive_runtime_system_prompt(
    _state: &State<'_, AppState>,
    runtime_mode: &str,
    _session_id: Option<&str>,
) -> String {
    if runtime_mode == "wander" {
        return [
            "You are RedClaw's wander ideation agent inside RedBox.",
            "Your only job is to inspect the provided material folders/files, discover hidden connections, and return strict JSON for a new topic.",
            "Use only the available redbox_* file tools in this runtime.",
            "You must inspect files before concluding.",
            "Keep the process lean: use redbox_fs(action=list) to inspect folders, then redbox_fs(action=read) for exact files, synthesize, output JSON only.",
            "Never suggest shell commands, app_cli, bash, workspace edits, or pseudo tools.",
        ]
        .join(" ");
    }
    format!(
        "You are the RedClaw desktop AI runtime inside RedBox for mode `{}`. \
Use tools when the user asks about app state, knowledge, advisors, work items, memories, sessions, or settings. \
Do not invent workspace/app facts that you can fetch with tools. \
If no tool is needed, answer directly and concisely. \
When using tools, synthesize the final answer in Chinese unless the user clearly asks otherwise.",
        runtime_mode
    )
}

pub(crate) fn interactive_runtime_system_prompt(
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> String {
    if session_id.is_none() {
        if let Ok(runtime_warm) = state.runtime_warm.lock() {
            if let Some(entry) = runtime_warm.entries.get(runtime_mode) {
                if !entry.system_prompt.trim().is_empty() {
                    return entry.system_prompt.clone();
                }
            }
        }
    }
    let settings_snapshot =
        with_store(state, |store| Ok(store.settings.clone())).unwrap_or_default();
    if !runtime_context_bundle_enabled(&settings_snapshot) {
        return legacy_interactive_runtime_system_prompt(state, runtime_mode, session_id);
    }
    build_runtime_context_bundle(state, runtime_mode, session_id)
        .map(|bundle| render_runtime_context_bundle_prompt(&bundle))
        .unwrap_or_else(|_| {
            legacy_interactive_runtime_system_prompt(state, runtime_mode, session_id)
        })
}

pub(crate) fn interactive_runtime_context_snapshot(
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> Option<Value> {
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone())).ok()?;
    if !runtime_context_bundle_enabled(&settings_snapshot) {
        return None;
    }
    build_runtime_context_bundle(state, runtime_mode, session_id)
        .ok()
        .map(|bundle| {
            let mut payload = context_bundle_checkpoint_payload(&bundle);
            if let Some(object) = payload.as_object_mut() {
                if let Ok(capability_set) =
                    resolve_capability_set_value(state, runtime_mode, session_id)
                {
                    object.insert("capabilitySet".to_string(), capability_set);
                }
            }
            payload
        })
}

pub(crate) fn parse_usize_arg(arguments: &Value, key: &str, default: usize, max: usize) -> usize {
    arguments
        .get(key)
        .and_then(|value| value.as_u64())
        .map(|value| value as usize)
        .unwrap_or(default)
        .clamp(1, max)
}

pub(crate) fn text_snippet(value: &str, limit: usize) -> String {
    let text = value.replace('\n', " ").trim().to_string();
    if text.chars().count() <= limit {
        return text;
    }
    text.chars().take(limit).collect::<String>()
}

pub(crate) fn collect_recent_chat_messages(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    limit: usize,
) -> Vec<Value> {
    let Some(session_id) = session_id else {
        return Vec::new();
    };
    if let Ok(bundle_messages) = load_session_bundle_messages(state, session_id) {
        if !bundle_messages.is_empty() {
            let summary_prompt = with_store(state, |store| {
                Ok(
                    store
                        .session_context_records
                        .iter()
                        .find(|item| {
                            item.session_id == session_id && item.compacted_message_count > 0
                        })
                        .map(|item| {
                            format!(
                                "[Session resume summary]\n{}\n\nUse this archived context together with the recent messages below.",
                                item.summary
                            )
                        }),
                )
            })
            .ok()
            .flatten();
            return crate::runtime::bundle_messages_for_runtime(
                &bundle_messages,
                summary_prompt,
                limit,
            );
        }
    }
    with_store(state, |store| {
        Ok(runtime_context_messages_for_session(
            None, &store, session_id, limit,
        ))
    })
    .unwrap_or_default()
}

pub(crate) fn resolve_workspace_tool_path(
    state: &State<'_, AppState>,
    raw_path: &str,
) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("path is required".to_string());
    }
    if let Some(relative) = trimmed.strip_prefix("builtin-skills/") {
        let builtin_root = lexbox_project_root().join("builtin-skills");
        let candidate = builtin_root.join(relative);
        let normalized = candidate.canonicalize().unwrap_or(candidate.clone());
        let builtin_normalized = builtin_root.canonicalize().unwrap_or(builtin_root);
        if !normalized.starts_with(&builtin_normalized) {
            return Err("path is outside builtin-skills".to_string());
        }
        return Ok(normalized);
    }
    let workspace = workspace_root(state)?;
    let candidate = if Path::new(trimmed).is_absolute() {
        PathBuf::from(trimmed)
    } else {
        workspace.join(trimmed)
    };
    let normalized = candidate.canonicalize().unwrap_or(candidate.clone());
    let workspace_normalized = workspace.canonicalize().unwrap_or(workspace);
    if !normalized.starts_with(&workspace_normalized) {
        return Err("path is outside currentSpaceRoot".to_string());
    }
    Ok(normalized)
}

pub(crate) fn list_directory_entries(path: &Path, limit: usize) -> Result<Vec<Value>, String> {
    let mut entries = fs::read_dir(path)
        .map_err(|error| error.to_string())?
        .flatten()
        .map(|entry| {
            let entry_path = entry.path();
            json!({
                "name": entry.file_name().to_string_lossy().to_string(),
                "path": entry_path.display().to_string(),
                "kind": if entry_path.is_dir() { "dir" } else { "file" }
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        a.get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .cmp(b.get("name").and_then(|v| v.as_str()).unwrap_or(""))
    });
    if entries.len() > limit {
        entries.truncate(limit);
    }
    Ok(entries)
}

pub(crate) fn interactive_runtime_tools_for_mode(
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> Value {
    with_store(state, |store| {
        Ok(openai_schemas_for_session(&store, runtime_mode, session_id))
    })
    .unwrap_or_else(|_| openai_schemas_for_runtime_mode(runtime_mode))
}
