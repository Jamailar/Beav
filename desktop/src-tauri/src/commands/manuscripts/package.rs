use super::package_subtitles::transcribe_package_subtitles_value;
use super::package_video::{get_video_project_state_value, save_video_project_brief_value};
use super::*;
use crate::store::media as media_store;

pub(super) fn handle_package_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "manuscripts:get-package-state" => Some((|| -> Result<Value, String> {
            let file_path = payload_value_as_string(&payload).unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !is_manuscript_package_path(&full_path) {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        "manuscripts:get-video-project-state" => {
            Some(get_video_project_state_value(state, payload))
        }
        "manuscripts:save-video-project-brief" => {
            Some(save_video_project_brief_value(state, payload))
        }
        "manuscripts:get-package-script-state" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let file_name = full_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Untitled");
            if get_package_kind_from_manifest(&full_path).as_deref() == Some("video") {
                let manifest = read_json_value_or(&package_manifest_path(&full_path), json!({}));
                return Ok(json!({
                    "success": true,
                    "script": package_video_script_state_value(&full_path, file_name, &manifest)
                }));
            }
            let project = ensure_editor_project(&full_path)?;
            Ok(json!({
                "success": true,
                "script": package_script_state_value(&project)
            }))
        })()),
        "manuscripts:update-package-script" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let content = payload_string(&payload, "content").unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let file_name = full_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Untitled");
            let source = payload_string(&payload, "source")
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "ai".to_string());
            let (next_state, script_state) =
                persist_package_script_body(state, &full_path, file_name, &content, None, &source)?;
            let _ = request_runtime_approval(
                state,
                RuntimeApprovalRecord::pending(
                    format!("manuscript-script:{file_path}"),
                    "manuscript_script",
                    file_path.clone(),
                    "manuscripts.package_script",
                    RuntimeApprovalDetails {
                        r#type: "edit".to_string(),
                        title: "稿件脚本待确认".to_string(),
                        description: format!(
                            "稿件包 {} 的脚本已更新，需确认后再视为可执行脚本。",
                            file_path
                        ),
                        impact: Some("会影响后续剪辑、渲染或执行步骤。".to_string()),
                    },
                )
                .with_metadata(Some(json!({
                    "filePath": file_path,
                    "source": source,
                }))),
            )?;
            Ok(json!({
                "success": true,
                "state": next_state,
                "script": script_state
            }))
        })()),
        "manuscripts:confirm-package-script" => Some((|| -> Result<Value, String> {
            let file_path =
                serde_json::from_value::<ManuscriptScriptConfirmPayload>(payload.clone())
                    .map(|value| value.file_path)
                    .unwrap_or_else(|_| payload_string(&payload, "filePath").unwrap_or_default());
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let file_name = full_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Untitled");
            if get_package_kind_from_manifest(&full_path).as_deref() == Some("video") {
                let mut manifest =
                    read_json_value_or(&package_manifest_path(&full_path), json!({}));
                let approval = confirm_manifest_video_script(&mut manifest)?;
                write_json_value(&package_manifest_path(&full_path), &manifest)?;
                let _ = resolve_runtime_approval_by_source_key(state, &file_path, true)?;
                return Ok(json!({
                    "success": true,
                    "script": package_video_script_state_value(&full_path, file_name, &manifest),
                    "approval": approval,
                    "state": get_manuscript_package_state(&full_path)?
                }));
            }
            let mut project = ensure_editor_project(&full_path)?;
            let approval = confirm_editor_project_script(&mut project)?;
            write_json_value(&package_editor_project_path(&full_path), &project)?;
            let _ = resolve_runtime_approval_by_source_key(state, &file_path, true)?;
            Ok(json!({
                "success": true,
                "script": package_script_state_value(&project),
                "approval": approval,
                "state": get_manuscript_package_state(&full_path)?
            }))
        })()),
        "manuscripts:transcribe-package-subtitles" => {
            Some(transcribe_package_subtitles_value(state, payload))
        }
        "manuscripts:attach-external-files" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !is_manuscript_package_path(&full_path) {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let package_kind =
                get_package_kind_from_manifest(&full_path).unwrap_or_else(|| "article".to_string());
            let picked = pick_files_native("选择要导入的素材文件", false, true)?;
            if picked.is_empty() {
                return Ok(json!({ "success": true, "canceled": true, "imported": [] }));
            }
            let imports_root = media_root(state)?.join("imports");
            fs::create_dir_all(&imports_root).map_err(|error| error.to_string())?;
            let mut imported = Vec::<Value>::new();
            for file in picked {
                let content_hash = file_content_hash(&file)?;
                if let Some(asset) = crate::commands::library::existing_media_asset_by_content_hash(
                    state,
                    &content_hash,
                )? {
                    ensure_package_asset_entry(&full_path, &asset, None, None, None)?;
                    let mime_type = asset.mime_type.clone().unwrap_or_else(|| {
                        let (mime_type, _, _) = guess_mime_and_kind(&file);
                        mime_type
                    });
                    let track = if mime_type.starts_with("audio/") {
                        "A1"
                    } else {
                        "V1"
                    };
                    if package_kind != "video" {
                        let _ = handle_manuscripts_channel(
                            app,
                            state,
                            "manuscripts:add-package-clip",
                            &json!({
                                "filePath": file_path,
                                "assetId": asset.id,
                                "track": track,
                            }),
                        );
                    }
                    imported.push(json!({
                        "absolutePath": asset.absolute_path,
                        "title": asset.title,
                        "mimeType": mime_type,
                        "assetId": asset.id,
                        "reused": true,
                    }));
                    continue;
                }
                let (relative_name, target) = copy_file_into_dir(&file, &imports_root)?;
                let (mime_type, kind, _) = guess_mime_and_kind(&target);
                let thumbnail_url = if kind == "video" {
                    ensure_video_thumbnail_for_path(Some(app), state, &target)
                } else {
                    None
                };
                let asset = with_store_mut(state, |store| {
                    let asset = MediaAssetRecord {
                        id: make_id("media"),
                        source: "imported".to_string(),
                        source_domain: None,
                        source_link: None,
                        project_id: None,
                        title: file
                            .file_name()
                            .and_then(|value| value.to_str())
                            .map(ToString::to_string),
                        prompt: None,
                        provider: None,
                        provider_template: None,
                        model: None,
                        aspect_ratio: None,
                        size: None,
                        quality: None,
                        mime_type: Some(mime_type.clone()),
                        content_hash: file_content_hash(&target).ok(),
                        relative_path: Some(format!("imports/{}", relative_name)),
                        bound_manuscript_path: Some(file_path.clone()),
                        created_at: now_rfc3339(),
                        updated_at: now_rfc3339(),
                        absolute_path: Some(target.display().to_string()),
                        preview_url: Some(file_url_for_path(&target)),
                        thumbnail_url,
                        exists: true,
                    };
                    media_store::push_asset(store, asset.clone());
                    Ok(asset)
                })?;
                persist_media_workspace_catalog(state)?;
                ensure_package_asset_entry(&full_path, &asset, None, None, None)?;
                let track = if mime_type.starts_with("audio/") {
                    "A1"
                } else {
                    "V1"
                };
                if package_kind != "video" {
                    let _ = handle_manuscripts_channel(
                        app,
                        state,
                        "manuscripts:add-package-clip",
                        &json!({
                            "filePath": file_path,
                            "assetId": asset.id,
                            "track": track,
                        }),
                    );
                }
                imported.push(json!({
                    "absolutePath": target.display().to_string(),
                    "title": asset.title,
                    "mimeType": mime_type,
                    "assetId": asset.id,
                }));
            }
            Ok(json!({
                "success": true,
                "canceled": false,
                "imported": imported,
                "state": get_manuscript_package_state(&full_path)?,
            }))
        })()),
        _ => None,
    }
}
