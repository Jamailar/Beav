use crate::helpers::{read_json_value_or, write_json_value};
use crate::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

const DEFAULT_CANVAS_WIDTH: i64 = 1080;
const DEFAULT_CANVAS_HEIGHT: i64 = 1920;
const DEFAULT_CANVAS_FPS: i64 = 30;
const DEFAULT_ASSET_DURATION_MS: i64 = 60_000;

pub fn handle_video_editor_v2_channel(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !channel.starts_with("videoEditorV2:") {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "videoEditorV2:get-or-create-for-manuscript" => {
                let manuscript_path = payload_string(payload, "manuscriptPath").unwrap_or_default();
                if manuscript_path.trim().is_empty() {
                    return Ok(json!({ "success": false, "error": "manuscriptPath is required" }));
                }
                let title = payload_string(payload, "title").unwrap_or_else(|| {
                    Path::new(&manuscript_path)
                        .file_stem()
                        .and_then(|value| value.to_str())
                        .unwrap_or("视频剪辑项目")
                        .to_string()
                });
                let project_id = deterministic_project_id(&manuscript_path);
                let project = get_or_create_project(state, &project_id, &title, Some(&manuscript_path))?;
                Ok(json!({ "success": true, "project": project }))
            }
            "videoEditorV2:create-project" => {
                let title = payload_string(payload, "title").unwrap_or_else(|| "视频剪辑项目".to_string());
                let project_id = make_id("video_v2");
                let project = get_or_create_project(state, &project_id, &title, None)?;
                Ok(json!({ "success": true, "project": project }))
            }
            "videoEditorV2:get-project" => {
                let project_id = payload_string(payload, "projectId").unwrap_or_default();
                let project = read_project(state, &project_id)?;
                Ok(json!({ "success": true, "project": project }))
            }
            "videoEditorV2:import-assets" => handle_import_assets(state, payload),
            "videoEditorV2:import-srt" => handle_import_srt(state, payload),
            "videoEditorV2:update-srt-segment" => handle_update_srt_segment(state, payload),
            "videoEditorV2:merge-srt-segments" => handle_merge_srt_segments(state, payload),
            "videoEditorV2:split-srt-segment" => handle_split_srt_segment(state, payload),
            "videoEditorV2:set-timeline-clip-disabled" => handle_set_clip_disabled(state, payload),
            "videoEditorV2:trim-timeline-clip" => handle_trim_clip(state, payload),
            "videoEditorV2:split-timeline-clip" => handle_split_clip(state, payload),
            "videoEditorV2:reorder-timeline-clip" => handle_reorder_clip(state, payload),
            "videoEditorV2:undo-timeline" => handle_undo_timeline(state, payload),
            "videoEditorV2:generate-auto-edit" => handle_generate_auto_edit(state, payload),
            "videoEditorV2:apply-auto-edit" => handle_apply_auto_edit(state, payload),
            "videoEditorV2:run-asr" => Ok(json!({
                "success": false,
                "error": "当前 V2 工作台还没有接入本机 ASR。请先导入 SRT 字幕，或通过右侧 AI 对话生成剪辑计划。"
            })),
            "videoEditorV2:render" => Ok(json!({
                "success": false,
                "error": "当前 V2 工作台已生成 Remotion 预览配置，但 host 渲染导出尚未接入。"
            })),
            _ => Ok(json!({ "success": false, "error": format!("Unsupported video editor V2 channel: {channel}") })),
        }
    })())
}

fn video_editor_v2_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = store_root(state)?.join("video-editor-v2");
    fs::create_dir_all(root.join("projects")).map_err(|error| error.to_string())?;
    Ok(root)
}

fn project_json_path(state: &State<'_, AppState>, project_id: &str) -> Result<PathBuf, String> {
    if project_id.trim().is_empty() {
        return Err("projectId is required".to_string());
    }
    Ok(video_editor_v2_root(state)?
        .join("projects")
        .join(safe_path_segment(project_id))
        .join("project.json"))
}

fn deterministic_project_id(source: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source.as_bytes());
    let digest = hasher.finalize();
    format!("video_v2_{:x}", &digest)[..25].to_string()
}

