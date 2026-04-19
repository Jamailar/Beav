use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::Stdio;
use std::thread;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter, State};

use crate::{
    commands::manuscripts::{sync_manuscript_package_html_assets, timeline_clip_duration_ms},
    file_url_for_path, get_default_package_entry, get_draft_type_from_file_name,
    get_package_kind_from_file_name, join_relative, make_id, normalize_relative_path, now_i64,
    now_iso, now_ms, package_assets_path, package_content_map_path, package_cover_path,
    package_editor_project_path, package_entry_path, package_images_path, package_layout_html_path,
    package_layout_template_path, package_manifest_path, package_remotion_input_props_path,
    package_remotion_path, package_scene_ui_path, package_timeline_path, package_track_ui_path,
    package_wechat_html_path, package_wechat_template_path, parse_json_value_from_text,
    read_json_value_or, redbox_project_root, resolve_manuscript_path, title_from_relative_path,
    write_json_value, write_text_file, AppState,
};

pub(crate) fn normalize_motion_preset(value: Option<&str>, fallback: &str) -> String {
    match value.unwrap_or("").trim() {
        "static" | "slow-zoom-in" | "slow-zoom-out" | "pan-left" | "pan-right" | "slide-up"
        | "slide-down" => value.unwrap().trim().to_string(),
        _ => fallback.to_string(),
    }
}

fn normalized_optional_id(value: Option<&Value>) -> Value {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| json!(value))
        .unwrap_or(Value::Null)
}

fn clamp_start_and_duration(
    start_frame: i64,
    duration_in_frames: i64,
    parent_duration_in_frames: i64,
) -> (i64, i64) {
    let safe_parent = parent_duration_in_frames.max(1);
    let safe_start = start_frame.max(0).min(safe_parent - 1);
    let max_duration = (safe_parent - safe_start).max(1);
    let safe_duration = duration_in_frames.max(1).min(max_duration);
    (safe_start, safe_duration)
}

pub(crate) fn remotion_scene_duration_frames(clip: &Value, fps: i64) -> i64 {
    let duration_ms = clip
        .get("durationMs")
        .and_then(|value| value.as_i64())
        .filter(|value| *value > 0)
        .unwrap_or(3000);
    ((duration_ms as f64 / 1000.0) * fps as f64)
        .round()
        .max(24.0) as i64
}

pub(crate) fn fallback_motion_preset(index: usize, asset_kind: &str) -> &'static str {
    if asset_kind == "audio" {
        return "static";
    }
    match index % 5 {
        0 => "slow-zoom-in",
        1 => "pan-left",
        2 => "pan-right",
        3 => "slide-up",
        _ => "slow-zoom-out",
    }
}

fn sanitized_remotion_out_name(title: &str) -> String {
    let mut value = String::new();
    let mut last_was_dash = false;
    for ch in title.trim().chars() {
        let keep =
            ch.is_ascii_alphanumeric() || ch == '-' || ('\u{4e00}'..='\u{9fa5}').contains(&ch);
        if keep {
            value.push(ch);
            last_was_dash = false;
            continue;
        }
        if !last_was_dash {
            value.push('-');
            last_was_dash = true;
        }
    }
    let normalized = value.trim_matches('-').to_string();
    if normalized.is_empty() {
        "redbox-motion".to_string()
    } else {
        normalized
    }
}

fn file_modified_at_ms(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
}

pub(crate) fn default_remotion_render_config(title: &str, render_mode: &str) -> Value {
    let motion_layer = render_mode == "motion-layer";
    json!({
        "defaultOutName": sanitized_remotion_out_name(title),
        "codec": if motion_layer { "prores" } else { "h264" },
        "imageFormat": if motion_layer { "png" } else { "jpeg" },
        "pixelFormat": if motion_layer { Value::String("yuva444p10le".to_string()) } else { Value::Null },
        "proResProfile": if motion_layer { Value::String("4444".to_string()) } else { Value::Null }
    })
}

pub(crate) fn normalized_remotion_render_config(
    render: Option<&Value>,
    title: &str,
    render_mode: &str,
) -> Value {
    let mut normalized = default_remotion_render_config(title, render_mode);
    let Some(source) = render.and_then(Value::as_object) else {
        return normalized;
    };
    let Some(target) = normalized.as_object_mut() else {
        return normalized;
    };
    for key in [
        "codec",
        "imageFormat",
        "pixelFormat",
        "proResProfile",
        "sampleRate",
        "outputPath",
        "renderedAt",
        "durationInFrames",
        "renderMode",
        "compositionId",
    ] {
        if let Some(value) = source.get(key) {
            target.insert(key.to_string(), value.clone());
        }
    }
    target.insert("renderMode".to_string(), json!(render_mode));
    normalized
}

pub(crate) fn build_remotion_input_props(composition: &Value) -> Value {
    json!({
        "composition": composition
    })
}

pub(crate) fn persist_remotion_composition_artifacts(
    package_path: &Path,
    composition: &Value,
) -> Result<(), String> {
    write_json_value(&package_remotion_path(package_path), composition)?;
    write_json_value(
        &package_remotion_input_props_path(package_path),
        &build_remotion_input_props(composition),
    )?;
    Ok(())
}

pub(crate) fn default_video_script_approval(source: &str) -> Value {
    json!({
        "status": "pending",
        "lastScriptUpdateAt": Value::Null,
        "lastScriptUpdateSource": if source.trim().is_empty() { Value::Null } else { json!(source) },
        "confirmedAt": Value::Null
    })
}

pub(crate) fn ensure_manifest_video_ai_state(
    manifest: &mut Value,
) -> Result<&mut serde_json::Map<String, Value>, String> {
    let manifest_object = manifest
        .as_object_mut()
        .ok_or_else(|| "Manifest must be an object".to_string())?;
    manifest_object
        .entry("videoEngine".to_string())
        .or_insert(json!("ai-remotion"));
    let video_ai = manifest_object
        .entry("videoAi".to_string())
        .or_insert_with(|| json!({}));
    if !video_ai.is_object() {
        *video_ai = json!({});
    }
    let video_ai_object = video_ai
        .as_object_mut()
        .ok_or_else(|| "Manifest videoAi must be an object".to_string())?;
    video_ai_object
        .entry("brief".to_string())
        .or_insert(Value::Null);
    video_ai_object
        .entry("lastBriefUpdateAt".to_string())
        .or_insert(Value::Null);
    video_ai_object
        .entry("lastBriefUpdateSource".to_string())
        .or_insert(Value::Null);
    let approval = video_ai_object
        .entry("scriptApproval".to_string())
        .or_insert_with(|| default_video_script_approval("system"));
    if !approval.is_object() {
        *approval = default_video_script_approval("system");
    }
    let approval_object = approval
        .as_object_mut()
        .ok_or_else(|| "Manifest videoAi.scriptApproval must be an object".to_string())?;
    approval_object
        .entry("status".to_string())
        .or_insert(json!("pending"));
    approval_object
        .entry("lastScriptUpdateAt".to_string())
        .or_insert(Value::Null);
    approval_object
        .entry("lastScriptUpdateSource".to_string())
        .or_insert(Value::Null);
    approval_object
        .entry("confirmedAt".to_string())
        .or_insert(Value::Null);
    Ok(video_ai_object)
}

pub(crate) fn video_project_brief_from_manifest(manifest: &Value) -> Value {
    json!({
        "content": manifest.pointer("/videoAi/brief").cloned().unwrap_or(Value::Null),
        "updatedAt": manifest.pointer("/videoAi/lastBriefUpdateAt").cloned().unwrap_or(Value::Null),
        "source": manifest.pointer("/videoAi/lastBriefUpdateSource").cloned().unwrap_or(Value::Null)
    })
}

pub(crate) fn video_script_state_from_manifest(manifest: &Value, script_body: &str) -> Value {
    let approval = manifest
        .pointer("/videoAi/scriptApproval")
        .cloned()
        .unwrap_or_else(|| default_video_script_approval(""));
    json!({
        "body": script_body,
        "approval": approval
    })
}

pub(crate) fn build_default_remotion_scene(title: &str, clips: &[Value]) -> Value {
    let fps = 30_i64;
    let render_mode = "full";
    let duration_in_frames = clips
        .iter()
        .filter(|clip| {
            clip.get("enabled")
                .and_then(|value| value.as_bool())
                .unwrap_or(true)
        })
        .map(|clip| remotion_scene_duration_frames(clip, fps))
        .sum::<i64>()
        .max(90);
    json!({
        "version": 2,
        "title": title,
        "entryCompositionId": "RedBoxVideoMotion",
        "width": 1080,
        "height": 1920,
        "fps": fps,
        "durationInFrames": duration_in_frames,
        "backgroundColor": "#05070b",
        "renderMode": render_mode,
        "transitions": [],
        "baseMedia": {
            "sourceAssetIds": [],
            "outputPath": Value::Null,
            "durationMs": ((duration_in_frames as f64 / fps as f64) * 1000.0).round() as i64,
            "width": Value::Null,
            "height": Value::Null,
            "status": "missing",
            "updatedAt": Value::Null
        },
        "ffmpegRecipe": {
            "operations": [],
            "artifacts": [],
            "summary": Value::Null
        },
        "scenes": [{
            "id": "scene-1",
            "clipId": Value::Null,
            "assetId": Value::Null,
            "assetKind": "unknown",
            "src": "",
            "startFrame": 0,
            "durationInFrames": duration_in_frames,
            "trimInFrames": 0,
            "motionPreset": "static",
            "overlayTitle": Value::Null,
            "overlayBody": Value::Null,
            "overlays": [],
            "entities": []
        }],
        "sceneItemTransforms": {},
        "render": default_remotion_render_config(title, render_mode)
    })
}

fn read_existing_editor_project(package_path: &Path) -> Option<Value> {
    let path = package_editor_project_path(package_path);
    if !path.exists() {
        return None;
    }
    Some(read_json_value_or(&path, json!({})))
}

