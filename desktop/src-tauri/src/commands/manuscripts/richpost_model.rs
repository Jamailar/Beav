use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(crate) const RICHPOST_FONT_SCALE_MIN: f64 = 0.8;
pub(crate) const RICHPOST_FONT_SCALE_MAX: f64 = 1.6;
pub(crate) const RICHPOST_LINE_HEIGHT_SCALE_MIN: f64 = 0.8;
pub(crate) const RICHPOST_LINE_HEIGHT_SCALE_MAX: f64 = 1.4;
pub(crate) const RICHPOST_PAGINATION_CANVAS_WIDTH_PX: f64 = 560.0;
pub(crate) const RICHPOST_PAGINATION_CANVAS_HEIGHT_PX: f64 = 560.0 * 4.0 / 3.0;
pub(crate) const RICHPOST_MASTER_COVER: &str = "cover";
pub(crate) const RICHPOST_MASTER_BODY: &str = "body";
pub(crate) const RICHPOST_MASTER_ENDING: &str = "ending";
pub(crate) const RICHPOST_DEFAULT_MASTER_NAMES: [&str; 3] = [
    RICHPOST_MASTER_COVER,
    RICHPOST_MASTER_BODY,
    RICHPOST_MASTER_ENDING,
];

#[derive(Debug, Clone, Copy)]
pub(crate) struct RichpostTypographySettings {
    pub(crate) font_scale: f64,
    pub(crate) line_height_scale: f64,
}

impl Default for RichpostTypographySettings {
    fn default() -> Self {
        Self {
            font_scale: 1.0,
            line_height_scale: 1.0,
        }
    }
}

#[derive(Clone, Copy)]
struct RichpostThemePreset {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    shell_bg: &'static str,
    preview_card_bg: &'static str,
    preview_card_border: &'static str,
    preview_card_shadow: &'static str,
    page_bg: &'static str,
    surface_bg: &'static str,
    surface_border: &'static str,
    surface_shadow: &'static str,
    surface_radius: &'static str,
    image_radius: &'static str,
    text: &'static str,
    muted: &'static str,
    accent: &'static str,
    heading_font: &'static str,
    body_font: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RichpostZoneFrame {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) w: f64,
    pub(crate) h: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RichpostThemeSpec {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) description: String,
    pub(crate) shell_bg: String,
    pub(crate) preview_card_bg: String,
    pub(crate) preview_card_border: String,
    pub(crate) preview_card_shadow: String,
    pub(crate) page_bg: String,
    pub(crate) surface_bg: String,
    pub(crate) surface_border: String,
    pub(crate) surface_shadow: String,
    pub(crate) surface_radius: String,
    pub(crate) image_radius: String,
    pub(crate) heading_color: String,
    pub(crate) body_color: String,
    pub(crate) text: String,
    pub(crate) muted: String,
    pub(crate) accent: String,
    pub(crate) heading_font: String,
    pub(crate) body_font: String,
    pub(crate) cover_frame: RichpostZoneFrame,
    pub(crate) body_frame: RichpostZoneFrame,
    pub(crate) ending_frame: RichpostZoneFrame,
    pub(crate) cover_background_path: String,
    pub(crate) body_background_path: String,
    pub(crate) ending_background_path: String,
    pub(crate) source: String,
}

fn richpost_theme_catalog() -> &'static [RichpostThemePreset] {
    &[]
}

fn richpost_theme_spec_from_preset(theme: &RichpostThemePreset) -> RichpostThemeSpec {
    RichpostThemeSpec {
        id: theme.id.to_string(),
        label: theme.label.to_string(),
        description: theme.description.to_string(),
        shell_bg: theme.shell_bg.to_string(),
        preview_card_bg: theme.preview_card_bg.to_string(),
        preview_card_border: theme.preview_card_border.to_string(),
        preview_card_shadow: theme.preview_card_shadow.to_string(),
        page_bg: theme.page_bg.to_string(),
        surface_bg: theme.surface_bg.to_string(),
        surface_border: theme.surface_border.to_string(),
        surface_shadow: theme.surface_shadow.to_string(),
        surface_radius: theme.surface_radius.to_string(),
        image_radius: theme.image_radius.to_string(),
        heading_color: theme.text.to_string(),
        body_color: theme.text.to_string(),
        text: theme.text.to_string(),
        muted: theme.muted.to_string(),
        accent: theme.accent.to_string(),
        heading_font: theme.heading_font.to_string(),
        body_font: theme.body_font.to_string(),
        cover_frame: default_richpost_zone_frame(RICHPOST_MASTER_COVER),
        body_frame: default_richpost_zone_frame(RICHPOST_MASTER_BODY),
        ending_frame: default_richpost_zone_frame(RICHPOST_MASTER_ENDING),
        cover_background_path: String::new(),
        body_background_path: String::new(),
        ending_background_path: String::new(),
        source: "builtin".to_string(),
    }
}

