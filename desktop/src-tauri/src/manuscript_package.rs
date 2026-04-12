use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use tauri::State;

use crate::{
    commands::manuscripts::timeline_clip_duration_ms, get_default_package_entry,
    get_draft_type_from_file_name, get_package_kind_from_file_name, join_relative,
    lexbox_project_root, make_id, normalize_relative_path, now_i64, now_iso, now_ms,
    package_assets_path, package_cover_path, package_entry_path, package_images_path,
    package_manifest_path, package_remotion_path, package_scene_ui_path, package_timeline_path,
    package_track_ui_path,
    parse_json_value_from_text, read_json_value_or, resolve_manuscript_path,
    title_from_relative_path, write_json_value, write_text_file, AppState,
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
    let timeline = read_json_value_or(
        package_timeline_path(package_path).as_path(),
        create_empty_otio_timeline(file_name),
    );
    let (tracks, source_refs, clips) = build_timeline_clip_summaries(&timeline);
    let fallback_title = title_from_relative_path(file_name);
    let title = manifest
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or(fallback_title.as_str())
        .to_string();
    let remotion = read_json_value_or(
        package_remotion_path(package_path).as_path(),
        build_default_remotion_scene(&title, &clips),
    );
    let track_ui = read_json_value_or(
        package_track_ui_path(package_path).as_path(),
        json!({}),
    );
    let scene_ui = read_json_value_or(
        package_scene_ui_path(package_path).as_path(),
        json!({
            "itemLocks": {},
            "itemGroups": {},
            "focusedGroupId": Value::Null
        }),
    );
    let clip_count = clips.len();
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
        "timelineSummary": {
            "trackCount": tracks.len(),
            "clipCount": clip_count,
            "sourceRefs": source_refs,
            "clips": clips,
            "trackNames": tracks.iter().filter_map(|track| track.get("name").and_then(|value| value.as_str()).map(ToString::to_string)).collect::<Vec<_>>(),
            "trackUi": track_ui
        },
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
        write_json_value(&package_scene_ui_path(package_path), &json!({
            "itemLocks": {},
            "itemGroups": {},
            "focusedGroupId": Value::Null
        }))?;
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