fn safe_path_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' { ch } else { '_' })
        .collect::<String>()
}

fn get_or_create_project(
    state: &State<'_, AppState>,
    project_id: &str,
    title: &str,
    manuscript_path: Option<&str>,
) -> Result<Value, String> {
    let path = project_json_path(state, project_id)?;
    if path.exists() {
        return Ok(read_json_value_or(&path, json!({})));
    }
    let project_dir = path.parent().ok_or_else(|| "Invalid V2 project path".to_string())?;
    fs::create_dir_all(project_dir.join("assets")).map_err(|error| error.to_string())?;
    fs::create_dir_all(project_dir.join("transcripts")).map_err(|error| error.to_string())?;
    let now = now_rfc3339();
    let project = json!({
        "version": 1,
        "id": project_id,
        "title": title,
        "sourceManuscriptPath": manuscript_path,
        "projectDir": project_dir.display().to_string(),
        "createdAt": now,
        "updatedAt": now,
        "status": "draft",
        "canvas": {
            "width": DEFAULT_CANVAS_WIDTH,
            "height": DEFAULT_CANVAS_HEIGHT,
            "fps": DEFAULT_CANVAS_FPS,
            "aspectRatio": "9:16"
        },
        "assets": [],
        "transcriptTracks": [],
        "timeline": {
            "id": "timeline_primary",
            "durationMs": 0,
            "tracks": [
                { "id": "track_primary", "kind": "primary-video", "name": "主轨", "clips": [] },
                { "id": "track_subtitle", "kind": "subtitle", "name": "字幕", "clips": [] }
            ]
        },
        "autoEditRuns": [],
        "undoStack": [],
        "remotionSnapshot": null,
        "renderOutputs": [],
        "lastError": null
    });
    write_json_value(&path, &project)?;
    Ok(project)
}

fn read_project(state: &State<'_, AppState>, project_id: &str) -> Result<Value, String> {
    let path = project_json_path(state, project_id)?;
    if !path.exists() {
        return Err("V2 剪辑项目不存在".to_string());
    }
    Ok(read_json_value_or(&path, json!({})))
}

fn save_project(state: &State<'_, AppState>, project: &mut Value) -> Result<(), String> {
    let project_id = project
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "project.id is missing".to_string())?
        .to_string();
    if let Some(object) = project.as_object_mut() {
        object.insert("updatedAt".to_string(), json!(now_rfc3339()));
    }
    let path = project_json_path(state, &project_id)?;
    write_json_value(&path, project)
}

fn handle_import_assets(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let project_id = payload_string(payload, "projectId").unwrap_or_default();
    let mut project = read_project(state, &project_id)?;
    let source_paths = payload
        .get("sourcePaths")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(PathBuf::from)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let picked = if source_paths.is_empty() {
        pick_files_native("选择要导入 V2 剪辑项目的素材文件", false, true)?
    } else {
        source_paths
    };
    if picked.is_empty() {
        return Ok(json!({ "success": true, "canceled": true, "project": project }));
    }
    let project_dir = project_dir(&project)?;
    let assets_dir = project_dir.join("assets");
    fs::create_dir_all(&assets_dir).map_err(|error| error.to_string())?;
    for source in picked {
        if !source.exists() || !source.is_file() {
            continue;
        }
        let (relative_name, target) = copy_file_into_dir(&source, &assets_dir)?;
        let (_mime_type, guessed_kind, _) = guess_mime_and_kind(&target);
        let kind = match guessed_kind.as_str() {
            "image" => "image",
            "audio" => "audio",
            "video" => "video",
            _ => infer_asset_kind(&target),
        };
        if !matches!(kind, "video" | "audio" | "image") {
            continue;
        }
        let asset_id = make_id("asset");
        let duration_ms = if kind == "image" { 5_000 } else { DEFAULT_ASSET_DURATION_MS };
        let asset = json!({
            "id": asset_id,
            "kind": kind,
            "title": source.file_stem().and_then(|value| value.to_str()).unwrap_or("素材"),
            "sourcePath": source.display().to_string(),
            "projectPath": target.display().to_string(),
            "relativePath": format!("assets/{relative_name}"),
            "proxyPath": null,
            "thumbnailPath": null,
            "durationMs": duration_ms,
            "width": null,
            "height": null,
            "fps": null,
            "hash": content_hash_hint(&target),
            "createdAt": now_rfc3339(),
            "updatedAt": now_rfc3339(),
            "probe": {
                "durationMs": duration_ms
            }
        });
        ensure_array_mut(&mut project, "assets")?.push(asset);
        if matches!(kind, "video" | "audio") {
            append_primary_clip(&mut project, &asset_id, duration_ms);
        }
    }
    normalize_timeline_duration(&mut project);
    save_project(state, &mut project)?;
    Ok(json!({ "success": true, "project": project }))
}

