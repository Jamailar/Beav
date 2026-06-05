use super::*;
use crate::store::settings as settings_store;

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
        "manuscripts:get-video-project-state" => Some((|| -> Result<Value, String> {
            let file_path = payload_value_as_string(&payload)
                .or_else(|| payload_string(&payload, "filePath"))
                .unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            if get_package_kind_from_manifest(&full_path).as_deref() != Some("video") {
                return Ok(json!({ "success": false, "error": "Not a video manuscript package" }));
            }
            let file_name = full_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Untitled");
            let package_state = get_manuscript_package_state(&full_path)?;
            let manifest = package_state
                .get("manifest")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let assets = package_state
                .get("assets")
                .cloned()
                .unwrap_or_else(|| json!({ "items": [] }));
            let remotion = package_state
                .get("remotion")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let timeline_summary = package_state
                .get("timelineSummary")
                .cloned()
                .unwrap_or_else(|| {
                    json!({
                        "trackCount": 0,
                        "clipCount": 0,
                        "sourceRefs": [],
                        "clips": [],
                        "trackNames": [],
                        "trackUi": {}
                    })
                });
            let project = read_json_value_or(&package_editor_project_path(&full_path), Value::Null);
            let editor_project = if project.is_object() {
                Some(&project)
            } else {
                None
            };
            Ok(json!({
                "success": true,
                "project": get_video_project_state(
                    &full_path,
                    file_name,
                    &manifest,
                    &assets,
                    &remotion,
                    editor_project,
                    &timeline_summary,
                )
            }))
        })()),
        "manuscripts:save-video-project-brief" => Some((|| -> Result<Value, String> {
            let file_path = payload_value_as_string(&payload)
                .or_else(|| payload_string(&payload, "filePath"))
                .unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            if get_package_kind_from_manifest(&full_path).as_deref() != Some("video") {
                return Ok(json!({ "success": false, "error": "Not a video manuscript package" }));
            }
            let brief = payload_string(&payload, "content")
                .or_else(|| payload_string(&payload, "brief"))
                .unwrap_or_default();
            let source = payload_string(&payload, "source").unwrap_or_else(|| "user".to_string());
            let (next_state, brief_state) =
                persist_video_project_brief(&full_path, &brief, &source)?;
            Ok(json!({
                "success": true,
                "brief": brief_state,
                "project": next_state.get("videoProject").cloned().unwrap_or(Value::Null),
                "state": next_state
            }))
        })()),
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
        "manuscripts:transcribe-package-subtitles" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let source_item_id = payload_string(&payload, "clipId")
                .or_else(|| payload_string(&payload, "itemId"))
                .unwrap_or_default();
            if file_path.is_empty() || source_item_id.is_empty() {
                return Ok(json!({
                    "success": false,
                    "error": "filePath and clipId are required"
                }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }

            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let Some((endpoint, api_key, model_name)) =
                resolve_transcription_settings(&settings_snapshot)
            else {
                return Ok(json!({
                    "success": false,
                    "error": "未配置音频转写服务，请先在设置中填写 transcription endpoint/model。"
                }));
            };

            let mut project = ensure_editor_project(&full_path)?;
            let source_item = project
                .get("items")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items.iter().find(|item| {
                        item.get("id")
                            .and_then(Value::as_str)
                            .map(|value| value == source_item_id)
                            .unwrap_or(false)
                    })
                })
                .cloned();
            let Some(source_item) = source_item else {
                return Ok(json!({ "success": false, "error": "Source clip not found" }));
            };
            if source_item.get("type").and_then(Value::as_str) != Some("media") {
                return Ok(json!({
                    "success": false,
                    "error": "当前只支持对音频/视频素材片段识别字幕"
                }));
            }

            let asset_id = source_item
                .get("assetId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let asset = project
                .get("assets")
                .and_then(Value::as_array)
                .and_then(|assets| {
                    assets.iter().find(|asset| {
                        asset
                            .get("id")
                            .and_then(Value::as_str)
                            .map(|value| value == asset_id)
                            .unwrap_or(false)
                    })
                })
                .cloned();
            let Some(asset) = asset else {
                return Ok(json!({ "success": false, "error": "Source asset not found" }));
            };

            let asset_kind = asset.get("kind").and_then(Value::as_str).unwrap_or("video");
            if asset_kind != "audio" && asset_kind != "video" {
                return Ok(json!({
                    "success": false,
                    "error": "当前片段不是音频或视频素材"
                }));
            }

            let media_source = asset
                .get("src")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if media_source.is_empty() {
                return Ok(json!({ "success": false, "error": "当前片段缺少素材路径" }));
            }
            let mime_type = asset
                .get("mimeType")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(if asset_kind == "audio" {
                    "audio/*"
                } else {
                    "video/*"
                });

            let from_ms = source_item
                .get("fromMs")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .max(0);
            let duration_ms = source_item
                .get("durationMs")
                .and_then(Value::as_i64)
                .unwrap_or(DEFAULT_TIMELINE_CLIP_MS)
                .max(500);
            let trim_in_ms = source_item
                .get("trimInMs")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .max(0);

            let (local_media_path, should_cleanup_media) =
                resolve_project_media_source_path(state, &full_path, &media_source)?;
            let raw_srt = crate::desktop_io::run_curl_transcription_with_response_format(
                &endpoint,
                api_key.as_deref(),
                &model_name,
                &local_media_path,
                mime_type,
                Some("srt"),
            );
            if should_cleanup_media {
                let _ = fs::remove_file(&local_media_path);
            }
            let raw_srt = raw_srt?;

            let parsed_segments = parse_srt_segments(&raw_srt);
            let source_segments = if parsed_segments.is_empty() {
                build_fallback_srt_segments(&raw_srt, duration_ms)
            } else {
                parsed_segments
            };
            if source_segments.is_empty() {
                return Ok(json!({ "success": false, "error": "转写结果为空" }));
            }

            let clip_end_ms = trim_in_ms + duration_ms;
            let clip_relative_segments = source_segments
                .into_iter()
                .filter_map(|segment| {
                    let intersect_start = segment.start_ms.max(trim_in_ms);
                    let intersect_end = segment.end_ms.min(clip_end_ms);
                    if intersect_end <= intersect_start {
                        return None;
                    }
                    Some(SrtSegment {
                        start_ms: (intersect_start - trim_in_ms).max(0),
                        end_ms: (intersect_end - trim_in_ms).max(0),
                        text: segment.text.trim().to_string(),
                    })
                })
                .filter(|segment| !segment.text.is_empty() && segment.end_ms > segment.start_ms)
                .collect::<Vec<_>>();

            let clip_relative_segments = if clip_relative_segments.is_empty() {
                build_fallback_srt_segments(&raw_srt, duration_ms)
            } else {
                clip_relative_segments
            };
            if clip_relative_segments.is_empty() {
                return Ok(json!({ "success": false, "error": "没有可写入时间轴的字幕片段" }));
            }

            let target_track_id = payload_string(&payload, "track")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    project
                        .get("tracks")
                        .and_then(Value::as_array)
                        .and_then(|tracks| {
                            tracks.iter().find_map(|track| {
                                let kind = track.get("kind").and_then(Value::as_str).unwrap_or("");
                                let id = track.get("id").and_then(Value::as_str).unwrap_or("");
                                if kind == "subtitle" && !id.trim().is_empty() {
                                    Some(id.to_string())
                                } else {
                                    None
                                }
                            })
                        })
                })
                .unwrap_or_else(|| "S1".to_string());
            ensure_editor_track(&mut project, &target_track_id, "subtitle")?;

            let subtitle_dir = full_path.join("subtitles");
            fs::create_dir_all(&subtitle_dir).map_err(|error| error.to_string())?;
            let subtitle_file_name = format!(
                "{}.srt",
                source_item_id
                    .chars()
                    .map(|ch| match ch {
                        'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => ch,
                        _ => '-',
                    })
                    .collect::<String>()
            );
            let subtitle_relative_path = format!("subtitles/{subtitle_file_name}");
            let subtitle_file_path = subtitle_dir.join(&subtitle_file_name);
            write_text_file(
                &subtitle_file_path,
                &serialize_srt_segments(&clip_relative_segments),
            )?;

            let style_template = editor_default_subtitle_style(
                &source_item_id,
                &subtitle_relative_path,
                payload_field(&payload, "subtitleStyle"),
            );
            let inserted_items = clip_relative_segments
                .iter()
                .enumerate()
                .map(|(index, segment)| {
                    let mut style = style_template.clone();
                    if let Some(style_object) = style.as_object_mut() {
                        style_object.insert("segmentIndex".to_string(), json!(index));
                        style_object.insert("startMs".to_string(), json!(segment.start_ms));
                        style_object.insert("endMs".to_string(), json!(segment.end_ms));
                    }
                    json!({
                        "id": make_id("subtitle-item"),
                        "type": "subtitle",
                        "trackId": target_track_id,
                        "text": segment.text,
                        "fromMs": from_ms + segment.start_ms,
                        "durationMs": (segment.end_ms - segment.start_ms).max(240),
                        "style": style,
                        "enabled": true
                    })
                })
                .collect::<Vec<_>>();
            let first_inserted_item_id = inserted_items
                .first()
                .and_then(|item| item.get("id").and_then(Value::as_str))
                .map(ToString::to_string);
            {
                let items = editor_project_items_mut(&mut project)?;
                items.retain(|item| {
                    if item.get("type").and_then(Value::as_str) != Some("subtitle") {
                        return true;
                    }
                    item.get("style")
                        .and_then(Value::as_object)
                        .and_then(|style| style.get("sourceItemId"))
                        .and_then(Value::as_str)
                        .map(|value| value != source_item_id)
                        .unwrap_or(true)
                });
                items.extend(inserted_items);
            }
            upsert_editor_project_last_subtitle_transcription(
                &mut project,
                &source_item_id,
                &subtitle_relative_path,
                clip_relative_segments.len(),
            )?;
            normalize_editor_project_timeline(&mut project)?;
            write_json_value(&package_editor_project_path(&full_path), &project)?;
            Ok(json!({
                "success": true,
                "clipId": source_item_id,
                "subtitleCount": clip_relative_segments.len(),
                "subtitleFile": subtitle_relative_path,
                "insertedClipId": first_inserted_item_id,
                "state": get_manuscript_package_state(&full_path)?
            }))
        })()),
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
                    store.media_assets.push(asset.clone());
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
