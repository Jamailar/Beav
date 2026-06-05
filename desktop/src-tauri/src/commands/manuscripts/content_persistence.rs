use super::*;

pub(super) fn package_block_is_page_break(kind: &str) -> bool {
    kind == "page-break"
}

pub(super) fn persist_richpost_page_plan(
    package_path: &std::path::Path,
    title: &str,
    blocks: &[PackageContentBlock],
    cover_asset: Option<&PackageBoundAsset>,
    image_assets: &[PackageBoundAsset],
    raw_plan: &Value,
    source: &str,
) -> Result<Value, String> {
    let manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    let typography = richpost_typography_settings_from_manifest(&manifest);
    let theme = richpost_theme_spec_from_manifest(Some(package_path), &manifest);
    let normalized = normalize_richpost_page_plan(
        raw_plan,
        title,
        blocks,
        cover_asset,
        image_assets,
        source,
        typography,
        &theme,
    );
    write_json_value(&package_richpost_page_plan_path(package_path), &normalized)?;
    persist_richpost_pages_from_plan(
        package_path,
        title,
        blocks,
        cover_asset,
        image_assets,
        &normalized,
    )?;
    let mut manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    if let Some(object) = manifest.as_object_mut() {
        object.insert("updatedAt".to_string(), json!(now_i64()));
    }
    write_json_value(&package_manifest_path(package_path), &manifest)?;
    get_manuscript_package_state(package_path)
}

pub(crate) fn sync_manuscript_package_html_assets(
    state: Option<&State<'_, AppState>>,
    package_path: &std::path::Path,
    file_name: &str,
    content_override: Option<&str>,
    target_override: Option<&str>,
) -> Result<Value, String> {
    let package_kind = get_package_kind_from_manifest(package_path)
        .ok_or_else(|| "未识别的工程类型".to_string())?;
    if package_kind != "post" {
        return get_manuscript_package_state(package_path);
    }
    let manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    let entry = manifest
        .get("entry")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_package_entry_for_kind(Some(&package_kind)));
    let title = manifest
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| title_from_relative_path(file_name));
    let typography = richpost_typography_settings_from_manifest(&manifest);
    let theme = richpost_theme_spec_from_manifest(Some(package_path), &manifest);
    let _ = ensure_richpost_layout_scaffold(package_path, &manifest)?;
    let content = content_override
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            fs::read_to_string(package_entry_path(package_path, file_name, Some(&manifest)))
                .unwrap_or_default()
        });
    let content_map_path = package_content_map_path(package_path);
    let blocks = build_package_content_blocks(&content_map_path, &content);
    write_json_value(
        &content_map_path,
        &package_content_map_value(&package_kind, &title, entry, &blocks),
    )?;
    let (cover_asset, image_assets) = collect_package_bound_assets(state, package_path)?;
    let has_manual_page_breaks = blocks
        .iter()
        .any(|block| package_block_is_page_break(&block.kind));
    let raw_plan = default_richpost_page_plan(
        &title,
        &blocks,
        cover_asset.as_ref(),
        &image_assets,
        if has_manual_page_breaks {
            "markdown-page-break"
        } else {
            "markdown-auto-reflow"
        },
        typography,
        &theme,
    );
    let _ = target_override;
    persist_richpost_page_plan(
        package_path,
        &title,
        &blocks,
        cover_asset.as_ref(),
        &image_assets,
        &raw_plan,
        raw_plan
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("system-sync"),
    )
}