fn handle_import_srt(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let project_id = payload_string(payload, "projectId").unwrap_or_default();
    let mut project = read_project(state, &project_id)?;
    let srt_content = payload_string(payload, "srtContent")
        .or_else(|| {
            payload_string(payload, "srtPath")
                .and_then(|path| fs::read_to_string(path).ok())
        })
        .unwrap_or_default();
    let content = if srt_content.trim().is_empty() {
        let picked = pick_files_native("选择 SRT 字幕文件", false, false)?;
        if picked.is_empty() {
            return Ok(json!({ "success": true, "canceled": true, "project": project }));
        }
        fs::read_to_string(&picked[0]).map_err(|error| error.to_string())?
    } else {
        srt_content
    };
    let asset_id = payload_string(payload, "assetId").unwrap_or_else(|| first_media_asset_id(&project));
    let segments = parse_srt_segments_v2(&content, &asset_id);
    let track_id = make_id("track");
    let project_dir = project_dir(&project)?;
    let transcripts_dir = project_dir.join("transcripts");
    fs::create_dir_all(&transcripts_dir).map_err(|error| error.to_string())?;
    let srt_path = transcripts_dir.join(format!("{track_id}.srt"));
    fs::write(&srt_path, &content).map_err(|error| error.to_string())?;
    let json_path = transcripts_dir.join(format!("{track_id}.json"));
    write_json_value(&json_path, &json!(segments))?;
    ensure_array_mut(&mut project, "transcriptTracks")?.push(json!({
        "id": track_id,
        "assetId": asset_id,
        "language": payload_string(payload, "language"),
        "sourceSrtPath": srt_path.display().to_string(),
        "normalizedJsonPath": json_path.display().to_string(),
        "editedSrtPath": null,
        "segments": segments,
        "createdAt": now_rfc3339(),
        "updatedAt": now_rfc3339()
    }));
    rebuild_subtitle_clips(&mut project);
    normalize_timeline_duration(&mut project);
    save_project(state, &mut project)?;
    Ok(json!({ "success": true, "project": project }))
}

fn handle_update_srt_segment(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let project_id = payload_string(payload, "projectId").unwrap_or_default();
    let segment_id = payload_string(payload, "segmentId").unwrap_or_default();
    let mut project = read_project(state, &project_id)?;
    for track in transcript_tracks_mut(&mut project) {
        let mut changed = false;
        for segment in track.get_mut("segments").and_then(Value::as_array_mut).into_iter().flatten() {
            if segment.get("id").and_then(Value::as_str) == Some(segment_id.as_str()) {
                if let Some(text) = payload_string(payload, "text") {
                    segment["text"] = json!(text);
                }
                if let Some(tags) = payload.get("tags").and_then(Value::as_array) {
                    segment["tags"] = json!(tags);
                }
                changed = true;
            }
        }
        if changed {
            track["updatedAt"] = json!(now_rfc3339());
        }
    }
    rebuild_subtitle_clips(&mut project);
    save_project(state, &mut project)?;
    Ok(json!({ "success": true, "project": project }))
}

