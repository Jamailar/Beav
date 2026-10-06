use super::*;

pub(super) const DEFAULT_TIMELINE_CLIP_MS: i64 = 4000;
const IMAGE_TIMELINE_CLIP_MS: i64 = 500;
const DEFAULT_MIN_CLIP_MS: i64 = 1000;

pub(super) fn min_clip_duration_ms_for_asset_kind(asset_kind: &str) -> i64 {
    if asset_kind.eq_ignore_ascii_case("image") {
        IMAGE_TIMELINE_CLIP_MS
    } else {
        DEFAULT_MIN_CLIP_MS
    }
}

pub(super) fn default_clip_duration_ms_for_asset(asset: &MediaAssetRecord) -> i64 {
    if media_asset_kind(asset) == "image" {
        IMAGE_TIMELINE_CLIP_MS
    } else {
        DEFAULT_TIMELINE_CLIP_MS
    }
}

pub(crate) fn timeline_clip_asset_kind(clip: &Value) -> String {
    clip.get("metadata")
        .and_then(|value| value.get("assetKind"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .or_else(|| {
            clip.pointer("/media_references/DEFAULT_MEDIA/metadata/mimeType")
                .and_then(|value| value.as_str())
                .map(|mime_type| {
                    if mime_type.starts_with("audio/") {
                        "audio".to_string()
                    } else if mime_type.starts_with("video/") {
                        "video".to_string()
                    } else {
                        "image".to_string()
                    }
                })
        })
        .unwrap_or_else(|| "video".to_string())
}

pub(crate) fn timeline_clip_duration_ms(clip: &Value) -> i64 {
    let asset_kind = timeline_clip_asset_kind(clip);
    let min_duration_ms = min_clip_duration_ms_for_asset_kind(&asset_kind);
    clip.get("metadata")
        .and_then(|value| value.get("durationMs"))
        .and_then(|value| value.as_i64())
        .unwrap_or_else(|| {
            if asset_kind.eq_ignore_ascii_case("image") {
                IMAGE_TIMELINE_CLIP_MS
            } else {
                DEFAULT_TIMELINE_CLIP_MS
            }
        })
        .max(min_duration_ms)
}

pub(super) fn media_asset_kind(asset: &MediaAssetRecord) -> &'static str {
    let mime_type = asset.mime_type.clone().unwrap_or_default();
    if mime_type.starts_with("audio/") {
        "audio"
    } else if mime_type.starts_with("video/") {
        "video"
    } else {
        "image"
    }
}

pub(super) fn default_track_name_for_asset(asset: &MediaAssetRecord) -> &'static str {
    if media_asset_kind(asset) == "audio" {
        "A1"
    } else {
        "V1"
    }
}

pub(super) fn timeline_track_kind(track_name: &str) -> &'static str {
    if track_name.starts_with('A') {
        "Audio"
    } else if track_name.starts_with('S')
        || track_name.starts_with('T')
        || track_name.starts_with('C')
    {
        "Subtitle"
    } else {
        "Video"
    }
}

pub(super) fn build_timeline_clip_from_asset(
    asset: &MediaAssetRecord,
    desired_order: usize,
    duration_ms: Option<i64>,
) -> Value {
    let duration_value = duration_ms
        .filter(|value| *value > 0)
        .unwrap_or_else(|| default_clip_duration_ms_for_asset(asset))
        .max(min_clip_duration_ms_for_asset_kind(media_asset_kind(asset)));
    json!({
        "OTIO_SCHEMA": "Clip.2",
        "name": asset.title.clone().unwrap_or_else(|| asset.id.clone()),
        "source_range": Value::Null,
        "media_references": {
            "DEFAULT_MEDIA": {
                "OTIO_SCHEMA": "ExternalReference.1",
                "target_url": asset.absolute_path.clone().or(asset.relative_path.clone()).unwrap_or_default(),
                "available_range": Value::Null,
                "metadata": {
                    "assetId": asset.id,
                    "mimeType": asset.mime_type
                }
            }
        },
        "active_media_reference_key": "DEFAULT_MEDIA",
        "metadata": {
            "clipId": create_timeline_clip_id(),
            "assetId": asset.id,
            "assetKind": media_asset_kind(asset),
            "source": "media-library",
            "order": desired_order,
            "durationMs": json!(duration_value),
            "trimInMs": 0,
            "trimOutMs": 0,
            "enabled": true,
            "addedAt": now_iso()
        }
    })
}

pub(super) fn build_timeline_subtitle_clip(
    desired_order: usize,
    text: &str,
    duration_ms: Option<i64>,
) -> Value {
    let duration_value = duration_ms
        .filter(|value| *value > 0)
        .unwrap_or(2000)
        .max(500);
    let clip_name = {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            format!("字幕 {}", desired_order + 1)
        } else {
            trimmed.to_string()
        }
    };
    json!({
        "OTIO_SCHEMA": "Clip.2",
        "name": clip_name,
        "source_range": Value::Null,
        "media_references": {
            "DEFAULT_MEDIA": {
                "OTIO_SCHEMA": "ExternalReference.1",
                "target_url": "",
                "available_range": Value::Null,
                "metadata": {
                    "mimeType": "text/plain",
                    "assetId": Value::Null
                }
            }
        },
        "active_media_reference_key": "DEFAULT_MEDIA",
        "metadata": {
            "clipId": create_timeline_clip_id(),
            "assetId": Value::Null,
            "assetKind": "subtitle",
            "source": "subtitle-editor",
            "order": desired_order,
            "durationMs": json!(duration_value),
            "trimInMs": 0,
            "trimOutMs": 0,
            "enabled": true,
            "subtitleStyle": {
                "position": "bottom",
                "fontSize": 34,
                "color": "#ffffff",
                "backgroundColor": "rgba(6, 8, 12, 0.58)",
                "emphasisColor": "#facc15",
                "align": "center",
                "fontWeight": 700,
                "textTransform": "none",
                "letterSpacing": 0,
                "borderRadius": 22,
                "paddingX": 20,
                "paddingY": 12,
                "emphasisWords": []
            },
            "addedAt": now_iso()
        }
    })
}

