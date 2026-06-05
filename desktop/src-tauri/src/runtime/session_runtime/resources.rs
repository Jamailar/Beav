use super::*;

pub fn session_resources_value_for_session(
    store: &AppStore,
    session_id: &str,
    include_child_sessions: bool,
    limit: Option<usize>,
    kind_filter: Option<&str>,
    query: Option<&str>,
) -> Value {
    let session_ids = session_ids_for_query(store, session_id, include_child_sessions);
    let fallback_dirs = Vec::<PathBuf>::new();
    let mut resources = Vec::<Value>::new();

    for message in store.chat_messages.iter().filter(|item| {
        session_ids
            .iter()
            .any(|candidate| candidate == &item.session_id)
    }) {
        if let Some(attachment) = message.attachment.as_ref() {
            collect_session_resources_from_value(
                attachment,
                "user_attachment",
                Some(&message.id),
                Some(&message.created_at),
                &fallback_dirs,
                &mut resources,
                0,
            );
        }
        if let Some(metadata) = message.metadata.as_ref() {
            collect_session_resources_from_value(
                metadata,
                "message_metadata",
                Some(&message.id),
                Some(&message.created_at),
                &fallback_dirs,
                &mut resources,
                0,
            );
        }
    }

    for result in store.session_tool_results.iter().filter(|item| {
        session_ids
            .iter()
            .any(|candidate| candidate == &item.session_id)
    }) {
        if let Some(payload) = result.payload.as_ref() {
            let updated_at = result.updated_at.to_string();
            collect_session_resources_from_value(
                payload,
                "tool_result",
                Some(&result.call_id),
                Some(updated_at.as_str()),
                &fallback_dirs,
                &mut resources,
                0,
            );
        }
    }

    dedupe_session_resources(&mut resources);
    resources.sort_by(|left, right| {
        resource_string(right, "createdAt").cmp(&resource_string(left, "createdAt"))
    });
    if let Some(kind) = kind_filter.map(str::trim).filter(|value| !value.is_empty()) {
        resources.retain(|item| {
            resource_string(item, "kind").eq_ignore_ascii_case(kind)
                || resource_string(item, "mimeType").starts_with(kind)
        });
    }
    if let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) {
        let query = query.to_ascii_lowercase();
        resources.retain(|item| item.to_string().to_ascii_lowercase().contains(&query));
    }
    let total = resources.len();
    if let Some(limit) = limit.filter(|value| *value > 0) {
        resources.truncate(limit);
    }
    json!({
        "success": true,
        "sessionId": session_id,
        "total": total,
        "items": resources,
    })
}

pub fn session_resources_prompt_for_session(
    store: &AppStore,
    session_id: &str,
    limit: usize,
) -> Option<String> {
    let value =
        session_resources_value_for_session(store, session_id, true, Some(limit), None, None);
    let items = value.get("items").and_then(Value::as_array)?;
    if items.is_empty() {
        return None;
    }
    let mut lines = vec![
        "Current session resources: use these exact references when a tool needs an attached or previously generated file. Do not invent local paths; if unsure, call session.resources.list/get.".to_string(),
    ];
    for item in items.iter().take(limit) {
        let id = resource_string(item, "id");
        let kind = resource_string(item, "kind");
        let source = resource_string(item, "source");
        let reference = resource_string(item, "reference");
        let name = resource_string(item, "name");
        let usage = item
            .get("recommendedUsage")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        if reference.is_empty() {
            continue;
        }
        lines.push(format!(
            "- id={id}; kind={kind}; source={source}; name={name}; reference={reference}; recommendedUsage={usage}"
        ));
    }
    if lines.len() <= 1 {
        None
    } else {
        Some(lines.join("\n"))
    }
}

fn collect_session_resources_from_value(
    value: &Value,
    source: &str,
    source_id: Option<&str>,
    created_at: Option<&str>,
    fallback_dirs: &[PathBuf],
    resources: &mut Vec<Value>,
    depth: usize,
) {
    if depth > SESSION_RESOURCE_MAX_DEPTH {
        return;
    }
    match value {
        Value::Object(object) => {
            if let Some(resource) =
                session_resource_from_object(object, source, source_id, created_at, fallback_dirs)
            {
                resources.push(resource);
            }
            for nested in object.values() {
                collect_session_resources_from_value(
                    nested,
                    source,
                    source_id,
                    created_at,
                    fallback_dirs,
                    resources,
                    depth + 1,
                );
            }
        }
        Value::Array(items) => {
            for nested in items {
                collect_session_resources_from_value(
                    nested,
                    source,
                    source_id,
                    created_at,
                    fallback_dirs,
                    resources,
                    depth + 1,
                );
            }
        }
        _ => {}
    }
}