pub(crate) fn default_richpost_theme_spec() -> RichpostThemeSpec {
    RichpostThemeSpec {
        id: "default".to_string(),
        label: "默认主题".to_string(),
        description: String::new(),
        shell_bg: "linear-gradient(180deg,#fff8ef 0%,#f5ede1 100%)".to_string(),
        preview_card_bg: "rgba(255,255,255,.82)".to_string(),
        preview_card_border: "rgba(34,24,18,.08)".to_string(),
        preview_card_shadow: "0 18px 48px rgba(88,59,36,.08)".to_string(),
        page_bg: "#ffffff".to_string(),
        surface_bg: "#ffffff".to_string(),
        surface_border: "rgba(34,24,18,.08)".to_string(),
        surface_shadow: "0 14px 34px rgba(17,17,17,.06)".to_string(),
        surface_radius: "0px".to_string(),
        image_radius: "0px".to_string(),
        heading_color: "#111111".to_string(),
        body_color: "#111111".to_string(),
        text: "#111111".to_string(),
        muted: "#6b625a".to_string(),
        accent: "#111111".to_string(),
        heading_font: "\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif"
            .to_string(),
        body_font: "\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif"
            .to_string(),
        cover_frame: default_richpost_zone_frame(RICHPOST_MASTER_COVER),
        body_frame: default_richpost_zone_frame(RICHPOST_MASTER_BODY),
        ending_frame: default_richpost_zone_frame(RICHPOST_MASTER_ENDING),
        cover_background_path: String::new(),
        body_background_path: String::new(),
        ending_background_path: String::new(),
        source: "default".to_string(),
    }
}

pub(crate) fn richpost_theme_catalog_specs() -> Vec<RichpostThemeSpec> {
    richpost_theme_catalog()
        .iter()
        .map(richpost_theme_spec_from_preset)
        .collect::<Vec<_>>()
}

pub(crate) fn sanitize_richpost_theme_id_fragment(raw: &str) -> String {
    sanitize_richpost_master_name(raw).unwrap_or_else(|| "theme".to_string())
}

pub(crate) fn default_richpost_zone_frame(role: &str) -> RichpostZoneFrame {
    match role {
        RICHPOST_MASTER_COVER => RichpostZoneFrame {
            x: 0.12,
            y: 0.18,
            w: 0.76,
            h: 0.58,
        },
        RICHPOST_MASTER_ENDING => RichpostZoneFrame {
            x: 0.12,
            y: 0.24,
            w: 0.76,
            h: 0.48,
        },
        _ => RichpostZoneFrame {
            x: 0.08,
            y: 0.1,
            w: 0.84,
            h: 0.78,
        },
    }
}

pub(crate) fn richpost_theme_has_custom_cover_role(theme: &RichpostThemeSpec) -> bool {
    !theme.cover_background_path.trim().is_empty()
        || theme.cover_frame != default_richpost_zone_frame(RICHPOST_MASTER_COVER)
}

pub(crate) fn richpost_zone_frame_css_vars(
    frame: &RichpostZoneFrame,
) -> serde_json::Map<String, Value> {
    serde_json::Map::from_iter([
        (
            "--rb-frame-left".to_string(),
            json!(format!("{:.3}%", frame.x * 100.0)),
        ),
        (
            "--rb-frame-top".to_string(),
            json!(format!("{:.3}%", frame.y * 100.0)),
        ),
        (
            "--rb-frame-width".to_string(),
            json!(format!("{:.3}%", frame.w * 100.0)),
        ),
        (
            "--rb-frame-height".to_string(),
            json!(format!("{:.3}%", frame.h * 100.0)),
        ),
    ])
}

pub(crate) fn richpost_theme_background_relative_path(
    theme: &RichpostThemeSpec,
    role: &str,
) -> String {
    match role {
        RICHPOST_MASTER_COVER => theme.cover_background_path.clone(),
        RICHPOST_MASTER_ENDING => theme.ending_background_path.clone(),
        _ => theme.body_background_path.clone(),
    }
}