fn handle_merge_srt_segments(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let project_id = payload_string(payload, "projectId").unwrap_or_default();
    let segment_id = payload_string(payload, "segmentId").unwrap_or_default();
    let mut project = read_project(state, &project_id)?;
    for track in transcript_tracks_mut(&mut project) {
        let Some(segments) = track.get_mut("segments").and_then(Value::as_array_mut) else {
            continue;
        };
        if let Some(index) = segments.iter().position(|segment| segment.get("id").and_then(Value::as_str) == Some(segment_id.as_str())) {
            if index + 1 < segments.len() {
                let next = segments.remove(index + 1);
                let next_text = next.get("text").and_then(Value::as_str).unwrap_or("");
                let next_end = next.get("endMs").and_then(Value::as_i64).unwrap_or(0);
                let current = &mut segments[index];
                let text = current.get("text").and_then(Value::as_str).unwrap_or("");
                current["text"] = json!(format!("{text}{next_text}"));
                current["endMs"] = json!(next_end.max(current.get("endMs").and_then(Value::as_i64).unwrap_or(0)));
                renumber_segments(segments);
                break;
            }
        }
    }
    rebuild_subtitle_clips(&mut project);
    normalize_timeline_duration(&mut project);
    save_project(state, &mut project)?;
    Ok(json!({ "success": true, "project": project }))
}

fn handle_split_srt_segment(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let project_id = payload_string(payload, "projectId").unwrap_or_default();
    let segment_id = payload_string(payload, "segmentId").unwrap_or_default();
    let split_offset_ms = payload.get("splitOffsetMs").and_then(Value::as_i64).unwrap_or(0);
    let mut project = read_project(state, &project_id)?;
    for track in transcript_tracks_mut(&mut project) {
        let Some(segments) = track.get_mut("segments").and_then(Value::as_array_mut) else {
            continue;
        };
        if let Some(index) = segments.iter().position(|segment| segment.get("id").and_then(Value::as_str) == Some(segment_id.as_str())) {
            let current = segments[index].clone();
            let start_ms = current.get("startMs").and_then(Value::as_i64).unwrap_or(0);
            let end_ms = current.get("endMs").and_then(Value::as_i64).unwrap_or(start_ms + 1000);
            let split_ms = if split_offset_ms > 0 {
                (start_ms + split_offset_ms).clamp(start_ms + 100, end_ms - 100)
            } else {
                start_ms + ((end_ms - start_ms) / 2).max(100)
            };
            let text = current.get("text").and_then(Value::as_str).unwrap_or("").to_string();
            let midpoint = text.len() / 2;
            segments[index]["endMs"] = json!(split_ms);
            segments[index]["text"] = json!(text[..midpoint].trim());
            let mut next = current;
            next["id"] = json!(make_id("seg"));
            next["startMs"] = json!(split_ms);
            next["text"] = json!(text[midpoint..].trim());
            segments.insert(index + 1, next);
            renumber_segments(segments);
            break;
        }
    }
    rebuild_subtitle_clips(&mut project);
    normalize_timeline_duration(&mut project);
    save_project(state, &mut project)?;
    Ok(json!({ "success": true, "project": project }))
}

fn handle_set_clip_disabled(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let project_id = payload_string(payload, "projectId").unwrap_or_default();
    let clip_id = payload_string(payload, "clipId").unwrap_or_default();
    let disabled = payload.get("disabled").and_then(Value::as_bool).unwrap_or(false);
    let mut project = read_project(state, &project_id)?;
    push_undo_snapshot(&mut project, "调整片段启用状态");
    for clip in timeline_clips_mut(&mut project) {
        if clip.get("id").and_then(Value::as_str) == Some(clip_id.as_str()) {
            clip["disabled"] = json!(disabled);
        }
    }
    save_project(state, &mut project)?;
    Ok(json!({ "success": true, "project": project }))
}

