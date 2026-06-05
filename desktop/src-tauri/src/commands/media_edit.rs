#[path = "media_edit/pipeline.rs"]
mod pipeline;

use crate::commands::library::persist_media_workspace_catalog;
use crate::store::media as media_store;
use crate::{
    ensure_video_thumbnail_for_path, file_content_hash, file_url_for_path, guess_mime_and_kind,
    make_id, media_root, now_rfc3339, workspace_root, AppState, MediaAssetRecord,
};
use pipeline::{normalized_operation_type, run_media_edit_operations};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, State};

fn resolve_media_edit_path(state: &State<'_, AppState>, raw_path: &str) -> Result<PathBuf, String> {
    let normalized = raw_path.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("media.edit requires a non-empty sourcePath".to_string());
    }
    let candidate = PathBuf::from(&normalized);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        workspace_root(state)
            .map_err(|error| error.to_string())?
            .join(normalized)
    };
    if !resolved.is_file() {
        return Err(format!(
            "media.edit source file not found: {}",
            resolved.display()
        ));
    }
    Ok(resolved)
}

fn output_dir_for_request(
    state: &State<'_, AppState>,
    request: &Value,
    job_id: &str,
) -> Result<PathBuf, String> {
    let base = request
        .pointer("/output/directory")
        .or_else(|| request.get("outputDirectory"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                workspace_root(state)
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join(path)
            }
        })
        .unwrap_or_else(|| {
            media_root(state)
                .unwrap_or_else(|_| PathBuf::from("media"))
                .join("edits")
        });
    let dir = base.join(job_id);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn output_kind(request: &Value) -> String {
    request
        .pointer("/output/kind")
        .or_else(|| request.get("outputKind"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("auto")
        .to_ascii_lowercase()
}

fn register_media_edit_assets(
    app: &AppHandle,
    state: &State<'_, AppState>,
    paths: &[PathBuf],
    request: &Value,
    job_id: &str,
) -> Result<Vec<MediaAssetRecord>, String> {
    let intent_summary = request
        .get("intentSummary")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let created_at = now_rfc3339();
    let assets = crate::persistence::with_store_mut(state, |store| {
        let mut assets = Vec::<MediaAssetRecord>::new();
        for (index, path) in paths.iter().enumerate() {
            let (mime_type, kind, _) = guess_mime_and_kind(path);
            let thumbnail_url = if kind == "video" {
                ensure_video_thumbnail_for_path(Some(app), state, path)
            } else {
                None
            };
            let base_id = make_id("media-edit");
            let asset = MediaAssetRecord {
                id: if paths.len() > 1 {
                    format!("{base_id}-{}", index + 1)
                } else {
                    base_id
                },
                source: "media-edit".to_string(),
                source_domain: None,
                source_link: None,
                project_id: Some(job_id.to_string()),
                title: Some(
                    intent_summary
                        .map(|summary| {
                            if paths.len() > 1 {
                                format!("{summary} {}", index + 1)
                            } else {
                                summary.to_string()
                            }
                        })
                        .unwrap_or_else(|| format!("Video edit {}", index + 1)),
                ),
                prompt: request
                    .get("instruction")
                    .or_else(|| request.get("intentSummary"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                provider: Some("ffmpeg".to_string()),
                provider_template: Some("media.edit".to_string()),
                model: None,
                aspect_ratio: None,
                size: None,
                quality: None,
                mime_type: Some(mime_type),
                content_hash: file_content_hash(path).ok(),
                relative_path: None,
                bound_manuscript_path: None,
                created_at: created_at.clone(),
                updated_at: created_at.clone(),
                absolute_path: Some(path.display().to_string()),
                preview_url: Some(file_url_for_path(path)),
                thumbnail_url,
                exists: path.is_file(),
            };
            media_store::push_asset(store, asset.clone());
            assets.push(asset);
        }
        Ok(assets)
    })?;
    persist_media_workspace_catalog(state)?;
    Ok(assets)
}

pub(crate) fn execute_media_edit(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    request: &Value,
) -> Result<Value, String> {
    let source_path = request
        .get("sourcePath")
        .or_else(|| request.get("path"))
        .or_else(|| request.get("toolPath"))
        .and_then(Value::as_str)
        .ok_or_else(|| "media.edit requires sourcePath".to_string())?;
    let source_path = resolve_media_edit_path(state, source_path)?;
    let operations = request
        .get("operations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if operations.is_empty() {
        return Err("media.edit requires at least one operation".to_string());
    }

    let job_id = make_id("media-edit-job");
    let output_dir = output_dir_for_request(state, request, &job_id)?;
    let operation_outputs = run_media_edit_operations(
        app,
        state,
        session_id,
        &source_path,
        &output_dir,
        &operations,
    )?;

    let kind = output_kind(request);
    let output_paths = if kind == "clips"
        || (kind == "auto"
            && operation_outputs.segment_paths.len() > 1
            && !operations
                .iter()
                .any(|operation| normalized_operation_type(operation).unwrap_or("") == "concat"))
    {
        operation_outputs.segment_paths.clone()
    } else {
        operation_outputs
            .current_path
            .clone()
            .map(|path| vec![path])
            .unwrap_or_else(Vec::new)
    };
    if output_paths.is_empty() {
        return Err("media.edit did not produce output".to_string());
    }
    let assets = register_media_edit_assets(app, state, &output_paths, request, &job_id)?;
    Ok(json!({
        "success": true,
        "jobId": job_id,
        "sourcePath": source_path.display().to_string(),
        "outputKind": kind,
        "outputDir": output_dir.display().to_string(),
        "outputs": output_paths.iter().map(|path| path.display().to_string()).collect::<Vec<_>>(),
        "artifacts": operation_outputs.artifacts,
        "assets": assets
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_kind_defaults_to_auto() {
        assert_eq!(output_kind(&json!({})), "auto");
        assert_eq!(
            output_kind(&json!({ "output": { "kind": "clips" } })),
            "clips"
        );
    }
}
