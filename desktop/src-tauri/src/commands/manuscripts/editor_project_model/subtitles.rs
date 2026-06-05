use super::*;

pub(super) fn editor_default_subtitle_style(
    source_item_id: &str,
    subtitle_file: &str,
    style_patch: Option<&Value>,
) -> Value {
    let mut style = json!({
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
        "animation": "fade-up",
        "presetId": "classic-bottom",
        "segmentationMode": "punctuationOrPause",
        "linesPerCaption": 1,
        "emphasisWords": [],
        "sourceItemId": source_item_id,
        "subtitleFile": subtitle_file
    });
    if let (Some(target), Some(source)) = (
        style.as_object_mut(),
        style_patch.and_then(Value::as_object),
    ) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
    style
}

pub(super) fn upsert_editor_project_last_subtitle_transcription(
    project: &mut Value,
    source_item_id: &str,
    subtitle_file: &str,
    segment_count: usize,
) -> Result<(), String> {
    let ai = ensure_editor_project_ai_state(project)?;
    ai.insert(
        "lastSubtitleTranscription".to_string(),
        json!({
            "sourceItemId": source_item_id,
            "subtitleFile": subtitle_file,
            "segmentCount": segment_count,
            "updatedAt": now_i64()
        }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subtitle_style_patch_overrides_defaults() {
        let style = editor_default_subtitle_style(
            "clip-1",
            "subtitles/clip-1.srt",
            Some(&json!({ "fontSize": 40 })),
        );

        assert_eq!(style.get("fontSize").and_then(Value::as_i64), Some(40));
        assert_eq!(
            style.get("sourceItemId").and_then(Value::as_str),
            Some("clip-1")
        );
    }
}
