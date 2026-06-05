use super::*;

pub(super) fn ensure_export_extension(
    path: std::path::PathBuf,
    extension: &str,
) -> std::path::PathBuf {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case(extension))
        .unwrap_or(false)
    {
        return path;
    }
    let trimmed_extension = extension.trim_start_matches('.');
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| {
            if value.contains('.') {
                value.to_string()
            } else {
                format!("{value}.{trimmed_extension}")
            }
        })
        .unwrap_or_else(|| format!("export.{trimmed_extension}"));
    path.with_file_name(file_name)
}

pub(super) fn remotion_export_scale(width: i64, height: i64, preset: &str) -> Option<f64> {
    let safe_width = width.max(1) as f64;
    let safe_height = height.max(1) as f64;
    let (target_width, target_height) = match preset {
        "720p" => {
            if safe_width > safe_height {
                (1280.0, 720.0)
            } else if safe_height > safe_width {
                (720.0, 1280.0)
            } else {
                (720.0, 720.0)
            }
        }
        "1080p" => {
            if safe_width > safe_height {
                (1920.0, 1080.0)
            } else if safe_height > safe_width {
                (1080.0, 1920.0)
            } else {
                (1080.0, 1080.0)
            }
        }
        _ => return None,
    };
    let scale = (target_width / safe_width)
        .min(target_height / safe_height)
        .min(1.0);
    if scale.is_finite() && scale > 0.0 && (scale - 1.0).abs() > 0.001 {
        Some(scale)
    } else {
        None
    }
}

pub(super) fn instructions_request_visual_text_layers(instructions: &str) -> bool {
    let normalized = instructions.trim().to_lowercase();
    if normalized.is_empty() {
        return false;
    }
    let negative_markers = [
        "不要标题",
        "不要字幕",
        "不要说明",
        "不要文案",
        "不需要标题",
        "不需要字幕",
        "不需要说明",
        "不需要文案",
        "只要动画",
        "纯动画",
        "only animation",
        "no title",
        "no subtitle",
        "no caption",
        "no overlay",
    ];
    if negative_markers
        .iter()
        .any(|marker| normalized.contains(marker))
    {
        return false;
    }
    let positive_markers = [
        "加标题",
        "显示标题",
        "带标题",
        "片头标题",
        "加字幕",
        "字幕",
        "caption",
        "文案",
        "屏幕文字",
        "文字说明",
        "文字提示",
        "overlay",
        "title card",
        "on-screen text",
        "text overlay",
        "subtitle",
    ];
    positive_markers
        .iter()
        .any(|marker| normalized.contains(marker))
}

pub(super) fn strip_incidental_remotion_text_layers(scene: &mut Value) {
    let Some(scenes) = scene.get_mut("scenes").and_then(Value::as_array_mut) else {
        return;
    };
    for item in scenes.iter_mut() {
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        object.insert("overlayTitle".to_string(), Value::Null);
        object.insert("overlayBody".to_string(), Value::Null);
        object.insert("overlays".to_string(), json!([]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensures_export_extension_only_for_extensionless_names() {
        assert_eq!(
            ensure_export_extension(std::path::PathBuf::from("demo"), "zip"),
            std::path::PathBuf::from("demo.zip")
        );
        assert_eq!(
            ensure_export_extension(std::path::PathBuf::from("demo.txt"), "zip"),
            std::path::PathBuf::from("demo.txt")
        );
    }

    #[test]
    fn computes_downscale_only_remotion_scale() {
        assert_eq!(remotion_export_scale(3840, 2160, "1080p"), Some(0.5));
        assert_eq!(remotion_export_scale(720, 1280, "1080p"), None);
        assert_eq!(remotion_export_scale(1920, 1080, "custom"), None);
    }

    #[test]
    fn detects_requested_visual_text_layers() {
        assert!(instructions_request_visual_text_layers("加标题和字幕"));
        assert!(!instructions_request_visual_text_layers(
            "只要动画，不要字幕"
        ));
    }
}