fn asset_items_from_package_assets(assets: &Value) -> Vec<Value> {
    assets
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn asset_id_from_record(asset: &Value) -> Option<String> {
    asset
        .get("assetId")
        .or_else(|| asset.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn asset_path_from_record(asset: &Value) -> Option<String> {
    for key in [
        "absolutePath",
        "mediaPath",
        "previewUrl",
        "relativePath",
        "src",
    ] {
        if let Some(value) = asset.get(key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn asset_kind_from_record(asset: &Value) -> String {
    asset
        .get("kind")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            infer_editor_asset_kind(
                asset.get("mimeType").and_then(Value::as_str),
                asset_path_from_record(asset).as_deref(),
            )
            .to_string()
        })
}

fn legacy_source_asset_ids(
    editor_project: Option<&Value>,
    timeline_summary: &Value,
) -> Vec<String> {
    let mut ids = Vec::<String>::new();
    let push_id = |ids: &mut Vec<String>, candidate: Option<&str>| {
        let Some(candidate) = candidate.map(str::trim).filter(|value| !value.is_empty()) else {
            return;
        };
        if !ids.iter().any(|value| value == candidate) {
            ids.push(candidate.to_string());
        }
    };

    if let Some(clips) = timeline_summary.get("clips").and_then(Value::as_array) {
        for clip in clips {
            push_id(&mut ids, clip.get("assetId").and_then(Value::as_str));
        }
    }

    if ids.is_empty() {
        if let Some(items) = editor_project
            .and_then(|project| project.get("items"))
            .and_then(Value::as_array)
        {
            for item in items {
                if item.get("type").and_then(Value::as_str) != Some("media") {
                    continue;
                }
                push_id(&mut ids, item.get("assetId").and_then(Value::as_str));
            }
        }
    }

    ids
}

fn infer_legacy_base_media(
    manifest: &Value,
    assets: &Value,
    remotion: &Value,
    editor_project: Option<&Value>,
    timeline_summary: &Value,
) -> Value {
    let source_asset_ids = legacy_source_asset_ids(editor_project, timeline_summary);
    let asset_items = asset_items_from_package_assets(assets);
    let preferred_asset = source_asset_ids
        .iter()
        .find_map(|asset_id| {
            asset_items.iter().find(|asset| {
                asset_id_from_record(asset)
                    .map(|candidate| candidate == *asset_id)
                    .unwrap_or(false)
            })
        })
        .or_else(|| {
            asset_items
                .iter()
                .find(|asset| matches!(asset_kind_from_record(asset).as_str(), "video" | "image"))
        });
    let output_path = preferred_asset
        .and_then(asset_path_from_record)
        .or_else(|| {
            remotion
                .pointer("/scenes/0/src")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        });
    let fps = remotion
        .get("fps")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(30);
    let duration_ms_from_remotion = remotion
        .get("durationInFrames")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .map(|value| ((value as f64 / fps as f64) * 1000.0).round() as i64);
    let duration_ms_from_clips = timeline_summary
        .get("clips")
        .and_then(Value::as_array)
        .map(|clips| {
            clips
                .iter()
                .map(|clip| clip.get("durationMs").and_then(Value::as_i64).unwrap_or(0))
                .sum::<i64>()
        })
        .filter(|value| *value > 0);
    let updated_at = manifest
        .get("updatedAt")
        .cloned()
        .unwrap_or_else(|| json!(now_i64()));
    json!({
        "sourceAssetIds": source_asset_ids,
        "outputPath": output_path,
        "durationMs": duration_ms_from_remotion.or(duration_ms_from_clips).unwrap_or(0),
        "width": remotion.get("width").cloned().unwrap_or(Value::Null),
        "height": remotion.get("height").cloned().unwrap_or(Value::Null),
        "status": if output_path.is_some() { "ready" } else { "missing" },
        "updatedAt": updated_at
    })
}

fn infer_legacy_ffmpeg_recipe(
    remotion: &Value,
    editor_project: Option<&Value>,
    timeline_summary: &Value,
) -> Value {
    let clips = timeline_summary
        .get("clips")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut operations = clips
        .iter()
        .filter(|clip| clip.get("enabled").and_then(Value::as_bool).unwrap_or(true))
        .filter_map(|clip| {
            let asset_id = clip
                .get("assetId")
                .and_then(Value::as_str)?
                .trim()
                .to_string();
            if asset_id.is_empty() {
                return None;
            }
            Some(json!({
                "type": "trim",
                "assetId": asset_id,
                "trimInMs": clip.get("trimInMs").cloned().unwrap_or(json!(0)),
                "trimOutMs": clip.get("trimOutMs").cloned().unwrap_or(json!(0)),
                "durationMs": clip.get("durationMs").cloned().unwrap_or(json!(0))
            }))
        })
        .collect::<Vec<_>>();
    let concat_asset_ids = clips
        .iter()
        .filter_map(|clip| clip.get("assetId").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if concat_asset_ids.len() > 1 {
        operations.push(json!({
            "type": "concat",
            "assetIds": concat_asset_ids
        }));
    }
    let summary = if operations.is_empty() {
        if editor_project.is_some() {
            "Migrated from legacy editor project without explicit clip operations."
        } else {
            "Migrated from legacy package without explicit clip operations."
        }
    } else {
        "Migrated from legacy timeline clip order."
    };
    json!({
        "operations": operations,
        "artifacts": [],
        "summary": summary,
        "migratedFromLegacy": true,
        "source": if editor_project.is_some() { "editor_or_timeline" } else { "timeline" },
        "derivedAt": now_i64(),
        "previousRender": remotion.get("render").cloned().unwrap_or(Value::Null)
    })
}

fn attach_base_media_to_primary_scene(remotion: &mut Value) {
    let base_media_path = remotion
        .pointer("/baseMedia/outputPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let Some(base_media_path) = base_media_path else {
        return;
    };
    let Some(scene) = remotion
        .get_mut("scenes")
        .and_then(Value::as_array_mut)
        .and_then(|items| items.first_mut())
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let should_replace = scene
        .get("src")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(|value| value.is_empty())
        .unwrap_or(true);
    if should_replace {
        scene.insert("src".to_string(), json!(base_media_path));
        scene.insert("assetKind".to_string(), json!("video"));
    }
}

fn normalize_video_remotion_scene(
    title: &str,
    manifest: &Value,
    assets: &Value,
    remotion: &Value,
    editor_project: Option<&Value>,
    timeline_summary: &Value,
) -> Value {
    let mut normalized = if remotion.is_object() {
        remotion.clone()
    } else {
        build_default_remotion_scene(title, &[])
    };
    let fallback = build_default_remotion_scene(title, &[]);
    let render_mode = normalized
        .get("renderMode")
        .and_then(Value::as_str)
        .unwrap_or("full")
        .to_string();
    let legacy_base_media = infer_legacy_base_media(
        manifest,
        assets,
        &normalized,
        editor_project,
        timeline_summary,
    );
    let legacy_ffmpeg_recipe =
        infer_legacy_ffmpeg_recipe(&normalized, editor_project, timeline_summary);
    if let Some(object) = normalized.as_object_mut() {
        object.insert("version".to_string(), json!(2));
        object
            .entry("title".to_string())
            .or_insert_with(|| json!(title));
        object
            .entry("entryCompositionId".to_string())
            .or_insert_with(|| {
                fallback
                    .get("entryCompositionId")
                    .cloned()
                    .unwrap_or(json!("RedBoxVideoMotion"))
            });
        object
            .entry("width".to_string())
            .or_insert_with(|| fallback.get("width").cloned().unwrap_or(json!(1080)));
        object
            .entry("height".to_string())
            .or_insert_with(|| fallback.get("height").cloned().unwrap_or(json!(1920)));
        object
            .entry("fps".to_string())
            .or_insert_with(|| fallback.get("fps").cloned().unwrap_or(json!(30)));
        object
            .entry("durationInFrames".to_string())
            .or_insert_with(|| {
                fallback
                    .get("durationInFrames")
                    .cloned()
                    .unwrap_or(json!(90))
            });
        object
            .entry("backgroundColor".to_string())
            .or_insert_with(|| {
                fallback
                    .get("backgroundColor")
                    .cloned()
                    .unwrap_or(json!("#05070b"))
            });
        object
            .entry("renderMode".to_string())
            .or_insert_with(|| json!("full"));
        object
            .entry("scenes".to_string())
            .or_insert_with(|| fallback.get("scenes").cloned().unwrap_or_else(|| json!([])));
        object
            .entry("transitions".to_string())
            .or_insert_with(|| json!([]));
        object
            .entry("sceneItemTransforms".to_string())
            .or_insert_with(|| json!({}));
        object
            .entry("render".to_string())
            .or_insert_with(|| normalized_remotion_render_config(None, title, &render_mode));
        if !object.contains_key("baseMedia") {
            object.insert("baseMedia".to_string(), legacy_base_media);
        } else {
            let object_width = object.get("width").cloned().unwrap_or(Value::Null);
            let object_height = object.get("height").cloned().unwrap_or(Value::Null);
            if let Some(base_media) = object.get_mut("baseMedia").and_then(Value::as_object_mut) {
                base_media
                    .entry("width".to_string())
                    .or_insert(object_width);
                base_media
                    .entry("height".to_string())
                    .or_insert(object_height);
            }
        }
        if !object.contains_key("ffmpegRecipe") {
            object.insert("ffmpegRecipe".to_string(), legacy_ffmpeg_recipe);
        }
    }
    attach_base_media_to_primary_scene(&mut normalized);
    normalized
}

pub(crate) fn get_video_project_state(
    package_path: &Path,
    file_name: &str,
    manifest: &Value,
    assets: &Value,
    remotion: &Value,
    editor_project: Option<&Value>,
    timeline_summary: &Value,
) -> Value {
    let script_body = read_package_entry_text(package_path, file_name, manifest);
    let script_approval = manifest
        .pointer("/videoAi/scriptApproval")
        .cloned()
        .or_else(|| {
            editor_project
                .and_then(|project| project.pointer("/ai/scriptApproval"))
                .cloned()
        })
        .unwrap_or_else(|| default_video_script_approval(""));
    json!({
        "brief": video_project_brief_from_manifest(manifest),
        "scriptBody": script_body,
        "scriptApproval": script_approval,
        "assets": asset_items_from_package_assets(assets),
        "baseMedia": remotion.get("baseMedia").cloned().unwrap_or_else(|| json!({
            "sourceAssetIds": [],
            "outputPath": Value::Null,
            "durationMs": 0,
            "width": Value::Null,
            "height": Value::Null,
            "status": "missing",
            "updatedAt": Value::Null
        })),
        "ffmpegRecipeSummary": remotion.pointer("/ffmpegRecipe/summary").cloned().unwrap_or(Value::Null),
        "remotion": remotion,
        "renderOutput": remotion.pointer("/render/outputPath").cloned().unwrap_or(Value::Null),
        "legacy": {
            "hasEditorProject": editor_project.is_some(),
            "hasTimelineSummary": timeline_summary.get("clipCount").and_then(Value::as_i64).unwrap_or(0) > 0
        }
    })
}

fn editor_track_kind_for_name(track_name: &str) -> &'static str {
    let normalized = track_name.trim().to_uppercase();
    if normalized.starts_with('A') {
        return "audio";
    }
    if normalized.starts_with('S') || normalized.starts_with('C') {
        return "subtitle";
    }
    if normalized.starts_with('T') {
        return "text";
    }
    if normalized.starts_with('M') {
        return "motion";
    }
    "video"
}

pub(crate) fn infer_editor_asset_kind(
    mime_type: Option<&str>,
    source: Option<&str>,
) -> &'static str {
    let mime = mime_type.unwrap_or("").trim().to_lowercase();
    if mime.starts_with("video/") {
        return "video";
    }
    if mime.starts_with("audio/") {
        return "audio";
    }
    if mime.starts_with("image/") {
        return "image";
    }
    let path = source.unwrap_or("").trim().to_lowercase();
    if path.ends_with(".mp4")
        || path.ends_with(".mov")
        || path.ends_with(".webm")
        || path.ends_with(".m4v")
        || path.ends_with(".mkv")
    {
        return "video";
    }
    if path.ends_with(".mp3")
        || path.ends_with(".wav")
        || path.ends_with(".m4a")
        || path.ends_with(".aac")
        || path.ends_with(".ogg")
        || path.ends_with(".flac")
    {
        return "audio";
    }
    if path.ends_with(".png")
        || path.ends_with(".jpg")
        || path.ends_with(".jpeg")
        || path.ends_with(".webp")
        || path.ends_with(".gif")
        || path.ends_with(".bmp")
        || path.ends_with(".svg")
    {
        return "image";
    }
    "video"
}

fn editor_track_ui_default() -> Value {
    json!({
        "hidden": false,
        "locked": false,
        "muted": false,
        "solo": false,
        "collapsed": false,
        "volume": 1.0
    })
}

fn editor_stage_default() -> Value {
    json!({
        "itemTransforms": {},
        "itemVisibility": {},
        "itemLocks": {},
        "itemOrder": [],
        "itemGroups": {},
        "focusedGroupId": Value::Null
    })
}

fn editor_default_tracks() -> Vec<Value> {
    vec![
        json!({ "id": "V1", "kind": "video", "name": "V1", "order": 0, "ui": editor_track_ui_default() }),
        json!({ "id": "A1", "kind": "audio", "name": "A1", "order": 1, "ui": editor_track_ui_default() }),
        json!({ "id": "S1", "kind": "subtitle", "name": "S1", "order": 2, "ui": editor_track_ui_default() }),
        json!({ "id": "T1", "kind": "text", "name": "T1", "order": 3, "ui": editor_track_ui_default() }),
        json!({ "id": "M1", "kind": "motion", "name": "M1", "order": 4, "ui": editor_track_ui_default() }),
    ]
}

pub(crate) fn build_default_editor_project(
    title: &str,
    script_body: &str,
    width: i64,
    height: i64,
    fps: i64,
) -> Value {
    let ratio_preset = if width >= height { "16:9" } else { "9:16" };
    json!({
        "version": 1,
        "project": {
            "id": make_id("editor-project"),
            "title": title,
            "width": width,
            "height": height,
            "fps": fps,
            "ratioPreset": ratio_preset,
            "backgroundColor": "#05070b"
        },
        "script": {
            "body": script_body
        },
        "assets": [],
        "tracks": editor_default_tracks(),
        "items": [],
        "animationLayers": [],
        "stage": editor_stage_default(),
        "ai": {
            "motionPrompt": "请根据当前时间线和脚本，生成适合短视频的动画节奏与标题强调。",
            "lastEditBrief": Value::Null,
            "lastMotionBrief": Value::Null,
            "scriptApproval": {
                "status": "pending",
                "lastScriptUpdateAt": now_i64(),
                "lastScriptUpdateSource": "system",
                "confirmedAt": Value::Null
            }
        }
    })
}

fn read_package_entry_text(package_path: &Path, file_name: &str, manifest: &Value) -> String {
    fs::read_to_string(package_entry_path(package_path, file_name, Some(manifest)))
        .unwrap_or_default()
}

fn track_ui_value(track_id: &str, track_ui: &Value, fallback_kind: &str) -> Value {
    let current = track_ui
        .get(track_id)
        .cloned()
        .unwrap_or_else(editor_track_ui_default);
    let mut merged = editor_track_ui_default();
    if let (Some(target), Some(source)) = (merged.as_object_mut(), current.as_object()) {
        for (key, value) in source {
            target.insert(key.to_string(), value.clone());
        }
        if fallback_kind != "audio" {
            target.insert("muted".to_string(), json!(false));
            target.insert("solo".to_string(), json!(false));
            target.insert("volume".to_string(), json!(1.0));
        }
    }
    merged
}

pub(crate) fn build_editor_project_from_legacy(
    package_path: &Path,
    file_name: &str,
) -> Result<Value, String> {
    let manifest = read_json_value_or(package_manifest_path(package_path).as_path(), json!({}));
    let fallback_title = title_from_relative_path(file_name);
    let title = manifest
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or(fallback_title.as_str())
        .to_string();
    let script_body = read_package_entry_text(package_path, file_name, &manifest);
    let timeline = read_json_value_or(
        package_timeline_path(package_path).as_path(),
        create_empty_otio_timeline(file_name),
    );
    let (_, _, clips) = build_timeline_clip_summaries(&timeline);
    let remotion = read_json_value_or(
        package_remotion_path(package_path).as_path(),
        build_default_remotion_scene(&title, &clips),
    );
    let track_ui = read_json_value_or(package_track_ui_path(package_path).as_path(), json!({}));
    let scene_ui = read_json_value_or(
        package_scene_ui_path(package_path).as_path(),
        editor_stage_default(),
    );
    let package_assets = read_json_value_or(
        package_assets_path(package_path).as_path(),
        json!({ "items": [] }),
    );
    let width = remotion
        .get("width")
        .and_then(|value| value.as_i64())
        .unwrap_or(1080);
    let height = remotion
        .get("height")
        .and_then(|value| value.as_i64())
        .unwrap_or(1920);
    let fps = remotion
        .get("fps")
        .and_then(|value| value.as_i64())
        .unwrap_or(30);
    let mut project = build_default_editor_project(&title, &script_body, width, height, fps);

    let assets = package_assets
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|asset| {
            let src = asset
                .get("absolutePath")
                .and_then(|value| value.as_str())
                .or_else(|| asset.get("mediaPath").and_then(|value| value.as_str()))
                .or_else(|| asset.get("relativePath").and_then(|value| value.as_str()))
                .unwrap_or("")
                .to_string();
            let mime_type = asset.get("mimeType").and_then(|value| value.as_str()).map(ToString::to_string);
            json!({
                "id": asset.get("assetId").cloned().unwrap_or_else(|| json!(make_id("asset"))),
                "kind": infer_editor_asset_kind(mime_type.as_deref(), Some(&src)),
                "title": asset.get("title").cloned().unwrap_or_else(|| json!("素材")),
                "src": src,
                "mimeType": mime_type,
                "durationMs": Value::Null,
                "metadata": {
                    "relativePath": asset.get("relativePath").cloned().unwrap_or(Value::Null),
                    "absolutePath": asset.get("absolutePath").cloned().unwrap_or(Value::Null),
                    "previewUrl": asset.get("previewUrl").cloned().unwrap_or(Value::Null),
                    "boundManuscriptPath": asset.get("boundManuscriptPath").cloned().unwrap_or(Value::Null),
                    "exists": asset.get("exists").cloned().unwrap_or(json!(true))
                }
            })
        })
        .collect::<Vec<_>>();

    let mut track_names = BTreeSet::new();
    for clip in &clips {
        if let Some(track) = clip.get("track").and_then(|value| value.as_str()) {
            track_names.insert(track.to_string());
        }
    }
    track_names.insert("M1".to_string());
    let has_subtitle = clips.iter().any(|clip| {
        clip.get("assetKind")
            .and_then(|value| value.as_str())
            .map(|value| value == "subtitle")
            .unwrap_or(false)
    });
    let has_text = clips.iter().any(|clip| {
        clip.get("assetKind")
            .and_then(|value| value.as_str())
            .map(|value| value == "text")
            .unwrap_or(false)
    });
    if has_subtitle {
        track_names.insert("S1".to_string());
    }
    if has_text {
        track_names.insert("T1".to_string());
    }
    let tracks = track_names
        .into_iter()
        .enumerate()
        .map(|(index, track_id)| {
            let kind = editor_track_kind_for_name(&track_id);
            json!({
                "id": track_id,
                "kind": kind,
                "name": track_id,
                "order": index,
                "ui": track_ui_value(&track_id, &track_ui, kind)
            })
        })
        .collect::<Vec<_>>();

    let mut items = Vec::new();
    for clip in &clips {
        let asset_kind = clip
            .get("assetKind")
            .and_then(|value| value.as_str())
            .unwrap_or("video");
        let raw_track_id = clip
            .get("track")
            .and_then(|value| value.as_str())
            .unwrap_or("V1");
        let track_id = if asset_kind == "text" {
            "T1".to_string()
        } else if asset_kind == "subtitle" {
            "S1".to_string()
        } else {
            raw_track_id.to_string()
        };
        let item = match asset_kind {
            "text" => json!({
                "id": clip.get("clipId").cloned().unwrap_or_else(|| json!(make_id("item"))),
                "type": "text",
                "trackId": track_id,
                "text": clip.get("name").cloned().unwrap_or_else(|| json!("文本")),
                "fromMs": clip.get("startMs").cloned().unwrap_or(json!(0)),
                "durationMs": clip.get("durationMs").cloned().unwrap_or(json!(2500)),
                "style": clip.get("textStyle").cloned().unwrap_or_else(|| json!({})),
                "enabled": clip.get("enabled").cloned().unwrap_or(json!(true))
            }),
            "subtitle" => json!({
                "id": clip.get("clipId").cloned().unwrap_or_else(|| json!(make_id("item"))),
                "type": "subtitle",
                "trackId": track_id,
                "text": clip.get("name").cloned().unwrap_or_else(|| json!("字幕")),
                "fromMs": clip.get("startMs").cloned().unwrap_or(json!(0)),
                "durationMs": clip.get("durationMs").cloned().unwrap_or(json!(2000)),
                "style": clip.get("subtitleStyle").cloned().unwrap_or_else(|| json!({})),
                "enabled": clip.get("enabled").cloned().unwrap_or(json!(true))
            }),
            _ => json!({
                "id": clip.get("clipId").cloned().unwrap_or_else(|| json!(make_id("item"))),
                "type": "media",
                "trackId": track_id,
                "assetId": clip.get("assetId").cloned().unwrap_or(Value::Null),
                "fromMs": clip.get("startMs").cloned().unwrap_or(json!(0)),
                "durationMs": clip.get("durationMs").cloned().unwrap_or(json!(3000)),
                "trimInMs": clip.get("trimInMs").cloned().unwrap_or(json!(0)),
                "trimOutMs": clip.get("trimOutMs").cloned().unwrap_or(json!(0)),
                "enabled": clip.get("enabled").cloned().unwrap_or(json!(true))
            }),
        };
        items.push(item);
    }

    let animation_layers = animation_layers_from_remotion_scene(&remotion, fps);
    items.extend(projected_motion_items_from_animation_layers(&json!({
        "animationLayers": animation_layers
    })));

    if let Some(object) = project.as_object_mut() {
        object.insert("assets".to_string(), Value::Array(assets));
        object.insert("tracks".to_string(), Value::Array(tracks));
        object.insert("items".to_string(), Value::Array(items));
        object.insert(
            "animationLayers".to_string(),
            Value::Array(animation_layers),
        );
        object.insert(
            "stage".to_string(),
            json!({
                "itemTransforms": scene_ui.get("itemTransforms").cloned().unwrap_or_else(|| json!({})),
                "itemVisibility": scene_ui.get("itemVisibility").cloned().unwrap_or_else(|| json!({})),
                "itemLocks": scene_ui.get("itemLocks").cloned().unwrap_or_else(|| json!({})),
                "itemOrder": scene_ui.get("itemOrder").cloned().unwrap_or_else(|| json!([])),
                "itemGroups": scene_ui.get("itemGroups").cloned().unwrap_or_else(|| json!({})),
                "focusedGroupId": scene_ui.get("focusedGroupId").cloned().unwrap_or(Value::Null)
            }),
        );
        object.insert(
            "ai".to_string(),
            json!({
                "motionPrompt": "请根据当前时间线和脚本，生成适合短视频的动画节奏与标题强调。",
                "lastEditBrief": Value::Null,
                "lastMotionBrief": remotion.get("raw").cloned().unwrap_or(Value::Null),
                "scriptApproval": {
                    "status": "pending",
                    "lastScriptUpdateAt": now_i64(),
                    "lastScriptUpdateSource": "system",
                    "confirmedAt": Value::Null
                }
            }),
        );
    }

    Ok(project)
}

pub(crate) fn ensure_editor_project(package_path: &Path) -> Result<Value, String> {
    let path = package_editor_project_path(package_path);
    if path.exists() {
        let mut project = read_json_value_or(&path, json!({}));
        let original = project.clone();
        if let Some(object) = project.as_object_mut() {
            let ai = object.entry("ai".to_string()).or_insert_with(|| json!({}));
            if !ai.is_object() {
                *ai = json!({});
            }
            if let Some(ai_object) = ai.as_object_mut() {
                ai_object.entry("motionPrompt".to_string()).or_insert(json!(
                    "请根据当前时间线和脚本，生成适合短视频的动画节奏与标题强调。"
                ));
                ai_object
                    .entry("lastEditBrief".to_string())
                    .or_insert(Value::Null);
                ai_object
                    .entry("lastMotionBrief".to_string())
                    .or_insert(Value::Null);
                let approval = ai_object
                    .entry("scriptApproval".to_string())
                    .or_insert_with(|| json!({}));
                if !approval.is_object() {
                    *approval = json!({});
                }
                if let Some(approval_object) = approval.as_object_mut() {
                    approval_object
                        .entry("status".to_string())
                        .or_insert(json!("pending"));
                    approval_object
                        .entry("lastScriptUpdateAt".to_string())
                        .or_insert(Value::Null);
                    approval_object
                        .entry("lastScriptUpdateSource".to_string())
                        .or_insert(Value::Null);
                    approval_object
                        .entry("confirmedAt".to_string())
                        .or_insert(Value::Null);
                }
            }
        }
        if !project_has_motion_projection(&project) {
            let _ = hydrate_editor_project_motion_from_remotion(&mut project, package_path)?;
        }
        if project != original {
            write_json_value(&path, &project)?;
        }
        return Ok(project);
    }
    let file_name = package_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled");
    let project = build_editor_project_from_legacy(package_path, file_name)?;
    write_json_value(&path, &project)?;
    Ok(project)
}

fn item_enabled(item: &Value) -> bool {
    item.get("enabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
}

fn project_has_motion_projection(project: &Value) -> bool {
    let has_layers = project
        .get("animationLayers")
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false);
    let has_motion_items = project
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .any(|item| item.get("type").and_then(Value::as_str) == Some("motion"))
        })
        .unwrap_or(false);
    has_layers || has_motion_items
}