fn session_resource_from_object(
    object: &serde_json::Map<String, Value>,
    source: &str,
    source_id: Option<&str>,
    created_at: Option<&str>,
    fallback_dirs: &[PathBuf],
) -> Option<Value> {
    let get = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let reference = get("absolutePath")
        .or_else(|| get("originalAbsolutePath"))
        .or_else(|| get("path"))
        .or_else(|| get("workspaceRelativePath"))
        .or_else(|| get("toolPath"))
        .or_else(|| get("relativePath"))
        .or_else(|| get("previewUrl"))
        .or_else(|| get("localUrl"))
        .or_else(|| get("inlineDataUrl"))?;
    let mut canonical_reference = reference.to_string();
    if let Some(path) = local_file_url_to_path(reference) {
        canonical_reference = path;
    } else if !Path::new(reference).is_absolute()
        && !reference.starts_with("http://")
        && !reference.starts_with("https://")
        && !reference.starts_with("data:")
    {
        if let Some(resolved) = fallback_dirs
            .iter()
            .find_map(|root| resolve_reference_from_dir(root, reference))
        {
            canonical_reference = resolved;
        }
    }
    let mime_type = get("mimeType")
        .or_else(|| get("mime"))
        .or_else(|| get("contentType"))
        .unwrap_or("");
    let kind = get("kind")
        .or_else(|| media_kind_from_mime(mime_type))
        .or_else(|| media_kind_from_path(&canonical_reference))
        .unwrap_or("file");
    if !matches!(
        kind,
        "image" | "video" | "audio" | "file" | "media" | "audio_segment"
    ) {
        return None;
    }
    let name = get("name")
        .or_else(|| get("title"))
        .or_else(|| get("label"))
        .or_else(|| path_file_name(&canonical_reference))
        .unwrap_or("resource");
    let id = get("id")
        .or_else(|| get("assetId"))
        .or_else(|| get("artifactId"))
        .or_else(|| get("jobId"))
        .or(source_id)
        .unwrap_or(name);
    let recommended_usage = recommended_usage_for_kind(kind);
    Some(json!({
        "id": id,
        "kind": if kind == "audio_segment" { "audio" } else { kind },
        "source": source,
        "sourceId": source_id,
        "name": name,
        "reference": canonical_reference,
        "path": canonical_reference,
        "mimeType": mime_type,
        "createdAt": created_at,
        "recommendedUsage": recommended_usage,
    }))
}

fn dedupe_session_resources(resources: &mut Vec<Value>) {
    let mut seen = std::collections::HashSet::<String>::new();
    resources.retain(|item| {
        let key = resource_string(item, "reference");
        if key.is_empty() {
            return false;
        }
        seen.insert(key)
    });
}

fn recommended_usage_for_kind(kind: &str) -> Vec<&'static str> {
    match kind {
        "image" => vec!["referenceImages"],
        "video" => vec!["sourcePath", "firstClip"],
        "audio" | "audio_segment" => vec!["drivingAudio", "sourcePath"],
        _ => vec!["tool input path"],
    }
}

fn media_kind_from_mime(mime: &str) -> Option<&'static str> {
    if mime.starts_with("image/") {
        Some("image")
    } else if mime.starts_with("video/") {
        Some("video")
    } else if mime.starts_with("audio/") {
        Some("audio")
    } else {
        None
    }
}

fn media_kind_from_path(path: &str) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase();
    if [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"]
        .iter()
        .any(|ext| lower.contains(ext))
    {
        Some("image")
    } else if [".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv"]
        .iter()
        .any(|ext| lower.contains(ext))
    {
        Some("video")
    } else if [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]
        .iter()
        .any(|ext| lower.contains(ext))
    {
        Some("audio")
    } else {
        None
    }
}

fn resource_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}