fn handle_trim_clip(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let project_id = payload_string(payload, "projectId").unwrap_or_default();
    let clip_id = payload_string(payload, "clipId").unwrap_or_default();
    let mut project = read_project(state, &project_id)?;
    push_undo_snapshot(&mut project, "裁剪片段");
    for clip in timeline_clips_mut(&mut project) {
        if clip.get("id").and_then(Value::as_str) == Some(clip_id.as_str()) {
            if let Some(value) = payload.get("sourceStartMs").and_then(Value::as_i64) {
                clip["sourceStartMs"] = json!(value.max(0));
            }
            if let Some(value) = payload.get("sourceEndMs").and_then(Value::as_i64) {
                clip["sourceEndMs"] = json!(value.max(0));
            }
        }
    }
    normalize_timeline_duration(&mut project);
    save_project(state, &mut project)?;
    Ok(json!({ "success": true, "project": project }))
}

fn handle_split_clip(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let project_id = payload_string(payload, "projectId").unwrap_or_default();
    let clip_id = payload_string(payload, "clipId").unwrap_or_default();
    let split_ms = payload.get("splitMs").and_then(Value::as_i64).unwrap_or(0);
    let mut project = read_project(state, &project_id)?;
    push_undo_snapshot(&mut project, "拆分片段");
    for track in timeline_tracks_mut(&mut project) {
        let Some(clips) = track.get_mut("clips").and_then(Value::as_array_mut) else {
            continue;
        };
        if let Some(index) = clips.iter().position(|clip| clip.get("id").and_then(Value::as_str) == Some(clip_id.as_str())) {
            let clip = clips[index].clone();
            let start = clip.get("timelineStartMs").and_then(Value::as_i64).unwrap_or(0);
            let end = clip.get("timelineEndMs").and_then(Value::as_i64).unwrap_or(start);
            let cut = split_ms.clamp(start + 100, end - 100);
            clips[index]["timelineEndMs"] = json!(cut);
            clips[index]["sourceEndMs"] = json!(clip.get("sourceStartMs").and_then(Value::as_i64).unwrap_or(0) + (cut - start));
            let mut right = clip;
            right["id"] = json!(make_id("clip"));
            right["timelineStartMs"] = json!(cut);
            right["sourceStartMs"] = json!(clips[index].get("sourceEndMs").and_then(Value::as_i64).unwrap_or(0));
            clips.insert(index + 1, right);
            break;
        }
    }
    normalize_timeline_duration(&mut project);
    save_project(state, &mut project)?;
    Ok(json!({ "success": true, "project": project }))
}

fn handle_reorder_clip(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let project_id = payload_string(payload, "projectId").unwrap_or_default();
    let clip_id = payload_string(payload, "clipId").unwrap_or_default();
    let target_index = payload.get("targetIndex").and_then(Value::as_i64).unwrap_or(0).max(0) as usize;
    let mut project = read_project(state, &project_id)?;
    push_undo_snapshot(&mut project, "重排片段");
    for track in timeline_tracks_mut(&mut project) {
        let Some(clips) = track.get_mut("clips").and_then(Value::as_array_mut) else {
            continue;
        };
        if let Some(index) = clips.iter().position(|clip| clip.get("id").and_then(Value::as_str) == Some(clip_id.as_str())) {
            let clip = clips.remove(index);
            clips.insert(target_index.min(clips.len()), clip);
            relayout_track(clips);
            break;
        }
    }
    normalize_timeline_duration(&mut project);
    save_project(state, &mut project)?;
    Ok(json!({ "success": true, "project": project }))
}

fn handle_undo_timeline(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let project_id = payload_string(payload, "projectId").unwrap_or_default();
    let mut project = read_project(state, &project_id)?;
    let undo = project
        .get_mut("undoStack")
        .and_then(Value::as_array_mut)
        .and_then(|items| if items.is_empty() { None } else { Some(items.remove(0)) });
    if let Some(record) = undo {
        if let Some(timeline) = record.get("timeline").cloned() {
            project["timeline"] = timeline;
        }
        if let Some(auto_edit_runs) = record.get("autoEditRuns").cloned() {
            project["autoEditRuns"] = auto_edit_runs;
        }
    }
    save_project(state, &mut project)?;
    Ok(json!({ "success": true, "project": project }))
}