fn composition_has_motion_scenes(composition: &Value) -> bool {
    composition
        .get("scenes")
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false)
}

pub(crate) fn hydrate_editor_project_motion_from_remotion(
    project: &mut Value,
    package_path: &Path,
) -> Result<bool, String> {
    let composition =
        read_json_value_or(package_remotion_path(package_path).as_path(), Value::Null);
    if !composition_has_motion_scenes(&composition) {
        return Ok(false);
    }
    let fps = composition
        .get("fps")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(30);
    let animation_layers = animation_layers_from_remotion_scene(&composition, fps);
    if animation_layers.is_empty() {
        return Ok(false);
    }
    let project_object = project
        .as_object_mut()
        .ok_or_else(|| "Editor project must be an object".to_string())?;
    project_object.insert("animationLayers".to_string(), json!(animation_layers));
    project_object.insert(
        "transitions".to_string(),
        composition
            .get("transitions")
            .cloned()
            .unwrap_or_else(|| json!([])),
    );
    let current_project = Value::Object(project_object.clone());
    let motion_items = projected_motion_items_from_animation_layers(&current_project);
    let items = project_object
        .entry("items".to_string())
        .or_insert_with(|| json!([]));
    if !items.is_array() {
        *items = json!([]);
    }
    let items_array = items
        .as_array_mut()
        .ok_or_else(|| "Editor project items must be an array".to_string())?;
    items_array.retain(|item| item.get("type").and_then(Value::as_str) != Some("motion"));
    items_array.extend(motion_items);
    Ok(true)
}

pub(crate) fn animation_layers_from_remotion_scene(remotion: &Value, fps: i64) -> Vec<Value> {
    remotion
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(index, scene)| {
            let bind_target = scene
                .get("clipId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(|value| {
                    json!([{
                        "type": "clip",
                        "targetId": value
                    }])
                })
                .unwrap_or_else(|| json!([]));
            json!({
                "id": scene.get("id").cloned().unwrap_or_else(|| json!(make_id("animation-layer"))),
                "name": scene.get("overlayTitle").cloned().unwrap_or_else(|| json!(format!("动画层 {}", index + 1))),
                "trackId": format!("M{}", index + 1),
                "enabled": true,
                "fromMs": (((scene.get("startFrame").and_then(|value| value.as_i64()).unwrap_or(0) as f64) * 1000.0) / fps as f64).round() as i64,
                "durationMs": (((scene.get("durationInFrames").and_then(|value| value.as_i64()).unwrap_or(90) as f64) * 1000.0) / fps as f64).round() as i64,
                "zIndex": index,
                "renderMode": remotion.get("renderMode").cloned().unwrap_or_else(|| json!("motion-layer")),
                "componentType": "scene-sequence",
                "props": {
                    "templateId": scene.get("motionPreset").cloned().unwrap_or_else(|| json!("static")),
                    "overlayTitle": scene.get("overlayTitle").cloned().unwrap_or(Value::Null),
                    "overlayBody": scene.get("overlayBody").cloned().unwrap_or(Value::Null),
                    "overlays": scene.get("overlays").cloned().unwrap_or_else(|| json!([]))
                },
                "entities": scene.get("entities").cloned().unwrap_or_else(|| json!([])),
                "bindings": bind_target
            })
        })
        .collect()
}

pub(crate) fn projected_motion_items_from_animation_layers(project: &Value) -> Vec<Value> {
    project
        .get("animationLayers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|layer| {
            let bindings = layer
                .get("bindings")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let bind_item_id = bindings
                .iter()
                .find(|binding| binding.get("type").and_then(Value::as_str) == Some("clip"))
                .and_then(|binding| binding.get("targetId").and_then(Value::as_str))
                .map(ToString::to_string);
            json!({
                "id": layer.get("id").cloned().unwrap_or_else(|| json!(make_id("motion-item"))),
                "type": "motion",
                "trackId": layer.get("trackId").cloned().unwrap_or_else(|| json!("M1")),
                "bindItemId": bind_item_id,
                "fromMs": layer.get("fromMs").cloned().unwrap_or_else(|| json!(0)),
                "durationMs": layer.get("durationMs").cloned().unwrap_or_else(|| json!(2000)),
                "templateId": layer.pointer("/props/templateId").cloned().unwrap_or_else(|| json!("static")),
                "props": {
                    "overlayTitle": layer.pointer("/props/overlayTitle").cloned().or_else(|| layer.get("name").cloned()).unwrap_or(Value::Null),
                    "overlayBody": layer.pointer("/props/overlayBody").cloned().unwrap_or(Value::Null),
                    "overlays": layer.pointer("/props/overlays").cloned().unwrap_or_else(|| json!([])),
                    "entities": layer.get("entities").cloned().unwrap_or_else(|| json!([]))
                },
                "enabled": layer.get("enabled").cloned().unwrap_or_else(|| json!(true))
            })
        })
        .collect()
}

fn editor_project_assets_map(project: &Value) -> BTreeMap<String, Value> {
    let mut result = BTreeMap::new();
    if let Some(assets) = project.get("assets").and_then(Value::as_array) {
        for asset in assets {
            if let Some(id) = asset.get("id").and_then(|value| value.as_str()) {
                result.insert(id.to_string(), asset.clone());
            }
        }
    }
    result
}

