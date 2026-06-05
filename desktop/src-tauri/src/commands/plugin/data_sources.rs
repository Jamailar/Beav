use super::*;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThrivePluginReadDataRequest {
    pub(super) plugin_id: String,
    pub(super) source: String,
    #[serde(default)]
    pub(super) limit: Option<usize>,
    #[serde(default)]
    pub(super) kind: Option<String>,
    #[serde(default)]
    pub(super) query: Option<String>,
}

fn enabled_thrive_plugin_manifest_by_id(
    state: &State<'_, AppState>,
    plugin_id: &str,
) -> Result<(ThrivePluginIndexEntry, RawThrivePluginManifest), String> {
    validate_plugin_id(plugin_id)?;
    let index = load_thrive_plugin_index(state)?;
    let entry = index
        .plugins
        .get(plugin_id)
        .cloned()
        .ok_or_else(|| format!("plugin `{plugin_id}` is not installed"))?;
    if !entry.enabled {
        return Err(format!("plugin `{plugin_id}` is disabled"));
    }
    let manifest = load_thrive_plugin_manifest(&PathBuf::from(&entry.root))?;
    Ok((entry, manifest))
}

fn plugin_has_capability(manifest: &RawThrivePluginManifest, capability: &str) -> bool {
    manifest
        .permissions
        .capabilities
        .iter()
        .any(|item| item == capability)
}

fn require_plugin_capability(
    manifest: &RawThrivePluginManifest,
    capability: &str,
) -> Result<(), String> {
    if plugin_has_capability(manifest, capability) {
        Ok(())
    } else {
        Err(format!(
            "plugin `{}` requires `{capability}` capability",
            manifest.name
        ))
    }
}

fn require_plugin_data_source_capability(
    manifest: &RawThrivePluginManifest,
    source: &str,
) -> Result<(), String> {
    match source {
        source if source.starts_with("knowledge.") => {
            require_plugin_capability(manifest, "knowledge.read")
        }
        source if source.starts_with("manuscripts.") => {
            require_plugin_capability(manifest, "manuscripts.read")
        }
        source if source.starts_with("media.") => require_plugin_capability(manifest, "media.read"),
        source if source.starts_with("subjects.") => {
            if plugin_has_capability(manifest, "subjects.read")
                || plugin_has_capability(manifest, "assets.read")
            {
                Ok(())
            } else {
                Err(format!(
                    "plugin `{}` requires `subjects.read` or `assets.read` capability",
                    manifest.name
                ))
            }
        }
        _ => Err(format!("unknown plugin data source `{source}`")),
    }
}

fn manuscripts_root_for_plugins(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("manuscripts");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn manuscript_tree_value(state: &State<'_, AppState>) -> Result<Value, String> {
    let root = manuscripts_root_for_plugins(state)?;
    serde_json::to_value(list_tree(&root, &root)?).map_err(|error| error.to_string())
}

fn count_manuscript_file_values(value: &Value) -> usize {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let is_directory = item
                        .get("isDirectory")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if is_directory {
                        count_manuscript_file_values(item.get("children").unwrap_or(&Value::Null))
                    } else {
                        1
                    }
                })
                .sum()
        })
        .unwrap_or_default()
}

fn collect_manuscript_file_values(value: &Value, out: &mut Vec<Value>) {
    let Some(items) = value.as_array() else {
        return;
    };
    for item in items {
        let is_directory = item
            .get("isDirectory")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if is_directory {
            collect_manuscript_file_values(item.get("children").unwrap_or(&Value::Null), out);
        } else {
            out.push(item.clone());
        }
    }
}

fn sort_json_items_by_updated_at(items: &mut [Value]) {
    items.sort_by(|left, right| {
        let left_at = left
            .get("updatedAt")
            .or_else(|| left.get("createdAt"))
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
            })
            .unwrap_or_default();
        let right_at = right
            .get("updatedAt")
            .or_else(|| right.get("createdAt"))
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
            })
            .unwrap_or_default();
        right_at.cmp(&left_at)
    });
}

