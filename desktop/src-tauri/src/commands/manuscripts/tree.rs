use super::*;

pub(super) fn handle_tree_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "manuscripts:list" => Some((|| -> Result<Value, String> {
            let root = manuscripts_root(state)?;
            serde_json::to_value(list_tree(&root, &root)?).map_err(|error| error.to_string())
        })()),
        "manuscripts:read" => Some((|| -> Result<Value, String> {
            let relative = payload_value_as_string(&payload).unwrap_or_default();
            let direct_path = std::path::PathBuf::from(&relative);
            let path = if direct_path.is_absolute() && direct_path.exists() {
                direct_path
            } else {
                resolve_manuscript_path(state, &relative)?
            };
            if is_manuscript_package_path(&path) {
                let file_name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("");
                let manifest = read_json_value_or(&package_manifest_path(&path), json!({}));
                let content =
                    fs::read_to_string(package_entry_path(&path, file_name, Some(&manifest)))
                        .unwrap_or_default();
                let base_url = file_url_for_path(&path);
                let entry_path = package_entry_path(&path, file_name, Some(&manifest));
                let mut metadata = manifest.as_object().cloned().unwrap_or_default();
                metadata.insert("contentFormat".to_string(), json!("markdown"));
                metadata.insert(
                    "fileBaseUrl".to_string(),
                    json!(if base_url.ends_with('/') {
                        base_url
                    } else {
                        format!("{base_url}/")
                    }),
                );
                metadata.insert("fileUrl".to_string(), json!(file_url_for_path(&entry_path)));
                metadata.insert(
                    "absolutePath".to_string(),
                    json!(entry_path.display().to_string()),
                );
                return Ok(json!({
                    "content": content,
                    "metadata": Value::Object(metadata)
                }));
            }
            let content_format = path
                .file_name()
                .and_then(|value| value.to_str())
                .map(manuscript_content_format_from_name)
                .unwrap_or("markdown");
            let file_name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            let base_url = path.parent().map(file_url_for_path).unwrap_or_default();
            if content_format == "document" {
                return Ok(json!({
                    "content": "",
                    "metadata": {
                        "id": slug_from_relative_path(&relative),
                        "title": title_from_relative_path(file_name),
                        "draftType": "document",
                        "contentFormat": "document",
                        "fileName": file_name,
                        "fileBaseUrl": if base_url.ends_with('/') { base_url } else { format!("{base_url}/") },
                        "fileUrl": file_url_for_path(&path),
                        "absolutePath": path.display().to_string(),
                    }
                }));
            }
            let content = fs::read_to_string(&path).unwrap_or_default();
            let frontmatter = if content_format == "markdown" {
                parse_markdown_frontmatter(&content).unwrap_or_else(|| json!({}))
            } else {
                json!({})
            };
            let title = payload_string(&frontmatter, "title")
                .unwrap_or_else(|| title_from_relative_path(&relative));
            let draft_type = payload_string(&frontmatter, "draftType")
                .or_else(|| payload_string(&frontmatter, "draft_type"))
                .unwrap_or_else(|| {
                    if content_format == "html" {
                        "html".to_string()
                    } else {
                        "unknown".to_string()
                    }
                });
            Ok(json!({
                "content": content,
                "metadata": {
                    "id": slug_from_relative_path(&relative),
                    "title": title,
                    "draftType": draft_type,
                    "contentFormat": content_format,
                    "fileName": file_name,
                    "fileBaseUrl": if base_url.ends_with('/') { base_url } else { format!("{base_url}/") },
                    "fileUrl": file_url_for_path(&path),
                    "absolutePath": path.display().to_string(),
                }
            }))
        })()),
        "manuscripts:save" => Some((|| -> Result<Value, String> {
            let target = payload_string(&payload, "path").unwrap_or_default();
            let content = payload_string(&payload, "content").unwrap_or_default();
            let result = save_manuscript_content(
                state,
                &target,
                &content,
                payload_field(&payload, "metadata").and_then(Value::as_object),
                "user",
            )?;
            let changed_path = payload_string(&result, "newPath").unwrap_or(target);
            crate::events::emit_manuscripts_changed(app, "save", &changed_path);
            Ok(result)
        })()),
        "manuscripts:get-write-proposal" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath")
                .or_else(|| payload_string(&payload, "path"))
                .unwrap_or_default();
            let proposal = get_manuscript_write_proposal(state, &file_path)?;
            Ok(json!({
                "success": true,
                "proposal": proposal,
            }))
        })()),
        "manuscripts:accept-write-proposal" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath")
                .or_else(|| payload_string(&payload, "path"))
                .unwrap_or_default();
            let proposed_content_override = payload_string(&payload, "proposedContentOverride");
            accept_manuscript_write_proposal(app, state, &file_path, proposed_content_override)
        })()),
        "manuscripts:reject-write-proposal" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath")
                .or_else(|| payload_string(&payload, "path"))
                .unwrap_or_default();
            let removed = reject_manuscript_write_proposal(app, state, &file_path)?;
            Ok(json!({
                "success": true,
                "removed": removed,
            }))
        })()),
        "manuscripts:create-folder" => Some((|| -> Result<Value, String> {
            let parent_path = payload_string(&payload, "parentPath").unwrap_or_default();
            let name = payload_string(&payload, "name").unwrap_or_else(|| "New Folder".to_string());
            let relative = join_relative(&parent_path, &name);
            let path = resolve_manuscript_path(state, &relative)?;
            fs::create_dir_all(&path).map_err(|error| error.to_string())?;
            Ok(json!({ "success": true, "path": normalize_relative_path(&relative) }))
        })()),
        "manuscripts:create-file" => Some((|| -> Result<Value, String> {
            let parent_path = payload_string(&payload, "parentPath").unwrap_or_default();
            let name =
                payload_string(&payload, "name").unwrap_or_else(|| "Untitled.md".to_string());
            let content = payload_string(&payload, "content").unwrap_or_default();
            let project_kind = payload_string(&payload, "kind")
                .map(|value| value.trim().to_ascii_lowercase())
                .filter(|value| {
                    matches!(
                        value.as_str(),
                        "post" | "richpost" | "article" | "longform" | "video" | "audio"
                    )
                });
            if let Some(project_kind) = project_kind {
                let relative = normalize_relative_path(&join_relative(&parent_path, &name));
                let path = resolve_manuscript_path(state, &relative)?;
                let title = payload_string(&payload, "title")
                    .unwrap_or_else(|| title_from_relative_path(&relative));
                create_manuscript_package(&path, &content, &project_kind, &title)?;
                crate::events::emit_manuscripts_changed(app, "create", &relative);
                return Ok(json!({ "success": true, "path": relative }));
            }
            let relative = normalize_relative_path(&join_relative(
                &parent_path,
                &ensure_manuscript_extension(&name, Some(".md")),
            ));
            let path = resolve_manuscript_path(state, &relative)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(&path, content).map_err(|error| error.to_string())?;
            crate::events::emit_manuscripts_changed(app, "create", &relative);
            Ok(json!({ "success": true, "path": normalize_relative_path(&relative) }))
        })()),
        "manuscripts:upgrade-to-package" => Some((|| -> Result<Value, String> {
            let source_path = payload_string(&payload, "sourcePath").unwrap_or_default();
            let target_kind =
                payload_string(&payload, "targetKind").unwrap_or_else(|| "article".to_string());
            let new_path =
                upgrade_markdown_manuscript_to_package(state, &source_path, &target_kind)?;
            Ok(json!({ "success": true, "newPath": new_path }))
        })()),
        "manuscripts:delete" => Some((|| -> Result<Value, String> {
            let relative = payload_value_as_string(&payload).unwrap_or_default();
            let path = resolve_manuscript_path(state, &relative)?;
            if path.is_dir() {
                fs::remove_dir_all(&path).map_err(|error| error.to_string())?;
            } else if path.exists() {
                fs::remove_file(&path).map_err(|error| error.to_string())?;
            }
            crate::events::emit_manuscripts_changed(app, "delete", &relative);
            Ok(json!({ "success": true }))
        })()),
        "manuscripts:rename" => Some((|| -> Result<Value, String> {
            let old_path = payload_string(&payload, "oldPath").unwrap_or_default();
            let new_name = payload_string(&payload, "newName").unwrap_or_default();
            if new_name.is_empty() {
                return Ok(json!({ "success": false, "error": "缺少新名称" }));
            }
            let source = resolve_manuscript_path(state, &old_path)?;
            let source_name = source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            if is_manuscript_package_path(&source) {
                let mut manifest = read_json_value_or(&package_manifest_path(&source), json!({}));
                let next_title = new_name.trim();
                if next_title.is_empty() {
                    return Ok(json!({ "success": false, "error": "缺少新名称" }));
                }
                if let Some(object) = manifest.as_object_mut() {
                    object.insert("title".to_string(), json!(next_title));
                    object.insert("updatedAt".to_string(), json!(now_i64()));
                } else {
                    manifest = json!({
                        "title": next_title,
                        "updatedAt": now_i64(),
                    });
                }
                write_json_value(&package_manifest_path(&source), &manifest)?;
                crate::events::emit_manuscripts_changed(app, "rename", &old_path);
                return Ok(
                    json!({ "success": true, "newPath": normalize_relative_path(&old_path) }),
                );
            }
            let parent_rel = normalize_relative_path(
                old_path
                    .rsplit_once('/')
                    .map(|(parent, _)| parent)
                    .unwrap_or(""),
            );
            let mut target_relative = join_relative(&parent_rel, &new_name);
            let fallback_extension = supported_manuscript_extension(source_name).unwrap_or(".md");
            if !target_relative.contains('.') {
                if source.is_file() {
                    target_relative =
                        ensure_manuscript_extension(&target_relative, Some(fallback_extension));
                } else {
                    target_relative = normalize_relative_path(&target_relative);
                }
            } else if source.is_file() && !source_name.contains('.') {
                target_relative = ensure_manuscript_extension(&target_relative, Some(".md"));
            } else {
                target_relative = normalize_relative_path(&target_relative);
            }
            let target = resolve_manuscript_path(state, &target_relative)?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::rename(&source, &target).map_err(|error| error.to_string())?;
            crate::events::emit_manuscripts_changed(app, "rename", &target_relative);
            Ok(json!({ "success": true, "newPath": target_relative }))
        })()),
        "manuscripts:move" => Some((|| -> Result<Value, String> {
            let source_path = payload_string(&payload, "sourcePath").unwrap_or_default();
            let target_dir = payload_string(&payload, "targetDir").unwrap_or_default();
            let source_relative = normalize_relative_path(&source_path);
            let target_dir_relative = normalize_relative_path(&target_dir);
            if source_relative.is_empty() {
                return Ok(json!({ "success": false, "error": "缺少移动源路径" }));
            }
            if source_relative == target_dir_relative
                || (!target_dir_relative.is_empty()
                    && target_dir_relative.starts_with(&format!("{source_relative}/")))
            {
                return Ok(json!({ "success": false, "error": "不能移动到自身或子文件夹内" }));
            }
            let source = resolve_manuscript_path(state, &source_path)?;
            if !source.exists() {
                return Ok(json!({ "success": false, "error": "移动源不存在" }));
            }
            let file_name = source
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "Invalid manuscript source".to_string())?;
            let target_relative =
                normalize_relative_path(&join_relative(&target_dir_relative, file_name));
            let source_parent = source_relative
                .rsplit_once('/')
                .map(|(parent, _)| normalize_relative_path(parent))
                .unwrap_or_default();
            if source_parent == target_dir_relative {
                return Ok(json!({ "success": true, "newPath": source_relative }));
            }
            let target = resolve_manuscript_path(state, &target_relative)?;
            if target.exists() {
                return Ok(json!({ "success": false, "error": "目标位置已存在同名文件或文件夹" }));
            }
            if let Some(parent) = target.parent() {
                if parent.exists() && !parent.is_dir() {
                    return Ok(json!({ "success": false, "error": "目标父路径不是文件夹" }));
                }
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::rename(&source, &target).map_err(|error| error.to_string())?;
            crate::events::emit_manuscripts_changed(app, "move", &target_relative);
            Ok(json!({ "success": true, "newPath": target_relative }))
        })()),
        _ => None,
    }
}