pub(crate) fn build_timeline_summary_from_editor_project(project: &Value) -> Value {
    let track_lookup = project
        .get("tracks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|track| {
            let id = track
                .get("id")
                .and_then(|value| value.as_str())?
                .to_string();
            Some((id, track))
        })
        .collect::<BTreeMap<_, _>>();
    let asset_lookup = editor_project_assets_map(project);
    let mut tracks = track_lookup
        .values()
        .filter(|track| {
            track
                .get("kind")
                .and_then(|value| value.as_str())
                .map(|value| value != "motion")
                .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    tracks.sort_by_key(|track| {
        track
            .get("order")
            .and_then(|value| value.as_i64())
            .unwrap_or(0)
    });
    let mut track_clips: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let items = project
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for item in items {
        let item_type = item
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if item_type == "motion" {
            continue;
        }
        let track_id = item
            .get("trackId")
            .and_then(|value| value.as_str())
            .unwrap_or("V1")
            .to_string();
        track_clips.entry(track_id).or_default().push(item);
    }
    let mut clips = Vec::new();
    for track in &tracks {
        let track_id = track
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("V1");
        let track_kind = track
            .get("kind")
            .and_then(|value| value.as_str())
            .unwrap_or("video");
        let mut items = track_clips.remove(track_id).unwrap_or_default();
        items.sort_by_key(|item| {
            item.get("fromMs")
                .and_then(|value| value.as_i64())
                .unwrap_or(0)
        });
        for (index, item) in items.into_iter().enumerate() {
            let item_type = item
                .get("type")
                .and_then(|value| value.as_str())
                .unwrap_or("media");
            let asset = item
                .get("assetId")
                .and_then(|value| value.as_str())
                .and_then(|asset_id| asset_lookup.get(asset_id))
                .cloned();
            let asset_kind = match item_type {
                "subtitle" => "subtitle".to_string(),
                "text" => "text".to_string(),
                _ => asset
                    .as_ref()
                    .map(|value| {
                        value
                            .get("kind")
                            .and_then(|kind| kind.as_str())
                            .unwrap_or("video")
                            .to_string()
                    })
                    .unwrap_or_else(|| track_kind.to_string()),
            };
            let from_ms = item
                .get("fromMs")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            let duration_ms = item
                .get("durationMs")
                .and_then(|value| value.as_i64())
                .unwrap_or(3000);
            clips.push(json!({
                "clipId": item.get("id").cloned().unwrap_or_else(|| json!(make_id("clip"))),
                "assetId": item.get("assetId").cloned().unwrap_or(Value::Null),
                "name": if item_type == "media" {
                    asset.as_ref()
                        .and_then(|value| value.get("title").cloned())
                        .unwrap_or_else(|| json!("素材"))
                } else {
                    item.get("text").cloned().unwrap_or_else(|| json!("文本"))
                },
                "track": track_id,
                "trackKind": track_kind,
                "order": index,
                "durationMs": duration_ms,
                "trimInMs": item.get("trimInMs").cloned().unwrap_or(json!(0)),
                "trimOutMs": item.get("trimOutMs").cloned().unwrap_or(json!(0)),
                "enabled": item_enabled(&item),
                "assetKind": asset_kind,
                "subtitleStyle": item.get("style").cloned().unwrap_or_else(|| json!({})),
                "textStyle": item.get("style").cloned().unwrap_or_else(|| json!({})),
                "transitionStyle": json!({}),
                "startMs": from_ms,
                "endMs": from_ms + duration_ms,
                "startSeconds": from_ms as f64 / 1000.0,
                "endSeconds": (from_ms + duration_ms) as f64 / 1000.0,
                "mediaPath": asset.as_ref().and_then(|value| value.get("src").cloned()).unwrap_or(Value::Null),
                "mimeType": asset.as_ref().and_then(|value| value.get("mimeType").cloned()).unwrap_or(Value::Null)
            }));
        }
    }
    json!({
        "trackCount": tracks.len(),
        "clipCount": clips.len(),
        "sourceRefs": [],
        "clips": clips,
        "trackNames": tracks
            .iter()
            .filter_map(|track| track.get("id").and_then(|value| value.as_str()).map(ToString::to_string))
            .collect::<Vec<_>>(),
        "trackUi": project
            .get("tracks")
            .and_then(Value::as_array)
            .map(|tracks| {
                let mut ui = serde_json::Map::new();
                for track in tracks {
                    if let Some(id) = track.get("id").and_then(|value| value.as_str()) {
                        ui.insert(id.to_string(), track.get("ui").cloned().unwrap_or_else(editor_track_ui_default));
                    }
                }
                Value::Object(ui)
            })
            .unwrap_or_else(|| json!({}))
    })
}

pub(crate) fn build_remotion_config_from_editor_project(project: &Value) -> Value {
    let project_meta = project.get("project").cloned().unwrap_or_else(|| json!({}));
    let width = project_meta
        .get("width")
        .and_then(|value| value.as_i64())
        .unwrap_or(1080);
    let height = project_meta
        .get("height")
        .and_then(|value| value.as_i64())
        .unwrap_or(1920);
    let fps = project_meta
        .get("fps")
        .and_then(|value| value.as_i64())
        .unwrap_or(30);
    let title = project_meta
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or("RedBox Motion")
        .to_string();
    let render_mode = project
        .get("animationLayers")
        .and_then(Value::as_array)
        .and_then(|layers| {
            layers.iter().find_map(|layer| {
                layer
                    .get("renderMode")
                    .and_then(Value::as_str)
                    .filter(|value| *value == "full" || *value == "motion-layer")
                    .map(ToString::to_string)
            })
        })
        .unwrap_or_else(|| "motion-layer".to_string());
    let background_color = project_meta
        .get("backgroundColor")
        .and_then(|value| value.as_str())
        .unwrap_or("#05070b");
    let asset_lookup = editor_project_assets_map(project);
    let tracks = project
        .get("tracks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let track_kind_lookup = tracks
        .into_iter()
        .filter_map(|track| {
            let id = track
                .get("id")
                .and_then(|value| value.as_str())?
                .to_string();
            let kind = track
                .get("kind")
                .and_then(|value| value.as_str())
                .unwrap_or("video")
                .to_string();
            Some((id, kind))
        })
        .collect::<BTreeMap<_, _>>();
    let items = project
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let media_items = items
        .iter()
        .filter(|item| item.get("type").and_then(|value| value.as_str()) == Some("media"))
        .filter(|item| item_enabled(item))
        .filter(|item| {
            let track_id = item
                .get("trackId")
                .and_then(|value| value.as_str())
                .unwrap_or("V1");
            track_kind_lookup
                .get(track_id)
                .map(|kind| kind == "video")
                .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    let motion_items = items
        .iter()
        .filter(|item| item.get("type").and_then(|value| value.as_str()) == Some("motion"))
        .filter(|item| item_enabled(item))
        .cloned()
        .collect::<Vec<_>>();
    let mut scenes = Vec::new();
    let mut duration_in_frames = 90_i64;
    for motion_item in motion_items.iter().filter(|item| {
        item.get("bindItemId")
            .and_then(Value::as_str)
            .map(|value| value.trim().is_empty())
            .unwrap_or(true)
    }) {
        let from_ms = motion_item
            .get("fromMs")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let scene_duration_ms = motion_item
            .get("durationMs")
            .and_then(Value::as_i64)
            .unwrap_or(2000)
            .max(300);
        let start_frame = ((from_ms as f64 / 1000.0) * fps as f64).round() as i64;
        let scene_duration_frames = ((scene_duration_ms as f64 / 1000.0) * fps as f64)
            .round()
            .max(12.0) as i64;
        duration_in_frames = duration_in_frames.max(start_frame + scene_duration_frames);
        let props = motion_item
            .get("props")
            .cloned()
            .unwrap_or_else(|| json!({}));
        scenes.push(json!({
            "id": motion_item.get("id").cloned().unwrap_or_else(|| json!(make_id("scene"))),
            "clipId": Value::Null,
            "assetId": Value::Null,
            "assetKind": "unknown",
            "src": "",
            "startFrame": start_frame,
            "durationInFrames": scene_duration_frames,
            "trimInFrames": 0,
            "motionPreset": motion_item.get("templateId").cloned().unwrap_or_else(|| json!("static")),
            "overlayTitle": props.get("overlayTitle").cloned().unwrap_or(Value::Null),
            "overlayBody": props.get("overlayBody").cloned().unwrap_or(Value::Null),
            "overlays": props.get("overlays").cloned().unwrap_or_else(|| json!([])),
            "entities": props.get("entities").cloned().unwrap_or_else(|| json!([]))
        }));
    }
    for media_item in media_items {
        let item_id = media_item
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let asset_id = media_item
            .get("assetId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let asset = asset_lookup.get(asset_id);
        let src = asset
            .and_then(|value| value.get("src").and_then(|src| src.as_str()))
            .unwrap_or("")
            .to_string();
        let media_kind = asset
            .and_then(|value| value.get("kind").and_then(|kind| kind.as_str()))
            .unwrap_or("video");
        if src.trim().is_empty() || media_kind == "audio" {
            continue;
        }
        let from_ms = media_item
            .get("fromMs")
            .and_then(|value| value.as_i64())
            .unwrap_or(0);
        let item_duration_ms = media_item
            .get("durationMs")
            .and_then(|value| value.as_i64())
            .unwrap_or(3000)
            .max(500);
        let bound_motion = motion_items
            .iter()
            .find(|motion| {
                motion
                    .get("bindItemId")
                    .and_then(|value| value.as_str())
                    .map(|value| value == item_id)
                    .unwrap_or(false)
            })
            .cloned();
        let scene_duration_ms = bound_motion
            .as_ref()
            .and_then(|motion| motion.get("durationMs").and_then(|value| value.as_i64()))
            .unwrap_or(item_duration_ms)
            .max(500);
        let start_frame = ((from_ms as f64 / 1000.0) * fps as f64).round() as i64;
        let scene_duration_frames = ((scene_duration_ms as f64 / 1000.0) * fps as f64)
            .round()
            .max(12.0) as i64;
        duration_in_frames = duration_in_frames.max(start_frame + scene_duration_frames);
        let props = bound_motion
            .as_ref()
            .and_then(|motion| motion.get("props"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        scenes.push(json!({
            "id": bound_motion
                .as_ref()
                .and_then(|motion| motion.get("id").cloned())
                .unwrap_or_else(|| json!(format!("scene-{item_id}"))),
            "clipId": item_id,
            "assetId": asset_id,
            "assetKind": media_kind,
            "src": src,
            "startFrame": start_frame,
            "durationInFrames": scene_duration_frames,
            "trimInFrames": ((media_item.get("trimInMs").and_then(|value| value.as_i64()).unwrap_or(0) as f64 / 1000.0) * fps as f64).round() as i64,
            "motionPreset": bound_motion
                .as_ref()
                .and_then(|motion| motion.get("templateId").cloned())
                .unwrap_or_else(|| json!("static")),
            "overlayTitle": props.get("overlayTitle").cloned().unwrap_or(Value::Null),
            "overlayBody": props.get("overlayBody").cloned().unwrap_or(Value::Null),
            "overlays": props.get("overlays").cloned().unwrap_or_else(|| json!([])),
            "entities": props.get("entities").cloned().unwrap_or_else(|| json!([]))
        }));
    }
    scenes.sort_by_key(|scene| scene.get("startFrame").and_then(Value::as_i64).unwrap_or(0));
    let bound_clip_ids = scenes
        .iter()
        .filter_map(|scene| {
            scene
                .get("clipId")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect::<BTreeSet<_>>();
    let transitions = project
        .get("transitions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|transition| {
            let left_clip_id = transition
                .get("leftClipId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let right_clip_id = transition
                .get("rightClipId")
                .and_then(Value::as_str)
                .unwrap_or("");
            !left_clip_id.trim().is_empty()
                && !right_clip_id.trim().is_empty()
                && bound_clip_ids.contains(left_clip_id)
                && bound_clip_ids.contains(right_clip_id)
        })
        .map(|transition| {
            json!({
                "id": transition.get("id").cloned().unwrap_or_else(|| json!(make_id("transition"))),
                "type": transition.get("type").cloned().unwrap_or_else(|| json!("crossfade")),
                "presentation": transition.get("presentation").cloned().unwrap_or_else(|| json!("fade")),
                "timing": transition.get("timing").cloned().unwrap_or_else(|| json!("linear")),
                "leftClipId": transition.get("leftClipId").cloned().unwrap_or(Value::Null),
                "rightClipId": transition.get("rightClipId").cloned().unwrap_or(Value::Null),
                "trackId": transition.get("trackId").cloned().unwrap_or(Value::Null),
                "durationInFrames": transition.get("durationInFrames").cloned().unwrap_or_else(|| json!(30)),
                "direction": transition.get("direction").cloned().unwrap_or(Value::Null),
                "alignment": transition.get("alignment").cloned().unwrap_or(Value::Null),
                "bezierPoints": transition.get("bezierPoints").cloned().unwrap_or(Value::Null),
                "presetId": transition.get("presetId").cloned().unwrap_or(Value::Null),
                "properties": transition.get("properties").cloned().unwrap_or_else(|| json!({}))
            })
        })
        .collect::<Vec<_>>();
    json!({
        "version": 1,
        "title": title,
        "entryCompositionId": "RedBoxVideoMotion",
        "width": width,
        "height": height,
        "fps": fps,
        "durationInFrames": duration_in_frames.max(90),
        "backgroundColor": background_color,
        "renderMode": render_mode,
        "scenes": scenes,
        "transitions": transitions,
        "sceneItemTransforms": project.pointer("/stage/itemTransforms").cloned().unwrap_or_else(|| json!({})),
        "render": normalized_remotion_render_config(project.get("render"), &title, &render_mode)
    })
}

fn normalize_overlay_animation(value: Option<&str>) -> &'static str {
    match value.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "fade-up" => "fade-up",
        "fade" | "fade-in" => "fade-in",
        "slide-left" | "slide-in-left" | "from-left" => "slide-left",
        "pop" | "spring-pop" | "scale-in" => "pop",
        _ => "fade-in",
    }
}

fn normalize_entity_animation_kind(value: Option<&str>) -> &'static str {
    match value.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "fade-in" | "fade" | "enter" => "fade-in",
        "fade-out" | "exit" => "fade-out",
        "slide-in-left" | "slide-left" | "from-left" => "slide-in-left",
        "slide-in-right" | "slide-right" | "from-right" => "slide-in-right",
        "slide-up" | "from-bottom" => "slide-up",
        "slide-down" | "from-top" => "slide-down",
        "pop" | "spring" | "spring-pop" | "scale-in" => "pop",
        "fall-bounce" | "drop" | "fall" | "bounce" => "fall-bounce",
        "float" => "float",
        _ => "fade-in",
    }
}

fn normalize_entity_position_mode(value: Option<&str>) -> &'static str {
    match value.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "video-space" | "video" | "media-space" | "media" => "video-space",
        _ => "canvas-space",
    }
}

fn entity_axis_value(entity: &Value, axis: &str) -> Option<f64> {
    entity.get(axis).and_then(Value::as_f64).or_else(|| {
        entity
            .get("style")
            .and_then(Value::as_object)
            .and_then(|style| style.get(axis))
            .and_then(Value::as_f64)
    })
}

fn nearly_equal(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1.0
}

fn detect_absolute_fall_bounce_correction(
    source_entity_y: Option<f64>,
    animation: &Value,
) -> Option<(f64, f64, f64)> {
    if normalize_entity_animation_kind(animation.get("kind").and_then(Value::as_str))
        != "fall-bounce"
    {
        return None;
    }
    let source_entity_y = source_entity_y?;
    let raw_from_y = animation
        .get("params")
        .and_then(Value::as_object)
        .and_then(|params| params.get("fromY"))
        .and_then(Value::as_f64)
        .or_else(|| animation.get("fromY").and_then(Value::as_f64))?;
    let raw_floor_y = animation
        .get("params")
        .and_then(Value::as_object)
        .and_then(|params| params.get("floorY").or_else(|| params.get("toY")))
        .and_then(Value::as_f64)
        .or_else(|| animation.get("floorY").and_then(Value::as_f64))
        .or_else(|| animation.get("toY").and_then(Value::as_f64))?;
    if !nearly_equal(raw_from_y, source_entity_y)
        || nearly_equal(raw_floor_y, 0.0)
        || nearly_equal(raw_floor_y, source_entity_y)
    {
        return None;
    }
    Some((raw_floor_y, raw_from_y - raw_floor_y, 0.0))
}

fn normalized_entity_rest_y(entity: &Value) -> Option<f64> {
    let source_entity_y = entity_axis_value(entity, "y");
    let animations = entity.get("animations").and_then(Value::as_array)?;
    animations
        .iter()
        .find_map(|animation| detect_absolute_fall_bounce_correction(source_entity_y, animation))
        .map(|(rest_y, _, _)| rest_y)
}

fn normalize_entity_animations(
    entity: &Value,
    duration_in_frames: i64,
    normalized_entity_y: Option<f64>,
) -> Vec<Value> {
    let source_entity_y = entity_axis_value(entity, "y");
    let entity_y = normalized_entity_y.or(source_entity_y);
    entity
        .get("animations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|animation| {
            let kind = normalize_entity_animation_kind(animation.get("kind").and_then(Value::as_str));
            let mut params = animation.get("params").cloned().unwrap_or_else(|| json!({}));
            if !params.is_object() {
                params = json!({});
            }
            if let Some(object) = params.as_object_mut() {
                if object.get("fromX").is_none() {
                    if let Some(value) = animation.get("fromX").cloned() {
                        object.insert("fromX".to_string(), value);
                    }
                }
                if object.get("fromScale").is_none() {
                    if let Some(value) = animation.get("fromScale").cloned() {
                        object.insert("fromScale".to_string(), value);
                    }
                }
                if object.get("amplitude").is_none() {
                    if let Some(value) = animation.get("amplitude").cloned() {
                        object.insert("amplitude".to_string(), value);
                    }
                }
                if object.get("decay").is_none() {
                    if let Some(value) = animation.get("decay").cloned() {
                        object.insert("decay".to_string(), value);
                    }
                }
                if object.get("bounces").is_none() {
                    if let Some(value) = animation
                        .get("bounces")
                        .cloned()
                        .or_else(|| animation.get("bounceCount").cloned())
                    {
                        object.insert("bounces".to_string(), value);
                    }
                }
                if kind == "slide-up" || kind == "slide-down" {
                    if object.get("fromY").is_none() {
                        if let Some(value) = animation.get("fromY").cloned() {
                            object.insert("fromY".to_string(), value);
                        }
                    }
                }
                if kind == "fall-bounce" {
                    if let Some((_, corrected_from_y, corrected_floor_y)) =
                        detect_absolute_fall_bounce_correction(source_entity_y, &animation)
                    {
                        object.insert("fromY".to_string(), json!(corrected_from_y));
                        object.insert("floorY".to_string(), json!(corrected_floor_y));
                    } else {
                        let absolute_from_y = animation
                            .get("fromY")
                            .and_then(Value::as_f64)
                            .or_else(|| object.get("fromY").and_then(Value::as_f64));
                        let absolute_to_y = animation
                            .get("toY")
                            .and_then(Value::as_f64)
                            .or_else(|| animation.get("floorY").and_then(Value::as_f64))
                            .or_else(|| object.get("toY").and_then(Value::as_f64))
                            .or_else(|| object.get("floorY").and_then(Value::as_f64));
                        let relative_from_y = match (absolute_from_y, entity_y) {
                            (Some(from_y), Some(entity_y)) => Some(from_y - entity_y),
                            (Some(from_y), None) => Some(from_y),
                            _ => None,
                        };
                        let relative_floor_y = match (absolute_to_y, entity_y) {
                            (Some(to_y), Some(entity_y)) => Some(to_y - entity_y),
                            (Some(to_y), None) => Some(to_y),
                            _ => None,
                        };
                        if object.get("fromY").is_none() {
                            if let Some(value) = relative_from_y {
                                object.insert("fromY".to_string(), json!(value));
                            }
                        }
                        if object.get("floorY").is_none() {
                            if let Some(value) = relative_floor_y {
                                object.insert("floorY".to_string(), json!(value));
                            }
                        }
                    }
                }
            }
            let from_frame = animation
                .get("fromFrame")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let requested_duration = animation
                .get("durationInFrames")
                .and_then(Value::as_i64)
                .or_else(|| animation.get("frames").and_then(Value::as_i64))
                .or_else(|| animation.get("durationFrames").and_then(Value::as_i64))
                .unwrap_or(duration_in_frames.max(12));
            let (safe_from_frame, safe_duration) =
                clamp_start_and_duration(from_frame, requested_duration, duration_in_frames);
            json!({
                "id": animation.get("id").cloned().unwrap_or_else(|| json!(make_id("entity-animation"))),
                "kind": kind,
                "fromFrame": safe_from_frame,
                "durationInFrames": safe_duration,
                "params": params
            })
        })
        .collect()
}

fn normalize_transition_presentation(value: Option<&str>) -> &'static str {
    match value.unwrap_or("").trim() {
        "fade" | "dissolve" => "fade",
        "wipe" => "wipe",
        "slide" => "slide",
        "flip" => "flip",
        "clockWipe" => "clockWipe",
        "iris" => "iris",
        _ => "fade",
    }
}

fn normalize_transition_timing(value: Option<&str>) -> &'static str {
    match value.unwrap_or("").trim() {
        "linear" => "linear",
        "spring" => "spring",
        "ease-in" => "ease-in",
        "ease-out" => "ease-out",
        "ease-in-out" => "ease-in-out",
        "cubic-bezier" => "cubic-bezier",
        _ => "linear",
    }
}

