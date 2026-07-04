use super::*;
use std::path::{Path, PathBuf};

const IMPORTABLE_DOCUMENT_EXTENSIONS: &[&str] = &[
    "doc", "docx", "docm", "odt", "ppt", "pptx", "pptm", "odp", "xls", "xlsx", "xlsm", "xlsb",
    "ods",
];

pub(super) fn handle_document_import_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "manuscripts:import-document" => Some(import_document_value(app, state, payload)),
        _ => None,
    }
}

fn import_document_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let parent_path = payload_string(payload, "parentPath").unwrap_or_default();
    let picked_sources = document_sources_from_payload(state, payload)?;
    if picked_sources.is_empty() {
        return Ok(json!({ "success": true, "canceled": true, "items": [] }));
    }

    let mut items = Vec::<Value>::new();
    for source in picked_sources {
        let imported = import_one_document(state, &source, &parent_path)?;
        crate::events::emit_manuscripts_changed(app, "create", &imported.relative_path);
        items.push(json!({
            "path": imported.relative_path,
            "title": imported.title,
            "sourcePath": source.display().to_string(),
        }));
    }

    let first_path = items
        .first()
        .and_then(|item| item.get("path"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok(json!({
        "success": true,
        "canceled": false,
        "path": first_path,
        "items": items,
    }))
}

struct ImportedDocument {
    relative_path: String,
    title: String,
}

fn document_sources_from_payload(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Vec<PathBuf>, String> {
    let mut sources = Vec::<PathBuf>::new();
    if let Some(items) = payload.get("sources").and_then(Value::as_array) {
        for item in items {
            if let Some(source) = item
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                sources.push(resolve_import_source(state, source)?);
            }
        }
    }
    if let Some(source) = payload_string(payload, "source")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        sources.push(resolve_import_source(state, &source)?);
    }
    if sources.is_empty() {
        sources = pick_files_native("选择要导入的 Word、Excel 或 PPT 文件", false, true)?;
    }
    Ok(sources)
}

fn resolve_import_source(state: &State<'_, AppState>, source: &str) -> Result<PathBuf, String> {
    crate::commands::file_ops::resolve_file_action_path(state, source)
        .or_else(|_| resolve_local_path(source).ok_or_else(|| "无效文档路径".to_string()))
}

fn import_one_document(
    state: &State<'_, AppState>,
    source: &Path,
    parent_path: &str,
) -> Result<ImportedDocument, String> {
    if !source.exists() || !source.is_file() {
        return Err(format!("文档不存在: {}", source.display()));
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if !IMPORTABLE_DOCUMENT_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!("暂不支持导入该文档格式: {extension}"));
    }

    let title = source
        .file_stem()
        .and_then(|value| value.to_str())
        .map(ToString::to_string)
        .unwrap_or_else(|| "Imported Document".to_string());
    let relative_path = unique_import_relative_path(state, parent_path, source, &extension)?;
    let target = resolve_manuscript_path(state, &relative_path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    fs::copy(source, &target).map_err(|error| error.to_string())?;
    Ok(ImportedDocument {
        relative_path,
        title,
    })
}

fn unique_import_relative_path(
    state: &State<'_, AppState>,
    parent_path: &str,
    source: &Path,
    extension: &str,
) -> Result<String, String> {
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .map(storage_safe_file_stem)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Imported Document".to_string());
    for index in 0..10_000 {
        let name = if index == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}-{index}.{extension}")
        };
        let relative = normalize_relative_path(&join_relative(parent_path, &name));
        let path = resolve_manuscript_path(state, &relative)?;
        if !path.exists() {
            return Ok(relative);
        }
    }
    Ok(normalize_relative_path(&join_relative(
        parent_path,
        &format!("{stem}-{}.{extension}", now_ms()),
    )))
}
