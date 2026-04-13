use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use tauri::State;

use crate::{
    commands::manuscripts::timeline_clip_duration_ms, get_default_package_entry,
    get_draft_type_from_file_name, get_package_kind_from_file_name, join_relative,
    lexbox_project_root, make_id, normalize_relative_path, now_i64, now_iso, now_ms,
    package_assets_path, package_cover_path, package_editor_project_path, package_entry_path,
    package_images_path, package_manifest_path, package_remotion_path, package_scene_ui_path,
    package_timeline_path, package_track_ui_path, parse_json_value_from_text, read_json_value_or,
    resolve_manuscript_path, title_from_relative_path, write_json_value, write_text_file, AppState,
};

pub(crate) fn normalize_motion_preset(value: Option<&str>, fallback: &str) -> String {
    match value.unwrap_or("").trim() {
        "static" | "slow-zoom-in" | "slow-zoom-out" | "pan-left" | "pan-right" | "slide-up"
        | "slide-down" => value.unwrap().trim().to_string(),
        _ => fallback.to_string(),
    }
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

pub(crate) fn build_default_remotion_scene(title: &str, clips: &[Value]) -> Value {
    let fps = 30_i64;
    let mut current_frame = 0_i64;
    let mut scenes = Vec::new();
    for (index, clip) in clips.iter().enumerate() {
        if clip
            .get("enabled")
            .and_then(|value| value.as_bool())
            .unwrap_or(true)
            == false
        {
            continue;
        }
        let asset_kind = clip
            .get("assetKind")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        let src = clip
            .get("mediaPath")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        if src.trim().is_empty() && asset_kind != "audio" {
            continue;
        }
        let duration_in_frames = remotion_scene_duration_frames(clip, fps);
        let overlay_title = clip
            .get("name")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .filter(|value| !value.trim().is_empty());
        scenes.push(json!({
            "id": format!("scene-{}", index + 1),
            "clipId": clip.get("clipId").cloned().unwrap_or(Value::Null),
            "assetId": clip.get("assetId").cloned().unwrap_or(Value::Null),
            "assetKind": asset_kind,
            "src": src,
            "startFrame": current_frame,
            "durationInFrames": duration_in_frames,
            "trimInFrames": 0,
            "motionPreset": fallback_motion_preset(index, asset_kind),
            "overlayTitle": overlay_title,
            "overlayBody": if asset_kind == "audio" {
                Value::Null
            } else {
                json!(format!("场景 {} · 让 AI 在这里做镜头运动、字幕和强调动画。", index + 1))
            },
            "overlays": []
        }));
        current_frame += duration_in_frames;
    }
    json!({
        "version": 1,
        "title": title,
        "width": 1080,
        "height": 1920,
        "fps": fps,
        "durationInFrames": current_frame.max(90),
        "backgroundColor": "#05070b",
        "scenes": scenes
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

    let scenes = remotion
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for scene in scenes {
        let scene_id = scene
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        items.push(json!({
            "id": if scene_id.is_empty() { make_id("motion-item") } else { format!("motion:{scene_id}") },
            "type": "motion",
            "trackId": "M1",
            "bindItemId": scene.get("clipId").cloned().unwrap_or(Value::Null),
            "fromMs": (((scene.get("startFrame").and_then(|value| value.as_i64()).unwrap_or(0) as f64) * 1000.0) / fps as f64).round() as i64,
            "durationMs": (((scene.get("durationInFrames").and_then(|value| value.as_i64()).unwrap_or(90) as f64) * 1000.0) / fps as f64).round() as i64,
            "templateId": scene.get("motionPreset").cloned().unwrap_or_else(|| json!("static")),
            "props": {
                "sceneId": scene.get("id").cloned().unwrap_or(Value::Null),
                "assetId": scene.get("assetId").cloned().unwrap_or(Value::Null),
                "overlayTitle": scene.get("overlayTitle").cloned().unwrap_or(Value::Null),
                "overlayBody": scene.get("overlayBody").cloned().unwrap_or(Value::Null),
                "overlays": scene.get("overlays").cloned().unwrap_or_else(|| json!([]))
            },
            "enabled": true
        }));
    }

    if let Some(object) = project.as_object_mut() {
        object.insert("assets".to_string(), Value::Array(assets));
        object.insert("tracks".to_string(), Value::Array(tracks));
        object.insert("items".to_string(), Value::Array(items));
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
            "overlays": props.get("overlays").cloned().unwrap_or_else(|| json!([]))
        }));
    }
    json!({
        "version": 1,
        "title": title,
        "width": width,
        "height": height,
        "fps": fps,
        "durationInFrames": duration_in_frames.max(90),
        "backgroundColor": background_color,
        "scenes": scenes,
        "sceneItemTransforms": project.pointer("/stage/itemTransforms").cloned().unwrap_or_else(|| json!({})),
        "render": Value::Null
    })
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

    let mut normalized_scenes = Vec::new();
    let mut current_frame = 0_i64;
    for (index, raw_scene) in source_scenes.iter().enumerate() {
        let fallback_scene = fallback_scenes.get(index).cloned().unwrap_or_else(|| {
            let clip = clips.get(index).cloned().unwrap_or_else(|| json!({}));
            json!({
                "id": format!("scene-{}", index + 1),
                "clipId": clip.get("clipId").cloned().unwrap_or(Value::Null),
                "assetId": clip.get("assetId").cloned().unwrap_or(Value::Null),
                "assetKind": clip.get("assetKind").cloned().unwrap_or(json!("unknown")),
                "src": clip.get("mediaPath").cloned().unwrap_or(json!("")),
                "startFrame": current_frame,
                "durationInFrames": remotion_scene_duration_frames(&clip, fps),
                "trimInFrames": 0,
                "motionPreset": fallback_motion_preset(index, clip.get("assetKind").and_then(|value| value.as_str()).unwrap_or("unknown")),
                "overlayTitle": clip.get("name").cloned().unwrap_or(json!(format!("场景 {}", index + 1))),
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
                .and_then(|value| value.as_str())
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
        });
        normalized_scenes.push(json!({
            "id": raw_scene.get("id").cloned().unwrap_or_else(|| fallback_scene.get("id").cloned().unwrap_or(json!(format!("scene-{}", index + 1)))),
            "clipId": raw_scene.get("clipId").cloned().or_else(|| fallback_scene.get("clipId").cloned()).unwrap_or(Value::Null),
            "assetId": raw_scene.get("assetId").cloned().or_else(|| fallback_scene.get("assetId").cloned()).unwrap_or(Value::Null),
            "assetKind": asset_kind,
            "src": raw_scene.get("src").cloned().or_else(|| fallback_scene.get("src").cloned()).unwrap_or(json!("")),
            "startFrame": current_frame,
            "durationInFrames": duration_in_frames,
            "trimInFrames": raw_scene.get("trimInFrames").cloned().or_else(|| fallback_scene.get("trimInFrames").cloned()).unwrap_or(json!(0)),
            "motionPreset": normalize_motion_preset(raw_scene.get("motionPreset").and_then(|value| value.as_str()), fallback_scene.get("motionPreset").and_then(|value| value.as_str()).unwrap_or("static")),
            "overlayTitle": raw_scene.get("overlayTitle").cloned().or_else(|| fallback_scene.get("overlayTitle").cloned()).unwrap_or(Value::Null),
            "overlayBody": raw_scene.get("overlayBody").cloned().or_else(|| fallback_scene.get("overlayBody").cloned()).unwrap_or(Value::Null),
            "overlays": overlays
        }));
        current_frame += duration_in_frames;
    }

    json!({
        "version": 1,
        "title": candidate.get("title").cloned().unwrap_or(json!(title)),
        "width": width,
        "height": height,
        "fps": fps,
        "durationInFrames": current_frame.max(90),
        "backgroundColor": background_color,
        "scenes": normalized_scenes,
        "sceneItemTransforms": candidate
            .get("sceneItemTransforms")
            .cloned()
            .or_else(|| fallback.get("sceneItemTransforms").cloned())
            .unwrap_or_else(|| json!({})),
        "render": candidate.get("render").cloned().unwrap_or(Value::Null)
    })
}

pub(crate) fn render_remotion_video(config: &Value, output_path: &Path) -> Result<Value, String> {
    let project_root = lexbox_project_root();
    let script_path = project_root.join("remotion").join("render.mjs");
    if !script_path.exists() {
        return Err(format!(
            "Remotion render script not found: {}",
            script_path.display()
        ));
    }
    let temp_config_path = std::env::temp_dir().join(format!("lexbox-remotion-{}.json", now_ms()));
    write_json_value(&temp_config_path, config)?;
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let output = std::process::Command::new("node")
        .arg(&script_path)
        .arg(&temp_config_path)
        .arg(output_path)
        .current_dir(&project_root)
        .output()
        .map_err(|error| error.to_string())?;
    let _ = fs::remove_file(&temp_config_path);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Remotion render failed with status {}", output.status)
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
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
    let editor_project = if get_package_kind_from_file_name(file_name) == Some("video") {
        Some(ensure_editor_project(package_path)?)
    } else {
        None
    };
    let timeline_summary = if let Some(project) = editor_project.as_ref() {
        build_timeline_summary_from_editor_project(project)
    } else {
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
    };
    let remotion = if let Some(project) = editor_project.as_ref() {
        build_remotion_config_from_editor_project(project)
    } else {
        let clips = timeline_summary
            .get("clips")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        read_json_value_or(
            package_remotion_path(package_path).as_path(),
            build_default_remotion_scene(&title, &clips),
        )
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
    Ok(json!({
        "manifest": {
            "packageKind": get_package_kind_from_file_name(file_name),
            "draftType": get_draft_type_from_file_name(file_name),
            "title": manifest.get("title").cloned().unwrap_or(json!(title)),
            "entry": manifest.get("entry").cloned().unwrap_or(json!(get_default_package_entry(file_name))),
            "updatedAt": manifest.get("updatedAt").cloned().unwrap_or(json!(now_i64()))
        },
        "assets": assets,
        "cover": cover,
        "images": images,
        "remotion": remotion,
        "timelineSummary": timeline_summary,
        "editorProject": editor_project.unwrap_or(Value::Null),
        "sceneUi": scene_ui,
        "hasLayoutHtml": false,
        "hasWechatHtml": false,
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
            "timeline": if package_kind == "video" || package_kind == "audio" { json!("timeline.otio.json") } else { Value::Null }
        }),
    )?;
    write_text_file(
        &package_entry_path(package_path, file_name, Some(&json!({ "entry": entry }))),
        content,
    )?;
    if package_kind == "video" || package_kind == "audio" {
        write_json_value(&package_assets_path(package_path), &json!({ "items": [] }))?;
        write_json_value(
            &package_timeline_path(package_path),
            &create_empty_otio_timeline(title),
        )?;
        write_json_value(
            &package_remotion_path(package_path),
            &build_default_remotion_scene(title, &[]),
        )?;
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
            &build_default_editor_project(
                title,
                content,
                1080,
                if package_kind == "audio" { 1080 } else { 1920 },
                30,
            ),
        )?;
    } else if package_kind == "article" {
        write_text_file(&package_path.join("layout.html"), "")?;
        write_text_file(&package_path.join("wechat.html"), "")?;
        write_json_value(&package_assets_path(package_path), &json!({ "items": [] }))?;
    } else if package_kind == "post" {
        write_json_value(&package_images_path(package_path), &json!({ "items": [] }))?;
        write_json_value(
            &package_cover_path(package_path),
            &json!({ "assetId": Value::Null }),
        )?;
        write_json_value(&package_assets_path(package_path), &json!({ "items": [] }))?;
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