fn normalize_transition_direction(value: Option<&str>) -> Value {
    match value.unwrap_or("").trim() {
        "from-left" => json!("from-left"),
        "from-right" => json!("from-right"),
        "from-top" => json!("from-top"),
        "from-bottom" => json!("from-bottom"),
        _ => Value::Null,
    }
}

fn normalize_remotion_transitions(candidate: &Value, fallback: &Value) -> Vec<Value> {
    candidate
        .get("transitions")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| fallback.get("transitions").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|transition| {
            let left_clip_id = transition
                .get("leftClipId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let right_clip_id = transition
                .get("rightClipId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if left_clip_id.is_empty() || right_clip_id.is_empty() {
                return None;
            }
            let duration_in_frames = transition
                .get("durationInFrames")
                .and_then(Value::as_i64)
                .unwrap_or(30)
                .max(1);
            Some(json!({
                "id": transition.get("id").cloned().unwrap_or_else(|| json!(make_id("transition"))),
                "type": transition.get("type").cloned().unwrap_or_else(|| json!("crossfade")),
                "presentation": normalize_transition_presentation(transition.get("presentation").and_then(Value::as_str)),
                "timing": normalize_transition_timing(transition.get("timing").and_then(Value::as_str)),
                "leftClipId": left_clip_id,
                "rightClipId": right_clip_id,
                "trackId": transition.get("trackId").cloned().unwrap_or(Value::Null),
                "durationInFrames": duration_in_frames,
                "direction": normalize_transition_direction(transition.get("direction").and_then(Value::as_str)),
                "alignment": transition.get("alignment").cloned().unwrap_or(Value::Null),
                "bezierPoints": transition.get("bezierPoints").cloned().unwrap_or(Value::Null),
                "presetId": transition.get("presetId").cloned().unwrap_or(Value::Null),
                "properties": transition.get("properties").cloned().unwrap_or_else(|| json!({}))
            }))
        })
        .collect()
}

