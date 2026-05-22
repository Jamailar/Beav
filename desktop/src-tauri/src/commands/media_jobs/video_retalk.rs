use super::payload_string_any;
use crate::*;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

const VIDEO_RETALK_MIN_EDGE: u32 = 640;
const VIDEO_RETALK_MAX_EDGE: u32 = 2048;
const VIDEO_RETALK_DEFAULT_SHORT_EDGE: u32 = 720;
const VIDEO_RETALK_HIGH_SHORT_EDGE: u32 = 1080;

#[derive(Debug, Clone, Copy)]
pub(super) struct VideoDimensions {
    pub(super) width: u32,
    pub(super) height: u32,
}

pub(super) fn prepare_source(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let path = payload_string_any(payload, &["path", "filePath", "sourcePath"])
        .ok_or_else(|| "generation:prepare-video-retalk-source requires path".to_string())?;
    if path.trim().starts_with("http://") || path.trim().starts_with("https://") {
        return Ok(json!({
            "success": true,
            "path": path,
            "normalized": false,
            "remote": true,
        }));
    }
    let source_path = resolve_local_video_path(state, &path)?;
    let source_dimensions = probe_video_dimensions(app, &source_path)?;
    let target_short_edge =
        video_retalk_target_short_edge(payload_string_any(payload, &["resolution"]).as_deref());
    let Some(target_dimensions) =
        target_video_retalk_dimensions(source_dimensions, target_short_edge)?
    else {
        return Ok(json!({
            "success": true,
            "path": source_path.to_string_lossy(),
            "normalized": false,
            "width": source_dimensions.width,
            "height": source_dimensions.height,
        }));
    };

    let output_dir = media_root(state)
        .unwrap_or_else(|_| PathBuf::from("media"))
        .join("prepared")
        .join("video-retalk");
    fs::create_dir_all(&output_dir).map_err(|error| {
        format!("failed to create VideoRetalk prepared video directory: {error}")
    })?;
    let output_path = output_dir.join(format!("video-retalk-source-{}.mp4", now_ms()));
    let scale_filter = format!(
        "scale={}:{}:flags=lanczos",
        target_dimensions.width, target_dimensions.height
    );
    let output = crate::background_command(crate::ffmpeg_runtime::ffmpeg_executable(Some(app))?)
        .args(["-y", "-i"])
        .arg(&source_path)
        .args([
            "-vf",
            &scale_filter,
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
        ])
        .arg(&output_path)
        .output()
        .map_err(|error| format!("failed to start ffmpeg: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "failed to prepare VideoRetalk reference video: {}",
            if stderr.is_empty() {
                "ffmpeg exited with error".to_string()
            } else {
                stderr
            }
        ));
    }
    let prepared_dimensions = probe_video_dimensions(app, &output_path)?;
    Ok(json!({
        "success": true,
        "path": output_path.to_string_lossy(),
        "normalized": true,
        "width": prepared_dimensions.width,
        "height": prepared_dimensions.height,
        "sourceWidth": source_dimensions.width,
        "sourceHeight": source_dimensions.height,
        "targetShortEdge": target_short_edge,
    }))
}

fn resolve_local_video_path(
    state: &State<'_, AppState>,
    raw_path: &str,
) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("generation:prepare-video-retalk-source requires path".to_string());
    }
    let normalized = trimmed.strip_prefix("file://").unwrap_or(trimmed);
    let candidate = PathBuf::from(normalized);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        workspace_root(state)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(candidate)
    };
    if !resolved.is_file() {
        return Err(format!(
            "VideoRetalk reference video does not exist: {}",
            resolved.display()
        ));
    }
    Ok(resolved)
}