fn clamp_richpost_font_scale(value: f64) -> f64 {
    ((value.clamp(RICHPOST_FONT_SCALE_MIN, RICHPOST_FONT_SCALE_MAX)) * 100.0).round() / 100.0
}

fn clamp_richpost_line_height_scale(value: f64) -> f64 {
    ((value.clamp(
        RICHPOST_LINE_HEIGHT_SCALE_MIN,
        RICHPOST_LINE_HEIGHT_SCALE_MAX,
    )) * 100.0)
        .round()
        / 100.0
}

pub(crate) fn richpost_typography_settings(
    font_scale: Option<f64>,
    line_height_scale: Option<f64>,
) -> RichpostTypographySettings {
    RichpostTypographySettings {
        font_scale: clamp_richpost_font_scale(font_scale.unwrap_or(1.0)),
        line_height_scale: clamp_richpost_line_height_scale(line_height_scale.unwrap_or(1.0)),
    }
}

pub(crate) fn richpost_typography_settings_from_manifest(
    manifest: &Value,
) -> RichpostTypographySettings {
    let raw = manifest.get("richpostTypography");
    richpost_typography_settings(
        raw.and_then(|value| value.get("fontScale"))
            .and_then(Value::as_f64),
        raw.and_then(|value| value.get("lineHeightScale"))
            .and_then(Value::as_f64),
    )
}

pub(crate) fn write_richpost_typography_settings_to_manifest(
    manifest: &mut Value,
    settings: RichpostTypographySettings,
) {
    let Some(object) = manifest.as_object_mut() else {
        return;
    };
    if (settings.font_scale - 1.0).abs() < 0.001 && (settings.line_height_scale - 1.0).abs() < 0.001
    {
        object.remove("richpostTypography");
        return;
    }
    object.insert(
        "richpostTypography".to_string(),
        json!({
            "fontScale": settings.font_scale,
            "lineHeightScale": settings.line_height_scale,
        }),
    );
}

pub(crate) fn sanitize_richpost_master_name(raw: &str) -> Option<String> {
    let mut sanitized = String::new();
    let mut last_was_dash = false;
    for ch in raw.trim().chars() {
        let lowered = ch.to_ascii_lowercase();
        let is_valid = lowered.is_ascii_alphanumeric() || lowered == '-' || lowered == '_';
        if is_valid {
            sanitized.push(lowered);
            last_was_dash = false;
        } else if !last_was_dash {
            sanitized.push('-');
            last_was_dash = true;
        }
    }
    let normalized = sanitized.trim_matches('-').trim_matches('_').to_string();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

pub(crate) fn sanitize_richpost_css_var_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if !trimmed.starts_with("--rb-") {
        return None;
    }
    if trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        Some(trimmed.to_string())
    } else {
        None
    }
}

pub(crate) fn richpost_css_var_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

pub(crate) fn merge_richpost_css_var_object(
    target: &mut serde_json::Map<String, Value>,
    raw: Option<&Value>,
) {
    let Some(object) = raw.and_then(Value::as_object) else {
        return;
    };
    for (key, value) in object {
        let Some(name) = sanitize_richpost_css_var_name(key) else {
            continue;
        };
        let Some(serialized) = richpost_css_var_string(value) else {
            continue;
        };
        target.insert(name, json!(serialized));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typography_settings_clamp_to_supported_range() {
        let settings = richpost_typography_settings(Some(4.2), Some(0.1));

        assert_eq!(settings.font_scale, RICHPOST_FONT_SCALE_MAX);
        assert_eq!(settings.line_height_scale, RICHPOST_LINE_HEIGHT_SCALE_MIN);
    }

    #[test]
    fn merge_css_vars_accepts_only_richpost_vars() {
        let mut target = serde_json::Map::new();

        merge_richpost_css_var_object(
            &mut target,
            Some(&json!({
                "--rb-text": " #111 ",
                "--bad-text": "#222",
                "--rb-invalid;": "#333",
                "--rb-count": 3
            })),
        );

        assert_eq!(
            target.get("--rb-text").and_then(Value::as_str),
            Some("#111")
        );
        assert_eq!(target.get("--rb-count").and_then(Value::as_str), Some("3"));
        assert!(!target.contains_key("--bad-text"));
        assert!(!target.contains_key("--rb-invalid;"));
    }
}