pub(crate) fn normalize_ai_remotion_scene(
    candidate: &Value,
    fallback: &Value,
    clips: &[Value],
    title: &str,
) -> Value {
    let fallback_scenes = fallback
        .get("scenes")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let source_scenes = candidate
        .get("scenes")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    if source_scenes.is_empty() {
        return fallback.clone();
    }

    let fps = candidate
        .get("fps")
        .and_then(|value| value.as_i64())
        .filter(|value| *value > 0)
        .unwrap_or_else(|| {
            fallback
                .get("fps")
                .and_then(|value| value.as_i64())
                .unwrap_or(30)
        });
    let width = candidate
        .get("width")
        .and_then(|value| value.as_i64())
        .filter(|value| *value >= 320)
        .unwrap_or_else(|| {
            fallback
                .get("width")
                .and_then(|value| value.as_i64())
                .unwrap_or(1080)
        });
    let height = candidate
        .get("height")
        .and_then(|value| value.as_i64())
        .filter(|value| *value >= 320)
        .unwrap_or_else(|| {
            fallback
                .get("height")
                .and_then(|value| value.as_i64())
                .unwrap_or(1920)
        });
    let background_color = candidate
        .get("backgroundColor")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("#05070b");
    let fallback_base_media = fallback
        .get("baseMedia")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let candidate_base_media = candidate
        .get("baseMedia")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let base_media_reference_width = candidate_base_media
        .get("width")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .or_else(|| {
            fallback_base_media
                .get("width")
                .and_then(Value::as_i64)
                .filter(|value| *value > 0)
        })
        .unwrap_or(width);
    let base_media_reference_height = candidate_base_media
        .get("height")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .or_else(|| {
            fallback_base_media
                .get("height")
                .and_then(Value::as_i64)
                .filter(|value| *value > 0)
        })
        .unwrap_or(height);

    let mut normalized_scenes = Vec::new();
    let mut current_frame = 0_i64;
    for (index, raw_scene) in source_scenes.iter().enumerate() {
        let candidate_clip_id = raw_scene.get("clipId").and_then(|value| value.as_str());
        let fallback_scene = fallback_scenes.get(index).cloned().unwrap_or_else(|| {
            let clip = candidate_clip_id
                .and_then(|clip_id| {
                    clips.iter().find(|item| {
                        item.get("clipId")
                            .and_then(Value::as_str)
                            .map(|value| value == clip_id)
                            .unwrap_or(false)
                    })
                })
                .cloned()
                .or_else(|| clips.get(index).cloned())
                .unwrap_or_else(|| json!({}));
            let standalone = candidate_clip_id.is_none()
                && raw_scene.get("assetId").and_then(Value::as_str).is_none();
            json!({
                "id": format!("scene-{}", index + 1),
                "clipId": if standalone { Value::Null } else { clip.get("clipId").cloned().unwrap_or(Value::Null) },
                "assetId": if standalone { Value::Null } else { clip.get("assetId").cloned().unwrap_or(Value::Null) },
                "assetKind": if standalone { json!("unknown") } else { clip.get("assetKind").cloned().unwrap_or(json!("unknown")) },
                "src": if standalone { json!("") } else { clip.get("mediaPath").cloned().unwrap_or(json!("")) },
                "startFrame": raw_scene.get("startFrame").cloned().unwrap_or(json!(current_frame)),
                "durationInFrames": if standalone { json!(90) } else { json!(remotion_scene_duration_frames(&clip, fps)) },
                "trimInFrames": 0,
                "motionPreset": fallback_motion_preset(index, clip.get("assetKind").and_then(|value| value.as_str()).unwrap_or("unknown")),
                "overlayTitle": raw_scene.get("overlayTitle").cloned().unwrap_or_else(|| clip.get("name").cloned().unwrap_or(json!(format!("场景 {}", index + 1)))),
                "overlayBody": Value::Null,
                "overlays": []
            })
        });
        let default_duration = fallback_scene
            .get("durationInFrames")
            .and_then(|value| value.as_i64())
            .unwrap_or(90);
        let duration_in_frames = raw_scene
            .get("durationInFrames")
            .and_then(|value| value.as_i64())
            .filter(|value| *value > 0)
            .unwrap_or(default_duration)
            .max(12);
        let start_frame = raw_scene
            .get("startFrame")
            .and_then(|value| value.as_i64())
            .unwrap_or(current_frame)
            .max(0);
        let asset_kind = fallback_scene
            .get("assetKind")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        let mut overlays = raw_scene
            .get("overlays")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        overlays.retain(|item| {
            item.get("text")
                .or_else(|| item.get("content"))
                .and_then(|value| value.as_str())
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
        });
        let normalized_overlays = overlays
            .into_iter()
            .map(|item| {
                let style = item.get("style").cloned().unwrap_or_else(|| json!({}));
                let requested_start = item.get("startFrame").and_then(Value::as_i64).unwrap_or(0);
                let requested_duration = item
                    .get("durationInFrames")
                    .and_then(Value::as_i64)
                    .unwrap_or(duration_in_frames);
                let (safe_start, safe_duration) =
                    clamp_start_and_duration(requested_start, requested_duration, duration_in_frames);
                json!({
                    "id": item.get("id").cloned().unwrap_or_else(|| json!(make_id("overlay"))),
                    "text": item.get("text").cloned().or_else(|| item.get("content").cloned()).unwrap_or_else(|| json!("")),
                    "startFrame": safe_start,
                    "durationInFrames": safe_duration,
                    "position": item.get("position").cloned().unwrap_or_else(|| json!("center")),
                    "animation": json!(normalize_overlay_animation(item.get("animation").and_then(Value::as_str))),
                    "fontSize": item.get("fontSize").cloned().or_else(|| style.get("fontSize").cloned()).unwrap_or_else(|| json!(42)),
                    "color": item.get("color").cloned().or_else(|| style.get("color").cloned()).unwrap_or_else(|| json!("#ffffff")),
                    "backgroundColor": item.get("backgroundColor").cloned().or_else(|| style.get("backgroundColor").cloned()).unwrap_or(Value::Null),
                    "align": item.get("align").cloned().or_else(|| style.get("align").cloned()).unwrap_or_else(|| json!("center"))
                })
            })
            .collect::<Vec<_>>();
        let entities = raw_scene
            .get("entities")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|entity| {
                let style = entity.get("style").cloned().unwrap_or_else(|| json!({}));
                let requested_start = entity
                    .get("startFrame")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let requested_duration = entity
                    .get("durationInFrames")
                    .and_then(Value::as_i64)
                    .unwrap_or(duration_in_frames);
                let (entity_start_frame, entity_duration_in_frames) =
                    clamp_start_and_duration(requested_start, requested_duration, duration_in_frames);
                let position_mode = normalize_entity_position_mode(
                    entity
                        .get("positionMode")
                        .or_else(|| style.get("positionMode"))
                        .and_then(Value::as_str),
                );
                let normalized_entity_y = normalized_entity_rest_y(&entity);
                json!({
                    "id": entity.get("id").cloned().unwrap_or_else(|| json!(make_id("entity"))),
                    "type": entity.get("type").cloned().unwrap_or_else(|| json!("text")),
                    "positionMode": position_mode,
                    "referenceWidth": entity.get("referenceWidth")
                        .cloned()
                        .or_else(|| style.get("referenceWidth").cloned())
                        .unwrap_or_else(|| {
                            if position_mode == "video-space" {
                                json!(base_media_reference_width)
                            } else {
                                json!(width)
                            }
                        }),
                    "referenceHeight": entity.get("referenceHeight")
                        .cloned()
                        .or_else(|| style.get("referenceHeight").cloned())
                        .unwrap_or_else(|| {
                            if position_mode == "video-space" {
                                json!(base_media_reference_height)
                            } else {
                                json!(height)
                            }
                        }),
                    "startFrame": entity_start_frame,
                    "durationInFrames": entity_duration_in_frames,
                    "x": entity.get("x").cloned().or_else(|| style.get("x").cloned()).unwrap_or_else(|| json!(0)),
                    "y": normalized_entity_y
                        .map(|value| json!(value))
                        .unwrap_or_else(|| entity.get("y").cloned().or_else(|| style.get("y").cloned()).unwrap_or_else(|| json!(0))),
                    "width": entity.get("width").cloned().or_else(|| style.get("width").cloned()).unwrap_or_else(|| json!(320)),
                    "height": entity.get("height").cloned().or_else(|| style.get("height").cloned()).unwrap_or_else(|| json!(180)),
                    "rotation": entity.get("rotation").cloned().or_else(|| style.get("rotation").cloned()).unwrap_or_else(|| json!(0)),
                    "scale": entity.get("scale").cloned().or_else(|| style.get("scale").cloned()).unwrap_or_else(|| json!(1)),
                    "opacity": entity.get("opacity").cloned().or_else(|| style.get("opacity").cloned()).unwrap_or_else(|| json!(1)),
                    "visible": entity.get("visible").cloned().unwrap_or_else(|| json!(true)),
                    "text": entity.get("text").cloned().or_else(|| entity.get("content").cloned()).unwrap_or(Value::Null),
                    "fontSize": entity.get("fontSize").cloned().or_else(|| style.get("fontSize").cloned()).unwrap_or(Value::Null),
                    "fontWeight": entity.get("fontWeight").cloned().or_else(|| style.get("fontWeight").cloned()).unwrap_or(Value::Null),
                    "color": entity.get("color").cloned().or_else(|| style.get("color").cloned()).unwrap_or(Value::Null),
                    "align": entity.get("align").cloned().or_else(|| style.get("align").cloned()).unwrap_or(Value::Null),
                    "lineHeight": entity.get("lineHeight").cloned().or_else(|| style.get("lineHeight").cloned()).unwrap_or(Value::Null),
                    "fill": entity.get("fill").cloned().or_else(|| style.get("fill").cloned()).unwrap_or(Value::Null),
                    "stroke": entity.get("stroke").cloned().or_else(|| style.get("stroke").cloned()).unwrap_or(Value::Null),
                    "strokeWidth": entity.get("strokeWidth").cloned().or_else(|| style.get("strokeWidth").cloned()).unwrap_or(Value::Null),
                    "radius": entity.get("radius").cloned().or_else(|| style.get("radius").cloned()).unwrap_or(Value::Null),
                    "shape": entity.get("shape").cloned().unwrap_or_else(|| json!("rect")),
                    "src": entity.get("src").cloned().unwrap_or(Value::Null),
                    "svgMarkup": entity.get("svgMarkup").cloned().or_else(|| entity.get("svg").cloned()).unwrap_or(Value::Null),
                    "borderRadius": entity.get("borderRadius").cloned().or_else(|| style.get("borderRadius").cloned()).unwrap_or(Value::Null),
                    "animations": normalize_entity_animations(&entity, entity_duration_in_frames, normalized_entity_y),
                    "children": entity.get("children").cloned().unwrap_or_else(|| json!([]))
                })
            })
            .collect::<Vec<_>>();
        let normalized_clip_id = normalized_optional_id(
            raw_scene
                .get("clipId")
                .or_else(|| fallback_scene.get("clipId")),
        );
        let normalized_asset_id = normalized_optional_id(
            raw_scene
                .get("assetId")
                .or_else(|| fallback_scene.get("assetId")),
        );
        let has_scene_binding = !normalized_clip_id.is_null() || !normalized_asset_id.is_null();
        normalized_scenes.push(json!({
            "id": raw_scene.get("id").cloned().unwrap_or_else(|| fallback_scene.get("id").cloned().unwrap_or(json!(format!("scene-{}", index + 1)))),
            "clipId": normalized_clip_id,
            "assetId": normalized_asset_id,
            "assetKind": if has_scene_binding { json!(asset_kind) } else { json!("unknown") },
            "src": if has_scene_binding {
                raw_scene.get("src").cloned().or_else(|| fallback_scene.get("src").cloned()).unwrap_or(json!(""))
            } else {
                json!("")
            },
            "startFrame": start_frame,
            "durationInFrames": duration_in_frames,
            "trimInFrames": raw_scene.get("trimInFrames").cloned().or_else(|| fallback_scene.get("trimInFrames").cloned()).unwrap_or(json!(0)),
            "motionPreset": normalize_motion_preset(raw_scene.get("motionPreset").and_then(|value| value.as_str()), fallback_scene.get("motionPreset").and_then(|value| value.as_str()).unwrap_or("static")),
            "overlayTitle": raw_scene.get("overlayTitle").cloned().or_else(|| fallback_scene.get("overlayTitle").cloned()).unwrap_or(Value::Null),
            "overlayBody": raw_scene.get("overlayBody").cloned().or_else(|| fallback_scene.get("overlayBody").cloned()).unwrap_or(Value::Null),
            "overlays": normalized_overlays,
            "entities": entities
        }));
        current_frame = (start_frame + duration_in_frames).max(current_frame + duration_in_frames);
    }

    let normalized_title = candidate
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or(title)
        .to_string();
    let normalized_render_mode = candidate
        .get("renderMode")
        .and_then(Value::as_str)
        .or_else(|| fallback.get("renderMode").and_then(Value::as_str))
        .filter(|value| *value == "full" || *value == "motion-layer")
        .unwrap_or("motion-layer")
        .to_string();

    let normalized_base_media = json!({
        "sourceAssetIds": candidate_base_media
            .get("sourceAssetIds")
            .cloned()
            .or_else(|| fallback_base_media.get("sourceAssetIds").cloned())
            .unwrap_or_else(|| json!([])),
        "outputPath": candidate_base_media
            .get("outputPath")
            .cloned()
            .or_else(|| fallback_base_media.get("outputPath").cloned())
            .unwrap_or(Value::Null),
        "durationMs": candidate_base_media
            .get("durationMs")
            .cloned()
            .or_else(|| fallback_base_media.get("durationMs").cloned())
            .unwrap_or_else(|| json!(((current_frame.max(1) as f64 / fps as f64) * 1000.0).round() as i64)),
        "width": candidate_base_media
            .get("width")
            .cloned()
            .or_else(|| fallback_base_media.get("width").cloned())
            .unwrap_or_else(|| json!(base_media_reference_width)),
        "height": candidate_base_media
            .get("height")
            .cloned()
            .or_else(|| fallback_base_media.get("height").cloned())
            .unwrap_or_else(|| json!(base_media_reference_height)),
        "status": candidate_base_media
            .get("status")
            .cloned()
            .or_else(|| fallback_base_media.get("status").cloned())
            .unwrap_or_else(|| json!("ready")),
        "updatedAt": candidate_base_media
            .get("updatedAt")
            .cloned()
            .or_else(|| fallback_base_media.get("updatedAt").cloned())
            .unwrap_or(Value::Null)
    });

    json!({
        "version": 2,
        "title": normalized_title,
        "entryCompositionId": candidate
            .get("entryCompositionId")
            .cloned()
            .or_else(|| fallback.get("entryCompositionId").cloned())
            .unwrap_or_else(|| json!("RedBoxVideoMotion")),
        "width": width,
        "height": height,
        "fps": fps,
        "durationInFrames": current_frame.max(1),
        "backgroundColor": background_color,
        "renderMode": normalized_render_mode,
        "baseMedia": normalized_base_media,
        "ffmpegRecipe": candidate
            .get("ffmpegRecipe")
            .cloned()
            .or_else(|| fallback.get("ffmpegRecipe").cloned())
            .unwrap_or_else(|| json!({
                "operations": [],
                "artifacts": [],
                "summary": Value::Null
            })),
        "scenes": normalized_scenes,
        "transitions": normalize_remotion_transitions(candidate, fallback),
        "sceneItemTransforms": candidate
            .get("sceneItemTransforms")
            .cloned()
            .or_else(|| fallback.get("sceneItemTransforms").cloned())
            .unwrap_or_else(|| json!({})),
        "render": normalized_remotion_render_config(
            candidate.get("render").or_else(|| fallback.get("render")),
            &normalized_title,
            &normalized_render_mode,
        )
    })
}

const REMOTION_PROGRESS_PREFIX: &str = "__REMOTION_PROGRESS__";

fn emit_remotion_render_progress(
    app: &AppHandle,
    file_path: &str,
    status: &str,
    percent: i64,
    stage: &str,
    output_path: Option<&Path>,
    error: Option<&str>,
) {
    let _ = app.emit(
        "manuscripts:render-progress",
        json!({
            "filePath": file_path,
            "status": status,
            "percent": percent.clamp(0, 100),
            "stage": stage,
            "outputPath": output_path.map(|path| path.display().to_string()),
            "error": error,
        }),
    );
}

pub(crate) fn render_remotion_video(
    config: &Value,
    output_path: &Path,
    scale: Option<f64>,
    app: Option<&AppHandle>,
    file_path: Option<&str>,
) -> Result<Value, String> {
    let project_root = redbox_project_root();
    let script_path = project_root.join("remotion").join("render.mjs");
    if !script_path.exists() {
        return Err(format!(
            "Remotion render script not found: {}",
            script_path.display()
        ));
    }
    let temp_config_path = std::env::temp_dir().join(format!("redbox-remotion-{}.json", now_ms()));
    write_json_value(&temp_config_path, config)?;
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if let (Some(app), Some(file_path)) = (app, file_path) {
        emit_remotion_render_progress(
            app,
            file_path,
            "running",
            0,
            "准备导出",
            Some(output_path),
            None,
        );
    }
    let mut command = std::process::Command::new("node");
    command
        .arg(&script_path)
        .arg(&temp_config_path)
        .arg(output_path);
    if let Some(scale) = scale.filter(|value| value.is_finite() && *value > 0.0) {
        command.arg(format!("{scale:.6}"));
    }
    let mut child = command
        .current_dir(&project_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Remotion renderer stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Remotion renderer stderr unavailable".to_string())?;
    let stdout_reader = thread::spawn(move || -> Result<String, String> {
        let mut content = String::new();
        BufReader::new(stdout)
            .read_to_string(&mut content)
            .map_err(|error| error.to_string())?;
        Ok(content)
    });
    let progress_app = app.cloned();
    let progress_file_path = file_path.map(ToString::to_string);
    let output_path_string = output_path.display().to_string();
    let stderr_reader = thread::spawn(move || -> Result<String, String> {
        let mut non_progress = Vec::new();
        for line in BufReader::new(stderr).lines() {
            let line = line.map_err(|error| error.to_string())?;
            if let Some(raw_payload) = line.strip_prefix(REMOTION_PROGRESS_PREFIX) {
                if let (Some(app), Some(file_path)) =
                    (progress_app.as_ref(), progress_file_path.as_deref())
                {
                    if let Ok(payload) = serde_json::from_str::<Value>(raw_payload) {
                        emit_remotion_render_progress(
                            app,
                            file_path,
                            "running",
                            payload.get("percent").and_then(Value::as_i64).unwrap_or(0),
                            payload
                                .get("stitchStage")
                                .and_then(Value::as_str)
                                .unwrap_or("处理中"),
                            Some(Path::new(&output_path_string)),
                            None,
                        );
                    }
                }
            } else if !line.trim().is_empty() {
                non_progress.push(line);
            }
        }
        Ok(non_progress.join("\n"))
    });
    let status = child.wait().map_err(|error| error.to_string())?;
    let stdout = stdout_reader
        .join()
        .map_err(|_| "Failed to read Remotion renderer stdout".to_string())??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "Failed to read Remotion renderer stderr".to_string())??;
    let _ = fs::remove_file(&temp_config_path);
    if !status.success() {
        if let (Some(app), Some(file_path)) = (app, file_path) {
            emit_remotion_render_progress(
                app,
                file_path,
                "error",
                0,
                "导出失败",
                Some(output_path),
                Some(&stderr),
            );
        }
        return Err(if stderr.is_empty() {
            format!("Remotion render failed with status {}", status)
        } else {
            stderr
        });
    }
    if let (Some(app), Some(file_path)) = (app, file_path) {
        emit_remotion_render_progress(
            app,
            file_path,
            "done",
            100,
            "导出完成",
            Some(output_path),
            None,
        );
    }
    let stdout = stdout.trim().to_string();
    if stdout.is_empty() {
        return Ok(json!({
            "success": true,
            "outputLocation": output_path.display().to_string()
        }));
    }
    parse_json_value_from_text(&stdout)
        .ok_or_else(|| "Remotion renderer returned invalid JSON".to_string())
}

pub(crate) fn create_empty_otio_timeline(title: &str) -> Value {
    json!({
        "OTIO_SCHEMA": "Timeline.1",
        "name": title,
        "global_start_time": Value::Null,
        "tracks": {
            "OTIO_SCHEMA": "Stack.1",
            "children": [
                { "OTIO_SCHEMA": "Track.1", "name": "V1", "kind": "Video", "children": [] },
                { "OTIO_SCHEMA": "Track.1", "name": "A1", "kind": "Audio", "children": [] }
            ]
        },
        "metadata": {
            "owner": "redbox",
            "engine": "ai-editing",
            "version": 1
        }
    })
}

pub(crate) fn create_timeline_clip_id() -> String {
    format!("clip_{}", make_id("pkg"))
}

pub(crate) fn ensure_timeline_track<'a>(
    timeline: &'a mut Value,
    track_name: &str,
    kind: &str,
) -> &'a mut Value {
    let tracks = timeline
        .get_mut("tracks")
        .and_then(|value| value.get_mut("children"))
        .and_then(Value::as_array_mut)
        .expect("timeline tracks should be an array");
    if let Some(index) = tracks.iter().position(|track| {
        track
            .get("name")
            .and_then(|value| value.as_str())
            .map(|value| value == track_name)
            .unwrap_or(false)
    }) {
        return &mut tracks[index];
    }
    tracks.push(json!({
        "OTIO_SCHEMA": "Track.1",
        "name": track_name,
        "kind": kind,
        "children": []
    }));
    let last_index = tracks.len() - 1;
    &mut tracks[last_index]
}