fn probe_video_dimensions(app: &AppHandle, path: &Path) -> Result<VideoDimensions, String> {
    let output = crate::background_command(crate::ffmpeg_runtime::ffprobe_executable(Some(app))?)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .map_err(|error| format!("failed to start ffprobe: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "failed to inspect VideoRetalk reference video: {}",
            if stderr.is_empty() {
                "ffprobe exited with error".to_string()
            } else {
                stderr
            }
        ));
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("failed to parse ffprobe output: {error}"))?;
    let stream = value
        .get("streams")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .ok_or_else(|| "VideoRetalk reference video has no video stream".to_string())?;
    let width = stream
        .get("width")
        .and_then(Value::as_u64)
        .ok_or_else(|| "VideoRetalk reference video is missing width metadata".to_string())?;
    let height = stream
        .get("height")
        .and_then(Value::as_u64)
        .ok_or_else(|| "VideoRetalk reference video is missing height metadata".to_string())?;
    if width == 0 || height == 0 || width > u32::MAX as u64 || height > u32::MAX as u64 {
        return Err("VideoRetalk reference video has invalid dimensions".to_string());
    }
    Ok(VideoDimensions {
        width: width as u32,
        height: height as u32,
    })
}

fn even_ceil(value: f64) -> u32 {
    let rounded = value.ceil() as u32;
    if rounded % 2 == 0 {
        rounded
    } else {
        rounded + 1
    }
}

fn even_floor(value: f64) -> u32 {
    let rounded = value.floor() as u32;
    if rounded % 2 == 0 {
        rounded
    } else {
        rounded.saturating_sub(1)
    }
}

pub(super) fn video_retalk_target_short_edge(resolution: Option<&str>) -> u32 {
    match resolution
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "1080p" | "1080" | "fullhd" | "full_hd" | "fhd" => VIDEO_RETALK_HIGH_SHORT_EDGE,
        "720p" | "720" | "hd" => VIDEO_RETALK_DEFAULT_SHORT_EDGE,
        _ => VIDEO_RETALK_DEFAULT_SHORT_EDGE,
    }
}

pub(super) fn target_video_retalk_dimensions(
    dimensions: VideoDimensions,
    target_short_edge: u32,
) -> Result<Option<VideoDimensions>, String> {
    let min_edge = dimensions.width.min(dimensions.height);
    let max_edge = dimensions.width.max(dimensions.height);
    let target_short_edge = target_short_edge.clamp(VIDEO_RETALK_MIN_EDGE, VIDEO_RETALK_MAX_EDGE);
    if min_edge >= target_short_edge && max_edge <= VIDEO_RETALK_MAX_EDGE {
        return Ok(None);
    }
    let target = if max_edge > VIDEO_RETALK_MAX_EDGE {
        let scale = VIDEO_RETALK_MAX_EDGE as f64 / max_edge as f64;
        VideoDimensions {
            width: even_floor(dimensions.width as f64 * scale),
            height: even_floor(dimensions.height as f64 * scale),
        }
    } else {
        let scale = target_short_edge as f64 / min_edge as f64;
        let scaled_width = dimensions.width as f64 * scale;
        let scaled_height = dimensions.height as f64 * scale;
        let scaled_max = scaled_width.max(scaled_height);
        if scaled_max > VIDEO_RETALK_MAX_EDGE as f64 {
            let fallback_scale = VIDEO_RETALK_MAX_EDGE as f64 / max_edge as f64;
            VideoDimensions {
                width: even_floor(dimensions.width as f64 * fallback_scale),
                height: even_floor(dimensions.height as f64 * fallback_scale),
            }
        } else {
            VideoDimensions {
                width: even_ceil(scaled_width),
                height: even_ceil(scaled_height),
            }
        }
    };
    let target_min = target.width.min(target.height);
    let target_max = target.width.max(target.height);
    if target_min < VIDEO_RETALK_MIN_EDGE || target_max > VIDEO_RETALK_MAX_EDGE {
        return Err(format!(
            "VideoRetalk reference video aspect ratio cannot fit {}~{}px bounds without cropping: {}x{}",
            VIDEO_RETALK_MIN_EDGE,
            VIDEO_RETALK_MAX_EDGE,
            dimensions.width,
            dimensions.height
        ));
    }
    Ok(Some(target))
}