fn plugin_data_source_value(
    state: &State<'_, AppState>,
    manifest: &RawThrivePluginManifest,
    source: &str,
    limit: usize,
    kind: Option<&str>,
    query: Option<&str>,
) -> Result<Value, String> {
    if !is_known_plugin_home_source(source) {
        return Err(format!("unknown plugin data source `{source}`"));
    }
    require_plugin_data_source_capability(manifest, source)?;

    match source {
        "knowledge.count" => {
            let page = crate::knowledge_index::catalog::list_page(
                state, None, 1, kind, query, None, false,
            )?;
            Ok(
                json!({ "success": true, "source": source, "total": page.total, "kindCounts": page.kind_counts }),
            )
        }
        "knowledge.recent" | "knowledge.items" => {
            let page = crate::knowledge_index::catalog::list_page(
                state,
                None,
                limit,
                kind,
                query,
                Some("updated"),
                false,
            )?;
            serde_json::to_value(page).map_err(|error| error.to_string())
        }
        "manuscripts.tree" => Ok(json!({
            "success": true,
            "source": source,
            "items": manuscript_tree_value(state)?,
        })),
        "manuscripts.count" => {
            let tree = manuscript_tree_value(state)?;
            Ok(json!({
                "success": true,
                "source": source,
                "total": count_manuscript_file_values(&tree),
            }))
        }
        "manuscripts.recent" => {
            let tree = manuscript_tree_value(state)?;
            let mut items = Vec::new();
            collect_manuscript_file_values(&tree, &mut items);
            sort_json_items_by_updated_at(&mut items);
            items.truncate(limit);
            Ok(json!({ "success": true, "source": source, "items": items }))
        }
        "media.count" => with_store(state, |store| {
            Ok(json!({
                "success": true,
                "source": source,
                "total": media_store::count_assets(&store),
            }))
        }),
        "media.recent" | "media.assets" => with_store(state, |store| {
            let assets = media_store::list_recent_assets(&store, limit);
            Ok(json!({ "success": true, "source": source, "assets": assets }))
        }),
        "subjects.count" => with_store(state, |store| {
            Ok(json!({
                "success": true,
                "source": source,
                "total": subjects_store::count_subjects(&store),
            }))
        }),
        "subjects.recent" | "subjects.list" => with_store(state, |store| {
            let subjects = subjects_store::list_recent_subjects(&store, limit);
            Ok(json!({ "success": true, "source": source, "subjects": subjects }))
        }),
        _ => Err(format!("unsupported plugin data source `{source}`")),
    }
}

pub(super) fn read_thrive_plugin_data(
    state: &State<'_, AppState>,
    request: ThrivePluginReadDataRequest,
) -> Result<Value, String> {
    let (_entry, manifest) = enabled_thrive_plugin_manifest_by_id(state, &request.plugin_id)?;
    let source = request.source.trim();
    let limit = normalize_plugin_home_limit(request.limit);
    let data = plugin_data_source_value(
        state,
        &manifest,
        source,
        limit,
        request.kind.as_deref(),
        request.query.as_deref(),
    )?;
    Ok(json!({
        "success": true,
        "pluginId": request.plugin_id,
        "source": source,
        "data": data,
    }))
}

fn plugin_home_widget_value(
    state: &State<'_, AppState>,
    plugin_id: &str,
    manifest: &RawThrivePluginManifest,
    widget: &RawThrivePluginHomeWidget,
    zone: &str,
) -> Value {
    let source = widget
        .source
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let data = source.map(|source| {
        plugin_data_source_value(
            state,
            manifest,
            source,
            normalize_plugin_home_limit(widget.limit),
            None,
            None,
        )
        .unwrap_or_else(|error| json!({ "success": false, "error": error }))
    });
    json!({
        "id": format!("{plugin_id}:{}", widget.id),
        "pluginId": plugin_id,
        "pluginName": manifest.name,
        "zone": zone,
        "title": widget.title,
        "subtitle": widget.subtitle,
        "kind": widget.kind,
        "source": source,
        "label": widget.label,
        "prompt": widget.prompt,
        "icon": widget.icon,
        "tone": widget.tone,
        "order": widget.order.unwrap_or(0),
        "limit": normalize_plugin_home_limit(widget.limit),
        "data": data,
    })
}

fn plugin_home_action_value(
    plugin_id: &str,
    manifest: &RawThrivePluginManifest,
    action: &RawThrivePluginHomeAction,
) -> Value {
    json!({
        "id": format!("{plugin_id}:{}", action.id),
        "pluginId": plugin_id,
        "pluginName": manifest.name,
        "label": action.label,
        "prompt": action.prompt,
        "target": action.target,
        "mode": action.mode,
        "icon": action.icon,
        "tone": action.tone,
        "order": action.order.unwrap_or(0),
    })
}

pub(super) fn list_thrive_plugin_home(state: &State<'_, AppState>) -> Result<Value, String> {
    let enabled_plugins = enabled_thrive_plugin_entries(state)?;
    let mut widgets = Vec::new();
    let mut sidebar_sections = Vec::new();
    let mut quick_actions = Vec::new();
    for (plugin_id, _entry, manifest) in enabled_plugins {
        if !plugin_has_capability(&manifest, "ui.home") {
            continue;
        }
        widgets.extend(
            manifest.home.widgets.iter().map(|widget| {
                plugin_home_widget_value(state, &plugin_id, &manifest, widget, "main")
            }),
        );
        sidebar_sections.extend(manifest.home.sidebar_sections.iter().map(|widget| {
            plugin_home_widget_value(state, &plugin_id, &manifest, widget, "sidebar")
        }));
        quick_actions.extend(
            manifest
                .home
                .quick_actions
                .iter()
                .map(|action| plugin_home_action_value(&plugin_id, &manifest, action)),
        );
    }
    widgets.sort_by_key(|item| {
        item.get("order")
            .and_then(Value::as_i64)
            .unwrap_or_default()
    });
    sidebar_sections.sort_by_key(|item| {
        item.get("order")
            .and_then(Value::as_i64)
            .unwrap_or_default()
    });
    quick_actions.sort_by_key(|item| {
        item.get("order")
            .and_then(Value::as_i64)
            .unwrap_or_default()
    });
    Ok(json!({
        "success": true,
        "widgets": widgets,
        "sidebarSections": sidebar_sections,
        "quickActions": quick_actions,
    }))
}