fn handle_generate_auto_edit(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let project_id = payload_string(payload, "projectId").unwrap_or_default();
    let track_id = payload_string(payload, "trackId").unwrap_or_else(|| first_transcript_track_id(&read_project(state, &project_id).unwrap_or(json!({}))));
    let goal = payload_string(payload, "goal").unwrap_or_else(|| "剪成节奏紧凑的粗剪".to_string());
    let target_duration_ms = payload.get("targetDurationMs").and_then(Value::as_i64);
    let mut project = read_project(state, &project_id)?;
    let segments = find_track_segments(&project, &track_id);
    let mut selected = Vec::new();
    let mut removed = Vec::new();
    let mut used_duration = 0_i64;
    for segment in segments {
        let segment_id = segment.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let text = segment.get("text").and_then(Value::as_str).unwrap_or("");
        let tags = segment.get("tags").and_then(Value::as_array).cloned().unwrap_or_default();
        let duration = segment.get("endMs").and_then(Value::as_i64).unwrap_or(0)
            - segment.get("startMs").and_then(Value::as_i64).unwrap_or(0);
        let should_remove = tags.iter().any(|tag| {
            tag.as_str().map(|value| matches!(value, "remove" | "filler" | "unclear")).unwrap_or(false)
        }) || text.trim().is_empty()
            || target_duration_ms.map(|target| used_duration >= target).unwrap_or(false);
        if should_remove {
            removed.push(json!({ "segmentId": segment_id, "reason": "低信息密度或超出目标时长" }));
        } else {
            used_duration += duration.max(0);
            selected.push(json!({
                "segmentId": segment_id,
                "reason": "保留为主线内容",
                "role": if selected.is_empty() { "hook" } else { "detail" },
                "priority": 100_i64.saturating_sub(selected.len() as i64)
            }));
        }
    }
    let run = json!({
        "id": make_id("auto"),
        "createdAt": now_rfc3339(),
        "appliedAt": null,
        "trackId": track_id,
        "userGoal": goal,
        "targetDurationMs": target_duration_ms,
        "plan": {
            "summary": "已根据字幕生成一版基础粗剪计划。",
            "selectedSegments": selected,
            "removedSegments": removed,
            "titleCards": [],
            "subtitleStyle": {},
            "warnings": []
        },
        "decisions": [],
        "status": "planned"
    });
    ensure_array_mut(&mut project, "autoEditRuns")?.insert(0, run);
    project["status"] = json!("auto_editing");
    save_project(state, &mut project)?;
    Ok(json!({ "success": true, "project": project }))
}