pub(crate) fn timeline_clip_identity(
    clip: &Value,
    fallback_track_name: &str,
    fallback_index: usize,
) -> String {
    let metadata = clip.get("metadata").cloned().unwrap_or_else(|| json!({}));
    if let Some(explicit) = metadata.get("clipId").and_then(|value| value.as_str()) {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let asset_id = metadata
        .get("assetId")
        .and_then(|value| value.as_str())
        .or_else(|| {
            clip.pointer("/media_references/DEFAULT_MEDIA/metadata/assetId")
                .and_then(|value| value.as_str())
        })
        .unwrap_or("");
    let name = clip
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    format!(
        "{fallback_track_name}:{}:{fallback_index}",
        if !asset_id.is_empty() {
            asset_id
        } else if !name.is_empty() {
            name
        } else {
            "clip"
        }
    )
}

pub(crate) fn normalize_package_timeline(timeline: &mut Value) {
    let Some(tracks) = timeline
        .get_mut("tracks")
        .and_then(|value| value.get_mut("children"))
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    let mut source_refs = Vec::<Value>::new();
    for track in tracks.iter_mut() {
        let track_name = track
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let Some(children) = track.get_mut("children").and_then(Value::as_array_mut) else {
            continue;
        };
        for (index, clip) in children.iter_mut().enumerate() {
            let metadata = clip.get("metadata").cloned().unwrap_or_else(|| json!({}));
            let asset_id = metadata
                .get("assetId")
                .and_then(|value| value.as_str())
                .or_else(|| {
                    clip.pointer("/media_references/DEFAULT_MEDIA/metadata/assetId")
                        .and_then(|value| value.as_str())
                })
                .unwrap_or("")
                .to_string();
            let media_path = clip
                .pointer("/media_references/DEFAULT_MEDIA/target_url")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            let mime_type = clip
                .pointer("/media_references/DEFAULT_MEDIA/metadata/mimeType")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            if !asset_id.is_empty() {
                source_refs.push(json!({
                    "assetId": asset_id,
                    "mediaPath": media_path,
                    "mimeType": mime_type,
                    "track": track_name,
                    "order": index,
                    "assetKind": metadata.get("assetKind").cloned().unwrap_or(Value::Null),
                    "addedAt": metadata.get("addedAt").cloned().unwrap_or(json!(now_iso()))
                }));
            }
            let clip_id = timeline_clip_identity(clip, &track_name, index);
            let mut next_metadata = metadata.as_object().cloned().unwrap_or_default();
            next_metadata.insert("clipId".to_string(), json!(clip_id));
            next_metadata.insert("order".to_string(), json!(index));
            next_metadata
                .entry("durationMs".to_string())
                .or_insert(Value::Null);
            next_metadata
                .entry("trimInMs".to_string())
                .or_insert(json!(0));
            next_metadata
                .entry("trimOutMs".to_string())
                .or_insert(json!(0));
            next_metadata
                .entry("enabled".to_string())
                .or_insert(json!(true));
            if let Some(object) = clip.as_object_mut() {
                object.insert("metadata".to_string(), Value::Object(next_metadata));
            }
        }
    }
    if let Some(metadata) = timeline.get_mut("metadata").and_then(Value::as_object_mut) {
        metadata.insert("sourceRefs".to_string(), Value::Array(source_refs));
    }
}

pub(crate) fn build_timeline_clip_summaries(
    timeline: &Value,
) -> (Vec<Value>, Vec<Value>, Vec<Value>) {
    let tracks = timeline
        .pointer("/tracks/children")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let source_refs = timeline
        .pointer("/metadata/sourceRefs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut clips = Vec::new();
    for track in &tracks {
        let track_name = track
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let track_kind = track
            .get("kind")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let children = track
            .get("children")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut cursor_ms = 0_i64;
        for (index, clip) in children.iter().enumerate() {
            let metadata = clip.get("metadata").cloned().unwrap_or_else(|| json!({}));
            let asset_id = metadata
                .get("assetId")
                .and_then(|value| value.as_str())
                .or_else(|| {
                    clip.pointer("/media_references/DEFAULT_MEDIA/metadata/assetId")
                        .and_then(|value| value.as_str())
                })
                .unwrap_or("");
            let duration_ms = timeline_clip_duration_ms(clip);
            let start_ms = cursor_ms;
            let end_ms = cursor_ms + duration_ms;
            clips.push(json!({
                "clipId": timeline_clip_identity(clip, track_name, index),
                "assetId": asset_id,
                "name": clip.get("name").and_then(|value| value.as_str()).unwrap_or(asset_id),
                "track": track_name,
                "trackKind": track_kind,
                "order": metadata.get("order").cloned().unwrap_or(json!(index)),
                "durationMs": metadata.get("durationMs").cloned().unwrap_or(json!(duration_ms)),
                "trimInMs": metadata.get("trimInMs").cloned().unwrap_or(json!(0)),
                "trimOutMs": metadata.get("trimOutMs").cloned().unwrap_or(json!(0)),
                "enabled": metadata.get("enabled").cloned().unwrap_or(json!(true)),
                "assetKind": metadata.get("assetKind").cloned().unwrap_or(Value::Null),
                "subtitleStyle": metadata.get("subtitleStyle").cloned().unwrap_or_else(|| json!({})),
                "textStyle": metadata.get("textStyle").cloned().unwrap_or_else(|| json!({})),
                "transitionStyle": metadata.get("transitionStyle").cloned().unwrap_or_else(|| json!({})),
                "startMs": start_ms,
                "endMs": end_ms,
                "startSeconds": start_ms as f64 / 1000.0,
                "endSeconds": end_ms as f64 / 1000.0,
                "mediaPath": clip.pointer("/media_references/DEFAULT_MEDIA/target_url").cloned().unwrap_or(Value::Null),
                "mimeType": clip.pointer("/media_references/DEFAULT_MEDIA/metadata/mimeType").cloned().unwrap_or(Value::Null)
            }));
            cursor_ms = end_ms;
        }
    }
    (tracks, source_refs, clips)
}

pub(crate) fn get_manuscript_package_state(package_path: &Path) -> Result<Value, String> {
    let file_name = package_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let manifest = read_json_value_or(package_manifest_path(package_path).as_path(), json!({}));
    let assets = read_json_value_or(
        package_assets_path(package_path).as_path(),
        json!({ "items": [] }),
    );
    let cover = read_json_value_or(
        package_cover_path(package_path).as_path(),
        json!({ "assetId": Value::Null }),
    );
    let images = read_json_value_or(
        package_images_path(package_path).as_path(),
        json!({ "items": [] }),
    );
    let fallback_title = title_from_relative_path(file_name);
    let title = manifest
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or(fallback_title.as_str())
        .to_string();
    let package_kind = get_package_kind_from_file_name(file_name);
    let content_map_path = package_content_map_path(package_path);
    let content_map_exists = content_map_path.exists();
    let layout_template_path = package_layout_template_path(package_path);
    let layout_template_exists = layout_template_path.exists();
    let wechat_template_path = package_wechat_template_path(package_path);
    let wechat_template_exists = wechat_template_path.exists();
    let layout_html_path = package_layout_html_path(package_path);
    let layout_html_exists = layout_html_path.exists();
    let layout_html_has_content = fs::metadata(&layout_html_path)
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false);
    let wechat_html_path = package_wechat_html_path(package_path);
    let wechat_html_exists = wechat_html_path.exists();
    let wechat_html_has_content = fs::metadata(&wechat_html_path)
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false);
    let editor_project = if package_kind == Some("video") {
        read_existing_editor_project(package_path)
    } else if package_kind == Some("audio") {
        Some(ensure_editor_project(package_path)?)
    } else {
        None
    };
    let timeline_summary = if let Some(project) = editor_project.as_ref() {
        build_timeline_summary_from_editor_project(project)
    } else if package_timeline_path(package_path).exists() {
        let timeline = read_json_value_or(
            package_timeline_path(package_path).as_path(),
            create_empty_otio_timeline(file_name),
        );
        let (tracks, source_refs, clips) = build_timeline_clip_summaries(&timeline);
        let track_ui = read_json_value_or(package_track_ui_path(package_path).as_path(), json!({}));
        json!({
            "trackCount": tracks.len(),
            "clipCount": clips.len(),
            "sourceRefs": source_refs,
            "clips": clips,
            "trackNames": tracks.iter().filter_map(|track| track.get("name").and_then(|value| value.as_str()).map(ToString::to_string)).collect::<Vec<_>>(),
            "trackUi": track_ui
        })
    } else {
        json!({
            "trackCount": 0,
            "clipCount": 0,
            "sourceRefs": [],
            "clips": [],
            "trackNames": [],
            "trackUi": {}
        })
    };
    let remotion_fallback = if let Some(project) = editor_project.as_ref() {
        build_remotion_config_from_editor_project(project)
    } else {
        let clips = timeline_summary
            .get("clips")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        build_default_remotion_scene(&title, &clips)
    };
    let raw_remotion = read_json_value_or(
        package_remotion_path(package_path).as_path(),
        remotion_fallback,
    );
    let remotion = if package_kind == Some("video") {
        normalize_video_remotion_scene(
            &title,
            &manifest,
            &assets,
            &raw_remotion,
            editor_project.as_ref(),
            &timeline_summary,
        )
    } else {
        raw_remotion
    };
    let scene_ui = if let Some(project) = editor_project.as_ref() {
        project
            .get("stage")
            .cloned()
            .unwrap_or_else(editor_stage_default)
    } else {
        read_json_value_or(
            package_scene_ui_path(package_path).as_path(),
            json!({
                "itemLocks": {},
                "itemGroups": {},
                "focusedGroupId": Value::Null
            }),
        )
    };
    let video_project = if package_kind == Some("video") {
        get_video_project_state(
            package_path,
            file_name,
            &manifest,
            &assets,
            &remotion,
            editor_project.as_ref(),
            &timeline_summary,
        )
    } else {
        Value::Null
    };
    Ok(json!({
        "manifest": {
            "packageKind": get_package_kind_from_file_name(file_name),
            "draftType": get_draft_type_from_file_name(file_name),
            "title": manifest.get("title").cloned().unwrap_or(json!(title)),
            "entry": manifest.get("entry").cloned().unwrap_or(json!(get_default_package_entry(file_name))),
            "updatedAt": manifest.get("updatedAt").cloned().unwrap_or(json!(now_i64())),
            "videoEngine": manifest.get("videoEngine").cloned().unwrap_or(Value::Null),
            "videoAi": manifest.get("videoAi").cloned().unwrap_or(Value::Null)
        },
        "assets": assets,
        "cover": cover,
        "images": images,
        "remotion": remotion,
        "timelineSummary": timeline_summary,
        "editorProject": editor_project.unwrap_or(Value::Null),
        "videoProject": video_project,
        "sceneUi": scene_ui,
        "contentMapExists": content_map_exists,
        "contentMapFile": if content_map_exists {
            json!(content_map_path.display().to_string())
        } else {
            Value::Null
        },
        "contentMapUpdatedAt": file_modified_at_ms(&content_map_path),
        "layoutTemplateExists": layout_template_exists,
        "wechatTemplateExists": wechat_template_exists,
        "layoutTemplateFile": if layout_template_exists {
            json!(layout_template_path.display().to_string())
        } else {
            Value::Null
        },
        "wechatTemplateFile": if wechat_template_exists {
            json!(wechat_template_path.display().to_string())
        } else {
            Value::Null
        },
        "layoutTemplateUpdatedAt": file_modified_at_ms(&layout_template_path),
        "wechatTemplateUpdatedAt": file_modified_at_ms(&wechat_template_path),
        "hasLayoutHtml": layout_html_has_content,
        "hasWechatHtml": wechat_html_has_content,
        "layoutHtmlExists": layout_html_exists,
        "wechatHtmlExists": wechat_html_exists,
        "layoutHtmlFile": if layout_html_exists {
            json!(layout_html_path.display().to_string())
        } else {
            Value::Null
        },
        "wechatHtmlFile": if wechat_html_exists {
            json!(wechat_html_path.display().to_string())
        } else {
            Value::Null
        },
        "layoutHtmlFileUrl": if layout_html_exists {
            json!(file_url_for_path(&layout_html_path))
        } else {
            Value::Null
        },
        "wechatHtmlFileUrl": if wechat_html_exists {
            json!(file_url_for_path(&wechat_html_path))
        } else {
            Value::Null
        },
        "layoutHtmlUpdatedAt": file_modified_at_ms(&layout_html_path),
        "wechatHtmlUpdatedAt": file_modified_at_ms(&wechat_html_path),
        "layoutHtml": "",
        "wechatHtml": ""
    }))
}

pub(crate) fn create_manuscript_package(
    package_path: &Path,
    content: &str,
    file_name: &str,
    title: &str,
) -> Result<(), String> {
    let package_kind = get_package_kind_from_file_name(file_name).unwrap_or("article");
    let draft_type = get_draft_type_from_file_name(file_name);
    let entry = get_default_package_entry(file_name);
    fs::create_dir_all(package_path).map_err(|error| error.to_string())?;
    fs::create_dir_all(package_path.join("cache")).map_err(|error| error.to_string())?;
    fs::create_dir_all(package_path.join("exports")).map_err(|error| error.to_string())?;
    write_json_value(
        &package_manifest_path(package_path),
        &json!({
            "id": make_id("manuscript-package"),
            "type": "manuscript-package",
            "packageKind": package_kind,
            "draftType": draft_type,
            "title": title,
            "status": "writing",
            "version": 1,
            "createdAt": now_i64(),
            "updatedAt": now_i64(),
            "entry": entry,
            "timeline": if package_kind == "audio" { json!("timeline.otio.json") } else { Value::Null },
            "videoEngine": if package_kind == "video" { json!("ai-remotion") } else { Value::Null },
            "videoAi": if package_kind == "video" {
                json!({
                    "brief": Value::Null,
                    "lastBriefUpdateAt": Value::Null,
                    "lastBriefUpdateSource": Value::Null,
                    "scriptApproval": {
                        "status": "pending",
                        "lastScriptUpdateAt": now_i64(),
                        "lastScriptUpdateSource": "system",
                        "confirmedAt": Value::Null
                    }
                })
            } else {
                Value::Null
            }
        }),
    )?;
    write_text_file(
        &package_entry_path(package_path, file_name, Some(&json!({ "entry": entry }))),
        content,
    )?;
    if package_kind == "video" {
        let default_remotion = build_default_remotion_scene(title, &[]);
        write_json_value(&package_assets_path(package_path), &json!({ "items": [] }))?;
        persist_remotion_composition_artifacts(package_path, &default_remotion)?;
    } else if package_kind == "audio" {
        let default_remotion = build_default_remotion_scene(title, &[]);
        write_json_value(&package_assets_path(package_path), &json!({ "items": [] }))?;
        write_json_value(
            &package_timeline_path(package_path),
            &create_empty_otio_timeline(title),
        )?;
        persist_remotion_composition_artifacts(package_path, &default_remotion)?;
        write_json_value(&package_track_ui_path(package_path), &json!({}))?;
        write_json_value(
            &package_scene_ui_path(package_path),
            &json!({
                "itemLocks": {},
                "itemGroups": {},
                "focusedGroupId": Value::Null
            }),
        )?;
        write_json_value(
            &package_editor_project_path(package_path),
            &build_default_editor_project(title, content, 1080, 1080, 30),
        )?;
    } else if package_kind == "article" {
        write_json_value(
            &package_cover_path(package_path),
            &json!({ "assetId": Value::Null }),
        )?;
        write_json_value(&package_images_path(package_path), &json!({ "items": [] }))?;
        write_json_value(&package_assets_path(package_path), &json!({ "items": [] }))?;
        write_text_file(&package_layout_html_path(package_path), "")?;
        write_text_file(&package_wechat_html_path(package_path), "")?;
    } else if package_kind == "post" {
        write_json_value(&package_images_path(package_path), &json!({ "items": [] }))?;
        write_json_value(
            &package_cover_path(package_path),
            &json!({ "assetId": Value::Null }),
        )?;
        write_json_value(&package_assets_path(package_path), &json!({ "items": [] }))?;
        let _ = sync_manuscript_package_html_assets(
            None,
            package_path,
            file_name,
            Some(content),
            None,
        )?;
    }
    Ok(())
}

