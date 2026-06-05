use super::*;

pub fn resolve_session_file_reference_inputs(
    state: &State<'_, AppState>,
    session_id: &str,
    inputs: Vec<String>,
) -> Vec<String> {
    if inputs.is_empty() {
        return inputs;
    }
    let original_inputs = inputs.clone();
    let fallback_dirs = session_reference_fallback_dirs(state);
    with_store(state, |store| {
        Ok(inputs
            .into_iter()
            .map(|raw| {
                resolve_session_file_reference_input_from_store(
                    &store,
                    session_id,
                    &raw,
                    &fallback_dirs,
                )
            })
            .collect::<Vec<_>>())
    })
    .unwrap_or(original_inputs)
}

pub(super) fn resolve_session_file_reference_input_from_store(
    store: &AppStore,
    session_id: &str,
    raw: &str,
    fallback_dirs: &[PathBuf],
) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("data:")
        || Path::new(trimmed).exists()
    {
        return trimmed.to_string();
    }
    let target_name = Path::new(trimmed)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(trimmed)
        .trim();
    let chat_messages = chat_messages_for_session(store, session_id);
    if let Some(resolved) = chat_messages.iter().rev().find_map(|message| {
        message.attachment.as_ref().and_then(|attachment| {
            resolve_reference_from_value_tree(attachment, trimmed, target_name, fallback_dirs, 0)
        })
    }) {
        return resolved;
    }
    let tool_results = tool_results_for_session(store, session_id);
    if let Some(resolved) = tool_results.iter().rev().find_map(|result| {
        result.payload.as_ref().and_then(|payload| {
            resolve_reference_from_value_tree(payload, trimmed, target_name, fallback_dirs, 0)
        })
    }) {
        return resolved;
    }
    if let Some(resolved) = fallback_dirs
        .iter()
        .find_map(|root| resolve_reference_from_dir(root, trimmed))
    {
        return resolved;
    }
    trimmed.to_string()
}

fn session_reference_fallback_dirs(state: &State<'_, AppState>) -> Vec<PathBuf> {
    let mut dirs = Vec::<PathBuf>::new();
    if let Ok(workspace) = crate::workspace_root(state) {
        dirs.push(workspace.clone());
        dirs.push(workspace.join(".redbox").join("chat-attachments"));
        dirs.push(workspace.join(".redbox").join("media"));
    }
    if let Ok(store_root) = store_root(state) {
        dirs.push(store_root.join("tmp").join("chat-inline-attachments"));
        dirs.push(store_root.join("media"));
    }
    dirs
}

pub(super) fn resolve_reference_from_value_tree(
    value: &Value,
    raw: &str,
    target_name: &str,
    fallback_dirs: &[PathBuf],
    depth: usize,
) -> Option<String> {
    const MAX_DEPTH: usize = 8;
    if depth > MAX_DEPTH {
        return None;
    }
    match value {
        Value::Object(object) => {
            if let Some(resolved) =
                resolve_reference_from_object(object, raw, target_name, fallback_dirs)
            {
                return Some(resolved);
            }
            object.values().find_map(|nested| {
                resolve_reference_from_value_tree(
                    nested,
                    raw,
                    target_name,
                    fallback_dirs,
                    depth + 1,
                )
            })
        }
        Value::Array(items) => items.iter().find_map(|nested| {
            resolve_reference_from_value_tree(nested, raw, target_name, fallback_dirs, depth + 1)
        }),
        _ => None,
    }
}

fn resolve_reference_from_object(
    value: &serde_json::Map<String, Value>,
    raw: &str,
    target_name: &str,
    fallback_dirs: &[PathBuf],
) -> Option<String> {
    let get = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|candidate| !candidate.is_empty())
    };

    let absolute_path = get("absolutePath")
        .or_else(|| get("originalAbsolutePath"))
        .or_else(|| get("path").filter(|candidate| Path::new(candidate).is_absolute()));
    let relative_path = get("workspaceRelativePath")
        .or_else(|| get("toolPath"))
        .or_else(|| get("relativePath"))
        .or_else(|| get("path").filter(|candidate| !Path::new(candidate).is_absolute()));
    let remote_path = get("previewUrl").or_else(|| get("localUrl"));
    let matches_name = [
        get("name"),
        get("title"),
        get("label"),
        absolute_path.and_then(path_file_name),
        relative_path.and_then(path_file_name),
        remote_path.and_then(path_file_name_from_url),
    ]
    .into_iter()
    .flatten()
    .any(|candidate| candidate == raw || candidate == target_name);
    if !matches_name {
        return None;
    }
    if let Some(path) = absolute_path {
        return Some(path.to_string());
    }
    if let Some(path) = relative_path.and_then(|candidate| {
        fallback_dirs
            .iter()
            .find_map(|root| resolve_reference_from_dir(root, candidate))
    }) {
        return Some(path);
    }
    if let Some(path) = remote_path.and_then(local_file_url_to_path) {
        return Some(path);
    }
    remote_path.map(ToString::to_string)
}

pub(super) fn resolve_reference_from_dir(root: &Path, raw: &str) -> Option<String> {
    let direct = root.join(raw);
    if direct.exists() {
        return Some(direct.display().to_string());
    }
    let file_name = Path::new(raw).file_name()?;
    let by_name = root.join(file_name);
    if by_name.exists() {
        return Some(by_name.display().to_string());
    }
    None
}

pub(super) fn path_file_name(path: &str) -> Option<&str> {
    Path::new(path).file_name().and_then(|value| value.to_str())
}

fn path_file_name_from_url(path: &str) -> Option<&str> {
    path.split('?')
        .next()
        .and_then(|value| value.rsplit('/').next())
        .filter(|value| !value.trim().is_empty())
}

pub(super) fn local_file_url_to_path(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let rest = trimmed.strip_prefix("file://")?;
    #[cfg(target_os = "windows")]
    let normalized = rest.trim_start_matches('/');
    #[cfg(not(target_os = "windows"))]
    let normalized = rest;
    Some(normalized.to_string())
}