pub(super) fn persist_package_script_body(
    state: &State<'_, AppState>,
    package_path: &std::path::Path,
    file_name: &str,
    content: &str,
    metadata: Option<&serde_json::Map<String, Value>>,
    source: &str,
) -> Result<(Value, Value), String> {
    let mut manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    let package_kind = payload_string(&manifest, "packageKind")
        .or_else(|| payload_string(&manifest, "kind"))
        .or_else(|| get_package_kind_from_manifest(package_path))
        .unwrap_or_else(|| "article".to_string());
    let draft_type =
        payload_string(&manifest, "draftType").unwrap_or_else(|| match package_kind.as_str() {
            "post" => "richpost".to_string(),
            "video" => "video".to_string(),
            "audio" => "audio".to_string(),
            _ => "longform".to_string(),
        });
    if let Some(object) = manifest.as_object_mut() {
        if let Some(metadata_object) = metadata {
            for (key, value) in metadata_object {
                object.insert(key.clone(), value.clone());
            }
        }
        object.insert("updatedAt".to_string(), json!(now_i64()));
        object
            .entry("title".to_string())
            .or_insert(json!(title_from_relative_path(file_name)));
        object
            .entry("entry".to_string())
            .or_insert(json!(
                if matches!(package_kind.as_str(), "video" | "audio") {
                    "script.md"
                } else {
                    "content.md"
                }
            ));
        object
            .entry("draftType".to_string())
            .or_insert(json!(draft_type));
        object
            .entry("packageKind".to_string())
            .or_insert(json!(package_kind.clone()));
        if package_kind == "post" {
            let default_theme = default_richpost_theme_spec();
            object
                .entry("richpostThemeId".to_string())
                .or_insert(json!(default_theme.id.clone()));
            object
                .entry("richpostThemeSnapshot".to_string())
                .or_insert_with(|| richpost_theme_spec_storage_value(&default_theme));
        }
    }
    write_json_value(&package_manifest_path(package_path), &manifest)?;
    write_text_file(
        &package_entry_path(package_path, file_name, Some(&manifest)),
        content,
    )?;

    if package_kind == "video" {
        mark_manifest_video_script_pending(&mut manifest, source)?;
        write_json_value(&package_manifest_path(package_path), &manifest)?;
        return Ok((
            get_manuscript_package_state(package_path)?,
            package_video_script_state_value(package_path, file_name, &manifest),
        ));
    }

    if package_kind == "audio" {
        let mut project = ensure_editor_project(package_path)?;
        mark_editor_project_script_pending(&mut project, content, source)?;
        write_json_value(&package_editor_project_path(package_path), &project)?;
        return Ok((
            get_manuscript_package_state(package_path)?,
            package_script_state_value(&project),
        ));
    }

    Ok((
        sync_manuscript_package_html_assets(
            Some(state),
            package_path,
            file_name,
            Some(content),
            None,
        )?,
        json!({
            "body": content,
            "approval": {
                "status": "pending",
                "lastScriptUpdateAt": Value::Null,
                "lastScriptUpdateSource": source,
                "confirmedAt": Value::Null
            }
        }),
    ))
}

pub(crate) fn save_manuscript_content(
    state: &State<'_, AppState>,
    target: &str,
    content: &str,
    metadata: Option<&serde_json::Map<String, Value>>,
    source: &str,
) -> Result<Value, String> {
    let current_relative = normalize_relative_path(target);
    let mut path = resolve_manuscript_path(state, target)?;
    let mut active_relative = current_relative.clone();
    let mut active_title = metadata
        .and_then(|items| items.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    let current_file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_string();
    let current_stem = title_from_relative_path(&current_relative);
    let should_auto_name = !is_manuscript_package_path(&path)
        && (active_title
            .as_deref()
            .map(is_untitled_manuscript_label)
            .unwrap_or(false)
            || is_auto_generated_manuscript_stem(&current_stem));
    if should_auto_name {
        if let Some(next_title) = first_markdown_heading_text(content) {
            let next_relative = choose_auto_named_manuscript_relative(
                state,
                &current_relative,
                &current_file_name,
                &next_title,
            )?;
            if next_relative != current_relative {
                let next_path = resolve_manuscript_path(state, &next_relative)?;
                if let Some(parent) = next_path.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                if path.exists() {
                    fs::rename(&path, &next_path).map_err(|error| error.to_string())?;
                }
                path = next_path;
                active_relative = next_relative;
            }
            active_title = Some(next_title);
        }
    }

    let merged_metadata = {
        let mut items = metadata.cloned().unwrap_or_default();
        if let Some(title) = active_title.as_ref() {
            items.insert("title".to_string(), json!(title));
        }
        items
    };
    if !path.exists()
        && merged_metadata
            .get("packageKind")
            .or_else(|| merged_metadata.get("kind"))
            .is_some()
    {
        let package_title = active_title
            .clone()
            .unwrap_or_else(|| title_from_relative_path(&active_relative));
        let kind = payload_string(&Value::Object(merged_metadata.clone()), "packageKind")
            .or_else(|| payload_string(&Value::Object(merged_metadata.clone()), "kind"))
            .unwrap_or_else(|| "post".to_string());
        create_manuscript_package(&path, content, &kind, &package_title)?;
    }
    if is_manuscript_package_path(&path) {
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let (next_state, script_state) = persist_package_script_body(
            state,
            &path,
            file_name,
            content,
            Some(&merged_metadata),
            source,
        )?;
        return Ok(json!({
            "success": true,
            "newPath": active_relative,
            "title": active_title,
            "state": next_state,
            "script": script_state,
            "content": content,
        }));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, content).map_err(|error| error.to_string())?;
    Ok(json!({
        "success": true,
        "newPath": active_relative,
        "title": active_title,
        "content": content,
    }))
}

pub(super) fn generate_richpost_page_plan(
    state: &State<'_, AppState>,
    package_path: &std::path::Path,
    file_name: &str,
    title: &str,
    body: &str,
    model_config: Option<&Value>,
) -> Result<Value, String> {
    let _ = (state, package_path, file_name, title, body, model_config);
    Err("图文分页方案功能已下线".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_block_page_break_kind_is_explicit() {
        assert!(package_block_is_page_break("page-break"));
        assert!(!package_block_is_page_break("heading"));
    }
}