pub(crate) fn upgrade_markdown_manuscript_to_package(
    state: &State<'_, AppState>,
    source_path: &str,
    target_extension: &str,
) -> Result<String, String> {
    let source_relative = normalize_relative_path(source_path);
    if source_relative.is_empty() {
        return Err("sourcePath is required".to_string());
    }
    let source = resolve_manuscript_path(state, &source_relative)?;
    if !source.exists() || !source.is_file() {
        return Err("Source manuscript not found".to_string());
    }
    let file_name = Path::new(&source_relative)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid manuscript source".to_string())?;
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid manuscript source".to_string())?;
    let parent_rel = source_relative
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    let target_relative = normalize_relative_path(&join_relative(
        parent_rel,
        &format!("{stem}{target_extension}"),
    ));
    let target = resolve_manuscript_path(state, &target_relative)?;
    if target.exists() {
        return Err("Target package already exists".to_string());
    }
    let content = fs::read_to_string(&source).map_err(|error| error.to_string())?;
    let title = title_from_relative_path(&source_relative);
    create_manuscript_package(&target, &content, &target_relative, &title)?;
    fs::remove_file(&source).map_err(|error| error.to_string())?;
    Ok(target_relative)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_default_remotion_scene_creates_single_default_scene() {
        let scene = build_default_remotion_scene(
            "苹果动画",
            &[
                json!({
                    "clipId": "clip-1",
                    "durationMs": 1500,
                    "enabled": true
                }),
                json!({
                    "clipId": "clip-2",
                    "durationMs": 2500,
                    "enabled": true
                }),
            ],
        );

        let scenes = scene
            .get("scenes")
            .and_then(Value::as_array)
            .expect("scenes should exist");
        assert_eq!(scenes.len(), 1);
        assert_eq!(scenes[0].get("id").and_then(Value::as_str), Some("scene-1"));
        assert!(scenes[0].get("clipId").map(Value::is_null).unwrap_or(false));
        assert_eq!(
            scene.get("entryCompositionId").and_then(Value::as_str),
            Some("RedBoxVideoMotion")
        );
        assert_eq!(
            scene.get("renderMode").and_then(Value::as_str),
            Some("motion-layer")
        );
        assert_eq!(
            scene
                .pointer("/render/defaultOutName")
                .and_then(Value::as_str),
            Some("苹果动画")
        );
        assert_eq!(
            scene.pointer("/render/codec").and_then(Value::as_str),
            Some("prores")
        );
        assert_eq!(
            scene.pointer("/render/imageFormat").and_then(Value::as_str),
            Some("png")
        );
        assert_eq!(
            scene
                .get("transitions")
                .and_then(Value::as_array)
                .map(|items| items.len()),
            Some(0)
        );
        assert_eq!(
            scenes[0]
                .get("durationInFrames")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
            120
        );
    }

    #[test]
    fn build_remotion_input_props_wraps_composition_in_standard_input_props_shape() {
        let composition = build_default_remotion_scene("苹果动画", &[]);
        let input_props = build_remotion_input_props(&composition);
        assert!(input_props.get("composition").is_some());
        assert_eq!(
            input_props
                .pointer("/composition/entryCompositionId")
                .and_then(Value::as_str),
            Some("RedBoxVideoMotion")
        );
        assert!(input_props.get("runtime").is_none());
    }

    #[test]
    fn normalize_ai_remotion_scene_maps_official_timing_style_aliases_to_host_animation_kinds() {
        let fallback = build_default_remotion_scene("测试", &[]);
        let candidate = json!({
            "title": "测试",
            "fps": 30,
            "scenes": [{
                "id": "scene-1",
                "startFrame": 0,
                "durationInFrames": 60,
                "entities": [{
                    "id": "title-1",
                    "type": "text",
                    "text": "Hello",
                    "x": 0,
                    "y": 0,
                    "width": 320,
                    "height": 120,
                    "animations": [{
                        "id": "anim-1",
                        "kind": "spring-pop",
                        "fromFrame": 0,
                        "durationInFrames": 24
                    }]
                }]
            }]
        });

        let normalized = normalize_ai_remotion_scene(&candidate, &fallback, &[], "测试");
        assert_eq!(
            normalized
                .pointer("/scenes/0/entities/0/animations/0/kind")
                .and_then(Value::as_str),
            Some("pop")
        );
    }

    #[test]
    fn normalize_ai_remotion_scene_keeps_shape_entities_when_transition_hints_are_present() {
        let fallback = build_default_remotion_scene("测试", &[]);
        let candidate = json!({
            "title": "测试",
            "fps": 30,
            "scenes": [{
                "id": "scene-1",
                "startFrame": 0,
                "durationInFrames": 60,
                "transition": { "type": "fade" },
                "entities": [{
                    "id": "apple-1",
                    "type": "shape",
                    "shape": "apple",
                    "x": 0,
                    "y": 0,
                    "width": 120,
                    "height": 120
                }]
            }]
        });

        let normalized = normalize_ai_remotion_scene(&candidate, &fallback, &[], "测试");
        assert_eq!(
            normalized
                .pointer("/scenes/0/entities/0/type")
                .and_then(Value::as_str),
            Some("shape")
        );
        assert_eq!(
            normalized
                .pointer("/scenes/0/entities/0/shape")
                .and_then(Value::as_str),
            Some("apple")
        );
    }

    #[test]
    fn normalize_ai_remotion_scene_preserves_supported_top_level_transitions() {
        let fallback = build_default_remotion_scene("测试", &[]);
        let candidate = json!({
            "title": "测试",
            "fps": 30,
            "scenes": [{
                "id": "scene-a",
                "clipId": "clip-a",
                "startFrame": 0,
                "durationInFrames": 45,
                "src": "",
                "assetKind": "video",
                "entities": []
            }, {
                "id": "scene-b",
                "clipId": "clip-b",
                "startFrame": 45,
                "durationInFrames": 45,
                "src": "",
                "assetKind": "video",
                "entities": []
            }],
            "transitions": [{
                "id": "transition-1",
                "presentation": "slide",
                "timing": "ease-in-out",
                "leftClipId": "clip-a",
                "rightClipId": "clip-b",
                "direction": "from-left",
                "durationInFrames": 18
            }]
        });

        let normalized = normalize_ai_remotion_scene(&candidate, &fallback, &[], "测试");
        assert_eq!(
            normalized
                .pointer("/transitions/0/presentation")
                .and_then(Value::as_str),
            Some("slide")
        );
        assert_eq!(
            normalized
                .pointer("/transitions/0/timing")
                .and_then(Value::as_str),
            Some("ease-in-out")
        );
        assert_eq!(
            normalized
                .pointer("/transitions/0/direction")
                .and_then(Value::as_str),
            Some("from-left")
        );
    }

    #[test]
    fn normalize_ai_remotion_scene_hoists_fall_bounce_root_fields_into_params() {
        let fallback = build_default_remotion_scene("苹果下落", &[]);
        let candidate = json!({
            "title": "苹果下落动画",
            "fps": 30,
            "scenes": [{
                "id": "scene-1",
                "startFrame": 0,
                "durationInFrames": 60,
                "entities": [{
                    "id": "apple-1",
                    "type": "shape",
                    "shape": "apple",
                    "x": 540,
                    "y": -300,
                    "width": 200,
                    "height": 200,
                    "animations": [{
                        "kind": "fall-bounce",
                        "fromY": -300,
                        "toY": 1650,
                        "durationFrames": 60,
                        "bounceCount": 1
                    }]
                }]
            }]
        });

        let normalized = normalize_ai_remotion_scene(&candidate, &fallback, &[], "苹果下落");
        assert_eq!(
            normalized.get("durationInFrames").and_then(Value::as_i64),
            Some(60)
        );
        assert_eq!(
            normalized
                .pointer("/scenes/0/entities/0/animations/0/durationInFrames")
                .and_then(Value::as_i64),
            Some(60)
        );
        assert_eq!(
            normalized
                .pointer("/scenes/0/entities/0/animations/0/params/bounces")
                .and_then(Value::as_i64),
            Some(1)
        );
        assert_eq!(
            normalized
                .pointer("/scenes/0/entities/0/animations/0/params/fromY")
                .and_then(Value::as_f64),
            Some(0.0)
        );
        assert_eq!(
            normalized
                .pointer("/scenes/0/entities/0/animations/0/params/floorY")
                .and_then(Value::as_f64),
            Some(1950.0)
        );
        assert_eq!(
            normalized
                .pointer("/render/defaultOutName")
                .and_then(Value::as_str),
            Some("苹果下落动画")
        );
        assert_eq!(
            normalized
                .pointer("/scenes/0/assetKind")
                .and_then(Value::as_str),
            Some("unknown")
        );
        assert_eq!(
            normalized.pointer("/scenes/0/src").and_then(Value::as_str),
            Some("")
        );
    }

    #[test]
    fn ensure_editor_project_rehydrates_motion_projection_from_remotion_scene() {
        let package_path = std::env::temp_dir().join(format!("redbox-remotion-heal-{}", now_ms()));
        fs::create_dir_all(&package_path).expect("create package dir");
        write_json_value(
            &package_editor_project_path(&package_path),
            &json!({
                "version": 1,
                "project": {
                    "id": "project-1",
                    "title": "苹果动画",
                    "width": 1080,
                    "height": 1920,
                    "fps": 30,
                    "ratioPreset": "9:16"
                },
                "script": { "body": "test" },
                "assets": [],
                "tracks": [{
                    "id": "M1",
                    "kind": "motion",
                    "name": "M1",
                    "order": 0,
                    "ui": {
                        "hidden": false,
                        "locked": false,
                        "muted": false,
                        "solo": false,
                        "collapsed": false,
                        "volume": 1.0
                    }
                }],
                "items": [],
                "animationLayers": [],
                "stage": {
                    "itemTransforms": {},
                    "itemVisibility": {},
                    "itemLocks": {},
                    "itemOrder": [],
                    "itemGroups": {},
                    "focusedGroupId": Value::Null
                },
                "ai": { "motionPrompt": "test" }
            }),
        )
        .expect("write project");
        write_json_value(
            &package_remotion_path(&package_path),
            &json!({
                "title": "苹果下落动画",
                "entryCompositionId": "RedBoxVideoMotion",
                "width": 1080,
                "height": 1920,
                "fps": 30,
                "durationInFrames": 60,
                "backgroundColor": "#000000",
                "renderMode": "motion-layer",
                "render": {
                    "defaultOutName": "苹果下落动画",
                    "codec": "prores",
                    "imageFormat": "png",
                    "pixelFormat": "yuva444p10le",
                    "proResProfile": "4444"
                },
                "transitions": [],
                "scenes": [{
                    "id": "scene-1",
                    "clipId": Value::Null,
                    "assetId": Value::Null,
                    "assetKind": "unknown",
                    "src": "",
                    "startFrame": 0,
                    "durationInFrames": 60,
                    "trimInFrames": 0,
                    "motionPreset": "static",
                    "overlayTitle": "苹果下落",
                    "overlayBody": Value::Null,
                    "overlays": [],
                    "entities": [{
                        "id": "apple-1",
                        "type": "shape",
                        "shape": "apple",
                        "color": "#FF0000",
                        "x": 540,
                        "y": -300,
                        "width": 200,
                        "height": 200,
                        "animations": [{
                            "id": "fall-1",
                            "kind": "fall-bounce",
                            "fromFrame": 0,
                            "durationInFrames": 60,
                            "params": {
                                "fromY": -300,
                                "floorY": 1650,
                                "bounces": 1
                            }
                        }]
                    }]
                }]
            }),
        )
        .expect("write remotion");

        let repaired = ensure_editor_project(&package_path).expect("rehydrate project");
        assert_eq!(
            repaired
                .pointer("/animationLayers/0/id")
                .and_then(Value::as_str),
            Some("scene-1")
        );
        assert_eq!(
            repaired.pointer("/items/0/type").and_then(Value::as_str),
            Some("motion")
        );
        assert_eq!(
            repaired
                .pointer("/items/0/props/entities/0/shape")
                .and_then(Value::as_str),
            Some("apple")
        );
        assert_eq!(
            repaired
                .pointer("/animationLayers/0/entities/0/color")
                .and_then(Value::as_str),
            Some("#FF0000")
        );
        assert_eq!(
            repaired
                .pointer("/items/0/props/entities/0/color")
                .and_then(Value::as_str),
            Some("#FF0000")
        );

        let _ = fs::remove_dir_all(&package_path);
    }

    #[test]
    fn video_project_brief_from_manifest_reads_video_ai_brief_fields() {
        let brief = video_project_brief_from_manifest(&json!({
            "videoAi": {
                "brief": "Jamba 手持戴森 V8 跳舞",
                "lastBriefUpdateAt": 1234567890_i64,
                "lastBriefUpdateSource": "user"
            }
        }));

        assert_eq!(
            brief.get("content").and_then(Value::as_str),
            Some("Jamba 手持戴森 V8 跳舞")
        );
        assert_eq!(
            brief.get("updatedAt").and_then(Value::as_i64),
            Some(1234567890)
        );
        assert_eq!(brief.get("source").and_then(Value::as_str), Some("user"));
    }
}