pub(super) fn build_timeline_text_clip(
    desired_order: usize,
    text: &str,
    duration_ms: Option<i64>,
) -> Value {
    let duration_value = duration_ms
        .filter(|value| *value > 0)
        .unwrap_or(2500)
        .max(600);
    let clip_name = {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            format!("文本 {}", desired_order + 1)
        } else {
            trimmed.to_string()
        }
    };
    json!({
        "OTIO_SCHEMA": "Clip.2",
        "name": clip_name,
        "source_range": Value::Null,
        "media_references": {
            "DEFAULT_MEDIA": {
                "OTIO_SCHEMA": "ExternalReference.1",
                "target_url": "",
                "available_range": Value::Null,
                "metadata": {
                    "mimeType": "text/plain",
                    "assetId": Value::Null
                }
            }
        },
        "active_media_reference_key": "DEFAULT_MEDIA",
        "metadata": {
            "clipId": create_timeline_clip_id(),
            "assetId": Value::Null,
            "assetKind": "text",
            "source": "text-editor",
            "order": desired_order,
            "durationMs": json!(duration_value),
            "trimInMs": 0,
            "trimOutMs": 0,
            "enabled": true,
            "textStyle": {
                "fontSize": 42,
                "color": "#ffffff",
                "backgroundColor": "rgba(15, 23, 42, 0.42)",
                "align": "center",
                "fontWeight": 700
            },
            "addedAt": now_iso()
        }
    })
}

pub(super) fn split_timeline_clip_value(
    clip: &Value,
    clip_id: &str,
    split_ratio: f64,
) -> (Value, Value) {
    let min_duration = min_clip_duration_ms_for_asset_kind(&timeline_clip_asset_kind(clip));
    let current_duration = timeline_clip_duration_ms(clip);
    let first_duration = ((current_duration as f64) * split_ratio).round() as i64;
    let first_duration = first_duration.max(min_duration);
    let second_duration = (current_duration - first_duration).max(min_duration);

    let mut first_clip = clip.clone();
    if let Some(object) = first_clip
        .get_mut("metadata")
        .and_then(Value::as_object_mut)
    {
        object.insert("clipId".to_string(), json!(clip_id));
        object.insert("durationMs".to_string(), json!(first_duration));
    }

    let mut second_clip = clip.clone();
    if let Some(object) = second_clip
        .get_mut("metadata")
        .and_then(Value::as_object_mut)
    {
        let trim_in = object
            .get("trimInMs")
            .and_then(|value| value.as_i64())
            .unwrap_or(0);
        object.insert("clipId".to_string(), json!(create_timeline_clip_id()));
        object.insert("durationMs".to_string(), json!(second_duration));
        object.insert("trimInMs".to_string(), json!(trim_in + first_duration));
    }

    (first_clip, second_clip)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media_asset(id: &str, mime_type: &str) -> MediaAssetRecord {
        MediaAssetRecord {
            id: id.to_string(),
            source: "test".to_string(),
            source_domain: None,
            source_link: None,
            project_id: None,
            title: Some(id.to_string()),
            prompt: None,
            provider: None,
            provider_template: None,
            model: None,
            aspect_ratio: None,
            size: None,
            quality: None,
            mime_type: Some(mime_type.to_string()),
            content_hash: None,
            relative_path: Some(format!("{id}.bin")),
            bound_manuscript_path: None,
            created_at: now_iso(),
            updated_at: now_iso(),
            absolute_path: None,
            preview_url: None,
            thumbnail_url: None,
            exists: true,
        }
    }

    #[test]
    fn builds_media_clip_with_kind_and_min_duration() {
        let asset = media_asset("img-1", "image/png");
        let clip = build_timeline_clip_from_asset(&asset, 2, Some(100));

        assert_eq!(
            clip.pointer("/metadata/assetKind").and_then(Value::as_str),
            Some("image")
        );
        assert_eq!(
            clip.pointer("/metadata/durationMs").and_then(Value::as_i64),
            Some(IMAGE_TIMELINE_CLIP_MS)
        );
    }

    #[test]
    fn splits_timeline_clip_with_trim_offset() {
        let clip = json!({
            "metadata": {
                "clipId": "clip-1",
                "assetKind": "video",
                "durationMs": 4000,
                "trimInMs": 500
            }
        });

        let (first, second) = split_timeline_clip_value(&clip, "clip-1", 0.5);

        assert_eq!(
            first
                .pointer("/metadata/durationMs")
                .and_then(Value::as_i64),
            Some(2000)
        );
        assert_eq!(
            second
                .pointer("/metadata/durationMs")
                .and_then(Value::as_i64),
            Some(2000)
        );
        assert_eq!(
            second.pointer("/metadata/trimInMs").and_then(Value::as_i64),
            Some(2500)
        );
    }
}