fn handle_apply_auto_edit(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let project_id = payload_string(payload, "projectId").unwrap_or_default();
    let run_id = payload_string(payload, "runId").unwrap_or_default();
    let mut project = read_project(state, &project_id)?;
    push_undo_snapshot(&mut project, "应用自动粗剪");
    let selected_ids = project
        .get("autoEditRuns")
        .and_then(Value::as_array)
        .and_then(|runs| {
            runs.iter()
                .find(|run| run_id.is_empty() || run.get("id").and_then(Value::as_str) == Some(run_id.as_str()))
        })
        .and_then(|run| run.get("plan"))
        .and_then(|plan| plan.get("selectedSegments"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("segmentId").and_then(Value::as_str).map(ToString::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for clip in timeline_clips_mut(&mut project) {
        let segment_ids = clip
            .get("transcriptSegmentIds")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !segment_ids.is_empty() {
            let keep = segment_ids
                .iter()
                .filter_map(Value::as_str)
                .any(|id| selected_ids.iter().any(|selected| selected == id));
            clip["disabled"] = json!(!keep);
        }
    }
    if let Some(runs) = project.get_mut("autoEditRuns").and_then(Value::as_array_mut) {
        for run in runs {
            if run_id.is_empty() || run.get("id").and_then(Value::as_str) == Some(run_id.as_str()) {
                run["status"] = json!("applied");
                run["appliedAt"] = json!(now_rfc3339());
                break;
            }
        }
    }
    project["status"] = json!("ready");
    save_project(state, &mut project)?;
    Ok(json!({ "success": true, "project": project }))
}

fn project_dir(project: &Value) -> Result<PathBuf, String> {
    project
        .get("projectDir")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| "projectDir is missing".to_string())
}

fn infer_asset_kind(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "mp4" | "mov" | "m4v" | "webm" | "mkv" => "video",
        "mp3" | "wav" | "m4a" | "aac" | "flac" => "audio",
        "png" | "jpg" | "jpeg" | "webp" | "gif" => "image",
        _ => "unknown",
    }
}

fn content_hash_hint(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.display().to_string().as_bytes());
    if let Ok(metadata) = fs::metadata(path) {
        hasher.update(metadata.len().to_string().as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn ensure_array_mut<'a>(value: &'a mut Value, key: &str) -> Result<&'a mut Vec<Value>, String> {
    if !value.get(key).map(Value::is_array).unwrap_or(false) {
        value[key] = json!([]);
    }
    value
        .get_mut(key)
        .and_then(Value::as_array_mut)
        .ok_or_else(|| format!("{key} must be an array"))
}

fn timeline_tracks_mut(project: &mut Value) -> Vec<&mut Value> {
    project
        .get_mut("timeline")
        .and_then(|timeline| timeline.get_mut("tracks"))
        .and_then(Value::as_array_mut)
        .map(|tracks| tracks.iter_mut().collect())
        .unwrap_or_default()
}

fn transcript_tracks_mut(project: &mut Value) -> Vec<&mut Value> {
    project
        .get_mut("transcriptTracks")
        .and_then(Value::as_array_mut)
        .map(|tracks| tracks.iter_mut().collect())
        .unwrap_or_default()
}

fn timeline_clips_mut(project: &mut Value) -> Vec<&mut Value> {
    let mut clips = Vec::new();
    for track in timeline_tracks_mut(project) {
        if let Some(track_clips) = track.get_mut("clips").and_then(Value::as_array_mut) {
            clips.extend(track_clips.iter_mut());
        }
    }
    clips
}

fn append_primary_clip(project: &mut Value, asset_id: &str, duration_ms: i64) {
    for track in timeline_tracks_mut(project) {
        if track.get("kind").and_then(Value::as_str) != Some("primary-video") {
            continue;
        }
        let clips = track.get_mut("clips").and_then(Value::as_array_mut).expect("clips array");
        let start = clips
            .iter()
            .map(|clip| clip.get("timelineEndMs").and_then(Value::as_i64).unwrap_or(0))
            .max()
            .unwrap_or(0);
        clips.push(json!({
            "id": make_id("clip"),
            "assetId": asset_id,
            "transcriptSegmentIds": [],
            "disabled": false,
            "sourceStartMs": 0,
            "sourceEndMs": duration_ms,
            "timelineStartMs": start,
            "timelineEndMs": start + duration_ms,
            "playbackRate": 1
        }));
        break;
    }
}

fn normalize_timeline_duration(project: &mut Value) {
    let duration = project
        .get("timeline")
        .and_then(|timeline| timeline.get("tracks"))
        .and_then(Value::as_array)
        .map(|tracks| {
            tracks
                .iter()
                .flat_map(|track| track.get("clips").and_then(Value::as_array).into_iter().flatten())
                .filter(|clip| !clip.get("disabled").and_then(Value::as_bool).unwrap_or(false))
                .map(|clip| clip.get("timelineEndMs").and_then(Value::as_i64).unwrap_or(0))
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0);
    project["timeline"]["durationMs"] = json!(duration);
}

fn relayout_track(clips: &mut [Value]) {
    let mut cursor = 0_i64;
    for clip in clips {
        let duration = (clip.get("timelineEndMs").and_then(Value::as_i64).unwrap_or(0)
            - clip.get("timelineStartMs").and_then(Value::as_i64).unwrap_or(0))
            .max(100);
        clip["timelineStartMs"] = json!(cursor);
        clip["timelineEndMs"] = json!(cursor + duration);
        cursor += duration;
    }
}

fn rebuild_subtitle_clips(project: &mut Value) {
    let mut clips = Vec::new();
    let tracks = project
        .get("transcriptTracks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for track in tracks {
        for segment in track.get("segments").and_then(Value::as_array).into_iter().flatten() {
            clips.push(json!({
                "id": format!("subtitle_{}", segment.get("id").and_then(Value::as_str).unwrap_or("segment")),
                "assetId": segment.get("assetId").cloned().unwrap_or(Value::Null),
                "transcriptSegmentIds": [segment.get("id").cloned().unwrap_or(Value::Null)],
                "disabled": false,
                "sourceStartMs": segment.get("startMs").cloned().unwrap_or(json!(0)),
                "sourceEndMs": segment.get("endMs").cloned().unwrap_or(json!(0)),
                "timelineStartMs": segment.get("startMs").cloned().unwrap_or(json!(0)),
                "timelineEndMs": segment.get("endMs").cloned().unwrap_or(json!(0)),
                "text": segment.get("text").cloned().unwrap_or(json!(""))
            }));
        }
    }
    for track in timeline_tracks_mut(project) {
        if track.get("kind").and_then(Value::as_str) == Some("subtitle") {
            track["clips"] = json!(clips);
            break;
        }
    }
}

fn parse_srt_segments_v2(content: &str, asset_id: &str) -> Vec<Value> {
    content
        .split("\n\n")
        .filter_map(|block| {
            let lines = block.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>();
            if lines.len() < 2 {
                return None;
            }
            let time_line_index = lines.iter().position(|line| line.contains("-->"))?;
            let (start_ms, end_ms) = parse_srt_time_range(lines[time_line_index])?;
            let text = lines[(time_line_index + 1)..].join(" ");
            Some((start_ms, end_ms, text))
        })
        .enumerate()
        .map(|(index, (start_ms, end_ms, text))| {
            json!({
                "id": make_id("seg"),
                "index": index + 1,
                "assetId": asset_id,
                "startMs": start_ms,
                "endMs": end_ms,
                "text": text,
                "confidence": null,
                "speaker": null,
                "tags": []
            })
        })
        .collect()
}

fn parse_srt_time_range(line: &str) -> Option<(i64, i64)> {
    let mut parts = line.split("-->");
    let start = parse_srt_timestamp(parts.next()?.trim())?;
    let end = parse_srt_timestamp(parts.next()?.trim())?;
    Some((start, end))
}

fn parse_srt_timestamp(value: &str) -> Option<i64> {
    let normalized = value.replace(',', ".");
    let mut chunks = normalized.split(':').collect::<Vec<_>>();
    if chunks.len() != 3 {
        return None;
    }
    let seconds_part = chunks.pop()?;
    let mut second_chunks = seconds_part.split('.');
    let seconds = second_chunks.next()?.parse::<i64>().ok()?;
    let millis = second_chunks.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
    let minutes = chunks.pop()?.parse::<i64>().ok()?;
    let hours = chunks.pop()?.parse::<i64>().ok()?;
    Some((((hours * 60 + minutes) * 60 + seconds) * 1000) + millis)
}

fn renumber_segments(segments: &mut [Value]) {
    for (index, segment) in segments.iter_mut().enumerate() {
        segment["index"] = json!(index + 1);
    }
}

fn first_media_asset_id(project: &Value) -> String {
    project
        .get("assets")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn first_transcript_track_id(project: &Value) -> String {
    project
        .get("transcriptTracks")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn find_track_segments(project: &Value, track_id: &str) -> Vec<Value> {
    project
        .get("transcriptTracks")
        .and_then(Value::as_array)
        .and_then(|tracks| tracks.iter().find(|track| track.get("id").and_then(Value::as_str) == Some(track_id)))
        .and_then(|track| track.get("segments"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn push_undo_snapshot(project: &mut Value, label: &str) {
    let timeline = project.get("timeline").cloned().unwrap_or(json!({}));
    let auto_edit_runs = project.get("autoEditRuns").cloned().unwrap_or(json!([]));
    let record = json!({
        "id": make_id("undo"),
        "createdAt": now_rfc3339(),
        "label": label,
        "timeline": timeline,
        "autoEditRuns": auto_edit_runs
    });
    if let Ok(stack) = ensure_array_mut(project, "undoStack") {
        stack.insert(0, record);
        stack.truncate(20);
    }
}
