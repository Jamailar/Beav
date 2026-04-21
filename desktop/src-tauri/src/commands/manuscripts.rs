use crate::commands::library::persist_media_workspace_catalog;
use crate::manuscript_package::{
    animation_layers_from_remotion_scene, build_default_remotion_scene,
    default_video_script_approval, ensure_manifest_video_ai_state, get_video_project_state,
    hydrate_editor_project_motion_from_remotion, normalized_remotion_render_config,
    persist_remotion_composition_artifacts, video_project_brief_from_manifest,
    video_script_state_from_manifest,
};
use crate::persistence::{with_store, with_store_mut};
use crate::skills::{load_skill_bundle_sections_from_sources, split_skill_body};
use crate::*;
use base64::Engine;
use pulldown_cmark::{
    html::push_html, Event as MarkdownEvent, Options as MarkdownOptions, Parser as MarkdownParser,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use tauri::{AppHandle, State};

#[path = "manuscripts/theme/mod.rs"]
mod theme;

const DEFAULT_TIMELINE_CLIP_MS: i64 = 4000;
const IMAGE_TIMELINE_CLIP_MS: i64 = 500;
const DEFAULT_MIN_CLIP_MS: i64 = 1000;
const DEFAULT_EDITOR_MOTION_PROMPT: &str =
    "请根据当前时间线和脚本，生成适合短视频的对象动画与节奏设计。默认不要额外标题、说明或字幕。";
const PACKAGE_HTML_LAYOUT_TARGET: &str = "layout";
const PACKAGE_HTML_WECHAT_TARGET: &str = "wechat";
const RICHPOST_FONT_SCALE_MIN: f64 = 0.8;
const RICHPOST_FONT_SCALE_MAX: f64 = 1.6;
const RICHPOST_LINE_HEIGHT_SCALE_MIN: f64 = 0.8;
const RICHPOST_LINE_HEIGHT_SCALE_MAX: f64 = 1.4;
const RICHPOST_PAGINATION_CANVAS_WIDTH_PX: f64 = 560.0;
const RICHPOST_PAGINATION_CANVAS_HEIGHT_PX: f64 = 560.0 * 4.0 / 3.0;
const RICHPOST_THEME_PREVIEW_TITLE: &str = "RedBox";
const RICHPOST_THEME_PREVIEW_BODY: &str = "用 AI 生产高质量内容。";
const RICHPOST_MASTER_COVER: &str = "cover";
const RICHPOST_MASTER_BODY: &str = "body";
const RICHPOST_MASTER_ENDING: &str = "ending";
const RICHPOST_DEFAULT_MASTER_NAMES: [&str; 3] = [
    RICHPOST_MASTER_COVER,
    RICHPOST_MASTER_BODY,
    RICHPOST_MASTER_ENDING,
];

#[derive(Debug, Clone)]
struct ParsedPackageBlock {
    kind: String,
    level: Option<u8>,
    text: String,
}

#[derive(Debug, Clone)]
struct PackageContentBlock {
    id: String,
    slot: String,
    kind: String,
    level: Option<u8>,
    text: String,
    order: usize,
    char_count: usize,
}

#[derive(Debug, Clone)]
struct PackageBoundAsset {
    id: String,
    title: String,
    url: String,
    role: String,
}

#[derive(Default)]
struct RichpostAutoPageDraft {
    title_block_ids: Vec<String>,
    body_block_ids: Vec<String>,
    body_fragments: Vec<Value>,
    title_height_px: f64,
    body_height_px: f64,
}

#[derive(Debug, Clone, Copy)]
struct RichpostTypographySettings {
    font_scale: f64,
    line_height_scale: f64,
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

#[derive(Clone, Copy)]
struct LongformLayoutPreset {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    surface_bg: &'static str,
    text: &'static str,
    accent: &'static str,
    layout_instructions: &'static str,
    wechat_instructions: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct RichpostZoneFrame {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RichpostThemeSpec {
    id: String,
    label: String,
    description: String,
    shell_bg: String,
    preview_card_bg: String,
    preview_card_border: String,
    preview_card_shadow: String,
    page_bg: String,
    surface_bg: String,
    surface_border: String,
    surface_shadow: String,
    surface_radius: String,
    image_radius: String,
    heading_color: String,
    body_color: String,
    text: String,
    muted: String,
    accent: String,
    heading_font: String,
    body_font: String,
    cover_frame: RichpostZoneFrame,
    body_frame: RichpostZoneFrame,
    ending_frame: RichpostZoneFrame,
    cover_background_path: String,
    body_background_path: String,
    ending_background_path: String,
    source: String,
}

fn blank_richpost_theme_spec() -> RichpostThemeSpec {
    RichpostThemeSpec {
        id: "blank-template".to_string(),
        label: "空白主题模板".to_string(),
        description: "用于新建 richpost 主题的空白起点，不继承当前稿件样式。".to_string(),
        shell_bg: "#f6f1e8".to_string(),
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
        source: "template".to_string(),
    }
}

fn default_richpost_theme_template_guide() -> String {
    r#"# Richpost Blank Theme Template

这个文件是 richpost 主题编辑的空白模板说明，供 AI 和开发者读取。

## 当前主题的真实编辑目标

- `richpost-themes.json`
  - 当前主题记录保存在这里
  - 重点字段：
    - `coverFrame` / `bodyFrame` / `endingFrame`
    - `coverBackgroundPath` / `bodyBackgroundPath` / `endingBackgroundPath`
    - `headingColor` / `bodyColor` / `accentColor` / `mutedColor`
    - `headingFont` / `bodyFont`
- `layout.tokens.json`
  - 负责页面级 token，例如颜色、字号、行高、边距、圆角、阴影
- `masters/cover.master.html`
  - 首页母版
- `masters/body.master.html`
  - 内容页母版
- `masters/ending.master.html`
  - 尾页母版
- `richpost-page-plan.json`
  - 决定每一页使用哪张母版和哪些 zones

## 规则

1. 不要改 `content.md`
2. 不要把正文直接硬编码进母版 HTML
3. 背景图必须落在背景层，文字在其上
4. 文字真实区域由 `coverFrame` / `bodyFrame` / `endingFrame` 控制
5. 首页、内容页、尾页可以各自有不同背景、容器和颜色

## 推荐做法

- 想改颜色、字体、基础视觉：优先改 `richpost-themes.json` 和 `layout.tokens.json`
- 想改背景层、容器、遮罩、装饰：优先改 `masters/*.master.html`
- 想改哪页用哪种母版：再改 `richpost-page-plan.json`

## 兼容性边界

- 可以自由调整：
  - 背景色
  - 背景图
  - 容器
  - 圆角
  - 边框
  - 阴影
  - 标题/正文颜色
  - 标题/正文字体
  - 文字区域大小和位置
- 不要引入外部字体 URL、远程 CSS 或远程 JS
"#
    .to_string()
}

pub(crate) fn ensure_richpost_theme_template_file(
    package_path: &std::path::Path,
) -> Result<(), String> {
    let path = package_richpost_theme_template_path(package_path);
    if path.exists() {
        return Ok(());
    }
    write_text_file(&path, &default_richpost_theme_template_guide())
}

fn richpost_theme_catalog() -> &'static [RichpostThemePreset] {
    &[]
}

fn longform_layout_preset_catalog() -> &'static [LongformLayoutPreset] {
    &[
        LongformLayoutPreset {
            id: "clean-reading",
            label: "清朗阅读",
            description: "简洁阅读页，标题清楚，正文克制，适合大多数长文稿件。",
            surface_bg: "#ffffff",
            text: "#171717",
            accent: "#171717",
            layout_instructions: "采用清晰、克制、稳定的长文阅读页。可以有导语区、章节分隔和轻量强调，但不要花哨。正文默认单栏，只有在局部信息块确实需要时才做双栏。",
            wechat_instructions: "转成适合公众号正文的清朗单栏版式。标题、导语、引用层级明确，段落宽度和留白稳定，不要做真正多栏正文。",
        },
        LongformLayoutPreset {
            id: "editorial-columns",
            label: "杂志分栏",
            description: "更强的版面感，适合专题、评论和叙事型长文。",
            surface_bg: "#fbf7f0",
            text: "#241d18",
            accent: "#8c5a34",
            layout_instructions: "采用偏杂志化的长文母版。允许在 layout.html 中使用双栏正文、跨栏章节标题、导语卡片和图片穿插，但阅读仍要稳定，不要做网页导航。",
            wechat_instructions: "保留杂志感的气质，但必须适配公众号单栏正文。可以用大标题、导语卡片、章节分隔和图片穿插，不要保留真实双栏排版。",
        },
        LongformLayoutPreset {
            id: "serif-notes",
            label: "衬线笔记",
            description: "偏文稿和随笔感，适合观点、读书、散文类长文。",
            surface_bg: "#f8f3ea",
            text: "#2e261f",
            accent: "#7a5636",
            layout_instructions: "采用偏文稿和随笔感的长文版式。标题可以用衬线感更强的层级，正文节奏舒展，留白更宽，强调阅读沉浸感。",
            wechat_instructions: "保持文稿和随笔气质，但仍按公众号单栏阅读页输出。可以强化标题、引文和章节间距，不要出现多栏正文或复杂浮动布局。",
        },
        LongformLayoutPreset {
            id: "report-brief",
            label: "信息简报",
            description: "更适合方法、复盘、知识整理和说明型长文。",
            surface_bg: "#f5f8fc",
            text: "#1d2733",
            accent: "#1f5fa6",
            layout_instructions: "采用更偏信息简报的长文母版。适合清晰的小标题、摘要框、清单、引用和图文说明。layout.html 可以局部使用两栏信息区，但正文主链路仍以易读为先。",
            wechat_instructions: "把信息简报风格转成公众号友好的单栏信息阅读页。摘要框、清单、提示块可以保留，但正文保持单栏，不做报表式分栏。",
        },
    ]
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

fn default_richpost_theme_spec() -> RichpostThemeSpec {
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

fn richpost_theme_catalog_specs() -> Vec<RichpostThemeSpec> {
    richpost_theme_catalog()
        .iter()
        .map(richpost_theme_spec_from_preset)
        .collect::<Vec<_>>()
}

fn sanitize_richpost_theme_text(raw: Option<&str>, fallback: &str) -> String {
    let sanitized = raw.unwrap_or("").trim().replace(['<', '>', '{', '}'], "");
    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn sanitize_richpost_theme_label(raw: Option<&str>, fallback: &str) -> String {
    let normalized = raw
        .unwrap_or("")
        .trim()
        .replace(['\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.is_empty() {
        fallback.to_string()
    } else {
        normalized.chars().take(32).collect::<String>()
    }
}

fn sanitize_richpost_theme_description(raw: Option<&str>) -> String {
    raw.unwrap_or("")
        .trim()
        .replace(['\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(120)
        .collect::<String>()
}

fn sanitize_richpost_theme_id_fragment(raw: &str) -> String {
    sanitize_richpost_master_name(raw).unwrap_or_else(|| "theme".to_string())
}

fn default_richpost_zone_frame(role: &str) -> RichpostZoneFrame {
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

fn normalize_richpost_zone_frame(
    raw: Option<&Value>,
    fallback: RichpostZoneFrame,
) -> RichpostZoneFrame {
    let raw_x = raw
        .and_then(|value| value.get("x"))
        .and_then(Value::as_f64)
        .unwrap_or(fallback.x);
    let raw_y = raw
        .and_then(|value| value.get("y"))
        .and_then(Value::as_f64)
        .unwrap_or(fallback.y);
    let raw_w = raw
        .and_then(|value| value.get("w"))
        .or_else(|| raw.and_then(|value| value.get("width")))
        .and_then(Value::as_f64)
        .unwrap_or(fallback.w);
    let raw_h = raw
        .and_then(|value| value.get("h"))
        .or_else(|| raw.and_then(|value| value.get("height")))
        .and_then(Value::as_f64)
        .unwrap_or(fallback.h);

    let mut x = raw_x.clamp(0.0, 0.92);
    let mut y = raw_y.clamp(0.0, 0.92);
    let mut w = raw_w.clamp(0.08, 1.0);
    let mut h = raw_h.clamp(0.08, 1.0);

    if x + w > 1.0 {
        if w >= 1.0 {
            x = 0.0;
            w = 1.0;
        } else {
            x = (1.0 - w).max(0.0);
        }
    }
    if y + h > 1.0 {
        if h >= 1.0 {
            y = 0.0;
            h = 1.0;
        } else {
            y = (1.0 - h).max(0.0);
        }
    }

    RichpostZoneFrame {
        x: ((x * 1000.0).round() / 1000.0),
        y: ((y * 1000.0).round() / 1000.0),
        w: ((w * 1000.0).round() / 1000.0),
        h: ((h * 1000.0).round() / 1000.0),
    }
}

fn richpost_theme_frame(theme: &RichpostThemeSpec, role: &str) -> RichpostZoneFrame {
    match role {
        RICHPOST_MASTER_COVER => theme.cover_frame.clone(),
        RICHPOST_MASTER_ENDING => theme.ending_frame.clone(),
        _ => theme.body_frame.clone(),
    }
}

fn richpost_theme_has_custom_cover_role(theme: &RichpostThemeSpec) -> bool {
    !theme.cover_background_path.trim().is_empty()
        || theme.cover_frame != default_richpost_zone_frame(RICHPOST_MASTER_COVER)
}

fn richpost_theme_preview_master(theme: &RichpostThemeSpec) -> &'static str {
    if !theme.cover_background_path.trim().is_empty() {
        RICHPOST_MASTER_COVER
    } else if !theme.body_background_path.trim().is_empty() {
        RICHPOST_MASTER_BODY
    } else if !theme.ending_background_path.trim().is_empty() {
        RICHPOST_MASTER_ENDING
    } else {
        RICHPOST_MASTER_BODY
    }
}

fn richpost_zone_frame_css_vars(frame: &RichpostZoneFrame) -> serde_json::Map<String, Value> {
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

fn sanitize_richpost_theme_background_path(raw: Option<&str>) -> String {
    normalize_relative_path(raw.unwrap_or(""))
        .chars()
        .take(240)
        .collect::<String>()
}

fn richpost_theme_background_relative_path(theme: &RichpostThemeSpec, role: &str) -> String {
    match role {
        RICHPOST_MASTER_COVER => theme.cover_background_path.clone(),
        RICHPOST_MASTER_ENDING => theme.ending_background_path.clone(),
        _ => theme.body_background_path.clone(),
    }
}

fn richpost_theme_background_storage_dir(
    package_path: &std::path::Path,
    theme_id: &str,
) -> std::path::PathBuf {
    theme::store::richpost_theme_background_storage_dir(package_path, theme_id)
}

fn resolve_richpost_theme_background_absolute_path(
    package_path: &std::path::Path,
    relative_path: &str,
) -> Option<std::path::PathBuf> {
    theme::store::resolve_richpost_theme_background_absolute_path(package_path, relative_path)
}

fn global_richpost_theme_background_relative_path(
    package_path: &std::path::Path,
    theme_id: &str,
    file_name: &str,
) -> String {
    theme::store::global_richpost_theme_background_relative_path(package_path, theme_id, file_name)
}

fn richpost_theme_background_relative_file_name(
    theme_id: &str,
    role: &str,
    extension: &str,
) -> String {
    let role_fragment = sanitize_richpost_master_name(role).unwrap_or_else(|| "body".to_string());
    let theme_fragment = sanitize_richpost_theme_id_fragment(theme_id);
    let timestamp = now_i64();
    if extension.trim().is_empty() {
        format!("{timestamp}-{theme_fragment}-{role_fragment}")
    } else {
        format!(
            "{timestamp}-{theme_fragment}-{role_fragment}.{}",
            extension.trim_matches('.')
        )
    }
}

fn next_richpost_custom_theme_label(package_path: &std::path::Path) -> String {
    theme::store::next_richpost_custom_theme_label(package_path)
}

fn read_custom_richpost_theme_specs(package_path: &std::path::Path) -> Vec<RichpostThemeSpec> {
    theme::store::read_custom_richpost_theme_specs(package_path)
}

fn write_custom_richpost_theme_specs(
    package_path: &std::path::Path,
    themes: &[RichpostThemeSpec],
) -> Result<(), String> {
    theme::store::write_custom_richpost_theme_specs(package_path, themes)
}

fn richpost_theme_spec_storage_value(theme: &RichpostThemeSpec) -> Value {
    theme::store::richpost_theme_spec_storage_value(theme)
}

fn write_applied_richpost_theme_to_manifest(manifest: &mut Value, theme: &RichpostThemeSpec) {
    theme::store::write_applied_richpost_theme_to_manifest(manifest, theme);
}

fn richpost_theme_spec_payload_value(theme: &RichpostThemeSpec) -> Value {
    theme::store::richpost_theme_spec_payload_value(theme)
}

fn sync_richpost_theme_root_from_package(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
    create_from_blank: bool,
) -> Result<(), String> {
    theme::store::sync_richpost_theme_root_from_package(package_path, theme, create_from_blank)
}

fn sync_package_from_richpost_theme_root(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
) -> Result<(), String> {
    theme::store::sync_package_from_richpost_theme_root(package_path, theme)
}

fn richpost_theme_root_master_path_for_theme(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
    master_name: &str,
) -> Option<std::path::PathBuf> {
    theme::store::richpost_theme_root_master_path_for_theme(package_path, theme, master_name)
}

fn richpost_theme_catalog_for_package(
    package_path: Option<&std::path::Path>,
) -> Vec<RichpostThemeSpec> {
    theme::store::richpost_theme_catalog_for_package(package_path)
}

fn richpost_theme_spec_from_manifest(
    package_path: Option<&std::path::Path>,
    manifest: &Value,
) -> RichpostThemeSpec {
    theme::store::richpost_theme_spec_from_manifest(package_path, manifest)
}

fn richpost_theme_spec_by_id(
    package_path: Option<&std::path::Path>,
    theme_id: &str,
) -> RichpostThemeSpec {
    theme::store::richpost_theme_spec_by_id(package_path, theme_id)
}

fn normalize_richpost_theme_draft(
    raw: &Value,
    base_theme: &RichpostThemeSpec,
    existing_theme_id: Option<&str>,
    package_path: &std::path::Path,
) -> RichpostThemeSpec {
    theme::store::normalize_richpost_theme_draft(raw, base_theme, existing_theme_id, package_path)
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

fn richpost_typography_settings(
    font_scale: Option<f64>,
    line_height_scale: Option<f64>,
) -> RichpostTypographySettings {
    RichpostTypographySettings {
        font_scale: clamp_richpost_font_scale(font_scale.unwrap_or(1.0)),
        line_height_scale: clamp_richpost_line_height_scale(line_height_scale.unwrap_or(1.0)),
    }
}

fn richpost_typography_settings_from_manifest(manifest: &Value) -> RichpostTypographySettings {
    let raw = manifest.get("richpostTypography");
    richpost_typography_settings(
        raw.and_then(|value| value.get("fontScale"))
            .and_then(Value::as_f64),
        raw.and_then(|value| value.get("lineHeightScale"))
            .and_then(Value::as_f64),
    )
}

fn write_richpost_typography_settings_to_manifest(
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

fn longform_layout_preset(preset_id: &str) -> &'static LongformLayoutPreset {
    longform_layout_preset_catalog()
        .iter()
        .find(|preset| preset.id == preset_id.trim())
        .unwrap_or(&longform_layout_preset_catalog()[0])
}

fn longform_layout_preset_from_manifest(manifest: &Value) -> &'static LongformLayoutPreset {
    manifest
        .get("longformLayoutPresetId")
        .and_then(Value::as_str)
        .map(longform_layout_preset)
        .unwrap_or(&longform_layout_preset_catalog()[0])
}

fn sanitize_richpost_master_name(raw: &str) -> Option<String> {
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

fn sanitize_richpost_css_var_name(raw: &str) -> Option<String> {
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

fn richpost_css_var_string(value: &Value) -> Option<String> {
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

fn merge_richpost_css_var_object(target: &mut serde_json::Map<String, Value>, raw: Option<&Value>) {
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

fn default_richpost_master_fragment(master_name: &str) -> &'static str {
    let _ = master_name;
    r#"<!--
RedBox richpost master scaffold.
- 保留 zone 占位符，不要把正文直接写进母版
- 背景层使用 rb-zone-background，默认位于文字下方
- 真实文字区域由 --rb-frame-left / top / width / height 控制
- 可以自由增加容器、遮罩、装饰，但不要删掉 title/body/media/footer 区
-->
<style>
.rb-page-host .rb-stage {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 100%;
}
.rb-page-host .rb-zone-background,
.rb-page-host .rb-zone-overlay,
.rb-page-host .rb-zone-decoration {
  position: absolute;
  inset: 0;
}
.rb-page-host .rb-zone-background {
  background-image: var(--rb-background-image, none);
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;
}
.rb-page-host .rb-zone-background .page-asset,
.rb-page-host .rb-zone-background img {
  width: 100%;
  height: 100%;
}
.rb-page-host .rb-zone-background img {
  object-fit: cover;
}
.rb-page-host .rb-stage-frame {
  position: absolute;
  left: var(--rb-frame-left, 8%);
  top: var(--rb-frame-top, 10%);
  width: var(--rb-frame-width, 84%);
  height: var(--rb-frame-height, 78%);
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: var(--rb-zone-gap);
  align-items: flex-start;
  justify-content: flex-start;
  overflow: hidden;
}
.rb-page-host .rb-zone-title,
.rb-page-host .rb-zone-body,
.rb-page-host .rb-zone-media,
.rb-page-host .rb-zone-footer {
  width: 100%;
  max-width: 100%;
}
.rb-page-host .rb-zone-media .page-asset img {
  object-fit: cover;
}
</style>
<div class="rb-stage">
  <div class="rb-zone rb-zone-background">{{zone:background}}</div>
  <div class="rb-zone rb-zone-overlay">{{zone:overlay}}</div>
  <div class="rb-zone rb-zone-decoration">{{zone:decoration}}</div>
  <div class="rb-stage-frame" data-zone-frame="content">
    <header class="rb-zone rb-zone-title">{{zone:title}}</header>
    <main class="rb-zone rb-zone-body">{{zone:body}}</main>
    <div class="rb-zone rb-zone-media">{{zone:media}}</div>
    <footer class="rb-zone rb-zone-footer">{{zone:footer}}</footer>
  </div>
</div>"#
}

fn richpost_master_file_needs_upgrade(path: &std::path::Path) -> bool {
    let Ok(content) = fs::read_to_string(path) else {
        return true;
    };
    !content.contains("data-zone-frame=\"content\"")
        || !content.contains("--rb-frame-left")
        || content.contains("min-height: var(--rb-frame-height")
        || !content.contains(
            ".rb-page-host .rb-stage {\n  position: relative;\n  width: 100%;\n  height: 100%;",
        )
        || content.contains("rb-stage-stack")
}

fn ensure_richpost_layout_scaffold(
    package_path: &std::path::Path,
    manifest: &Value,
) -> Result<Value, String> {
    theme::scaffold::ensure_richpost_layout_scaffold(package_path, manifest)
}

#[allow(dead_code)]
pub(crate) fn richpost_theme_catalog_value(package_path: Option<&std::path::Path>) -> Value {
    theme::scaffold::richpost_theme_catalog_value(package_path)
}

pub(crate) fn richpost_theme_catalog_value_for_manifest(
    package_path: Option<&std::path::Path>,
    manifest: &Value,
) -> Value {
    theme::scaffold::richpost_theme_catalog_value_for_manifest(package_path, manifest)
}

pub(crate) fn richpost_theme_state_value(
    package_path: &std::path::Path,
    manifest: &Value,
) -> Value {
    theme::scaffold::richpost_theme_state_value(package_path, manifest)
}

pub(crate) fn longform_layout_preset_catalog_value() -> Value {
    json!(longform_layout_preset_catalog()
        .iter()
        .map(|preset| {
            json!({
                "id": preset.id,
                "label": preset.label,
                "description": preset.description,
                "surfaceColor": preset.surface_bg,
                "textColor": preset.text,
                "accentColor": preset.accent
            })
        })
        .collect::<Vec<_>>())
}

pub(crate) fn longform_layout_preset_state_value(manifest: &Value) -> Value {
    let preset = longform_layout_preset_from_manifest(manifest);
    json!({
        "id": preset.id,
        "label": preset.label,
        "description": preset.description
    })
}

fn package_block_is_page_break(kind: &str) -> bool {
    kind == "page-break"
}

fn normalize_manuscript_title_candidate(value: &str) -> String {
    let mut normalized = String::new();
    let mut last_was_space = false;
    for ch in value.trim().chars() {
        let mapped = if matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            '-'
        } else {
            ch
        };
        if mapped.is_whitespace() {
            if !last_was_space {
                normalized.push(' ');
                last_was_space = true;
            }
            continue;
        }
        normalized.push(mapped);
        last_was_space = false;
    }
    normalized.trim().to_string()
}

fn is_untitled_manuscript_label(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized.is_empty() || normalized == "未命名" || normalized.starts_with("untitled-")
}

fn is_auto_generated_manuscript_stem(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && (trimmed.chars().all(|ch| ch.is_ascii_digit())
            || trimmed.eq_ignore_ascii_case("untitled")
            || trimmed.to_ascii_lowercase().starts_with("untitled-"))
}

fn first_markdown_heading_text(content: &str) -> Option<String> {
    let normalized = strip_markdown_frontmatter(content).replace("\r\n", "\n");
    normalized
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .find_map(|line| parse_markdown_heading(line).map(|(_, text)| text))
        .map(|text| normalize_manuscript_title_candidate(&text))
        .filter(|text| !text.is_empty())
}

fn build_manuscript_renamed_relative_path(
    current_relative: &str,
    current_file_name: &str,
    next_stem: &str,
) -> String {
    let parent_rel = normalize_relative_path(
        current_relative
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or(""),
    );
    let mut target_relative = join_relative(&parent_rel, next_stem);
    if !target_relative.contains('.') {
        if current_file_name.ends_with(ARTICLE_DRAFT_EXTENSION) {
            target_relative = format!(
                "{}{}",
                normalize_relative_path(&target_relative),
                ARTICLE_DRAFT_EXTENSION
            );
        } else if current_file_name.ends_with(POST_DRAFT_EXTENSION) {
            target_relative = format!(
                "{}{}",
                normalize_relative_path(&target_relative),
                POST_DRAFT_EXTENSION
            );
        } else if current_file_name.ends_with(VIDEO_DRAFT_EXTENSION) {
            target_relative = format!(
                "{}{}",
                normalize_relative_path(&target_relative),
                VIDEO_DRAFT_EXTENSION
            );
        } else if current_file_name.ends_with(AUDIO_DRAFT_EXTENSION) {
            target_relative = format!(
                "{}{}",
                normalize_relative_path(&target_relative),
                AUDIO_DRAFT_EXTENSION
            );
        } else {
            target_relative = ensure_markdown_extension(&target_relative);
        }
    } else {
        target_relative = normalize_relative_path(&target_relative);
    }
    target_relative
}

fn choose_auto_named_manuscript_relative(
    state: &State<'_, AppState>,
    current_relative: &str,
    current_file_name: &str,
    next_title: &str,
) -> Result<String, String> {
    let base_title = normalize_manuscript_title_candidate(next_title);
    if base_title.is_empty() {
        return Ok(normalize_relative_path(current_relative));
    }
    let current_normalized = normalize_relative_path(current_relative);
    let mut attempt = 0usize;
    loop {
        let candidate_title = if attempt == 0 {
            base_title.clone()
        } else {
            format!("{}-{}", base_title, attempt + 1)
        };
        let candidate_relative = build_manuscript_renamed_relative_path(
            &current_normalized,
            current_file_name,
            &candidate_title,
        );
        if candidate_relative == current_normalized {
            return Ok(candidate_relative);
        }
        let candidate_path = resolve_manuscript_path(state, &candidate_relative)?;
        if !candidate_path.exists() {
            return Ok(candidate_relative);
        }
        attempt += 1;
    }
}

fn ensure_export_extension(path: std::path::PathBuf, extension: &str) -> std::path::PathBuf {
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

fn remotion_export_scale(width: i64, height: i64, preset: &str) -> Option<f64> {
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

fn instructions_request_visual_text_layers(instructions: &str) -> bool {
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

fn strip_incidental_remotion_text_layers(scene: &mut Value) {
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

fn min_clip_duration_ms_for_asset_kind(asset_kind: &str) -> i64 {
    if asset_kind.eq_ignore_ascii_case("image") {
        IMAGE_TIMELINE_CLIP_MS
    } else {
        DEFAULT_MIN_CLIP_MS
    }
}

fn ensure_editor_project_ai_state(
    project: &mut Value,
) -> Result<&mut serde_json::Map<String, Value>, String> {
    let project_object = project
        .as_object_mut()
        .ok_or_else(|| "Editor project must be an object".to_string())?;
    let ai = project_object
        .entry("ai".to_string())
        .or_insert_with(|| json!({}));
    if !ai.is_object() {
        *ai = json!({});
    }
    let ai_object = ai
        .as_object_mut()
        .ok_or_else(|| "Editor project ai must be an object".to_string())?;
    ai_object
        .entry("motionPrompt".to_string())
        .or_insert(json!(DEFAULT_EDITOR_MOTION_PROMPT));
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
    let approval_object = approval
        .as_object_mut()
        .ok_or_else(|| "Editor project scriptApproval must be an object".to_string())?;
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
    Ok(ai_object)
}

fn package_script_state_value(project: &Value) -> Value {
    let approval = project
        .pointer("/ai/scriptApproval")
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "status": "pending",
                "lastScriptUpdateAt": Value::Null,
                "lastScriptUpdateSource": Value::Null,
                "confirmedAt": Value::Null
            })
        });
    json!({
        "body": project
            .pointer("/script/body")
            .and_then(|value| value.as_str())
            .unwrap_or(""),
        "approval": approval
    })
}

fn package_video_script_state_value(
    package_path: &std::path::Path,
    file_name: &str,
    manifest: &Value,
) -> Value {
    let script_body =
        fs::read_to_string(package_entry_path(package_path, file_name, Some(manifest)))
            .unwrap_or_default();
    video_script_state_from_manifest(manifest, &script_body)
}

fn mark_manifest_video_script_pending(manifest: &mut Value, source: &str) -> Result<(), String> {
    let video_ai = ensure_manifest_video_ai_state(manifest)?;
    let approval = video_ai
        .get_mut("scriptApproval")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Manifest videoAi.scriptApproval must be an object".to_string())?;
    approval.insert("status".to_string(), json!("pending"));
    approval.insert("lastScriptUpdateAt".to_string(), json!(now_i64()));
    approval.insert(
        "lastScriptUpdateSource".to_string(),
        if source.trim().is_empty() {
            Value::Null
        } else {
            json!(source)
        },
    );
    approval.insert("confirmedAt".to_string(), Value::Null);
    Ok(())
}

fn confirm_manifest_video_script(manifest: &mut Value) -> Result<Value, String> {
    let video_ai = ensure_manifest_video_ai_state(manifest)?;
    let approval = video_ai
        .get_mut("scriptApproval")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Manifest videoAi.scriptApproval must be an object".to_string())?;
    if approval
        .get("lastScriptUpdateAt")
        .map(Value::is_null)
        .unwrap_or(true)
    {
        approval.insert("lastScriptUpdateAt".to_string(), json!(now_i64()));
    }
    approval.insert("status".to_string(), json!("confirmed"));
    approval.insert("confirmedAt".to_string(), json!(now_i64()));
    Ok(manifest
        .pointer("/videoAi/scriptApproval")
        .cloned()
        .unwrap_or_else(|| default_video_script_approval("system")))
}

fn persist_video_project_brief(
    package_path: &std::path::Path,
    brief: &str,
    source: &str,
) -> Result<(Value, Value), String> {
    let mut manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    if let Some(object) = manifest.as_object_mut() {
        object.insert("updatedAt".to_string(), json!(now_i64()));
    }
    let video_ai = ensure_manifest_video_ai_state(&mut manifest)?;
    let normalized_brief = brief.trim();
    video_ai.insert(
        "brief".to_string(),
        if normalized_brief.is_empty() {
            Value::Null
        } else {
            json!(normalized_brief)
        },
    );
    video_ai.insert("lastBriefUpdateAt".to_string(), json!(now_i64()));
    video_ai.insert(
        "lastBriefUpdateSource".to_string(),
        if source.trim().is_empty() {
            Value::Null
        } else {
            json!(source)
        },
    );
    write_json_value(&package_manifest_path(package_path), &manifest)?;
    Ok((
        get_manuscript_package_state(package_path)?,
        video_project_brief_from_manifest(&manifest),
    ))
}

fn normalize_video_project_asset_kind(input: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = input.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let normalized = raw.to_ascii_lowercase();
    match normalized.as_str() {
        "reference-image" | "voice-reference" | "keyframe" | "clip" | "output" | "other" => {
            Ok(Some(normalized))
        }
        _ => Err(
            "kind must be one of reference-image, voice-reference, keyframe, clip, output, other"
                .to_string(),
        ),
    }
}

fn mark_editor_project_script_pending(
    project: &mut Value,
    content: &str,
    source: &str,
) -> Result<(), String> {
    let project_object = project
        .as_object_mut()
        .ok_or_else(|| "Editor project must be an object".to_string())?;
    let script = project_object
        .entry("script".to_string())
        .or_insert_with(|| json!({}));
    if !script.is_object() {
        *script = json!({});
    }
    if let Some(script_object) = script.as_object_mut() {
        script_object.insert("body".to_string(), json!(content));
    }
    let ai_object = ensure_editor_project_ai_state(project)?;
    ai_object.insert("lastEditBrief".to_string(), Value::Null);
    ai_object.insert("lastMotionBrief".to_string(), Value::Null);
    let approval = ai_object
        .get_mut("scriptApproval")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Editor project scriptApproval must be an object".to_string())?;
    approval.insert("status".to_string(), json!("pending"));
    approval.insert("lastScriptUpdateAt".to_string(), json!(now_i64()));
    approval.insert("lastScriptUpdateSource".to_string(), json!(source));
    approval.insert("confirmedAt".to_string(), Value::Null);
    Ok(())
}

fn confirm_editor_project_script(project: &mut Value) -> Result<Value, String> {
    let ai_object = ensure_editor_project_ai_state(project)?;
    let approval = ai_object
        .get_mut("scriptApproval")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Editor project scriptApproval must be an object".to_string())?;
    if approval
        .get("lastScriptUpdateAt")
        .map(Value::is_null)
        .unwrap_or(true)
    {
        approval.insert("lastScriptUpdateAt".to_string(), json!(now_i64()));
    }
    approval.insert("status".to_string(), json!("confirmed"));
    approval.insert("confirmedAt".to_string(), json!(now_i64()));
    Ok(project
        .pointer("/ai/scriptApproval")
        .cloned()
        .unwrap_or(Value::Null))
}

fn first_orchestration_output_artifact(orchestration: &Value) -> Result<(String, String), String> {
    let output = orchestration
        .get("outputs")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .ok_or_else(|| "动画子代理没有返回输出".to_string())?;
    let status = output
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if status != "completed" {
        let summary = output
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("动画子代理执行失败");
        return Err(summary.to_string());
    }
    let artifact = output
        .get("artifact")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            output
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("动画子代理未返回 artifact")
                .to_string()
        })?;
    let summary = output
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok((artifact.to_string(), summary))
}

fn run_animation_director_subagent(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    model_config: Option<&Value>,
    user_input: &str,
) -> Result<(Value, String), String> {
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let base_prompt_patch =
        load_redbox_prompt("runtime/agents/video_editor/animation_director.txt")
            .unwrap_or_default();
    let skill_prompt_patch = build_remotion_best_practices_prompt_patch(state, user_input);
    let system_prompt_patch = [base_prompt_patch, skill_prompt_patch]
        .into_iter()
        .filter(|item| !item.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let metadata = json!({
        "intent": "direct_answer",
        "useRealSubagents": true,
        "subagentRoles": ["animation-director"],
        "allowedTools": ["redbox_fs"],
        "systemPromptPatch": system_prompt_patch,
    });
    let route =
        crate::runtime::runtime_direct_route_record("video-editor", user_input, Some(&metadata));
    let task_id = make_id("video-animation");
    let orchestration =
        crate::commands::runtime_orchestration::run_subagent_orchestration_for_task(
            Some(app),
            state,
            &settings_snapshot,
            "video-editor",
            &task_id,
            session_id,
            &route,
            user_input,
            Some(&metadata),
            model_config,
        )?;
    let (artifact, summary) = first_orchestration_output_artifact(&orchestration)?;
    let parsed = parse_json_value_from_text(&artifact)
        .ok_or_else(|| "动画子代理返回的 artifact 不是合法 JSON".to_string())?;
    Ok((parsed, summary))
}

fn selected_remotion_rule_names(bundle: &crate::skills::SkillBundleSections) -> Vec<String> {
    let mut rules = bundle.rules.keys().cloned().collect::<Vec<_>>();
    rules.sort();
    rules
}

fn build_remotion_best_practices_prompt_patch(
    state: &State<'_, AppState>,
    _user_input: &str,
) -> String {
    let workspace = workspace_root(state).ok();
    let bundle =
        load_skill_bundle_sections_from_sources("remotion-best-practices", workspace.as_deref());
    let (_, skill_body) = split_skill_body(&bundle.body);
    let mut sections = Vec::<String>::new();
    if !skill_body.trim().is_empty() {
        sections.push(skill_body);
    }
    for rule_name in selected_remotion_rule_names(&bundle) {
        let Some(rule_body) = bundle.rules.get(&rule_name) else {
            continue;
        };
        let (_, rule_content) = split_skill_body(rule_body);
        if rule_content.trim().is_empty() {
            continue;
        }
        sections.push(format!("## Loaded rule: {rule_name}\n{rule_content}"));
    }
    sections.join("\n\n")
}

fn package_html_file_path(package_path: &std::path::Path, target: &str) -> std::path::PathBuf {
    if target == PACKAGE_HTML_WECHAT_TARGET {
        package_wechat_html_path(package_path)
    } else {
        package_layout_html_path(package_path)
    }
}

fn package_html_template_path(package_path: &std::path::Path, target: &str) -> std::path::PathBuf {
    if target == PACKAGE_HTML_WECHAT_TARGET {
        package_wechat_template_path(package_path)
    } else {
        package_layout_template_path(package_path)
    }
}

fn normalize_package_block_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn package_block_match_key(kind: &str, level: Option<u8>, text: &str) -> String {
    format!(
        "{kind}|{}|{}",
        level.unwrap_or(0),
        normalize_package_block_text(text)
    )
}

fn parse_markdown_heading(line: &str) -> Option<(u8, String)> {
    let trimmed = line.trim();
    if !trimmed.starts_with('#') {
        return None;
    }
    let level = trimmed.chars().take_while(|char| *char == '#').count();
    if level == 0 || level > 6 {
        return None;
    }
    let body = trimmed[level..].trim();
    if body.is_empty() {
        return None;
    }
    Some((level as u8, body.to_string()))
}

fn push_package_paragraph_block(target: &mut Vec<ParsedPackageBlock>, lines: &mut Vec<String>) {
    if lines.is_empty() {
        return;
    }
    let text = lines
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    lines.clear();
    if text.trim().is_empty() {
        return;
    }
    target.push(ParsedPackageBlock {
        kind: "paragraph".to_string(),
        level: None,
        text,
    });
}

fn parse_package_markdown_blocks(content: &str) -> Vec<ParsedPackageBlock> {
    let normalized = strip_markdown_frontmatter(content).replace("\r\n", "\n");
    let mut blocks = Vec::<ParsedPackageBlock>::new();
    let mut paragraph_lines = Vec::<String>::new();
    let mut blank_run = 0usize;
    for line in normalized.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            push_package_paragraph_block(&mut blocks, &mut paragraph_lines);
            blank_run += 1;
            if blank_run >= 3
                && !blocks
                    .last()
                    .map(|block| package_block_is_page_break(&block.kind))
                    .unwrap_or(false)
            {
                blocks.push(ParsedPackageBlock {
                    kind: "page-break".to_string(),
                    level: None,
                    text: String::new(),
                });
                blank_run = 0;
            }
            continue;
        }
        if matches!(trimmed, "---" | "***" | "___") {
            push_package_paragraph_block(&mut blocks, &mut paragraph_lines);
            blank_run = 0;
            continue;
        }
        blank_run = 0;
        if let Some((level, text)) = parse_markdown_heading(trimmed) {
            push_package_paragraph_block(&mut blocks, &mut paragraph_lines);
            blocks.push(ParsedPackageBlock {
                kind: "heading".to_string(),
                level: Some(level),
                text,
            });
            continue;
        }
        paragraph_lines.push(line.to_string());
    }
    push_package_paragraph_block(&mut blocks, &mut paragraph_lines);
    blocks
}

fn read_previous_package_content_blocks(path: &std::path::Path) -> Vec<PackageContentBlock> {
    read_json_value_or(path, json!({ "blocks": [] }))
        .get("blocks")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .enumerate()
                .filter_map(|(index, block)| {
                    let id = block.get("id").and_then(Value::as_str)?.trim().to_string();
                    let slot = block
                        .get("slot")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string)
                        .unwrap_or_else(|| id.clone());
                    let kind = block
                        .get("type")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("paragraph")
                        .to_string();
                    let text = block
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let level = block
                        .get("level")
                        .and_then(Value::as_u64)
                        .map(|value| value as u8);
                    let order = block
                        .get("order")
                        .and_then(Value::as_u64)
                        .map(|value| value as usize)
                        .unwrap_or(index);
                    Some(PackageContentBlock {
                        id,
                        slot,
                        kind,
                        level,
                        text: text.clone(),
                        order,
                        char_count: text.chars().count(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn compute_exact_package_block_matches(
    previous: &[PackageContentBlock],
    next: &[ParsedPackageBlock],
) -> Vec<(usize, usize)> {
    let previous_len = previous.len();
    let next_len = next.len();
    if previous_len == 0 || next_len == 0 {
        return Vec::new();
    }
    let mut matrix = vec![vec![0usize; next_len + 1]; previous_len + 1];
    for previous_index in (0..previous_len).rev() {
        let previous_key = package_block_match_key(
            &previous[previous_index].kind,
            previous[previous_index].level,
            &previous[previous_index].text,
        );
        for next_index in (0..next_len).rev() {
            let next_key = package_block_match_key(
                &next[next_index].kind,
                next[next_index].level,
                &next[next_index].text,
            );
            matrix[previous_index][next_index] = if previous_key == next_key {
                matrix[previous_index + 1][next_index + 1] + 1
            } else {
                matrix[previous_index + 1][next_index].max(matrix[previous_index][next_index + 1])
            };
        }
    }
    let mut matches = Vec::<(usize, usize)>::new();
    let mut previous_index = 0usize;
    let mut next_index = 0usize;
    while previous_index < previous_len && next_index < next_len {
        let previous_key = package_block_match_key(
            &previous[previous_index].kind,
            previous[previous_index].level,
            &previous[previous_index].text,
        );
        let next_key = package_block_match_key(
            &next[next_index].kind,
            next[next_index].level,
            &next[next_index].text,
        );
        if previous_key == next_key {
            matches.push((previous_index, next_index));
            previous_index += 1;
            next_index += 1;
        } else if matrix[previous_index + 1][next_index] >= matrix[previous_index][next_index + 1] {
            previous_index += 1;
        } else {
            next_index += 1;
        }
    }
    matches
}

fn compute_text_only_package_block_matches(
    previous: &[PackageContentBlock],
    next: &[ParsedPackageBlock],
    used_previous: &BTreeSet<usize>,
    assigned_ids: &[Option<String>],
) -> Vec<(usize, usize)> {
    let mut matches = Vec::<(usize, usize)>::new();
    let mut claimed_previous = used_previous.clone();
    for (next_index, next_block) in next.iter().enumerate() {
        if assigned_ids
            .get(next_index)
            .and_then(|value| value.as_ref())
            .is_some()
        {
            continue;
        }
        let next_text_key = normalize_package_block_text(&next_block.text);
        if next_text_key.is_empty() {
            continue;
        }
        let best_previous = previous
            .iter()
            .enumerate()
            .filter(|(previous_index, previous_block)| {
                !claimed_previous.contains(previous_index)
                    && normalize_package_block_text(&previous_block.text) == next_text_key
            })
            .min_by_key(|(previous_index, previous_block)| {
                let kind_penalty = if previous_block.kind == next_block.kind {
                    0usize
                } else {
                    1usize
                };
                let level_penalty = if previous_block.level == next_block.level {
                    0usize
                } else {
                    1usize
                };
                (
                    kind_penalty,
                    level_penalty,
                    previous_index.abs_diff(next_index),
                )
            })
            .map(|(previous_index, _)| previous_index);
        if let Some(previous_index) = best_previous {
            claimed_previous.insert(previous_index);
            matches.push((previous_index, next_index));
        }
    }
    matches
}

fn package_block_id_prefix(kind: &str, level: Option<u8>) -> String {
    if kind == "heading" {
        format!("h{}", level.unwrap_or(2))
    } else if package_block_is_page_break(kind) {
        "pb".to_string()
    } else {
        "p".to_string()
    }
}

fn package_block_counter_seed(id: &str) -> usize {
    id.rsplit_once('_')
        .and_then(|(_, raw)| raw.parse::<usize>().ok())
        .unwrap_or(0)
}

fn next_package_block_id(
    prefix: &str,
    counters: &mut BTreeMap<String, usize>,
    used_ids: &mut BTreeSet<String>,
) -> String {
    let counter = counters.entry(prefix.to_string()).or_insert(0);
    loop {
        *counter += 1;
        let candidate = format!("{prefix}_{:03}", *counter);
        if used_ids.insert(candidate.clone()) {
            return candidate;
        }
    }
}

fn build_package_content_blocks(
    content_map_path: &std::path::Path,
    content: &str,
) -> Vec<PackageContentBlock> {
    let parsed_blocks = parse_package_markdown_blocks(content);
    let previous_blocks = read_previous_package_content_blocks(content_map_path);
    let exact_matches = compute_exact_package_block_matches(&previous_blocks, &parsed_blocks);
    let mut assigned_ids = vec![None::<String>; parsed_blocks.len()];
    let mut used_previous = BTreeSet::<usize>::new();
    let mut used_ids = previous_blocks
        .iter()
        .map(|block| block.id.clone())
        .collect::<BTreeSet<_>>();
    let mut counters = BTreeMap::<String, usize>::new();

    for block in &previous_blocks {
        let prefix = package_block_id_prefix(&block.kind, block.level);
        let counter = counters.entry(prefix).or_insert(0);
        *counter = (*counter).max(package_block_counter_seed(&block.id));
    }

    for (previous_index, next_index) in exact_matches {
        assigned_ids[next_index] = Some(previous_blocks[previous_index].id.clone());
        used_previous.insert(previous_index);
    }

    for (previous_index, next_index) in compute_text_only_package_block_matches(
        &previous_blocks,
        &parsed_blocks,
        &used_previous,
        &assigned_ids,
    ) {
        assigned_ids[next_index] = Some(previous_blocks[previous_index].id.clone());
        used_previous.insert(previous_index);
    }

    for (next_index, parsed_block) in parsed_blocks.iter().enumerate() {
        if assigned_ids[next_index].is_some() {
            continue;
        }
        let best_previous = previous_blocks
            .iter()
            .enumerate()
            .filter(|(previous_index, previous_block)| {
                !used_previous.contains(previous_index)
                    && previous_block.kind == parsed_block.kind
                    && previous_block.level == parsed_block.level
            })
            .min_by_key(|(previous_index, _)| previous_index.abs_diff(next_index))
            .map(|(previous_index, _)| previous_index);
        if let Some(previous_index) = best_previous {
            assigned_ids[next_index] = Some(previous_blocks[previous_index].id.clone());
            used_previous.insert(previous_index);
        }
    }

    parsed_blocks
        .into_iter()
        .enumerate()
        .map(|(index, block)| {
            let prefix = package_block_id_prefix(&block.kind, block.level);
            let id = assigned_ids[index]
                .clone()
                .unwrap_or_else(|| next_package_block_id(&prefix, &mut counters, &mut used_ids));
            PackageContentBlock {
                slot: id.clone(),
                id,
                kind: block.kind,
                level: block.level,
                char_count: block.text.chars().count(),
                text: block.text,
                order: index,
            }
        })
        .collect::<Vec<_>>()
}

fn package_content_map_value(
    package_kind: &str,
    title: &str,
    entry: &str,
    blocks: &[PackageContentBlock],
) -> Value {
    json!({
        "version": 1,
        "packageKind": package_kind,
        "title": title,
        "entry": entry,
        "generatedAt": now_i64(),
        "blocks": blocks.iter().map(|block| {
            json!({
                "id": block.id,
                "slot": block.slot,
                "type": block.kind,
                "level": block.level,
                "text": block.text,
                "order": block.order,
                "charCount": block.char_count
            })
        }).collect::<Vec<_>>()
    })
}

fn render_package_slot_text(value: &str) -> String {
    escape_html(value).replace('\n', "<br />")
}

fn render_markdown_fragment_html(value: &str) -> String {
    let options = MarkdownOptions::ENABLE_STRIKETHROUGH | MarkdownOptions::ENABLE_TABLES;
    let parser = MarkdownParser::new_ext(value, options).map(|event| match event {
        MarkdownEvent::SoftBreak => MarkdownEvent::HardBreak,
        other => other,
    });
    let mut html = String::new();
    push_html(&mut html, parser);
    if html.trim().is_empty() {
        render_package_slot_text(value)
    } else {
        html.trim().to_string()
    }
}

fn unwrap_single_paragraph_html(html: &str) -> String {
    let trimmed = html.trim();
    if let Some(inner) = trimmed
        .strip_prefix("<p>")
        .and_then(|value| value.strip_suffix("</p>"))
    {
        inner.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

fn render_package_block_fragment_parts(kind: &str, level: Option<u8>, text: &str) -> String {
    if package_block_is_page_break(kind) {
        return String::new();
    }
    if kind == "heading" {
        let level = level.unwrap_or(2).clamp(1, 6);
        let content = unwrap_single_paragraph_html(&render_markdown_fragment_html(text));
        format!(
            "<section class=\"rb-block rb-heading rb-heading-level-{level}\"><h{level}>{content}</h{level}></section>"
        )
    } else {
        let content = render_markdown_fragment_html(text);
        format!("<section class=\"rb-block rb-paragraph\">{content}</section>")
    }
}

fn render_package_block_fragment(block: &PackageContentBlock) -> String {
    render_package_block_fragment_parts(&block.kind, block.level, &block.text)
}

fn collect_package_bound_assets(
    state: Option<&State<'_, AppState>>,
    package_path: &std::path::Path,
) -> Result<(Option<PackageBoundAsset>, Vec<PackageBoundAsset>), String> {
    let Some(state) = state else {
        return Ok((None, Vec::new()));
    };
    let cover_asset_id = read_json_value_or(&package_cover_path(package_path), json!({}))
        .get("assetId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let image_asset_ids =
        read_json_value_or(&package_images_path(package_path), json!({ "items": [] }))
            .get("items")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        item.get("assetId")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(ToString::to_string)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
    with_store(state, |store| {
        let resolve_asset = |asset_id: &str| -> Option<PackageBoundAsset> {
            let asset = store.media_assets.iter().find(|item| item.id == asset_id)?;
            let url = asset_prompt_url(asset)?;
            Some(PackageBoundAsset {
                id: asset.id.clone(),
                title: asset
                    .title
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(asset.id.as_str())
                    .to_string(),
                url,
                role: "image".to_string(),
            })
        };
        let cover = cover_asset_id
            .as_deref()
            .and_then(resolve_asset)
            .map(|mut asset| {
                asset.role = "cover".to_string();
                asset
            });
        let images = image_asset_ids
            .iter()
            .filter_map(|asset_id| resolve_asset(asset_id))
            .collect::<Vec<_>>();
        Ok((cover, images))
    })
}

fn richpost_template_catalog() -> &'static [&'static str] {
    &[
        "cover",
        "text-stack",
        "text-image",
        "image-focus",
        "quote",
        "ending",
    ]
}

fn normalize_richpost_template(value: &str) -> &'static str {
    match value.trim() {
        "cover" => "cover",
        "text-image" => "text-image",
        "image-focus" => "image-focus",
        "quote" => "quote",
        "ending" => "ending",
        _ => "text-stack",
    }
}

fn richpost_master_name_from_template(template: &str) -> String {
    match normalize_richpost_template(template) {
        "cover" => RICHPOST_MASTER_COVER.to_string(),
        "ending" => RICHPOST_MASTER_ENDING.to_string(),
        _ => RICHPOST_MASTER_BODY.to_string(),
    }
}

fn richpost_master_role(master_name: &str, template: &str) -> &'static str {
    match sanitize_richpost_master_name(master_name).as_deref() {
        Some(RICHPOST_MASTER_COVER) => RICHPOST_MASTER_COVER,
        Some(RICHPOST_MASTER_ENDING) => RICHPOST_MASTER_ENDING,
        Some(RICHPOST_MASTER_BODY) => RICHPOST_MASTER_BODY,
        _ => match normalize_richpost_template(template) {
            "cover" => RICHPOST_MASTER_COVER,
            "ending" => RICHPOST_MASTER_ENDING,
            _ => RICHPOST_MASTER_BODY,
        },
    }
}

fn sanitize_richpost_zone_name(raw: &str) -> Option<String> {
    sanitize_richpost_master_name(raw)
}

fn richpost_page_style_overrides_for_template(template: &str) -> Value {
    let _ = template;
    Value::Object(serde_json::Map::new())
}

fn richpost_zone_assignment_value(block_ids: Vec<String>, asset_ids: Vec<String>) -> Value {
    richpost_zone_assignment_with_fragments(block_ids, asset_ids, Vec::new())
}

fn richpost_zone_assignment_with_fragments(
    block_ids: Vec<String>,
    asset_ids: Vec<String>,
    fragments: Vec<Value>,
) -> Value {
    let mut object = serde_json::Map::new();
    if !block_ids.is_empty() {
        object.insert("blockIds".to_string(), json!(block_ids));
    }
    if !asset_ids.is_empty() {
        object.insert("assetIds".to_string(), json!(asset_ids));
    }
    if !fragments.is_empty() {
        object.insert("fragments".to_string(), Value::Array(fragments));
    }
    Value::Object(object)
}

fn richpost_zone_block_ids(zones: &serde_json::Map<String, Value>) -> Vec<String> {
    let mut items = Vec::<String>::new();
    for zone_name in [
        "title",
        "body",
        "media",
        "footer",
        "background",
        "overlay",
        "decoration",
    ] {
        if let Some(blocks) = zones
            .get(zone_name)
            .and_then(|value| value.get("blockIds"))
            .and_then(Value::as_array)
        {
            for block_id in blocks.iter().filter_map(Value::as_str) {
                if !items.iter().any(|item| item == block_id) {
                    items.push(block_id.to_string());
                }
            }
        }
        if let Some(fragments) = zones
            .get(zone_name)
            .and_then(|value| value.get("fragments"))
            .and_then(Value::as_array)
        {
            for source_block_id in fragments
                .iter()
                .filter_map(|fragment| fragment.get("sourceBlockId"))
                .filter_map(Value::as_str)
            {
                if !items.iter().any(|item| item == source_block_id) {
                    items.push(source_block_id.to_string());
                }
            }
        }
    }
    items
}

fn richpost_zone_asset_ids(zones: &serde_json::Map<String, Value>) -> Vec<String> {
    let mut items = Vec::<String>::new();
    for zone_name in [
        "background",
        "media",
        "footer",
        "overlay",
        "decoration",
        "title",
        "body",
    ] {
        if let Some(assets) = zones
            .get(zone_name)
            .and_then(|value| value.get("assetIds"))
            .and_then(Value::as_array)
        {
            items.extend(
                assets
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string),
            );
        }
    }
    items
}

fn richpost_block_ids(blocks: &[PackageContentBlock]) -> Vec<String> {
    blocks
        .iter()
        .filter(|block| !package_block_is_page_break(&block.kind))
        .map(|block| block.id.clone())
        .collect::<Vec<_>>()
}

fn richpost_block_segments(blocks: &[PackageContentBlock]) -> Vec<Vec<PackageContentBlock>> {
    let mut segments = Vec::<Vec<PackageContentBlock>>::new();
    let mut current = Vec::<PackageContentBlock>::new();
    for block in blocks {
        if package_block_is_page_break(&block.kind) {
            if !current.is_empty() {
                segments.push(current);
                current = Vec::new();
            }
            continue;
        }
        current.push(block.clone());
    }
    if !current.is_empty() {
        segments.push(current);
    }
    segments
}

fn richpost_asset_records(
    cover_asset: Option<&PackageBoundAsset>,
    image_assets: &[PackageBoundAsset],
) -> Vec<PackageBoundAsset> {
    let mut items = Vec::<PackageBoundAsset>::new();
    if let Some(asset) = cover_asset {
        items.push(asset.clone());
    }
    items.extend(image_assets.iter().cloned());
    items
}

fn richpost_asset_outline_prompt(
    cover_asset: Option<&PackageBoundAsset>,
    image_assets: &[PackageBoundAsset],
) -> String {
    let mut lines = Vec::<String>::new();
    if let Some(asset) = cover_asset {
        lines.push(format!(
            "- id={} | role=cover | title={} | url={}",
            asset.id, asset.title, asset.url
        ));
    }
    if image_assets.is_empty() {
        lines.push("- 无额外配图".to_string());
    } else {
        lines.extend(image_assets.iter().enumerate().map(|(index, asset)| {
            format!(
                "- id={} | role=image | imageIndex={} | title={} | url={}",
                asset.id,
                index + 1,
                asset.title,
                asset.url
            )
        }));
    }
    lines.join("\n")
}

fn richpost_body_font_size_px(settings: RichpostTypographySettings) -> f64 {
    (RICHPOST_PAGINATION_CANVAS_WIDTH_PX * 0.032).clamp(17.0, 34.0) * settings.font_scale
}

fn richpost_body_line_height_px(settings: RichpostTypographySettings) -> f64 {
    richpost_body_font_size_px(settings) * 1.92 * settings.line_height_scale.max(0.1)
}

fn richpost_heading_font_size_px(level: u8, settings: RichpostTypographySettings) -> f64 {
    let viewport_ratio = match level {
        1 => 0.054,
        2 => 0.045,
        3 => 0.038,
        4 => 0.032,
        5 => 0.027,
        _ => 0.024,
    };
    let (min_px, max_px) = match level {
        1 => (28.0, 58.0),
        2 => (24.0, 48.0),
        3 => (21.0, 40.0),
        4 => (18.0, 34.0),
        5 => (17.0, 28.0),
        _ => (16.0, 24.0),
    };
    (RICHPOST_PAGINATION_CANVAS_WIDTH_PX * viewport_ratio).clamp(min_px, max_px)
        * settings.font_scale
}

fn richpost_heading_line_height_px(level: u8, settings: RichpostTypographySettings) -> f64 {
    richpost_heading_font_size_px(level, settings) * 1.22
}

fn richpost_block_gap_px() -> f64 {
    14.0
}

fn richpost_text_width_units(text: &str) -> f64 {
    text.chars()
        .map(|ch| {
            if ch == '\n' || ch == '\r' {
                0.0
            } else if ch.is_whitespace() {
                0.32
            } else if ch.is_ascii_punctuation() {
                0.38
            } else if ch.is_ascii_digit() {
                0.62
            } else if ch.is_ascii_uppercase() {
                0.74
            } else if ch.is_ascii_lowercase() {
                0.58
            } else if matches!(
                ch,
                '，' | '。'
                    | '、'
                    | '：'
                    | '；'
                    | '！'
                    | '？'
                    | '（'
                    | '）'
                    | '“'
                    | '”'
                    | '《'
                    | '》'
            ) {
                0.72
            } else {
                1.0
            }
        })
        .sum::<f64>()
}

fn richpost_body_units_per_line(
    settings: RichpostTypographySettings,
    frame_width_ratio: f64,
) -> f64 {
    let frame_width_px = RICHPOST_PAGINATION_CANVAS_WIDTH_PX * frame_width_ratio.clamp(0.1, 1.0);
    let font_size_px = richpost_body_font_size_px(settings).max(1.0);
    (frame_width_px / (font_size_px * 0.92)).clamp(6.0, 44.0)
}

fn richpost_heading_units_per_line(
    level: u8,
    settings: RichpostTypographySettings,
    frame_width_ratio: f64,
) -> f64 {
    let frame_width_px = RICHPOST_PAGINATION_CANVAS_WIDTH_PX * frame_width_ratio.clamp(0.1, 1.0);
    let font_size_px = richpost_heading_font_size_px(level, settings).max(1.0);
    (frame_width_px / (font_size_px * 0.98)).clamp(4.0, 28.0)
}

fn richpost_page_height_limit_px(
    settings: RichpostTypographySettings,
    frame_height_ratio: f64,
) -> f64 {
    let frame_height_px = RICHPOST_PAGINATION_CANVAS_HEIGHT_PX * frame_height_ratio.clamp(0.1, 1.0);
    (frame_height_px - richpost_block_gap_px() * 0.5)
        .max(richpost_body_line_height_px(settings) * 6.0)
}

fn richpost_zone_fragment_value(
    source_block_id: &str,
    kind: &str,
    level: Option<u8>,
    text: &str,
    continued_from_previous: bool,
    continues_to_next: bool,
) -> Value {
    json!({
        "sourceBlockId": source_block_id,
        "kind": kind,
        "level": level,
        "text": text,
        "continuedFromPrevious": continued_from_previous,
        "continuesToNext": continues_to_next
    })
}

fn richpost_estimated_wrapped_line_count(text: &str, units_per_line: f64) -> usize {
    let mut line_count = 0usize;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        line_count +=
            ((richpost_text_width_units(trimmed) / units_per_line.max(1.0)).ceil() as usize).max(1);
    }
    line_count.max(1)
}

fn richpost_block_height_px_from_parts(
    kind: &str,
    level: Option<u8>,
    text: &str,
    settings: RichpostTypographySettings,
    frame: &RichpostZoneFrame,
) -> f64 {
    if package_block_is_page_break(kind) {
        return 0.0;
    }
    if kind == "heading" {
        let units_per_line = richpost_heading_units_per_line(level.unwrap_or(2), settings, frame.w);
        let wrapped_lines = richpost_estimated_wrapped_line_count(text, units_per_line);
        return wrapped_lines as f64
            * richpost_heading_line_height_px(level.unwrap_or(2), settings);
    }
    let wrapped_lines = richpost_estimated_wrapped_line_count(
        text,
        richpost_body_units_per_line(settings, frame.w),
    );
    wrapped_lines as f64 * richpost_body_line_height_px(settings)
}

fn richpost_default_block_height_px(
    block: &PackageContentBlock,
    settings: RichpostTypographySettings,
    frame: &RichpostZoneFrame,
) -> f64 {
    richpost_block_height_px_from_parts(&block.kind, block.level, &block.text, settings, frame)
}

fn richpost_split_text_for_unit_budget(text: &str, max_units: f64) -> (String, String) {
    if max_units <= 0.0 {
        return (String::new(), text.trim().to_string());
    }
    let total_units = richpost_text_width_units(text);
    if total_units <= max_units {
        return (text.trim().to_string(), String::new());
    }
    let mut consumed_units = 0.0;
    let mut ideal_byte = text.len();
    for (index, ch) in text.char_indices() {
        consumed_units += richpost_text_width_units(&ch.to_string());
        if consumed_units >= max_units {
            ideal_byte = index + ch.len_utf8();
            break;
        }
    }
    let prefix = &text[..ideal_byte];
    let sentence_cut = prefix
        .char_indices()
        .rev()
        .find(|(_, ch)| matches!(ch, '。' | '！' | '？' | '；' | ';' | '\n'))
        .map(|(index, ch)| index + ch.len_utf8());
    let soft_cut = prefix
        .char_indices()
        .rev()
        .find(|(_, ch)| matches!(ch, '，' | '、' | ',' | ':' | '：' | ' ' | '\t'))
        .map(|(index, ch)| index + ch.len_utf8());
    let mut split_byte = sentence_cut.or(soft_cut).unwrap_or(ideal_byte);
    let accepted_units = richpost_text_width_units(&text[..split_byte]);
    if accepted_units < (max_units / 2.0).max(1.0) {
        split_byte = ideal_byte;
    }
    let head = text[..split_byte].trim_end().to_string();
    let tail = text[split_byte..].trim_start().to_string();
    if head.is_empty() || tail.is_empty() {
        let head = text[..ideal_byte].trim_end().to_string();
        let tail = text[ideal_byte..].trim_start().to_string();
        return (head, tail);
    }
    (head, tail)
}

fn richpost_split_paragraph_for_available_lines(
    text: &str,
    available_height_px: f64,
    settings: RichpostTypographySettings,
    frame: &RichpostZoneFrame,
) -> (String, String) {
    let content_lines =
        (available_height_px / richpost_body_line_height_px(settings)).floor() as usize;
    if content_lines == 0 {
        return (String::new(), text.trim().to_string());
    }
    richpost_split_text_for_unit_budget(
        text,
        (content_lines as f64) * richpost_body_units_per_line(settings, frame.w),
    )
}

fn richpost_push_completed_auto_page(
    pages: &mut Vec<RichpostAutoPageDraft>,
    current: &mut RichpostAutoPageDraft,
) {
    if current.title_block_ids.is_empty()
        && current.body_block_ids.is_empty()
        && current.body_fragments.is_empty()
    {
        return;
    }
    pages.push(std::mem::take(current));
}

fn richpost_page_has_title_content(page: &RichpostAutoPageDraft) -> bool {
    !page.title_block_ids.is_empty()
}

fn richpost_page_has_body_content(page: &RichpostAutoPageDraft) -> bool {
    !page.body_block_ids.is_empty() || !page.body_fragments.is_empty()
}

fn richpost_page_has_any_content(page: &RichpostAutoPageDraft) -> bool {
    richpost_page_has_title_content(page) || richpost_page_has_body_content(page)
}

fn richpost_page_height_px(page: &RichpostAutoPageDraft) -> f64 {
    page.title_height_px + page.body_height_px
}

fn richpost_append_title_block(
    page: &mut RichpostAutoPageDraft,
    block_id: String,
    block_height_px: f64,
) {
    if richpost_page_has_title_content(page) {
        page.title_height_px += richpost_block_gap_px();
    }
    page.title_block_ids.push(block_id);
    page.title_height_px += block_height_px;
}

fn richpost_append_body_block_id(
    page: &mut RichpostAutoPageDraft,
    block_id: String,
    block_height_px: f64,
) {
    if richpost_page_has_any_content(page) {
        page.body_height_px += richpost_block_gap_px();
    }
    page.body_block_ids.push(block_id);
    page.body_height_px += block_height_px;
}

fn richpost_append_body_fragment(
    page: &mut RichpostAutoPageDraft,
    fragment: Value,
    fragment_height_px: f64,
) {
    if richpost_page_has_any_content(page) {
        page.body_height_px += richpost_block_gap_px();
    }
    page.body_fragments.push(fragment);
    page.body_height_px += fragment_height_px;
}

fn richpost_master_for_page_position(
    theme: &RichpostThemeSpec,
    page_index: usize,
    total_pages: usize,
) -> &'static str {
    if total_pages <= 1 {
        if richpost_theme_has_custom_cover_role(theme) {
            RICHPOST_MASTER_COVER
        } else {
            RICHPOST_MASTER_BODY
        }
    } else if page_index == 0 {
        RICHPOST_MASTER_COVER
    } else if page_index + 1 == total_pages {
        RICHPOST_MASTER_ENDING
    } else {
        RICHPOST_MASTER_BODY
    }
}

fn richpost_frame_for_page_position(
    theme: &RichpostThemeSpec,
    page_index: usize,
    total_pages: usize,
) -> RichpostZoneFrame {
    richpost_theme_frame(
        theme,
        richpost_master_for_page_position(theme, page_index, total_pages),
    )
}

fn richpost_default_segment_pages(
    segment: &[PackageContentBlock],
    settings: RichpostTypographySettings,
    theme: &RichpostThemeSpec,
    start_page_index: usize,
    total_pages_hint: usize,
) -> Vec<RichpostAutoPageDraft> {
    if segment.is_empty() {
        return vec![RichpostAutoPageDraft::default()];
    }
    const MIN_FRAGMENT_LINES: usize = 3;

    let mut pages = Vec::<RichpostAutoPageDraft>::new();
    let mut current = RichpostAutoPageDraft::default();

    for block in segment {
        let current_page_index = start_page_index + pages.len();
        let frame = richpost_frame_for_page_position(theme, current_page_index, total_pages_hint);
        let page_height_limit_px = richpost_page_height_limit_px(settings, frame.h);
        if block.kind == "heading" {
            let block_height_px = richpost_default_block_height_px(block, settings, &frame);
            let heading_guard_px = richpost_body_line_height_px(settings) * 1.35;
            let title_gap_px = if richpost_page_has_title_content(&current) {
                richpost_block_gap_px()
            } else {
                0.0
            };
            let should_wrap = richpost_page_has_any_content(&current)
                && (richpost_page_height_px(&current) + title_gap_px + block_height_px
                    > page_height_limit_px
                    || page_height_limit_px - richpost_page_height_px(&current)
                        < block_height_px + heading_guard_px);
            if should_wrap {
                richpost_push_completed_auto_page(&mut pages, &mut current);
            }
            if current.body_fragments.is_empty() {
                richpost_append_title_block(&mut current, block.id.clone(), block_height_px);
            } else {
                richpost_append_body_fragment(
                    &mut current,
                    richpost_zone_fragment_value(
                        &block.id,
                        &block.kind,
                        block.level,
                        &block.text,
                        false,
                        false,
                    ),
                    block_height_px,
                );
            }
            continue;
        }

        let full_block_height_px = richpost_default_block_height_px(block, settings, &frame);
        let next_body_gap_px = if richpost_page_has_any_content(&current) {
            richpost_block_gap_px()
        } else {
            0.0
        };
        if richpost_page_height_px(&current) + next_body_gap_px + full_block_height_px
            <= page_height_limit_px
        {
            richpost_append_body_fragment(
                &mut current,
                richpost_zone_fragment_value(
                    &block.id,
                    &block.kind,
                    block.level,
                    &block.text,
                    false,
                    false,
                ),
                full_block_height_px,
            );
            continue;
        }

        let mut remaining = block.text.clone();
        let mut continued_from_previous = false;
        loop {
            let next_gap_px = if richpost_page_has_any_content(&current) {
                richpost_block_gap_px()
            } else {
                0.0
            };
            let available_height_px =
                (page_height_limit_px - richpost_page_height_px(&current) - next_gap_px).max(0.0);
            let fragment_budget = available_height_px;
            let remaining_height_px = richpost_block_height_px_from_parts(
                &block.kind,
                block.level,
                &remaining,
                settings,
                &frame,
            );
            if richpost_page_height_px(&current) + next_gap_px + remaining_height_px
                <= page_height_limit_px
            {
                richpost_append_body_fragment(
                    &mut current,
                    richpost_zone_fragment_value(
                        &block.id,
                        &block.kind,
                        block.level,
                        &remaining,
                        continued_from_previous,
                        false,
                    ),
                    remaining_height_px,
                );
                break;
            }
            if available_height_px
                < richpost_body_line_height_px(settings) * MIN_FRAGMENT_LINES as f64
            {
                richpost_push_completed_auto_page(&mut pages, &mut current);
                continue;
            }
            let (head, tail) = richpost_split_paragraph_for_available_lines(
                &remaining,
                fragment_budget,
                settings,
                &frame,
            );
            if head.trim().is_empty() || tail.trim().is_empty() {
                if !richpost_page_has_any_content(&current) {
                    richpost_append_body_block_id(
                        &mut current,
                        block.id.clone(),
                        remaining_height_px,
                    );
                    break;
                }
                richpost_push_completed_auto_page(&mut pages, &mut current);
                continue;
            }
            let fragment_height_px = richpost_block_height_px_from_parts(
                &block.kind,
                block.level,
                &head,
                settings,
                &frame,
            );
            richpost_append_body_fragment(
                &mut current,
                richpost_zone_fragment_value(
                    &block.id,
                    &block.kind,
                    block.level,
                    &head,
                    continued_from_previous,
                    true,
                ),
                fragment_height_px,
            );
            richpost_push_completed_auto_page(&mut pages, &mut current);
            remaining = tail;
            continued_from_previous = true;
        }
    }

    richpost_push_completed_auto_page(&mut pages, &mut current);
    if pages.is_empty() {
        vec![RichpostAutoPageDraft::default()]
    } else {
        pages
    }
}

fn split_richpost_zone_blocks(
    blocks_by_id: &BTreeMap<String, PackageContentBlock>,
    master_name: &str,
    block_ids: &[String],
) -> (Vec<String>, Vec<String>) {
    let mut title_ids = Vec::<String>::new();
    let mut body_ids = Vec::<String>::new();
    let mut in_title = true;
    for block_id in block_ids {
        let is_heading = blocks_by_id
            .get(block_id)
            .map(|block| block.kind == "heading")
            .unwrap_or(false);
        if in_title && is_heading {
            title_ids.push(block_id.clone());
            continue;
        }
        in_title = false;
        body_ids.push(block_id.clone());
    }
    if title_ids.is_empty() && master_name == RICHPOST_MASTER_COVER {
        if let Some(first) = body_ids.first().cloned() {
            title_ids.push(first);
            body_ids.remove(0);
        }
    }
    (title_ids, body_ids)
}

fn build_default_richpost_zones(
    blocks_by_id: &BTreeMap<String, PackageContentBlock>,
    master_name: &str,
    template: &str,
    block_ids: &[String],
    asset_ids: &[String],
) -> Value {
    let (title_ids, body_ids) = split_richpost_zone_blocks(blocks_by_id, master_name, block_ids);
    let mut zones = serde_json::Map::<String, Value>::new();
    if !title_ids.is_empty() {
        zones.insert(
            "title".to_string(),
            richpost_zone_assignment_value(title_ids, Vec::new()),
        );
    }
    if !body_ids.is_empty() {
        zones.insert(
            "body".to_string(),
            richpost_zone_assignment_value(body_ids, Vec::new()),
        );
    }
    if !asset_ids.is_empty() {
        let normalized_template = normalize_richpost_template(template);
        if master_name == RICHPOST_MASTER_COVER || master_name == RICHPOST_MASTER_ENDING {
            zones.insert(
                "background".to_string(),
                richpost_zone_assignment_value(Vec::new(), asset_ids.to_vec()),
            );
        } else if normalized_template == "image-focus" {
            let background_assets = vec![asset_ids[0].clone()];
            zones.insert(
                "background".to_string(),
                richpost_zone_assignment_value(Vec::new(), background_assets),
            );
            if asset_ids.len() > 1 {
                zones.insert(
                    "media".to_string(),
                    richpost_zone_assignment_value(Vec::new(), asset_ids[1..].to_vec()),
                );
            }
        } else {
            zones.insert(
                "media".to_string(),
                richpost_zone_assignment_value(Vec::new(), asset_ids.to_vec()),
            );
        }
    }
    Value::Object(zones)
}

fn normalize_richpost_style_overrides(raw: Option<&Value>, template: &str) -> Value {
    let mut normalized = richpost_page_style_overrides_for_template(template)
        .as_object()
        .cloned()
        .unwrap_or_default();
    merge_richpost_css_var_object(&mut normalized, raw);
    Value::Object(normalized)
}

fn normalize_richpost_zones(
    raw: Option<&Value>,
    blocks_by_id: &BTreeMap<String, PackageContentBlock>,
    master_name: &str,
    template: &str,
    legacy_block_ids: &[String],
    legacy_asset_ids: &[String],
    assigned_block_ids: &mut BTreeSet<String>,
    valid_asset_ids: &BTreeSet<String>,
) -> Value {
    let mut normalized_zones = serde_json::Map::<String, Value>::new();
    if let Some(object) = raw.and_then(Value::as_object) {
        for (zone_name, zone_value) in object {
            let Some(zone_key) = sanitize_richpost_zone_name(zone_name) else {
                continue;
            };
            let block_ids = zone_value
                .get("blockIds")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|value| blocks_by_id.contains_key(*value))
                        .filter(|value| assigned_block_ids.insert((*value).to_string()))
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let asset_ids = zone_value
                .get("assetIds")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|value| valid_asset_ids.contains(*value))
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let fragments = zone_value
                .get("fragments")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_object)
                        .filter_map(|fragment| {
                            let source_block_id = fragment
                                .get("sourceBlockId")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|value| blocks_by_id.contains_key(*value))?;
                            assigned_block_ids.insert(source_block_id.to_string());
                            let source_block = blocks_by_id.get(source_block_id)?;
                            let text = fragment
                                .get("text")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|value| !value.is_empty())?;
                            Some(richpost_zone_fragment_value(
                                source_block_id,
                                fragment
                                    .get("kind")
                                    .and_then(Value::as_str)
                                    .unwrap_or(&source_block.kind),
                                fragment
                                    .get("level")
                                    .and_then(Value::as_u64)
                                    .and_then(|value| u8::try_from(value).ok())
                                    .or(source_block.level),
                                text,
                                fragment
                                    .get("continuedFromPrevious")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                                fragment
                                    .get("continuesToNext")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                            ))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if block_ids.is_empty() && asset_ids.is_empty() {
                if fragments.is_empty() {
                    continue;
                }
            }
            normalized_zones.insert(
                zone_key,
                richpost_zone_assignment_with_fragments(block_ids, asset_ids, fragments),
            );
        }
    }

    if normalized_zones.is_empty() {
        let fallback_block_ids = legacy_block_ids
            .iter()
            .filter(|block_id| assigned_block_ids.insert((*block_id).to_string()))
            .cloned()
            .collect::<Vec<_>>();
        return build_default_richpost_zones(
            blocks_by_id,
            master_name,
            template,
            &fallback_block_ids,
            legacy_asset_ids,
        );
    }

    Value::Object(normalized_zones)
}

fn default_richpost_page_plan(
    title: &str,
    blocks: &[PackageContentBlock],
    cover_asset: Option<&PackageBoundAsset>,
    image_assets: &[PackageBoundAsset],
    source: &str,
    typography: RichpostTypographySettings,
    theme: &RichpostThemeSpec,
) -> Value {
    let segments = richpost_block_segments(blocks);
    let mut pages = Vec::<Value>::new();
    let blocks_by_id = blocks
        .iter()
        .map(|block| (block.id.clone(), block.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut available_asset_ids = Vec::<String>::new();
    if let Some(asset) = cover_asset {
        available_asset_ids.push(asset.id.clone());
    }
    available_asset_ids.extend(image_assets.iter().map(|asset| asset.id.clone()));
    let mut next_asset_index = 0usize;

    let mut total_pages_hint = segments
        .iter()
        .map(|segment| {
            richpost_default_segment_pages(segment, typography, theme, 0, 1)
                .into_iter()
                .filter(|page| !(page.title_block_ids.is_empty() && page.body_fragments.is_empty()))
                .count()
        })
        .sum::<usize>()
        .max(1);
    let mut segment_pages = Vec::<RichpostAutoPageDraft>::new();
    for _ in 0..4 {
        let mut next_pages = Vec::<RichpostAutoPageDraft>::new();
        let mut start_page_index = 0usize;
        for segment in &segments {
            let mut generated = richpost_default_segment_pages(
                segment,
                typography,
                theme,
                start_page_index,
                total_pages_hint,
            )
            .into_iter()
            .filter(|page| !(page.title_block_ids.is_empty() && page.body_fragments.is_empty()))
            .collect::<Vec<_>>();
            start_page_index += generated.len();
            next_pages.append(&mut generated);
        }
        let next_total = next_pages.len().max(1);
        segment_pages = next_pages;
        if next_total == total_pages_hint {
            break;
        }
        total_pages_hint = next_total;
    }
    let segment_page_count = segment_pages.len();
    for (page_index, page_draft) in segment_pages.into_iter().enumerate() {
        let template = "text-stack";
        let asset_ids = if next_asset_index < available_asset_ids.len() {
            let asset_id = available_asset_ids[next_asset_index].clone();
            next_asset_index += 1;
            vec![asset_id]
        } else {
            Vec::new()
        };
        let master =
            richpost_master_for_page_position(theme, page_index, segment_page_count).to_string();
        let mut page_block_ids = page_draft.title_block_ids.clone();
        for body_block_id in &page_draft.body_block_ids {
            if !page_block_ids.iter().any(|item| item == body_block_id) {
                page_block_ids.push(body_block_id.clone());
            }
        }
        for source_block_id in page_draft
            .body_fragments
            .iter()
            .filter_map(|fragment| fragment.get("sourceBlockId"))
            .filter_map(Value::as_str)
        {
            if !page_block_ids.iter().any(|item| item == source_block_id) {
                page_block_ids.push(source_block_id.to_string());
            }
        }
        let mut zones = serde_json::Map::<String, Value>::new();
        if !page_draft.title_block_ids.is_empty() {
            zones.insert(
                "title".to_string(),
                richpost_zone_assignment_value(page_draft.title_block_ids.clone(), Vec::new()),
            );
        }
        if !page_draft.body_fragments.is_empty() {
            zones.insert(
                "body".to_string(),
                richpost_zone_assignment_with_fragments(
                    Vec::new(),
                    Vec::new(),
                    page_draft.body_fragments.clone(),
                ),
            );
        } else if !page_draft.body_block_ids.is_empty() {
            zones.insert(
                "body".to_string(),
                richpost_zone_assignment_value(page_draft.body_block_ids.clone(), Vec::new()),
            );
        }
        if !asset_ids.is_empty() {
            zones.insert(
                "media".to_string(),
                richpost_zone_assignment_value(Vec::new(), asset_ids.clone()),
            );
        }
        pages.push(json!({
            "master": master,
            "template": template,
            "blockIds": page_block_ids,
            "assetIds": asset_ids.clone(),
            "zones": Value::Object(zones),
            "styleOverrides": richpost_page_style_overrides_for_template(template)
        }));
    }

    if pages.is_empty() {
        let fallback_assets = available_asset_ids
            .first()
            .cloned()
            .map(|asset_id| vec![asset_id])
            .unwrap_or_default();
        pages.push(json!({
            "master": RICHPOST_MASTER_BODY,
            "template": "text-stack",
            "blockIds": [],
            "assetIds": fallback_assets.clone(),
            "zones": build_default_richpost_zones(
                &blocks_by_id,
                RICHPOST_MASTER_BODY,
                "text-stack",
                &[],
                &fallback_assets
            ),
            "styleOverrides": richpost_page_style_overrides_for_template("text-stack")
        }));
    }

    let normalized_pages = pages
        .into_iter()
        .enumerate()
        .map(|(index, mut page)| {
            if let Some(object) = page.as_object_mut() {
                object.insert("id".to_string(), json!(format!("page-{:03}", index + 1)));
            }
            page
        })
        .collect::<Vec<_>>();

    json!({
        "version": 1,
        "title": title,
        "generatedAt": now_i64(),
        "source": source,
        "pageCount": normalized_pages.len(),
        "pages": normalized_pages
    })
}

fn normalize_richpost_page_plan(
    raw: &Value,
    title: &str,
    blocks: &[PackageContentBlock],
    cover_asset: Option<&PackageBoundAsset>,
    image_assets: &[PackageBoundAsset],
    source: &str,
    typography: RichpostTypographySettings,
    theme: &RichpostThemeSpec,
) -> Value {
    let all_block_ids = richpost_block_ids(blocks);
    let blocks_by_id = blocks
        .iter()
        .filter(|block| !package_block_is_page_break(&block.kind))
        .map(|block| (block.id.clone(), block.clone()))
        .collect::<BTreeMap<_, _>>();
    let valid_asset_ids = richpost_asset_records(cover_asset, image_assets)
        .iter()
        .map(|asset| asset.id.clone())
        .collect::<BTreeSet<_>>();
    let mut assigned_block_ids = BTreeSet::<String>::new();
    let mut normalized_pages = Vec::<Value>::new();

    if let Some(pages) = raw.get("pages").and_then(Value::as_array) {
        for page in pages {
            let Some(object) = page.as_object() else {
                continue;
            };
            let template = normalize_richpost_template(
                object
                    .get("template")
                    .and_then(Value::as_str)
                    .unwrap_or("text-stack"),
            );
            let master = object
                .get("master")
                .and_then(Value::as_str)
                .and_then(sanitize_richpost_master_name)
                .unwrap_or_else(|| richpost_master_name_from_template(template));
            let legacy_block_ids = object
                .get("blockIds")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|value| blocks_by_id.contains_key(*value))
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let legacy_asset_ids = object
                .get("assetIds")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|value| valid_asset_ids.contains(*value))
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let zones = normalize_richpost_zones(
                object.get("zones"),
                &blocks_by_id,
                richpost_master_role(&master, template),
                template,
                &legacy_block_ids,
                &legacy_asset_ids,
                &mut assigned_block_ids,
                &valid_asset_ids,
            );
            let Some(zone_object) = zones.as_object() else {
                continue;
            };
            let block_ids = richpost_zone_block_ids(zone_object);
            let asset_ids = richpost_zone_asset_ids(zone_object);
            if block_ids.is_empty() && asset_ids.is_empty() {
                continue;
            }
            normalized_pages.push(json!({
                "master": master,
                "template": template,
                "blockIds": block_ids,
                "assetIds": asset_ids,
                "zones": zones,
                "styleOverrides": normalize_richpost_style_overrides(object.get("styleOverrides"), template)
            }));
        }
    }

    let remaining_block_ids = all_block_ids
        .into_iter()
        .filter(|block_id| !assigned_block_ids.contains(block_id))
        .collect::<Vec<_>>();
    let already_used_assets = normalized_pages
        .iter()
        .filter_map(|page| page.get("zones").and_then(Value::as_object))
        .flat_map(richpost_zone_asset_ids)
        .collect::<BTreeSet<_>>();
    let remaining_image_assets = image_assets
        .iter()
        .filter(|asset| !already_used_assets.contains(&asset.id))
        .cloned()
        .collect::<Vec<_>>();
    if !remaining_block_ids.is_empty() {
        let fallback = default_richpost_page_plan(
            title,
            &blocks
                .iter()
                .filter(|block| remaining_block_ids.contains(&block.id))
                .cloned()
                .collect::<Vec<_>>(),
            None,
            &remaining_image_assets,
            "system-overflow",
            typography,
            theme,
        );
        if let Some(pages) = fallback.get("pages").and_then(Value::as_array) {
            normalized_pages.extend(pages.iter().cloned().map(|page| {
                json!({
                    "master": page.get("master").cloned().unwrap_or_else(|| json!(RICHPOST_MASTER_BODY)),
                    "template": page.get("template").cloned().unwrap_or_else(|| json!("text-stack")),
                    "blockIds": page.get("blockIds").cloned().unwrap_or_else(|| json!([])),
                    "assetIds": page.get("assetIds").cloned().unwrap_or_else(|| json!([])),
                    "zones": page.get("zones").cloned().unwrap_or_else(|| json!({})),
                    "styleOverrides": page.get("styleOverrides").cloned().unwrap_or_else(|| json!({}))
                })
            }));
        }
    }

    if normalized_pages.is_empty() {
        return default_richpost_page_plan(
            title,
            blocks,
            cover_asset,
            image_assets,
            source,
            typography,
            theme,
        );
    }

    let pages = normalized_pages
        .into_iter()
        .enumerate()
        .map(|(index, mut page)| {
            if let Some(object) = page.as_object_mut() {
                object.insert("id".to_string(), json!(format!("page-{:03}", index + 1)));
            }
            page
        })
        .collect::<Vec<_>>();

    json!({
        "version": 1,
        "title": title,
        "generatedAt": now_i64(),
        "source": source,
        "pageCount": pages.len(),
        "pages": pages
    })
}

fn richpost_page_plan_outline(blocks: &[PackageContentBlock]) -> String {
    if blocks.is_empty() {
        return "无正文块".to_string();
    }
    blocks
        .iter()
        .map(|block| {
            if package_block_is_page_break(&block.kind) {
                return format!(
                    "- id={} | type=page-break | 由连续三个空行触发，表示这里必须换页",
                    block.id
                );
            }
            let preview = normalize_package_block_text(&block.text)
                .chars()
                .take(36)
                .collect::<String>();
            format!(
                "- id={} | type={}{} | chars={} | preview={}",
                block.id,
                block.kind,
                block
                    .level
                    .map(|level| format!(" h{level}"))
                    .unwrap_or_default(),
                block.char_count,
                preview
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn richpost_css_var_map_from_tokens(
    tokens: &Value,
    role: &str,
    style_overrides: Option<&Value>,
) -> BTreeMap<String, String> {
    let mut map = BTreeMap::<String, String>::new();
    if let Some(object) = tokens.get("cssVars").and_then(Value::as_object) {
        for (key, value) in object {
            let Some(name) = sanitize_richpost_css_var_name(key) else {
                continue;
            };
            let Some(text) = richpost_css_var_string(value) else {
                continue;
            };
            map.insert(name, text);
        }
    }
    if let Some(object) = tokens
        .get("roleCssVars")
        .and_then(|value| value.get(role))
        .and_then(Value::as_object)
    {
        for (key, value) in object {
            let Some(name) = sanitize_richpost_css_var_name(key) else {
                continue;
            };
            let Some(text) = richpost_css_var_string(value) else {
                continue;
            };
            map.insert(name, text);
        }
    }
    if let Some(object) = style_overrides.and_then(Value::as_object) {
        for (key, value) in object {
            let Some(name) = sanitize_richpost_css_var_name(key) else {
                continue;
            };
            let Some(text) = richpost_css_var_string(value) else {
                continue;
            };
            map.insert(name, text);
        }
    }
    map
}

fn richpost_css_var_style_attr(vars: &BTreeMap<String, String>) -> String {
    vars.iter()
        .map(|(key, value)| format!("{}:{};", escape_html(key), escape_html(value)))
        .collect::<Vec<_>>()
        .join("")
}

fn richpost_token_value(tokens: &Value, key: &str) -> String {
    tokens
        .get("cssVars")
        .and_then(Value::as_object)
        .and_then(|object| object.get(key))
        .and_then(richpost_css_var_string)
        .unwrap_or_default()
}

fn richpost_zone_html(
    page: &Value,
    zone_name: &str,
    blocks_by_id: &BTreeMap<String, PackageContentBlock>,
    assets_by_id: &BTreeMap<String, PackageBoundAsset>,
) -> String {
    let Some(zone) = page
        .get("zones")
        .and_then(Value::as_object)
        .and_then(|zones| zones.get(zone_name))
        .and_then(Value::as_object)
    else {
        return String::new();
    };
    let asset_html = zone
        .get("assetIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|asset_id| assets_by_id.get(asset_id))
                .map(|asset| {
                    format!(
                        "<figure class=\"page-asset\" data-asset-id=\"{}\"><img src=\"{}\" alt=\"{}\" loading=\"lazy\" /></figure>",
                        escape_html(&asset.id),
                        escape_html(&asset.url),
                        escape_html(&asset.title)
                    )
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
        ;
    let fragment_array = zone
        .get("fragments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let fragment_html = fragment_array
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|fragment| {
            let text = fragment.get("text").and_then(Value::as_str)?;
            let kind = fragment
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("paragraph");
            let level = fragment
                .get("level")
                .and_then(Value::as_u64)
                .and_then(|value| u8::try_from(value).ok());
            Some(render_package_block_fragment_parts(kind, level, text))
        })
        .collect::<Vec<_>>()
        .join("");
    let block_html = zone
        .get("blockIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|block_id| blocks_by_id.get(block_id))
                .map(render_package_block_fragment)
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    let render_fragments_first = fragment_array.iter().any(|fragment| {
        fragment
            .get("continuedFromPrevious")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    });
    let zone_content = if fragment_html.is_empty() {
        block_html
    } else if block_html.is_empty() {
        fragment_html
    } else if render_fragments_first {
        format!("{fragment_html}{block_html}")
    } else {
        format!("{block_html}{fragment_html}")
    };
    format!("{asset_html}{zone_content}")
}

fn read_richpost_master_fragment(
    package_path: &std::path::Path,
    theme: Option<&RichpostThemeSpec>,
    master_name: &str,
    template: &str,
) -> String {
    let sanitized = sanitize_richpost_master_name(master_name)
        .unwrap_or_else(|| richpost_master_name_from_template(template));
    let role = richpost_master_role(&sanitized, template);
    if let Some(theme_path) = theme.and_then(|value| {
        richpost_theme_root_master_path_for_theme(package_path, value, &sanitized)
    }) {
        if let Some(content) = fs::read_to_string(&theme_path)
            .ok()
            .map(|content| content.trim().to_string())
            .filter(|content| !content.is_empty())
        {
            return content;
        }
    }
    let package_master_path = package_richpost_master_path(package_path, &sanitized);
    fs::read_to_string(&package_master_path)
        .ok()
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty())
        .unwrap_or_else(|| default_richpost_master_fragment(role).to_string())
}

fn render_richpost_master_fragment(
    master_fragment: &str,
    page: &Value,
    blocks_by_id: &BTreeMap<String, PackageContentBlock>,
    assets_by_id: &BTreeMap<String, PackageBoundAsset>,
) -> String {
    let mut zone_names = vec![
        "background".to_string(),
        "overlay".to_string(),
        "decoration".to_string(),
        "title".to_string(),
        "body".to_string(),
        "media".to_string(),
        "footer".to_string(),
    ];
    if let Some(object) = page.get("zones").and_then(Value::as_object) {
        for zone_name in object.keys() {
            if !zone_names.iter().any(|item| item == zone_name) {
                zone_names.push(zone_name.clone());
            }
        }
    }
    let mut rendered = master_fragment.to_string();
    for zone_name in zone_names {
        rendered = rendered.replace(
            &format!("{{{{zone:{zone_name}}}}}"),
            &richpost_zone_html(page, &zone_name, blocks_by_id, assets_by_id),
        );
    }
    rendered
}

fn render_richpost_page_html(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
    title: &str,
    page: &Value,
    page_index: usize,
    _total_pages: usize,
    blocks_by_id: &BTreeMap<String, PackageContentBlock>,
    assets_by_id: &BTreeMap<String, PackageBoundAsset>,
    tokens: &Value,
    typography: RichpostTypographySettings,
) -> String {
    let template = normalize_richpost_template(
        page.get("template")
            .and_then(Value::as_str)
            .unwrap_or("text-stack"),
    );
    let master_name = page
        .get("master")
        .and_then(Value::as_str)
        .and_then(sanitize_richpost_master_name)
        .unwrap_or_else(|| richpost_master_name_from_template(template));
    let master_role = richpost_master_role(&master_name, template);
    let page_css_vars =
        richpost_css_var_map_from_tokens(tokens, master_role, page.get("styleOverrides"));
    let page_style_attr = richpost_css_var_style_attr(&page_css_vars);
    let page_id = page
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("page-{:03}", page_index + 1));
    let page_title = page
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("{title} - 第 {} 页", page_index + 1));
    let master_fragment =
        read_richpost_master_fragment(package_path, Some(theme), &master_name, template);
    let page_markup =
        render_richpost_master_fragment(&master_fragment, page, blocks_by_id, assets_by_id);

    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{}</title>
  <style>
    :root {{ --rb-font-scale: 1; --rb-line-height-scale: 1; }}
    * {{ box-sizing: border-box; }}
    html, body {{ margin: 0; width: 100%; height: 100%; overflow: hidden; }}
    body {{
      height: 100vh;
      background: var(--rb-page-bg, #ffffff);
      color: var(--rb-body-text, var(--rb-text, #111111));
      font-family: var(--rb-body-font, "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif);
    }}
    .rb-page-host {{
      position: relative;
      width: 100%;
      height: 100vh;
      aspect-ratio: 3 / 4;
      background: var(--rb-page-bg, #ffffff);
      color: var(--rb-body-text, var(--rb-text, #111111));
      overflow: hidden;
      isolation: isolate;
    }}
    .rb-zone {{ min-width: 0; }}
    .rb-zone:empty {{ display: none; }}
    .rb-zone-background:empty,
    .rb-zone-overlay:empty,
    .rb-zone-decoration:empty {{ display: block; }}
    .rb-zone-overlay,
    .rb-zone-decoration {{ pointer-events: none; }}
    .page-asset {{
      width: 100%;
      margin: 0;
      max-width: 100%;
    }}
    .page-asset + .page-asset {{ margin-top: var(--rb-zone-gap, 16px); }}
    .page-asset img {{
      display: block;
      width: 100%;
      max-width: 100%;
      height: auto;
      border-radius: var(--rb-image-radius, 0px);
    }}
    .rb-block {{ min-width: 0; }}
    .rb-block + .rb-block {{ margin-top: var(--rb-zone-gap, 16px); }}
    .rb-heading {{
      width: min(100%, var(--rb-title-max-width, 100%));
    }}
    .rb-heading h1,
    .rb-heading h2,
    .rb-heading h3,
    .rb-heading h4,
    .rb-heading h5,
    .rb-heading h6 {{
      margin: 0;
      color: var(--rb-heading-text, var(--rb-text, #111111));
      font-family: var(--rb-heading-font, var(--rb-body-font, "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif));
      font-weight: 700;
      line-height: 1.22;
      letter-spacing: -0.02em;
    }}
    .rb-heading h1 {{ font-size: var(--rb-heading-h1-size, calc(clamp(28px, 5.4vw, 58px) * var(--rb-font-scale))); }}
    .rb-heading h2 {{ font-size: var(--rb-heading-h2-size, calc(clamp(24px, 4.5vw, 48px) * var(--rb-font-scale))); }}
    .rb-heading h3 {{ font-size: var(--rb-heading-h3-size, calc(clamp(21px, 3.8vw, 40px) * var(--rb-font-scale))); }}
    .rb-heading h4 {{ font-size: var(--rb-heading-h4-size, calc(clamp(18px, 3.2vw, 34px) * var(--rb-font-scale))); }}
    .rb-heading h5 {{ font-size: var(--rb-heading-h5-size, calc(clamp(17px, 2.7vw, 28px) * var(--rb-font-scale))); }}
    .rb-heading h6 {{ font-size: var(--rb-heading-h6-size, calc(clamp(16px, 2.4vw, 24px) * var(--rb-font-scale))); }}
    .rb-paragraph {{
      width: min(100%, var(--rb-content-max-width, 100%));
    }}
    .rb-paragraph > :first-child {{ margin-top: 0; }}
    .rb-paragraph > :last-child {{ margin-bottom: 0; }}
    .rb-paragraph p,
    .rb-paragraph li,
    .rb-paragraph blockquote,
    .rb-paragraph td,
    .rb-paragraph th {{
      color: var(--rb-body-text, var(--rb-text, #111111));
      font-family: var(--rb-body-font, "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif);
      font-size: var(--rb-body-font-size, calc(clamp(17px, 3.2vw, 34px) * var(--rb-font-scale)));
      line-height: var(--rb-runtime-body-line-height, var(--rb-body-line-height, 1.9));
    }}
    .rb-paragraph strong {{ font-weight: var(--rb-strong-weight, 700); }}
    .rb-paragraph a {{
      color: var(--rb-accent, #111111);
      text-decoration: var(--rb-link-decoration, underline);
    }}
    .rb-paragraph ul,
    .rb-paragraph ol {{
      margin: 0;
      padding-left: 1.25em;
    }}
    .rb-paragraph blockquote {{
      margin: 0;
      padding-left: 1em;
      border-left: 3px solid var(--rb-accent, #111111);
      color: var(--rb-muted, #666666);
    }}
    .rb-paragraph table {{
      margin: 0;
      border-collapse: collapse;
    }}
    .rb-paragraph hr {{
      border: 0;
      border-top: 1px solid var(--rb-surface-border, rgba(17,17,17,0.08));
      margin: calc(var(--rb-zone-gap, 16px) * 1.1) 0;
    }}
  </style>
  <script>
    (() => {{
      const applyRuntimeTypography = (fontScale, lineHeightScale) => {{
        document.documentElement.style.setProperty('--rb-font-scale', String(fontScale));
        document.documentElement.style.setProperty('--rb-line-height-scale', String(lineHeightScale));
        const host = document.querySelector('.rb-page-host');
        if (!host) return;
        const computed = window.getComputedStyle(host);
        const rawBaseLineHeight = Number.parseFloat(computed.getPropertyValue('--rb-body-line-height').trim() || '1.9');
        const baseLineHeight = Number.isFinite(rawBaseLineHeight) ? rawBaseLineHeight : 1.9;
        host.style.setProperty('--rb-runtime-body-line-height', String((baseLineHeight * lineHeightScale).toFixed(3)));
      }};
      const params = new URLSearchParams(window.location.search);
      const defaultFontScale = {};
      const defaultLineHeightScale = {};
      const rawFontScale = Number(params.get('fontScale') || String(defaultFontScale));
      const fontScale = Number.isFinite(rawFontScale) ? Math.min(1.6, Math.max(0.8, rawFontScale)) : defaultFontScale;
      const rawLineHeightScale = Number(params.get('lineHeightScale') || String(defaultLineHeightScale));
      const lineHeightScale = Number.isFinite(rawLineHeightScale) ? Math.min(1.4, Math.max(0.8, rawLineHeightScale)) : defaultLineHeightScale;
      const run = () => applyRuntimeTypography(fontScale, lineHeightScale);
      if (document.readyState === 'loading') {{
        document.addEventListener('DOMContentLoaded', run, {{ once: true }});
      }} else {{
        run();
      }}
    }})();
  </script>
</head>
<body>
  <section class="rb-page-host" data-page-id="{}" data-master="{}" data-template="{}" style="{}">
    {}
  </section>
</body>
</html>"#,
        escape_html(&page_title),
        typography.font_scale,
        typography.line_height_scale,
        escape_html(&page_id),
        escape_html(master_role),
        escape_html(template),
        page_style_attr,
        page_markup,
    )
}

fn render_richpost_preview_shell(
    title: &str,
    plan: &Value,
    _package_path: &std::path::Path,
    tokens: &Value,
    typography: RichpostTypographySettings,
) -> String {
    let pages = plan
        .get("pages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let cards = pages
        .iter()
        .filter_map(|page| {
            let page_id = page.get("id").and_then(Value::as_str)?;
            let label = page.get("label").and_then(Value::as_str).unwrap_or(page_id);
            Some(format!(
                "<section class=\"preview-card\"><iframe title=\"{}\" src=\"./pages/{}.html?v={}\" loading=\"lazy\"></iframe></section>",
                escape_html(label),
                escape_html(page_id),
                now_i64()
            ))
        })
        .collect::<Vec<_>>()
        .join("");
    let shell_bg = richpost_token_value(tokens, "--rb-shell-bg");
    let preview_card_bg = richpost_token_value(tokens, "--rb-preview-card-bg");
    let preview_card_border = richpost_token_value(tokens, "--rb-preview-card-border");
    let preview_card_shadow = richpost_token_value(tokens, "--rb-preview-card-shadow");
    let text_color = richpost_token_value(tokens, "--rb-text");
    let muted_color = richpost_token_value(tokens, "--rb-muted");
    let heading_font = richpost_token_value(tokens, "--rb-heading-font");
    let body_font = richpost_token_value(tokens, "--rb-body-font");
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{}</title>
  <style>
    :root {{
      color-scheme: light;
      --bg:{};
      --card:{};
      --text:{};
      --muted:{};
      --line:{};
      --shadow:{};
      --heading-font:{};
      --body-font:{};
    }}
    * {{ box-sizing: border-box; }}
    body {{ margin:0; background:var(--bg); color:var(--text); font-family:var(--body-font); }}
    .shell {{ max-width: 780px; margin: 0 auto; padding: 28px 18px 48px; }}
    .pages {{ display:flex; flex-direction:column; gap:20px; }}
    .preview-card {{ padding:16px; background:var(--card); border:1px solid var(--line); box-shadow:var(--shadow); backdrop-filter: blur(10px); border-radius:0; }}
    iframe {{ display:block; width:100%; aspect-ratio:3/4; border:0; background:#fff; }}
  </style>
  <script>
    (() => {{
      const params = new URLSearchParams(window.location.search);
      const defaultFontScale = String({});
      const defaultLineHeightScale = String({});
      const rawFontScale = params.get('fontScale') || defaultFontScale;
      const rawLineHeightScale = params.get('lineHeightScale') || defaultLineHeightScale;
      document.addEventListener('DOMContentLoaded', () => {{
        document.querySelectorAll('iframe').forEach((frame) => {{
          const src = frame.getAttribute('src');
          if (!src) return;
          const nextUrl = new URL(src, window.location.href);
          nextUrl.searchParams.set('fontScale', rawFontScale);
          nextUrl.searchParams.set('lineHeightScale', rawLineHeightScale);
          frame.setAttribute('src', nextUrl.toString());
        }});
      }});
    }})();
  </script>
</head>
<body>
  <div class="shell">
    <main class="pages">{}</main>
  </div>
</body>
</html>"#,
        escape_html(title),
        shell_bg,
        preview_card_bg,
        text_color,
        muted_color,
        preview_card_border,
        preview_card_shadow,
        heading_font,
        body_font,
        typography.font_scale,
        typography.line_height_scale,
        cards
    )
}

fn render_richpost_theme_preview_html(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
    typography: RichpostTypographySettings,
) -> String {
    render_richpost_theme_preview_page_html(
        package_path,
        theme,
        typography,
        richpost_theme_preview_master(theme),
    )
}

fn read_richpost_preview_layout_tokens_value_for_theme(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
) -> Value {
    let default_tokens = theme::scaffold::default_richpost_layout_tokens(Some(package_path), theme);
    let raw = theme::store::richpost_theme_root_tokens_path_for_theme(package_path, theme)
        .map(|path| read_json_value_or(&path, default_tokens.clone()))
        .unwrap_or(default_tokens);
    theme::scaffold::normalize_richpost_layout_tokens_value(&raw, theme, Some(package_path))
}

fn read_richpost_preview_master_fragment(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
    master_name: &str,
    template: &str,
) -> String {
    let sanitized = sanitize_richpost_master_name(master_name)
        .unwrap_or_else(|| richpost_master_name_from_template(template));
    let role = richpost_master_role(&sanitized, template);
    if let Some(theme_path) =
        theme::store::richpost_theme_root_master_path_for_theme(package_path, theme, &sanitized)
    {
        if let Some(content) = fs::read_to_string(&theme_path)
            .ok()
            .map(|content| content.trim().to_string())
            .filter(|content| !content.is_empty())
        {
            return content;
        }
    }
    default_richpost_master_fragment(role).to_string()
}

fn render_richpost_isolated_preview_page_html(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
    title: &str,
    page: &Value,
    page_index: usize,
    blocks_by_id: &BTreeMap<String, PackageContentBlock>,
    assets_by_id: &BTreeMap<String, PackageBoundAsset>,
    tokens: &Value,
    typography: RichpostTypographySettings,
) -> String {
    let template = normalize_richpost_template(
        page.get("template")
            .and_then(Value::as_str)
            .unwrap_or("text-stack"),
    );
    let master_name = page
        .get("master")
        .and_then(Value::as_str)
        .and_then(sanitize_richpost_master_name)
        .unwrap_or_else(|| richpost_master_name_from_template(template));
    let master_role = richpost_master_role(&master_name, template);
    let page_css_vars =
        richpost_css_var_map_from_tokens(tokens, master_role, page.get("styleOverrides"));
    let page_style_attr = richpost_css_var_style_attr(&page_css_vars);
    let page_id = page
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("preview-page-{:03}", page_index + 1));
    let page_title = page
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("{title} - 第 {} 页", page_index + 1));
    let master_fragment =
        read_richpost_preview_master_fragment(package_path, theme, &master_name, template);
    let page_markup =
        render_richpost_master_fragment(&master_fragment, page, blocks_by_id, assets_by_id);

    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{}</title>
  <style>
    :root {{ --rb-font-scale: 1; --rb-line-height-scale: 1; }}
    html, body {{ width: 100%; height: 100%; margin: 0; }}
    body {{
      background: transparent;
      overflow: hidden;
    }}
    .rb-page-host {{
      position: relative;
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      color: var(--rb-text, #111111);
      font-family: var(--rb-body-font, "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif);
      font-size: var(--rb-body-font-size, calc(clamp(17px, 3.2vw, 34px) * var(--rb-font-scale)));
      line-height: var(--rb-runtime-body-line-height, calc(var(--rb-body-line-height, 1.9) * var(--rb-line-height-scale)));
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }}
    .rb-page-host *, .rb-page-host *::before, .rb-page-host *::after {{ box-sizing: border-box; }}
    .rb-page-host h1, .rb-page-host h2, .rb-page-host h3, .rb-page-host h4, .rb-page-host h5, .rb-page-host h6 {{
      margin: 0;
      color: var(--rb-heading-text, var(--rb-text, #111111));
      font-family: var(--rb-heading-font, var(--rb-body-font, "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif));
      line-height: 1.18;
      letter-spacing: -0.03em;
    }}
    .rb-page-host h1 {{ font-size: var(--rb-heading-h1-size, calc(clamp(28px, 5.4vw, 58px) * var(--rb-font-scale))); }}
    .rb-page-host h2 {{ font-size: var(--rb-heading-h2-size, calc(clamp(24px, 4.5vw, 48px) * var(--rb-font-scale))); }}
    .rb-page-host h3 {{ font-size: var(--rb-heading-h3-size, calc(clamp(21px, 3.8vw, 40px) * var(--rb-font-scale))); }}
    .rb-page-host h4 {{ font-size: var(--rb-heading-h4-size, calc(clamp(18px, 3.2vw, 34px) * var(--rb-font-scale))); }}
    .rb-page-host h5 {{ font-size: var(--rb-heading-h5-size, calc(clamp(17px, 2.7vw, 28px) * var(--rb-font-scale))); }}
    .rb-page-host h6 {{ font-size: var(--rb-heading-h6-size, calc(clamp(16px, 2.4vw, 24px) * var(--rb-font-scale))); }}
    .rb-page-host p {{
      margin: 0;
      color: var(--rb-body-text, var(--rb-text, #111111));
      font-family: var(--rb-body-font, "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif);
      font-size: inherit;
      line-height: inherit;
      word-break: break-word;
      white-space: pre-wrap;
    }}
    .rb-page-host a {{
      color: var(--rb-accent, #111111);
      text-decoration: var(--rb-link-decoration, underline);
    }}
    .rb-page-host strong {{
      font-weight: var(--rb-strong-weight, 700);
    }}
    .rb-page-host img {{
      max-width: 100%;
      display: block;
      border-radius: var(--rb-image-radius, 0px);
    }}
    .rb-page-host ul, .rb-page-host ol {{
      margin: 0;
      padding-left: 1.25em;
    }}
    .rb-page-host blockquote {{
      margin: 0;
      padding-left: 1em;
      border-left: 3px solid var(--rb-accent, #111111);
      color: var(--rb-muted, #666666);
    }}
    .rb-page-host table {{
      margin: 0;
      border-collapse: collapse;
    }}
    .rb-page-host hr {{
      border: 0;
      border-top: 1px solid var(--rb-surface-border, rgba(17,17,17,0.08));
      margin: calc(var(--rb-zone-gap, 16px) * 1.1) 0;
    }}
  </style>
  <script>
    (() => {{
      const applyRuntimeTypography = (fontScale, lineHeightScale) => {{
        document.documentElement.style.setProperty('--rb-font-scale', String(fontScale));
        document.documentElement.style.setProperty('--rb-line-height-scale', String(lineHeightScale));
        const host = document.querySelector('.rb-page-host');
        if (!host) return;
        const computed = window.getComputedStyle(host);
        const rawBaseLineHeight = Number.parseFloat(computed.getPropertyValue('--rb-body-line-height').trim() || '1.9');
        const baseLineHeight = Number.isFinite(rawBaseLineHeight) ? rawBaseLineHeight : 1.9;
        host.style.setProperty('--rb-runtime-body-line-height', String((baseLineHeight * lineHeightScale).toFixed(3)));
      }};
      const params = new URLSearchParams(window.location.search);
      const defaultFontScale = {};
      const defaultLineHeightScale = {};
      const rawFontScale = Number(params.get('fontScale') || String(defaultFontScale));
      const fontScale = Number.isFinite(rawFontScale) ? Math.min(1.6, Math.max(0.8, rawFontScale)) : defaultFontScale;
      const rawLineHeightScale = Number(params.get('lineHeightScale') || String(defaultLineHeightScale));
      const lineHeightScale = Number.isFinite(rawLineHeightScale) ? Math.min(1.4, Math.max(0.8, rawLineHeightScale)) : defaultLineHeightScale;
      const run = () => applyRuntimeTypography(fontScale, lineHeightScale);
      if (document.readyState === 'loading') {{
        document.addEventListener('DOMContentLoaded', run, {{ once: true }});
      }} else {{
        run();
      }}
    }})();
  </script>
</head>
<body>
  <section class="rb-page-host" data-page-id="{}" data-master="{}" data-template="{}" style="{}">
    {}
  </section>
</body>
</html>"#,
        escape_html(&page_title),
        typography.font_scale,
        typography.line_height_scale,
        escape_html(&page_id),
        escape_html(master_role),
        escape_html(template),
        page_style_attr,
        page_markup,
    )
}

fn render_richpost_theme_preview_page_html(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
    typography: RichpostTypographySettings,
    master_id: &str,
) -> String {
    let blocks = vec![
        PackageContentBlock {
            id: "preview_h1".to_string(),
            slot: "preview_h1".to_string(),
            kind: "heading".to_string(),
            level: Some(1),
            text: RICHPOST_THEME_PREVIEW_TITLE.to_string(),
            order: 0,
            char_count: RICHPOST_THEME_PREVIEW_TITLE.chars().count(),
        },
        PackageContentBlock {
            id: "preview_p1".to_string(),
            slot: "preview_p1".to_string(),
            kind: "paragraph".to_string(),
            level: None,
            text: RICHPOST_THEME_PREVIEW_BODY.to_string(),
            order: 1,
            char_count: RICHPOST_THEME_PREVIEW_BODY.chars().count(),
        },
    ];
    let blocks_by_id = blocks
        .into_iter()
        .map(|block| (block.id.clone(), block))
        .collect::<BTreeMap<_, _>>();
    let preview_page = json!({
        "id": "preview-page",
        "master": master_id,
        "template": "text-stack",
        "blockIds": ["preview_h1", "preview_p1"],
        "assetIds": [],
        "zones": {
            "title": {
                "blockIds": ["preview_h1"]
            },
            "body": {
                "blockIds": ["preview_p1"]
            }
        },
        "styleOverrides": {}
    });
    let tokens = read_richpost_preview_layout_tokens_value_for_theme(package_path, theme);
    render_richpost_isolated_preview_page_html(
        package_path,
        theme,
        RICHPOST_THEME_PREVIEW_TITLE,
        &preview_page,
        0,
        &blocks_by_id,
        &BTreeMap::new(),
        &tokens,
        typography,
    )
}

fn render_richpost_theme_preview_pages(
    package_path: &std::path::Path,
    theme: &RichpostThemeSpec,
    typography: RichpostTypographySettings,
) -> Vec<Value> {
    [
        (RICHPOST_MASTER_COVER, "首页"),
        (RICHPOST_MASTER_BODY, "内容页"),
        (RICHPOST_MASTER_ENDING, "尾页"),
    ]
    .into_iter()
    .map(|(master_id, label)| {
        json!({
            "id": master_id,
            "label": label,
            "html": render_richpost_theme_preview_page_html(package_path, theme, typography, master_id),
        })
    })
    .collect::<Vec<_>>()
}

fn persist_richpost_pages_from_plan(
    package_path: &std::path::Path,
    title: &str,
    blocks: &[PackageContentBlock],
    cover_asset: Option<&PackageBoundAsset>,
    image_assets: &[PackageBoundAsset],
    plan: &Value,
) -> Result<(), String> {
    let manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    let tokens = ensure_richpost_layout_scaffold(package_path, &manifest)?;
    let typography = richpost_typography_settings_from_manifest(&manifest);
    let theme = richpost_theme_spec_from_manifest(Some(package_path), &manifest);
    let pages_dir = package_richpost_pages_dir(package_path);
    fs::create_dir_all(&pages_dir).map_err(|error| error.to_string())?;
    let blocks_by_id = blocks
        .iter()
        .map(|block| (block.id.clone(), block.clone()))
        .collect::<BTreeMap<_, _>>();
    let assets_by_id = richpost_asset_records(cover_asset, image_assets)
        .into_iter()
        .map(|asset| (asset.id.clone(), asset))
        .collect::<BTreeMap<_, _>>();
    let pages = plan
        .get("pages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut keep_file_names = BTreeSet::<String>::new();
    for (index, page) in pages.iter().enumerate() {
        let Some(page_id) = page.get("id").and_then(Value::as_str) else {
            continue;
        };
        let html = render_richpost_page_html(
            package_path,
            &theme,
            title,
            page,
            index,
            pages.len(),
            &blocks_by_id,
            &assets_by_id,
            &tokens,
            typography,
        );
        let path = package_richpost_page_html_path(package_path, page_id);
        write_text_file(&path, &html)?;
        keep_file_names.insert(format!("{page_id}.html"));
    }
    if let Ok(entries) = fs::read_dir(&pages_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !keep_file_names.contains(&file_name) {
                let _ = fs::remove_file(path);
            }
        }
    }
    write_text_file(
        &package_layout_html_path(package_path),
        &render_richpost_preview_shell(title, plan, package_path, &tokens, typography),
    )?;
    Ok(())
}

fn persist_richpost_page_plan(
    package_path: &std::path::Path,
    title: &str,
    blocks: &[PackageContentBlock],
    cover_asset: Option<&PackageBoundAsset>,
    image_assets: &[PackageBoundAsset],
    raw_plan: &Value,
    source: &str,
) -> Result<Value, String> {
    let manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    let typography = richpost_typography_settings_from_manifest(&manifest);
    let theme = richpost_theme_spec_from_manifest(Some(package_path), &manifest);
    let normalized = normalize_richpost_page_plan(
        raw_plan,
        title,
        blocks,
        cover_asset,
        image_assets,
        source,
        typography,
        &theme,
    );
    write_json_value(&package_richpost_page_plan_path(package_path), &normalized)?;
    persist_richpost_pages_from_plan(
        package_path,
        title,
        blocks,
        cover_asset,
        image_assets,
        &normalized,
    )?;
    let mut manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    if let Some(object) = manifest.as_object_mut() {
        object.insert("updatedAt".to_string(), json!(now_i64()));
    }
    write_json_value(&package_manifest_path(package_path), &manifest)?;
    get_manuscript_package_state(package_path)
}

fn package_content_outline_prompt(blocks: &[PackageContentBlock]) -> String {
    if blocks.is_empty() {
        return "无正文块".to_string();
    }
    blocks
        .iter()
        .map(|block| {
            let preview = normalize_package_block_text(&block.text)
                .chars()
                .take(24)
                .collect::<String>();
            if block.kind == "heading" {
                format!(
                    "- {} | heading h{} | {} chars | preview={}",
                    block.slot,
                    block.level.unwrap_or(2),
                    block.char_count,
                    preview
                )
            } else {
                format!(
                    "- {} | paragraph | {} chars | preview={}",
                    block.slot, block.char_count, preview
                )
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn available_package_asset_slot_lines(image_assets: &[PackageBoundAsset]) -> Vec<String> {
    let mut lines = vec![
        "- {{asset:cover_url}} | 封面图片 URL，没有封面时为空".to_string(),
        "- {{asset:cover_figure}} | 已包好 <figure><img/></figure> 的封面块，没有封面时为空"
            .to_string(),
        "- {{asset:image_gallery}} | 已包好图库 HTML，没有配图时为空".to_string(),
        "- {{asset:image_count}} | 已绑定配图数量".to_string(),
    ];
    for (index, _) in image_assets.iter().enumerate() {
        let slot_index = index + 1;
        lines.push(format!(
            "- {{asset:image_{}_url}} | 第 {} 张配图 URL",
            slot_index, slot_index
        ));
        lines.push(format!(
            "- {{asset:image_{}_alt}} | 第 {} 张配图 alt 文本",
            slot_index, slot_index
        ));
    }
    lines
}

pub(crate) fn sync_manuscript_package_html_assets(
    state: Option<&State<'_, AppState>>,
    package_path: &std::path::Path,
    file_name: &str,
    content_override: Option<&str>,
    target_override: Option<&str>,
) -> Result<Value, String> {
    let package_kind =
        get_package_kind_from_file_name(file_name).ok_or_else(|| "未识别的工程类型".to_string())?;
    if package_kind != "post" {
        return get_manuscript_package_state(package_path);
    }
    let manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    let entry = manifest
        .get("entry")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| get_default_package_entry(file_name));
    let title = manifest
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| title_from_relative_path(file_name));
    let typography = richpost_typography_settings_from_manifest(&manifest);
    let theme = richpost_theme_spec_from_manifest(Some(package_path), &manifest);
    let _ = ensure_richpost_layout_scaffold(package_path, &manifest)?;
    let content = content_override
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            fs::read_to_string(package_entry_path(package_path, file_name, Some(&manifest)))
                .unwrap_or_default()
        });
    let content_map_path = package_content_map_path(package_path);
    let blocks = build_package_content_blocks(&content_map_path, &content);
    write_json_value(
        &content_map_path,
        &package_content_map_value(package_kind, &title, entry, &blocks),
    )?;
    let (cover_asset, image_assets) = collect_package_bound_assets(state, package_path)?;
    let has_manual_page_breaks = blocks
        .iter()
        .any(|block| package_block_is_page_break(&block.kind));
    let raw_plan = default_richpost_page_plan(
        &title,
        &blocks,
        cover_asset.as_ref(),
        &image_assets,
        if has_manual_page_breaks {
            "markdown-page-break"
        } else {
            "markdown-auto-reflow"
        },
        typography,
        &theme,
    );
    let _ = target_override;
    persist_richpost_page_plan(
        package_path,
        &title,
        &blocks,
        cover_asset.as_ref(),
        &image_assets,
        &raw_plan,
        raw_plan
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("system-sync"),
    )
}

fn persist_package_script_body(
    state: &State<'_, AppState>,
    package_path: &std::path::Path,
    file_name: &str,
    content: &str,
    metadata: Option<&serde_json::Map<String, Value>>,
    source: &str,
) -> Result<(Value, Value), String> {
    let mut manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    if let Some(object) = manifest.as_object_mut() {
        if let Some(metadata_object) = metadata {
            for (key, value) in metadata_object {
                object.insert(key.clone(), value.clone());
            }
        }
        object.insert("updatedAt".to_string(), json!(now_i64()));
        object
            .entry("title".to_string())
            .or_insert(json!(title_from_relative_path(file_name)));
        object
            .entry("entry".to_string())
            .or_insert(json!(get_default_package_entry(file_name)));
        object
            .entry("draftType".to_string())
            .or_insert(json!(get_draft_type_from_file_name(file_name)));
        object
            .entry("packageKind".to_string())
            .or_insert(json!(get_package_kind_from_file_name(file_name)));
        if matches!(get_package_kind_from_file_name(file_name), Some("post")) {
            let default_theme = default_richpost_theme_spec();
            object
                .entry("richpostThemeId".to_string())
                .or_insert(json!(default_theme.id.clone()));
            object
                .entry("richpostThemeSnapshot".to_string())
                .or_insert_with(|| richpost_theme_spec_storage_value(&default_theme));
        }
        if matches!(get_package_kind_from_file_name(file_name), Some("article")) {
            object
                .entry("longformLayoutPresetId".to_string())
                .or_insert(json!(longform_layout_preset_catalog()[0].id));
        }
    }
    write_json_value(&package_manifest_path(package_path), &manifest)?;
    write_text_file(
        &package_entry_path(package_path, file_name, Some(&manifest)),
        content,
    )?;

    if matches!(get_package_kind_from_file_name(file_name), Some("video")) {
        mark_manifest_video_script_pending(&mut manifest, source)?;
        write_json_value(&package_manifest_path(package_path), &manifest)?;
        return Ok((
            get_manuscript_package_state(package_path)?,
            package_video_script_state_value(package_path, file_name, &manifest),
        ));
    }

    if matches!(get_package_kind_from_file_name(file_name), Some("audio")) {
        let mut project = ensure_editor_project(package_path)?;
        mark_editor_project_script_pending(&mut project, content, source)?;
        write_json_value(&package_editor_project_path(package_path), &project)?;
        return Ok((
            get_manuscript_package_state(package_path)?,
            package_script_state_value(&project),
        ));
    }

    Ok((
        sync_manuscript_package_html_assets(
            Some(state),
            package_path,
            file_name,
            Some(content),
            None,
        )?,
        json!({
            "body": content,
            "approval": {
                "status": "pending",
                "lastScriptUpdateAt": Value::Null,
                "lastScriptUpdateSource": source,
                "confirmedAt": Value::Null
            }
        }),
    ))
}

pub(crate) fn save_manuscript_content(
    state: &State<'_, AppState>,
    target: &str,
    content: &str,
    metadata: Option<&serde_json::Map<String, Value>>,
    source: &str,
) -> Result<Value, String> {
    let current_relative = normalize_relative_path(target);
    let mut path = resolve_manuscript_path(state, target)?;
    let mut active_relative = current_relative.clone();
    let mut active_title = metadata
        .and_then(|items| items.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    let current_file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_string();
    let current_stem = title_from_relative_path(&current_relative);
    let should_auto_name = active_title
        .as_deref()
        .map(is_untitled_manuscript_label)
        .unwrap_or(false)
        || is_auto_generated_manuscript_stem(&current_stem);
    if should_auto_name {
        if let Some(next_title) = first_markdown_heading_text(content) {
            let next_relative = choose_auto_named_manuscript_relative(
                state,
                &current_relative,
                &current_file_name,
                &next_title,
            )?;
            if next_relative != current_relative {
                let next_path = resolve_manuscript_path(state, &next_relative)?;
                if let Some(parent) = next_path.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                if path.exists() {
                    fs::rename(&path, &next_path).map_err(|error| error.to_string())?;
                }
                path = next_path;
                active_relative = next_relative;
            }
            active_title = Some(next_title);
        }
    }

    let merged_metadata = {
        let mut items = metadata.cloned().unwrap_or_default();
        if let Some(title) = active_title.as_ref() {
            items.insert("title".to_string(), json!(title));
        }
        items
    };
    let path_file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_string();
    if !path.exists() && is_manuscript_package_name(&path_file_name) {
        let package_title = active_title
            .clone()
            .unwrap_or_else(|| title_from_relative_path(&active_relative));
        create_manuscript_package(&path, content, &active_relative, &package_title)?;
    }
    if path.is_dir()
        && is_manuscript_package_name(
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(""),
        )
    {
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let (next_state, script_state) = persist_package_script_body(
            state,
            &path,
            file_name,
            content,
            Some(&merged_metadata),
            source,
        )?;
        return Ok(json!({
            "success": true,
            "newPath": active_relative,
            "title": active_title,
            "state": next_state,
            "script": script_state,
            "content": content,
        }));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, content).map_err(|error| error.to_string())?;
    Ok(json!({
        "success": true,
        "newPath": active_relative,
        "title": active_title,
        "content": content,
    }))
}

fn normalize_package_html_target(
    package_kind: &str,
    raw_target: &str,
) -> Result<&'static str, String> {
    let normalized = raw_target.trim().to_ascii_lowercase();
    match package_kind {
        "article" => match normalized.as_str() {
            "" | "layout" => Ok(PACKAGE_HTML_LAYOUT_TARGET),
            "wechat" => Ok(PACKAGE_HTML_WECHAT_TARGET),
            _ => Err("长文工程只支持 layout 或 wechat HTML".to_string()),
        },
        "post" => match normalized.as_str() {
            "" | "layout" | "richpost" => Ok(PACKAGE_HTML_LAYOUT_TARGET),
            _ => Err("图文工程只支持 layout HTML".to_string()),
        },
        _ => Err("只有长文和图文工程支持 HTML 资产".to_string()),
    }
}

fn package_html_target_label(package_kind: &str, target: &str) -> &'static str {
    match (package_kind, target) {
        ("article", PACKAGE_HTML_WECHAT_TARGET) => "公众号正文",
        ("article", _) => "长文排版",
        ("post", _) => "图文排版",
        _ => "HTML 排版",
    }
}

fn package_html_base_style_instructions(package_kind: &str, target: &str) -> &'static str {
    match (package_kind, target) {
        ("article", PACKAGE_HTML_WECHAT_TARGET) => {
            "输出适合公众号正文的单栏长文排版。文字区域偏窄、留白稳定、标题层级清晰、引用和强调块克制，整体像真实公众号文章预览。"
        }
        ("article", _) => {
            "输出适合长文阅读的排版页。重点是标题、导语、小标题、正文、总结的层级清晰，可包含封面图和分隔区块，阅读体验比默认 Markdown 明显更强。"
        }
        ("post", _) => {
            "输出适合图文笔记预览的页面。整体偏移动端卡片感，段落更短，视觉节奏更快，封面和配图应自然穿插，但不要做成网页导航站。"
        }
        _ => "输出可读、克制、适合发布预览的 HTML 页面。",
    }
}

fn package_html_style_instructions(
    package_kind: &str,
    target: &str,
    manifest: Option<&Value>,
) -> String {
    let mut instructions = package_html_base_style_instructions(package_kind, target).to_string();
    if package_kind == "article" {
        let preset = manifest
            .map(longform_layout_preset_from_manifest)
            .unwrap_or(&longform_layout_preset_catalog()[0]);
        let preset_instructions = if target == PACKAGE_HTML_WECHAT_TARGET {
            preset.wechat_instructions
        } else {
            preset.layout_instructions
        };
        instructions.push_str("\n当前长文母版：");
        instructions.push_str(preset.label);
        instructions.push_str("。");
        instructions.push_str(preset_instructions);
    }
    instructions
}

fn asset_prompt_url(asset: &MediaAssetRecord) -> Option<String> {
    asset
        .preview_url
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            asset
                .absolute_path
                .as_ref()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .map(|value| file_url_for_path(std::path::Path::new(value)))
        })
}

fn collect_package_prompt_assets(
    state: &State<'_, AppState>,
    package_path: &std::path::Path,
) -> Result<(String, String, String), String> {
    let (cover_asset, image_assets) = collect_package_bound_assets(Some(state), package_path)?;
    let cover_block = cover_asset
        .as_ref()
        .map(|asset| format!("- {} | url={}", asset.title, asset.url))
        .unwrap_or_else(|| "无".to_string());
    let image_block = if image_assets.is_empty() {
        "无".to_string()
    } else {
        image_assets
            .iter()
            .enumerate()
            .map(|(index, asset)| {
                format!(
                    "- {} | imageIndex={} | url={}",
                    asset.title,
                    index + 1,
                    asset.url
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    Ok((
        cover_block,
        image_block,
        available_package_asset_slot_lines(&image_assets).join("\n"),
    ))
}

fn extract_html_document_from_text(raw: &str, title: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(start) = trimmed.find("```") {
        let fenced = &trimmed[start + 3..];
        let fenced = fenced
            .strip_prefix("html")
            .or_else(|| fenced.strip_prefix("HTML"))
            .unwrap_or(fenced)
            .trim_start_matches('\n');
        if let Some(end) = fenced.find("```") {
            return extract_html_document_from_text(fenced[..end].trim(), title);
        }
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("<!doctype html") || lower.starts_with("<html") {
        return Some(trimmed.to_string());
    }
    if trimmed.contains("<body")
        || trimmed.contains("<section")
        || trimmed.contains("<article")
        || trimmed.contains("<div")
    {
        return Some(format!(
            "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\" /><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" /><title>{}</title></head>{}</html>",
            escape_html(title),
            trimmed
        ));
    }
    None
}

fn persist_package_html_template(
    state: &State<'_, AppState>,
    package_path: &std::path::Path,
    file_name: &str,
    target: &str,
    html_template: &str,
) -> Result<Value, String> {
    write_text_file(
        &package_html_template_path(package_path, target),
        html_template,
    )?;
    sync_manuscript_package_html_assets(Some(state), package_path, file_name, None, Some(target))
}

fn generate_package_html_template(
    state: &State<'_, AppState>,
    package_path: &std::path::Path,
    file_name: &str,
    target: &str,
    title: &str,
    body: &str,
    model_config: Option<&Value>,
) -> Result<String, String> {
    let package_kind =
        get_package_kind_from_file_name(file_name).ok_or_else(|| "未识别的工程类型".to_string())?;
    let manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    let content_map_path = package_content_map_path(package_path);
    let blocks = build_package_content_blocks(&content_map_path, body);
    let (cover_asset_block, image_asset_block, asset_slot_block) =
        collect_package_prompt_assets(state, package_path)?;
    let prompt = render_redbox_prompt(
        &load_redbox_prompt_or_embedded(
            "templates/package_html_renderer.txt",
            include_str!("../../../prompts/library/templates/package_html_renderer.txt"),
        ),
        &[
            (
                "package_kind",
                if package_kind == "article" {
                    "longform"
                } else {
                    "richpost"
                }
                .to_string(),
            ),
            (
                "target_label",
                package_html_target_label(package_kind, target).to_string(),
            ),
            ("title", title.to_string()),
            (
                "style_instructions",
                package_html_style_instructions(package_kind, target, Some(&manifest)),
            ),
            (
                "available_text_slots",
                if blocks.is_empty() {
                    "无正文槽位，可只输出基础骨架和 {{slot:content_tail}}".to_string()
                } else {
                    package_content_outline_prompt(&blocks)
                },
            ),
            ("available_asset_slots", asset_slot_block),
            ("cover_asset_block", cover_asset_block),
            ("image_asset_block", image_asset_block),
            ("body_outline", markdown_summary(body, 240)),
        ],
    );
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let raw = run_model_structured_task_with_settings(
        &settings_snapshot,
        model_config,
        "你是 RedBox 的工程排版模板生成器。只输出严格 JSON：{\"html\": string}。html 必须是完整 HTML 模板文档，不要附加解释。",
        &prompt,
        true,
    )?;
    let parsed = parse_json_value_from_text(&raw).unwrap_or(Value::Null);
    let html = parsed
        .get("html")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| extract_html_document_from_text(&raw, title))
        .ok_or_else(|| "AI 没有返回可保存的 HTML 模板".to_string())?;
    extract_html_document_from_text(&html, title)
        .ok_or_else(|| "生成结果不是有效的 HTML 模板文档".to_string())
}

fn generate_richpost_page_plan(
    state: &State<'_, AppState>,
    package_path: &std::path::Path,
    file_name: &str,
    title: &str,
    body: &str,
    model_config: Option<&Value>,
) -> Result<Value, String> {
    let package_kind =
        get_package_kind_from_file_name(file_name).ok_or_else(|| "未识别的工程类型".to_string())?;
    if package_kind != "post" {
        return Err("只有图文工程支持分页方案".to_string());
    }
    let content_map_path = package_content_map_path(package_path);
    let blocks = build_package_content_blocks(&content_map_path, body);
    let manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    let typography = richpost_typography_settings_from_manifest(&manifest);
    let theme = richpost_theme_spec_from_manifest(Some(package_path), &manifest);
    let (cover_asset, image_assets) = collect_package_bound_assets(Some(state), package_path)?;
    let default_plan = default_richpost_page_plan(
        title,
        &blocks,
        cover_asset.as_ref(),
        &image_assets,
        "system-default",
        typography,
        &theme,
    );
    let prompt = render_redbox_prompt(
        &load_redbox_prompt_or_embedded(
            "templates/richpost_page_planner.txt",
            include_str!("../../../prompts/library/templates/richpost_page_planner.txt"),
        ),
        &[
            ("title", title.to_string()),
            ("body_outline", markdown_summary(body, 260)),
            ("content_block_outline", richpost_page_plan_outline(&blocks)),
            (
                "asset_outline",
                richpost_asset_outline_prompt(cover_asset.as_ref(), &image_assets),
            ),
            (
                "template_catalog",
                richpost_template_catalog()
                    .iter()
                    .map(|item| format!("- {item}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            (
                "default_plan_json",
                serde_json::to_string_pretty(&default_plan).map_err(|error| error.to_string())?,
            ),
        ],
    );
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let raw = run_model_structured_task_with_settings(
        &settings_snapshot,
        model_config,
        "你是 RedBox 的小红书图文分页规划器。只输出严格 JSON。不要解释。",
        &prompt,
        true,
    )?;
    let parsed = parse_json_value_from_text(&raw).unwrap_or(Value::Null);
    if !parsed.is_object() {
        return Ok(default_plan);
    }
    Ok(normalize_richpost_page_plan(
        &parsed,
        title,
        &blocks,
        cover_asset.as_ref(),
        &image_assets,
        "ai",
        typography,
        &theme,
    ))
}

fn persist_package_html_document(
    package_path: &std::path::Path,
    target: &str,
    html: &str,
) -> Result<Value, String> {
    write_text_file(&package_html_file_path(package_path, target), html)?;
    let mut manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    if let Some(object) = manifest.as_object_mut() {
        object.insert("updatedAt".to_string(), json!(now_i64()));
    }
    write_json_value(&package_manifest_path(package_path), &manifest)?;
    get_manuscript_package_state(package_path)
}

fn generate_package_html_document(
    state: &State<'_, AppState>,
    package_path: &std::path::Path,
    file_name: &str,
    target: &str,
    title: &str,
    body: &str,
    model_config: Option<&Value>,
) -> Result<String, String> {
    let package_kind =
        get_package_kind_from_file_name(file_name).ok_or_else(|| "未识别的工程类型".to_string())?;
    let manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
    let (cover_asset_block, image_asset_block, _) =
        collect_package_prompt_assets(state, package_path)?;
    let prompt = render_redbox_prompt(
        &load_redbox_prompt_or_embedded(
            "templates/package_html_document_renderer.txt",
            include_str!("../../../prompts/library/templates/package_html_document_renderer.txt"),
        ),
        &[
            ("package_kind", "longform".to_string()),
            (
                "target_label",
                package_html_target_label(package_kind, target).to_string(),
            ),
            ("title", title.to_string()),
            (
                "style_instructions",
                package_html_style_instructions(package_kind, target, Some(&manifest)),
            ),
            ("cover_asset_block", cover_asset_block),
            ("image_asset_block", image_asset_block),
            ("body", body.to_string()),
        ],
    );
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let raw = run_model_structured_task_with_settings(
        &settings_snapshot,
        model_config,
        "你是 RedBox 的 HTML 排版生成器。只输出严格 JSON：{\"html\": string}。html 必须是完整 HTML 文档，不要附加解释。",
        &prompt,
        true,
    )?;
    let parsed = parse_json_value_from_text(&raw).unwrap_or(Value::Null);
    let html = parsed
        .get("html")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| extract_html_document_from_text(&raw, title))
        .ok_or_else(|| "AI 没有返回可保存的 HTML 文档".to_string())?;
    extract_html_document_from_text(&html, title)
        .ok_or_else(|| "生成结果不是有效的 HTML 文档".to_string())
}

fn manuscript_write_proposal_by_file_path(
    store: &AppStore,
    file_path: &str,
) -> Option<ManuscriptWriteProposalRecord> {
    let normalized = normalize_relative_path(file_path);
    store
        .manuscript_write_proposals
        .iter()
        .find(|item| normalize_relative_path(&item.file_path) == normalized)
        .cloned()
}

pub(crate) fn get_manuscript_write_proposal(
    state: &State<'_, AppState>,
    file_path: &str,
) -> Result<Option<ManuscriptWriteProposalRecord>, String> {
    with_store(state, |store| {
        Ok(manuscript_write_proposal_by_file_path(&store, file_path))
    })
}

pub(crate) fn upsert_manuscript_write_proposal(
    app: &AppHandle,
    state: &State<'_, AppState>,
    proposal: ManuscriptWriteProposalRecord,
) -> Result<ManuscriptWriteProposalRecord, String> {
    let saved = with_store_mut(state, |store| {
        let normalized = normalize_relative_path(&proposal.file_path);
        store
            .manuscript_write_proposals
            .retain(|item| normalize_relative_path(&item.file_path) != normalized);
        store.manuscript_write_proposals.push(proposal.clone());
        Ok(proposal.clone())
    })?;
    crate::events::emit_manuscript_write_proposal_changed(
        app,
        &saved.file_path,
        Some(json!(saved.clone())),
    );
    Ok(saved)
}

pub(crate) fn reject_manuscript_write_proposal(
    app: &AppHandle,
    state: &State<'_, AppState>,
    file_path: &str,
) -> Result<bool, String> {
    let normalized = normalize_relative_path(file_path);
    let removed = with_store_mut(state, |store| {
        let before = store.manuscript_write_proposals.len();
        store
            .manuscript_write_proposals
            .retain(|item| normalize_relative_path(&item.file_path) != normalized);
        Ok(before != store.manuscript_write_proposals.len())
    })?;
    if removed {
        crate::events::emit_manuscript_write_proposal_changed(app, file_path, None);
    }
    Ok(removed)
}

pub(crate) fn accept_manuscript_write_proposal(
    app: &AppHandle,
    state: &State<'_, AppState>,
    file_path: &str,
) -> Result<Value, String> {
    let proposal = get_manuscript_write_proposal(state, file_path)?
        .ok_or_else(|| "未找到待审改稿提案".to_string())?;
    let saved = save_manuscript_content(
        state,
        &proposal.file_path,
        &proposal.proposed_content,
        proposal.metadata.as_ref().and_then(Value::as_object),
        "ai-proposal-accepted",
    )?;
    let _ = reject_manuscript_write_proposal(app, state, &proposal.file_path)?;
    let mut object = saved.as_object().cloned().unwrap_or_default();
    object.insert("proposalId".to_string(), json!(proposal.id));
    object.insert("filePath".to_string(), json!(proposal.file_path));
    object.insert("content".to_string(), json!(proposal.proposed_content));
    Ok(Value::Object(object))
}

fn default_clip_duration_ms_for_asset(asset: &MediaAssetRecord) -> i64 {
    if media_asset_kind(asset) == "image" {
        IMAGE_TIMELINE_CLIP_MS
    } else {
        DEFAULT_TIMELINE_CLIP_MS
    }
}

fn timeline_clip_asset_kind(clip: &Value) -> String {
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

fn editor_runtime_state_value(
    state: &State<'_, AppState>,
    file_path: &str,
) -> Result<Value, String> {
    let guard = state
        .editor_runtime_states
        .lock()
        .map_err(|_| "editor runtime state lock 已损坏".to_string())?;
    let record = guard.get(file_path).cloned();
    Ok(match record {
        Some(record) => json!({
            "filePath": record.file_path,
            "sessionId": record.session_id,
            "playheadSeconds": record.playhead_seconds,
            "selectedClipId": record.selected_clip_id,
            "selectedClipIds": record.selected_clip_ids,
            "activeTrackId": record.active_track_id,
            "selectedTrackIds": record.selected_track_ids,
            "selectedSceneId": record.selected_scene_id,
            "previewTab": record.preview_tab,
            "canvasRatioPreset": record.canvas_ratio_preset,
            "activePanel": record.active_panel,
            "drawerPanel": record.drawer_panel,
            "sceneItemTransforms": record.scene_item_transforms,
            "sceneItemVisibility": record.scene_item_visibility,
            "sceneItemOrder": record.scene_item_order,
            "sceneItemLocks": record.scene_item_locks,
            "sceneItemGroups": record.scene_item_groups,
            "focusedGroupId": record.focused_group_id,
            "trackUi": record.track_ui,
            "viewportScrollLeft": record.viewport_scroll_left,
            "viewportMaxScrollLeft": record.viewport_max_scroll_left,
            "viewportScrollTop": record.viewport_scroll_top,
            "viewportMaxScrollTop": record.viewport_max_scroll_top,
            "timelineZoomPercent": record.timeline_zoom_percent,
            "canUndo": !record.undo_stack.is_empty(),
            "canRedo": !record.redo_stack.is_empty(),
            "updatedAt": record.updated_at,
        }),
        None => json!({
            "filePath": file_path,
            "sessionId": Value::Null,
            "playheadSeconds": 0.0,
            "selectedClipId": Value::Null,
            "selectedClipIds": json!([]),
            "activeTrackId": Value::Null,
            "selectedTrackIds": json!([]),
            "selectedSceneId": Value::Null,
            "previewTab": Value::Null,
            "canvasRatioPreset": Value::Null,
            "activePanel": Value::Null,
            "drawerPanel": Value::Null,
            "sceneItemTransforms": Value::Null,
            "sceneItemVisibility": Value::Null,
            "sceneItemOrder": Value::Null,
            "sceneItemLocks": Value::Null,
            "sceneItemGroups": Value::Null,
            "focusedGroupId": Value::Null,
            "trackUi": Value::Null,
            "viewportScrollLeft": 0.0,
            "viewportMaxScrollLeft": 0.0,
            "viewportScrollTop": 0.0,
            "viewportMaxScrollTop": 0.0,
            "timelineZoomPercent": 100.0,
            "canUndo": false,
            "canRedo": false,
            "updatedAt": now_ms(),
        }),
    })
}

fn editor_runtime_state_record(
    state: &State<'_, AppState>,
    file_path: &str,
) -> Result<Option<EditorRuntimeStateRecord>, String> {
    let guard = state
        .editor_runtime_states
        .lock()
        .map_err(|_| "editor runtime state lock 已损坏".to_string())?;
    Ok(guard.get(file_path).cloned())
}

fn empty_editor_runtime_state_record(file_path: &str) -> EditorRuntimeStateRecord {
    EditorRuntimeStateRecord {
        file_path: file_path.to_string(),
        session_id: None,
        playhead_seconds: 0.0,
        selected_clip_id: None,
        selected_clip_ids: Some(json!([])),
        active_track_id: None,
        selected_track_ids: Some(json!([])),
        selected_scene_id: None,
        preview_tab: None,
        canvas_ratio_preset: None,
        active_panel: None,
        drawer_panel: None,
        scene_item_transforms: None,
        scene_item_visibility: None,
        scene_item_order: None,
        scene_item_locks: None,
        scene_item_groups: None,
        focused_group_id: None,
        track_ui: None,
        viewport_scroll_left: 0.0,
        viewport_max_scroll_left: 0.0,
        viewport_scroll_top: 0.0,
        viewport_max_scroll_top: 0.0,
        timeline_zoom_percent: 100.0,
        undo_stack: Vec::new(),
        redo_stack: Vec::new(),
        updated_at: now_ms(),
    }
}

fn push_editor_project_undo_snapshot(
    state: &State<'_, AppState>,
    file_path: &str,
    project: &Value,
) -> Result<(), String> {
    let mut guard = state
        .editor_runtime_states
        .lock()
        .map_err(|_| "editor runtime state lock 已损坏".to_string())?;
    let record = guard
        .entry(file_path.to_string())
        .or_insert_with(|| empty_editor_runtime_state_record(file_path));
    record.undo_stack.push(project.clone());
    if record.undo_stack.len() > 80 {
        record.undo_stack.remove(0);
    }
    record.redo_stack.clear();
    record.updated_at = now_ms();
    Ok(())
}

fn restore_editor_project_from_history(
    state: &State<'_, AppState>,
    file_path: &str,
    full_path: &Path,
    direction: &str,
) -> Result<Value, String> {
    let current_project = ensure_editor_project(full_path)?;
    let mut guard = state
        .editor_runtime_states
        .lock()
        .map_err(|_| "editor runtime state lock 已损坏".to_string())?;
    let record = guard
        .entry(file_path.to_string())
        .or_insert_with(|| empty_editor_runtime_state_record(file_path));
    let source_stack = if direction == "redo" {
        &mut record.redo_stack
    } else {
        &mut record.undo_stack
    };
    let Some(next_project) = source_stack.pop() else {
        return Ok(json!({
            "success": false,
            "error": if direction == "redo" { "Nothing to redo" } else { "Nothing to undo" }
        }));
    };
    if direction == "redo" {
        record.undo_stack.push(current_project.clone());
    } else {
        record.redo_stack.push(current_project.clone());
    }
    record.updated_at = now_ms();
    drop(guard);
    write_json_value(&package_editor_project_path(full_path), &next_project)?;
    Ok(json!({
        "success": true,
        "state": get_manuscript_package_state(full_path)?
    }))
}

fn merge_json_objects(base: &Value, patch: &Value) -> Value {
    match (base, patch) {
        (Value::Object(base_object), Value::Object(patch_object)) => {
            let mut merged = base_object.clone();
            for (key, value) in patch_object {
                let next = if let Some(existing) = merged.get(key) {
                    merge_json_objects(existing, value)
                } else {
                    value.clone()
                };
                merged.insert(key.clone(), next);
            }
            Value::Object(merged)
        }
        (_, value) => value.clone(),
    }
}

fn merge_remotion_scene_patch(existing: &Value, patch: &Value) -> Value {
    if !patch.is_object() {
        return existing.clone();
    }
    let mut merged = merge_json_objects(existing, patch);
    let patch_scenes = patch
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if patch_scenes.is_empty() {
        return merged;
    }
    let existing_scenes = existing
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut next_scenes = existing_scenes.clone();
    for (index, patch_scene) in patch_scenes.iter().enumerate() {
        let target_index = patch_scene
            .get("id")
            .and_then(Value::as_str)
            .and_then(|scene_id| {
                existing_scenes.iter().position(|scene| {
                    scene
                        .get("id")
                        .and_then(Value::as_str)
                        .map(|value| value == scene_id)
                        .unwrap_or(false)
                })
            })
            .or_else(|| (index < next_scenes.len()).then_some(index))
            .unwrap_or(next_scenes.len());
        let merged_scene = next_scenes
            .get(target_index)
            .map(|scene| merge_json_objects(scene, patch_scene))
            .unwrap_or_else(|| patch_scene.clone());
        if target_index < next_scenes.len() {
            next_scenes[target_index] = merged_scene;
        } else {
            next_scenes.push(merged_scene);
        }
    }
    if let Some(object) = merged.as_object_mut() {
        object.insert("scenes".to_string(), Value::Array(next_scenes));
    }
    merged
}

fn remotion_scene_summary_items(composition: &Value) -> Vec<Value> {
    composition
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|scene| {
            let entity_count = scene
                .get("entities")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            let overlay_count = scene
                .get("overlays")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            json!({
                "id": scene.get("id").cloned().unwrap_or(Value::Null),
                "clipId": scene.get("clipId").cloned().unwrap_or(Value::Null),
                "assetId": scene.get("assetId").cloned().unwrap_or(Value::Null),
                "startFrame": scene.get("startFrame").cloned().unwrap_or_else(|| json!(0)),
                "durationInFrames": scene.get("durationInFrames").cloned().unwrap_or_else(|| json!(0)),
                "entityCount": entity_count,
                "overlayCount": overlay_count,
                "overlayTitle": scene.get("overlayTitle").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

fn remotion_asset_metadata(project: &Value) -> Vec<Value> {
    project
        .get("assets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|asset| {
            json!({
                "id": asset.get("id").cloned().unwrap_or(Value::Null),
                "title": asset.get("title").cloned().unwrap_or(Value::Null),
                "kind": asset.get("kind").cloned().unwrap_or(Value::Null),
                "src": asset.get("src").cloned().unwrap_or(Value::Null),
                "mimeType": asset.get("mimeType").cloned().unwrap_or(Value::Null),
                "durationMs": asset.get("durationMs").cloned().unwrap_or(Value::Null),
                "metadata": asset.get("metadata").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

fn remotion_context_value(
    state: &State<'_, AppState>,
    package_path: &std::path::Path,
    file_path: &str,
) -> Result<Value, String> {
    let package_state = get_manuscript_package_state(package_path)?;
    let composition = package_state
        .get("remotion")
        .cloned()
        .unwrap_or_else(|| build_default_remotion_scene("RedBox Motion", &[]));
    let asset_container = package_state
        .pointer("/videoProject/assets")
        .cloned()
        .map(|items| json!({ "assets": items }))
        .or_else(|| {
            package_state
                .get("editorProject")
                .and_then(|project| project.get("assets"))
                .cloned()
                .map(|items| json!({ "assets": items }))
        })
        .unwrap_or_else(|| json!({ "assets": [] }));
    let runtime_state = editor_runtime_state_record(state, file_path)?;
    let fps = composition
        .get("fps")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(30);
    let playhead_seconds = runtime_state
        .as_ref()
        .map(|record| record.playhead_seconds)
        .unwrap_or(0.0)
        .max(0.0);
    let playhead_frame = (playhead_seconds * fps as f64).round() as i64;
    let scenes = composition
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let transitions = composition
        .get("transitions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let active_scene = runtime_state
        .as_ref()
        .and_then(|record| record.selected_scene_id.as_deref())
        .and_then(|scene_id| {
            scenes.iter().find(|scene| {
                scene
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|value| value == scene_id)
                    .unwrap_or(false)
            })
        })
        .cloned()
        .or_else(|| {
            scenes
                .iter()
                .find(|scene| {
                    let start_frame = scene.get("startFrame").and_then(Value::as_i64).unwrap_or(0);
                    let duration_in_frames = scene
                        .get("durationInFrames")
                        .and_then(Value::as_i64)
                        .unwrap_or(0)
                        .max(1);
                    playhead_frame >= start_frame
                        && playhead_frame < start_frame + duration_in_frames
                })
                .cloned()
        })
        .or_else(|| scenes.first().cloned())
        .unwrap_or(Value::Null);
    let scene_ids_at_playhead = scenes
        .iter()
        .filter(|scene| {
            let start_frame = scene.get("startFrame").and_then(Value::as_i64).unwrap_or(0);
            let duration_in_frames = scene
                .get("durationInFrames")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .max(1);
            playhead_frame >= start_frame && playhead_frame < start_frame + duration_in_frames
        })
        .filter_map(|scene| {
            scene
                .get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "composition": {
            "title": composition.get("title").cloned().unwrap_or(Value::Null),
            "entryCompositionId": composition.get("entryCompositionId").cloned().unwrap_or_else(|| json!("RedBoxVideoMotion")),
            "width": composition.get("width").cloned().unwrap_or_else(|| json!(1080)),
            "height": composition.get("height").cloned().unwrap_or_else(|| json!(1920)),
            "fps": composition.get("fps").cloned().unwrap_or_else(|| json!(30)),
            "durationInFrames": composition.get("durationInFrames").cloned().unwrap_or_else(|| json!(90)),
            "renderMode": composition.get("renderMode").cloned().unwrap_or_else(|| json!("motion-layer")),
            "backgroundColor": composition.get("backgroundColor").cloned().unwrap_or(Value::Null),
            "sceneCount": scenes.len(),
            "transitionCount": transitions.len(),
            "render": normalized_remotion_render_config(
                composition.get("render"),
                composition.get("title").and_then(Value::as_str).unwrap_or("RedBox Motion"),
                composition.get("renderMode").and_then(Value::as_str).unwrap_or("motion-layer"),
            )
        },
        "scenes": remotion_scene_summary_items(&composition),
        "transitions": transitions,
        "activeScene": active_scene,
        "assetMetadata": remotion_asset_metadata(&asset_container),
        "selectionMapping": {
            "selectedClipId": runtime_state.as_ref().and_then(|record| record.selected_clip_id.clone()),
            "selectedSceneId": runtime_state.as_ref().and_then(|record| record.selected_scene_id.clone()).or_else(|| active_scene.get("id").and_then(Value::as_str).map(ToString::to_string)),
            "playheadSeconds": playhead_seconds,
            "playheadFrame": playhead_frame,
            "sceneIdsAtPlayhead": scene_ids_at_playhead,
            "activeSceneId": active_scene.get("id").cloned().unwrap_or(Value::Null),
            "activeSceneClipId": active_scene.get("clipId").cloned().unwrap_or(Value::Null),
        }
    }))
}

#[allow(dead_code)]
fn sync_project_transitions_from_remotion_scene(
    project: &mut Value,
    composition: &Value,
) -> Result<(), String> {
    let project_object = project
        .as_object_mut()
        .ok_or_else(|| "Editor project must be an object".to_string())?;
    project_object.insert(
        "transitions".to_string(),
        composition
            .get("transitions")
            .cloned()
            .unwrap_or_else(|| json!([])),
    );
    Ok(())
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

fn media_asset_kind(asset: &MediaAssetRecord) -> &'static str {
    let mime_type = asset.mime_type.clone().unwrap_or_default();
    if mime_type.starts_with("audio/") {
        "audio"
    } else if mime_type.starts_with("video/") {
        "video"
    } else {
        "image"
    }
}

fn default_track_name_for_asset(asset: &MediaAssetRecord) -> &'static str {
    if media_asset_kind(asset) == "audio" {
        "A1"
    } else {
        "V1"
    }
}

fn timeline_track_kind(track_name: &str) -> &'static str {
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

fn build_timeline_clip_from_asset(
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

fn build_timeline_subtitle_clip(
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

fn build_timeline_text_clip(desired_order: usize, text: &str, duration_ms: Option<i64>) -> Value {
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

#[derive(Clone)]
struct SrtSegment {
    start_ms: i64,
    end_ms: i64,
    text: String,
}

fn parse_srt_timestamp(value: &str) -> Option<i64> {
    let normalized = value.trim().replace('.', ",");
    let mut parts = normalized.split(':');
    let hours = parts.next()?.trim().parse::<i64>().ok()?;
    let minutes = parts.next()?.trim().parse::<i64>().ok()?;
    let seconds_and_millis = parts.next()?.trim();
    if parts.next().is_some() {
        return None;
    }
    let (seconds, millis) = seconds_and_millis.split_once(',')?;
    let seconds = seconds.trim().parse::<i64>().ok()?;
    let millis = millis.trim().parse::<i64>().ok()?;
    Some((((hours * 60 + minutes) * 60 + seconds) * 1000) + millis)
}

fn parse_srt_segments(content: &str) -> Vec<SrtSegment> {
    content
        .replace("\r\n", "\n")
        .split("\n\n")
        .filter_map(|block| {
            let lines = block
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>();
            if lines.is_empty() {
                return None;
            }
            let timing_line_index = lines.iter().position(|line| line.contains("-->"))?;
            let timing_line = lines.get(timing_line_index)?;
            let (start_raw, end_raw) = timing_line.split_once("-->")?;
            let start_ms = parse_srt_timestamp(start_raw)?;
            let end_ms = parse_srt_timestamp(end_raw)?;
            if end_ms <= start_ms {
                return None;
            }
            let text = lines
                .iter()
                .skip(timing_line_index + 1)
                .map(|line| line.trim())
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string();
            if text.is_empty() {
                return None;
            }
            Some(SrtSegment {
                start_ms,
                end_ms,
                text,
            })
        })
        .collect()
}

fn format_srt_timestamp(value_ms: i64) -> String {
    let safe = value_ms.max(0);
    let hours = safe / 3_600_000;
    let minutes = (safe % 3_600_000) / 60_000;
    let seconds = (safe % 60_000) / 1000;
    let millis = safe % 1000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{millis:03}")
}

fn serialize_srt_segments(segments: &[SrtSegment]) -> String {
    segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            format!(
                "{}\n{} --> {}\n{}",
                index + 1,
                format_srt_timestamp(segment.start_ms),
                format_srt_timestamp(segment.end_ms),
                segment.text.trim()
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn build_fallback_srt_segments(transcript: &str, duration_ms: i64) -> Vec<SrtSegment> {
    let normalized = transcript.trim();
    if normalized.is_empty() {
        return Vec::new();
    }
    vec![SrtSegment {
        start_ms: 0,
        end_ms: duration_ms.max(800),
        text: normalized.to_string(),
    }]
}

fn resolve_project_media_source_path(
    state: &State<'_, AppState>,
    package_path: &std::path::Path,
    source: &str,
) -> Result<(std::path::PathBuf, bool), String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("当前片段缺少素材路径".to_string());
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let bytes = run_curl_bytes("GET", trimmed, None, &[], None)?;
        let temp_root = store_root(state)?.join("tmp");
        fs::create_dir_all(&temp_root).map_err(|error| error.to_string())?;
        let extension = std::path::Path::new(trimmed)
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("media");
        let target = temp_root.join(format!("subtitle-source-{}.{}", now_ms(), extension));
        fs::write(&target, bytes).map_err(|error| error.to_string())?;
        return Ok((target, true));
    }

    let Some(raw_path) = resolve_local_path(trimmed) else {
        return Err("当前片段的素材路径不可解析".to_string());
    };
    let mut candidates = Vec::new();
    if raw_path.is_absolute() {
        candidates.push(raw_path);
    } else {
        candidates.push(raw_path.clone());
        candidates.push(package_path.join(&raw_path));
        if let Ok(media_root_path) = media_root(state) {
            candidates.push(media_root_path.join(&raw_path));
        }
        if let Ok(workspace_root_path) = workspace_root(state) {
            candidates.push(workspace_root_path.join(&raw_path));
        }
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .map(|path| (path, false))
        .ok_or_else(|| format!("找不到素材文件: {trimmed}"))
}

fn ensure_editor_track(project: &mut Value, track_id: &str, kind: &str) -> Result<(), String> {
    if project
        .get("tracks")
        .and_then(Value::as_array)
        .map(|tracks| {
            tracks.iter().any(|track| {
                track
                    .get("id")
                    .and_then(|value| value.as_str())
                    .map(|value| value == track_id)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
    {
        return Ok(());
    }
    let order = editor_project_tracks_mut(project)?.len();
    editor_project_tracks_mut(project)?.push(json!({
        "id": track_id,
        "kind": kind,
        "name": track_id,
        "order": order,
        "ui": {
            "hidden": false,
            "locked": false,
            "muted": false,
            "solo": false,
            "collapsed": false,
            "volume": 1.0
        }
    }));
    Ok(())
}

fn editor_default_subtitle_style(
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

fn upsert_editor_project_last_subtitle_transcription(
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

fn editor_project_items_mut(project: &mut Value) -> Result<&mut Vec<Value>, String> {
    project
        .get_mut("items")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "Editor project items missing".to_string())
}

fn editor_project_tracks_mut(project: &mut Value) -> Result<&mut Vec<Value>, String> {
    project
        .get_mut("tracks")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "Editor project tracks missing".to_string())
}

fn ensure_motion_track(project: &mut Value) -> Result<(), String> {
    let tracks = editor_project_tracks_mut(project)?;
    if tracks.iter().any(|track| {
        track
            .get("id")
            .and_then(|value| value.as_str())
            .map(|value| value == "M1")
            .unwrap_or(false)
    }) {
        return Ok(());
    }
    let next_order = tracks
        .iter()
        .filter_map(|track| track.get("order").and_then(|value| value.as_i64()))
        .max()
        .unwrap_or(-1)
        + 1;
    tracks.push(json!({
        "id": "M1",
        "kind": "motion",
        "name": "M1",
        "order": next_order,
        "ui": {
            "hidden": false,
            "locked": false,
            "muted": false,
            "solo": false,
            "collapsed": false,
            "volume": 1.0
        }
    }));
    Ok(())
}

fn editor_project_animation_layers_mut(project: &mut Value) -> Result<&mut Vec<Value>, String> {
    let object = project
        .as_object_mut()
        .ok_or_else(|| "Editor project must be an object".to_string())?;
    let layers = object
        .entry("animationLayers".to_string())
        .or_insert_with(|| json!([]));
    if !layers.is_array() {
        *layers = json!([]);
    }
    layers
        .as_array_mut()
        .ok_or_else(|| "Editor project animationLayers missing".to_string())
}

fn default_motion_item_from_media(media_item: &Value, _project: &Value, index: usize) -> Value {
    let item_id = media_item
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or("item");
    let from_ms = media_item
        .get("fromMs")
        .and_then(|value| value.as_i64())
        .unwrap_or(0);
    let duration_ms = media_item
        .get("durationMs")
        .and_then(|value| value.as_i64())
        .unwrap_or(DEFAULT_TIMELINE_CLIP_MS)
        .max(500);
    let template_id = match index % 5 {
        0 => "slow-zoom-in",
        1 => "pan-left",
        2 => "pan-right",
        3 => "slide-up",
        _ => "slow-zoom-out",
    };
    json!({
        "id": format!("motion:{item_id}"),
        "type": "motion",
        "trackId": "M1",
        "bindItemId": item_id,
        "fromMs": from_ms,
        "durationMs": duration_ms,
        "templateId": template_id,
        "props": {
            "overlayTitle": Value::Null,
            "overlayBody": Value::Null,
            "overlays": []
        },
        "enabled": true
    })
}

fn normalize_motion_item(raw: &Value, fallback: &Value) -> Value {
    json!({
        "id": raw.get("id").cloned().unwrap_or_else(|| fallback.get("id").cloned().unwrap_or_else(|| json!(make_id("motion-item")))),
        "type": "motion",
        "trackId": "M1",
        "bindItemId": raw.get("bindItemId").cloned().or_else(|| fallback.get("bindItemId").cloned()).unwrap_or(Value::Null),
        "fromMs": raw.get("fromMs").cloned().or_else(|| fallback.get("fromMs").cloned()).unwrap_or(json!(0)),
        "durationMs": raw.get("durationMs").cloned().or_else(|| fallback.get("durationMs").cloned()).unwrap_or(json!(2000)),
        "templateId": raw.get("templateId").cloned().or_else(|| fallback.get("templateId").cloned()).unwrap_or(json!("static")),
        "props": raw.get("props").cloned().or_else(|| fallback.get("props").cloned()).unwrap_or_else(|| json!({})),
        "enabled": raw.get("enabled").cloned().or_else(|| fallback.get("enabled").cloned()).unwrap_or(json!(true))
    })
}

#[allow(dead_code)]
fn sync_project_motion_items_from_remotion_scene(
    project: &mut Value,
    composition: &Value,
) -> Result<(), String> {
    ensure_motion_track(project)?;
    let fps = composition
        .get("fps")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(30);
    let scenes = composition
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let animation_layers = animation_layers_from_remotion_scene(composition, fps);
    let media_lookup = project
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(Value::as_str)?.to_string();
            Some((id, item))
        })
        .collect::<BTreeMap<_, _>>();

    editor_project_animation_layers_mut(project)?.clear();
    editor_project_animation_layers_mut(project)?.extend(animation_layers.clone());

    editor_project_items_mut(project)?
        .retain(|item| item.get("type").and_then(Value::as_str) != Some("motion"));

    let motion_items = scenes
        .iter()
        .map(|scene| {
            let bind_item_id = scene
                .get("clipId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let fallback_media = media_lookup.get(&bind_item_id);
            let from_ms = fallback_media
                .and_then(|item| item.get("fromMs").and_then(Value::as_i64))
                .unwrap_or_else(|| {
                    ((scene
                        .get("startFrame")
                        .and_then(Value::as_i64)
                        .unwrap_or(0) as f64
                        / fps as f64)
                        * 1000.0)
                        .round() as i64
                })
                .max(0);
            let duration_ms = ((scene
                .get("durationInFrames")
                .and_then(Value::as_i64)
                .unwrap_or(1) as f64
                / fps as f64)
                * 1000.0)
                .round() as i64;
            json!({
                "id": scene.get("id").cloned().unwrap_or_else(|| json!(make_id("motion-item"))),
                "type": "motion",
                "trackId": "M1",
                "bindItemId": if bind_item_id.is_empty() { Value::Null } else { json!(bind_item_id) },
                "fromMs": from_ms,
                "durationMs": duration_ms.max(300),
                "templateId": scene.get("motionPreset").cloned().unwrap_or_else(|| json!("static")),
                "props": {
                    "overlayTitle": scene.get("overlayTitle").cloned().unwrap_or(Value::Null),
                    "overlayBody": scene.get("overlayBody").cloned().unwrap_or(Value::Null),
                    "overlays": scene.get("overlays").cloned().unwrap_or_else(|| json!([])),
                    "entities": scene.get("entities").cloned().unwrap_or_else(|| json!([]))
                },
                "enabled": true
            })
        })
        .collect::<Vec<_>>();

    editor_project_items_mut(project)?.extend(motion_items);
    Ok(())
}

fn generate_motion_items_for_project(
    state: &State<'_, AppState>,
    project: &Value,
    instructions: &str,
    selected_item_ids: &[String],
    model_config: Option<&Value>,
) -> Result<(Vec<Value>, String), String> {
    let media_items = project
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| item.get("type").and_then(|value| value.as_str()) == Some("media"))
        .filter(|item| {
            if selected_item_ids.is_empty() {
                return true;
            }
            item.get("id")
                .and_then(|value| value.as_str())
                .map(|value| selected_item_ids.iter().any(|selected| selected == value))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    if media_items.is_empty() {
        return Err("当前工程没有可生成动画的媒体片段".to_string());
    }

    let fallback_items = media_items
        .iter()
        .enumerate()
        .map(|(index, item)| default_motion_item_from_media(item, project, index))
        .collect::<Vec<_>>();
    let user_prompt = format!(
        "请基于当前脚本和媒体片段，生成 motion item 列表。\n\
只输出 JSON，不要输出解释。\n\
结构：{{\"brief\":string,\"items\":[{{\"bindItemId\":string,\"fromMs\":number,\"durationMs\":number,\"templateId\":\"static|slow-zoom-in|slow-zoom-out|pan-left|pan-right|slide-up|slide-down\",\"props\":{{\"overlayTitle\":string|null,\"overlayBody\":string|null,\"overlays\":[{{\"id\":string,\"text\":string,\"startFrame\":number,\"durationInFrames\":number,\"position\":\"top|center|bottom\",\"animation\":\"fade-up|fade-in|slide-left|pop\",\"fontSize\":number}}]}}}}]}}\n\
要求：\n\
1. 每个 item 必须绑定现有 bindItemId。\n\
2. fromMs / durationMs 要落在绑定片段范围内或与其基本一致。\n\
3. 模板只允许 static, slow-zoom-in, slow-zoom-out, pan-left, pan-right, slide-up, slide-down。\n\
4. 适合短视频节奏，前段更强，后段更稳。\n\
5. 默认不要生成 overlayTitle、overlayBody 或 overlays；除非脚本明确要求屏幕文字、标题或字幕。\n\
\n\
脚本：{}\n\
目标片段：{}",
        instructions,
        serde_json::to_string(&media_items).map_err(|error| error.to_string())?
    );
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let raw = run_model_structured_task_with_settings(
        &settings_snapshot,
        model_config,
        "你是 RedClaw 的短视频动画导演。只输出严格 JSON。",
        &user_prompt,
        true,
    )?;
    let parsed = parse_json_value_from_text(&raw).unwrap_or(Value::Null);
    let normalized_items = parsed
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    normalize_motion_item(
                        item,
                        fallback_items.get(index).unwrap_or(&fallback_items[0]),
                    )
                })
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty())
        .unwrap_or(fallback_items);
    let brief = parsed
        .get("brief")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(raw);
    Ok((normalized_items, brief))
}

fn normalize_editor_ai_command(raw: &Value) -> Option<Value> {
    let command_type = raw.get("type").and_then(|value| value.as_str())?;
    match command_type {
        "upsert_assets" => Some(json!({
            "type": "upsert_assets",
            "assets": raw.get("assets").cloned().unwrap_or_else(|| json!([]))
        })),
        "add_track" => Some(json!({
            "type": "add_track",
            "kind": raw.get("kind").cloned().unwrap_or(json!("video")),
            "trackId": raw.get("trackId").cloned().unwrap_or(Value::Null)
        })),
        "delete_tracks" => Some(json!({
            "type": "delete_tracks",
            "trackIds": raw.get("trackIds").cloned().unwrap_or_else(|| json!([]))
        })),
        "update_item" => Some(json!({
            "type": "update_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null),
            "patch": raw.get("patch").cloned().unwrap_or_else(|| json!({}))
        })),
        "delete_item" => Some(json!({
            "type": "delete_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null)
        })),
        "split_item" => Some(json!({
            "type": "split_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null),
            "splitMs": raw.get("splitMs").cloned().unwrap_or(json!(0))
        })),
        "move_items" => Some(json!({
            "type": "move_items",
            "itemIds": raw.get("itemIds").cloned().unwrap_or_else(|| json!([])),
            "deltaMs": raw.get("deltaMs").cloned().unwrap_or(json!(0)),
            "targetTrackId": raw.get("targetTrackId").cloned().unwrap_or(Value::Null)
        })),
        "retime_item" => Some(json!({
            "type": "retime_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null),
            "fromMs": raw.get("fromMs").cloned().unwrap_or(Value::Null),
            "durationMs": raw.get("durationMs").cloned().unwrap_or(Value::Null)
        })),
        "set_track_ui" => Some(json!({
            "type": "set_track_ui",
            "trackId": raw.get("trackId").cloned().unwrap_or(Value::Null),
            "patch": raw.get("patch").cloned().unwrap_or_else(|| json!({}))
        })),
        "reorder_tracks" => Some(json!({
            "type": "reorder_tracks",
            "trackId": raw.get("trackId").cloned().unwrap_or(Value::Null),
            "direction": raw.get("direction").cloned().unwrap_or(json!("up"))
        })),
        "update_stage_item" => Some(json!({
            "type": "update_stage_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null),
            "patch": raw.get("patch").cloned().unwrap_or(Value::Null),
            "visible": raw.get("visible").cloned().unwrap_or(Value::Null),
            "locked": raw.get("locked").cloned().unwrap_or(Value::Null),
            "groupId": raw.get("groupId").cloned().unwrap_or(Value::Null)
        })),
        "animation_layer_create" => Some(json!({
            "type": "animation_layer_create",
            "layer": raw.get("layer").cloned().unwrap_or_else(|| json!({}))
        })),
        "animation_layer_update" => Some(json!({
            "type": "animation_layer_update",
            "layerId": raw.get("layerId").cloned().unwrap_or(Value::Null),
            "patch": raw.get("patch").cloned().unwrap_or_else(|| json!({}))
        })),
        "animation_layer_delete" => Some(json!({
            "type": "animation_layer_delete",
            "layerId": raw.get("layerId").cloned().unwrap_or(Value::Null)
        })),
        _ => None,
    }
}

fn generate_editor_commands_for_project(
    state: &State<'_, AppState>,
    project: &Value,
    instructions: &str,
    model_config: Option<&Value>,
) -> Result<(Vec<Value>, String), String> {
    let user_prompt = format!(
        "把用户的编辑要求转换成结构化命令 JSON。\n\
只输出 JSON，不要输出解释。\n\
允许命令：add_track, delete_tracks, update_item, delete_item, split_item, move_items, retime_item, set_track_ui, reorder_tracks, update_stage_item。\n\
输出结构：{{\"brief\":string,\"commands\":[...]}}\n\
规则：\n\
1. 只能引用现有 itemId / trackId。\n\
2. 不要生成 motion item；motion 相关生成单独走 generate-motion-items。\n\
3. patch 只包含必要字段。\n\
4. 如果用户指令模糊，给出最保守的命令。\n\
\n\
当前工程 JSON：{}\n\
用户要求：{}",
        serde_json::to_string(project).map_err(|error| error.to_string())?,
        instructions
    );
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let raw = run_model_structured_task_with_settings(
        &settings_snapshot,
        model_config,
        "你是 RedClaw 的视频编辑命令规划器。只输出严格 JSON。",
        &user_prompt,
        true,
    )?;
    let parsed = parse_json_value_from_text(&raw).unwrap_or(Value::Null);
    let commands = parsed
        .get("commands")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(normalize_editor_ai_command)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let brief = parsed
        .get("brief")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(raw);
    Ok((commands, brief))
}

fn apply_editor_commands(project: &mut Value, commands: &[Value]) -> Result<(), String> {
    ensure_motion_track(project)?;
    for command in commands {
        let command_type = command
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        match command_type {
            "upsert_assets" => {
                let assets = command
                    .get("assets")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let current_assets = project
                    .get_mut("assets")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Editor project assets missing".to_string())?;
                for asset in assets {
                    let asset_id = asset
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    if asset_id.is_empty() {
                        continue;
                    }
                    if let Some(existing) = current_assets.iter_mut().find(|item| {
                        item.get("id").and_then(|value| value.as_str()) == Some(asset_id)
                    }) {
                        *existing = asset.clone();
                    } else {
                        current_assets.push(asset.clone());
                    }
                }
            }
            "add_track" => {
                let kind = command
                    .get("kind")
                    .and_then(|value| value.as_str())
                    .unwrap_or("video");
                let prefix = match kind {
                    "audio" => "A",
                    "subtitle" => "S",
                    "text" => "T",
                    "motion" => "M",
                    _ => "V",
                };
                let track_id = command
                    .get("trackId")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string)
                    .unwrap_or_else(|| {
                        let tracks = project
                            .get("tracks")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let max_index = tracks
                            .iter()
                            .filter_map(|track| {
                                let id = track
                                    .get("id")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or("");
                                if !id.starts_with(prefix) {
                                    return None;
                                }
                                id[1..].parse::<i64>().ok()
                            })
                            .max()
                            .unwrap_or(0);
                        format!("{prefix}{}", max_index + 1)
                    });
                let order = editor_project_tracks_mut(project)?.len();
                editor_project_tracks_mut(project)?.push(json!({
                    "id": track_id,
                    "kind": kind,
                    "name": track_id,
                    "order": order,
                    "ui": {
                        "hidden": false,
                        "locked": false,
                        "muted": false,
                        "solo": false,
                        "collapsed": false,
                        "volume": 1.0
                    }
                }));
            }
            "delete_tracks" => {
                let track_ids = command
                    .get("trackIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
                editor_project_tracks_mut(project)?.retain(|track| {
                    let track_id = track
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !track_ids.iter().any(|value| value == track_id)
                });
                editor_project_items_mut(project)?.retain(|item| {
                    let track_id = item
                        .get("trackId")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !track_ids.iter().any(|value| value == track_id)
                });
                for (order, track) in editor_project_tracks_mut(project)?.iter_mut().enumerate() {
                    if let Some(object) = track.as_object_mut() {
                        object.insert("order".to_string(), json!(order));
                    }
                }
            }
            "add_item" => {
                if let Some(item) = command.get("item") {
                    editor_project_items_mut(project)?.push(item.clone());
                }
            }
            "update_item" => {
                let item_id = command
                    .get("itemId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let patch = command.get("patch").cloned().unwrap_or_else(|| json!({}));
                if let Some(item) = editor_project_items_mut(project)?
                    .iter_mut()
                    .find(|item| item.get("id").and_then(|value| value.as_str()) == Some(item_id))
                {
                    if let (Some(target), Some(source)) = (item.as_object_mut(), patch.as_object())
                    {
                        for (key, value) in source {
                            target.insert(key.to_string(), value.clone());
                        }
                    }
                }
            }
            "delete_item" => {
                let item_ids = command
                    .get("itemIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_else(|| vec![command.get("itemId").cloned().unwrap_or(Value::Null)]);
                let normalized = item_ids
                    .iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
                editor_project_items_mut(project)?.retain(|item| {
                    let item_id = item
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !normalized.iter().any(|value| value == item_id)
                });
            }
            "delete_items" => {
                let item_ids = command
                    .get("itemIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
                editor_project_items_mut(project)?.retain(|item| {
                    let item_id = item
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !item_ids.iter().any(|value| value == item_id)
                });
            }
            "split_item" => {
                let item_id = command
                    .get("itemId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let split_ms = command
                    .get("splitMs")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                let items = editor_project_items_mut(project)?;
                let Some(index) = items.iter().position(|item| {
                    item.get("id").and_then(|value| value.as_str()) == Some(item_id)
                }) else {
                    continue;
                };
                let mut original = items[index].clone();
                let from_ms = original
                    .get("fromMs")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                let duration_ms = original
                    .get("durationMs")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                if split_ms <= from_ms || split_ms >= from_ms + duration_ms {
                    continue;
                }
                let first_duration = split_ms - from_ms;
                let second_duration = duration_ms - first_duration;
                if let Some(object) = original.as_object_mut() {
                    object.insert("durationMs".to_string(), json!(first_duration));
                }
                items[index] = original;
                let mut second = items[index].clone();
                if let Some(object) = second.as_object_mut() {
                    object.insert("id".to_string(), json!(make_id("item")));
                    object.insert("fromMs".to_string(), json!(split_ms));
                    object.insert("durationMs".to_string(), json!(second_duration));
                    if let Some(trim_in_ms) =
                        object.get("trimInMs").and_then(|value| value.as_i64())
                    {
                        object.insert("trimInMs".to_string(), json!(trim_in_ms + first_duration));
                    }
                }
                items.insert(index + 1, second);
            }
            "move_items" => {
                let delta_ms = command
                    .get("deltaMs")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                let target_track_id = command
                    .get("targetTrackId")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string);
                let item_ids = command
                    .get("itemIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
                for item in editor_project_items_mut(project)?.iter_mut() {
                    let item_id = item
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    if !item_ids.iter().any(|value| value == item_id) {
                        continue;
                    }
                    if let Some(object) = item.as_object_mut() {
                        let from_ms = object
                            .get("fromMs")
                            .and_then(|value| value.as_i64())
                            .unwrap_or(0);
                        object.insert("fromMs".to_string(), json!((from_ms + delta_ms).max(0)));
                        if let Some(track_id) = target_track_id.as_ref() {
                            object.insert("trackId".to_string(), json!(track_id));
                        }
                    }
                }
            }
            "retime_item" => {
                let item_id = command
                    .get("itemId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if let Some(item) = editor_project_items_mut(project)?
                    .iter_mut()
                    .find(|item| item.get("id").and_then(|value| value.as_str()) == Some(item_id))
                {
                    if let Some(object) = item.as_object_mut() {
                        if let Some(from_ms) = command.get("fromMs") {
                            object.insert("fromMs".to_string(), from_ms.clone());
                        }
                        if let Some(duration_ms) = command.get("durationMs") {
                            object.insert("durationMs".to_string(), duration_ms.clone());
                        }
                    }
                }
            }
            "set_track_ui" => {
                let track_id = command
                    .get("trackId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let patch = command.get("patch").cloned().unwrap_or_else(|| json!({}));
                if let Some(track) = editor_project_tracks_mut(project)?
                    .iter_mut()
                    .find(|track| {
                        track.get("id").and_then(|value| value.as_str()) == Some(track_id)
                    })
                {
                    let current_ui = track.get("ui").cloned().unwrap_or_else(|| json!({}));
                    let mut next_ui = current_ui;
                    if let (Some(target), Some(source)) =
                        (next_ui.as_object_mut(), patch.as_object())
                    {
                        for (key, value) in source {
                            target.insert(key.to_string(), value.clone());
                        }
                    }
                    if let Some(object) = track.as_object_mut() {
                        object.insert("ui".to_string(), next_ui);
                    }
                }
            }
            "reorder_tracks" => {
                let track_id = command
                    .get("trackId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let direction = command
                    .get("direction")
                    .and_then(|value| value.as_str())
                    .unwrap_or("up");
                let tracks = editor_project_tracks_mut(project)?;
                let Some(index) = tracks.iter().position(|track| {
                    track.get("id").and_then(|value| value.as_str()) == Some(track_id)
                }) else {
                    continue;
                };
                let target_index = if direction == "down" {
                    (index + 1).min(tracks.len().saturating_sub(1))
                } else {
                    index.saturating_sub(1)
                };
                let track = tracks.remove(index);
                tracks.insert(target_index, track);
                for (order, track) in tracks.iter_mut().enumerate() {
                    if let Some(object) = track.as_object_mut() {
                        object.insert("order".to_string(), json!(order));
                    }
                }
            }
            "update_stage_item" => {
                let item_id = command
                    .get("itemId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let stage = project
                    .get_mut("stage")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| "Editor project stage missing".to_string())?;
                if let Some(transform_patch) = command.get("patch").and_then(Value::as_object) {
                    let transforms = stage
                        .entry("itemTransforms".to_string())
                        .or_insert_with(|| json!({}));
                    let entry = transforms
                        .as_object_mut()
                        .ok_or_else(|| "Stage itemTransforms missing".to_string())?
                        .entry(item_id.to_string())
                        .or_insert_with(|| json!({}));
                    if let (Some(target), Some(source)) =
                        (entry.as_object_mut(), Some(transform_patch))
                    {
                        for (key, value) in source {
                            target.insert(key.to_string(), value.clone());
                        }
                    }
                }
                if let Some(visible) = command.get("visible") {
                    stage
                        .entry("itemVisibility".to_string())
                        .or_insert_with(|| json!({}))
                        .as_object_mut()
                        .ok_or_else(|| "Stage itemVisibility missing".to_string())?
                        .insert(item_id.to_string(), visible.clone());
                }
                if let Some(locked) = command.get("locked") {
                    stage
                        .entry("itemLocks".to_string())
                        .or_insert_with(|| json!({}))
                        .as_object_mut()
                        .ok_or_else(|| "Stage itemLocks missing".to_string())?
                        .insert(item_id.to_string(), locked.clone());
                }
                if let Some(group_id) = command.get("groupId") {
                    stage
                        .entry("itemGroups".to_string())
                        .or_insert_with(|| json!({}))
                        .as_object_mut()
                        .ok_or_else(|| "Stage itemGroups missing".to_string())?
                        .insert(item_id.to_string(), group_id.clone());
                }
            }
            "animation_layer_create" => {
                let layer = command.get("layer").cloned().unwrap_or_else(|| json!({}));
                editor_project_animation_layers_mut(project)?.push(layer);
            }
            "animation_layer_update" => {
                let layer_id = command.get("layerId").and_then(Value::as_str).unwrap_or("");
                let patch = command.get("patch").cloned().unwrap_or_else(|| json!({}));
                if let Some(layer) = editor_project_animation_layers_mut(project)?
                    .iter_mut()
                    .find(|item| item.get("id").and_then(Value::as_str) == Some(layer_id))
                {
                    if let (Some(target), Some(source)) = (layer.as_object_mut(), patch.as_object())
                    {
                        for (key, value) in source {
                            target.insert(key.to_string(), value.clone());
                        }
                    }
                }
            }
            "animation_layer_delete" => {
                let layer_id = command.get("layerId").and_then(Value::as_str).unwrap_or("");
                editor_project_animation_layers_mut(project)?
                    .retain(|item| item.get("id").and_then(Value::as_str) != Some(layer_id));
            }
            _ => {}
        }
    }
    normalize_editor_project_timeline(project)?;
    Ok(())
}

fn normalize_editor_project_timeline(project: &mut Value) -> Result<(), String> {
    let tracks = project
        .get("tracks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut ordered_tracks = tracks;
    ordered_tracks.sort_by_key(|track| {
        track
            .get("order")
            .and_then(|value| value.as_i64())
            .unwrap_or(0)
    });
    let main_video_track_id = ordered_tracks
        .iter()
        .find(|track| track.get("kind").and_then(|value| value.as_str()) == Some("video"))
        .and_then(|track| track.get("id").and_then(|value| value.as_str()))
        .map(ToString::to_string);
    let motion_track_ids = ordered_tracks
        .iter()
        .filter(|track| track.get("kind").and_then(Value::as_str) == Some("motion"))
        .filter_map(|track| {
            track
                .get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>();
    if !motion_track_ids.is_empty() {
        let layers = editor_project_animation_layers_mut(project)?;
        let original_order = layers
            .iter()
            .enumerate()
            .filter_map(|(index, layer)| {
                layer
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| (id.to_string(), index))
            })
            .collect::<BTreeMap<_, _>>();
        let mut rebuilt_layers = Vec::new();
        for track_id in &motion_track_ids {
            let mut track_layers = layers
                .iter()
                .filter(|layer| {
                    layer.get("trackId").and_then(Value::as_str) == Some(track_id.as_str())
                })
                .cloned()
                .collect::<Vec<_>>();
            track_layers.sort_by(|left, right| {
                let left_from = left.get("fromMs").and_then(Value::as_i64).unwrap_or(0);
                let right_from = right.get("fromMs").and_then(Value::as_i64).unwrap_or(0);
                if left_from != right_from {
                    return left_from.cmp(&right_from);
                }
                let left_id = left.get("id").and_then(Value::as_str).unwrap_or("");
                let right_id = right.get("id").and_then(Value::as_str).unwrap_or("");
                original_order
                    .get(left_id)
                    .unwrap_or(&0usize)
                    .cmp(original_order.get(right_id).unwrap_or(&0usize))
            });
            let mut cursor = 0_i64;
            for (z_index, mut layer) in track_layers.into_iter().enumerate() {
                let from_ms = layer
                    .get("fromMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .max(cursor);
                let duration_ms = layer
                    .get("durationMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .max(300);
                if let Some(object) = layer.as_object_mut() {
                    object.insert("trackId".to_string(), json!(track_id));
                    object.insert("fromMs".to_string(), json!(from_ms));
                    object.insert("durationMs".to_string(), json!(duration_ms));
                    object.insert("zIndex".to_string(), json!(z_index));
                }
                cursor = from_ms + duration_ms;
                rebuilt_layers.push(layer);
            }
        }
        let known_motion_tracks = motion_track_ids.iter().cloned().collect::<BTreeSet<_>>();
        rebuilt_layers.extend(
            layers
                .iter()
                .filter(|layer| {
                    layer
                        .get("trackId")
                        .and_then(Value::as_str)
                        .map(|track_id| !known_motion_tracks.contains(track_id))
                        .unwrap_or(true)
                })
                .cloned(),
        );
        *layers = rebuilt_layers;
    }
    let projected_motion_items = projected_motion_items_from_animation_layers(project);
    let items = editor_project_items_mut(project)?;
    items.retain(|item| item.get("type").and_then(Value::as_str) != Some("motion"));
    items.extend(projected_motion_items);
    let items = editor_project_items_mut(project)?;
    let original_order = items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            item.get("id")
                .and_then(|value| value.as_str())
                .map(|id| (id.to_string(), index))
        })
        .collect::<BTreeMap<_, _>>();
    let mut rebuilt = Vec::new();
    for track in &ordered_tracks {
        let Some(track_id) = track.get("id").and_then(|value| value.as_str()) else {
            continue;
        };
        let mut track_items = items
            .iter()
            .filter(|item| item.get("trackId").and_then(|value| value.as_str()) == Some(track_id))
            .cloned()
            .collect::<Vec<_>>();
        track_items.sort_by(|left, right| {
            let left_from = left
                .get("fromMs")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            let right_from = right
                .get("fromMs")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            if left_from != right_from {
                return left_from.cmp(&right_from);
            }
            let left_id = left
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let right_id = right
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            original_order
                .get(left_id)
                .unwrap_or(&0usize)
                .cmp(original_order.get(right_id).unwrap_or(&0usize))
        });
        let mut cursor = 0_i64;
        for mut item in track_items {
            let from_ms = item
                .get("fromMs")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            let duration_ms = item
                .get("durationMs")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            let next_from_ms = if main_video_track_id.as_deref() == Some(track_id) {
                cursor
            } else {
                from_ms.max(cursor)
            };
            if let Some(object) = item.as_object_mut() {
                object.insert("fromMs".to_string(), json!(next_from_ms));
            }
            cursor = next_from_ms + duration_ms.max(0);
            rebuilt.push(item);
        }
    }
    let known_track_ids = ordered_tracks
        .iter()
        .filter_map(|track| {
            track
                .get("id")
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
        })
        .collect::<BTreeSet<_>>();
    let remainder = items
        .iter()
        .filter(|item| {
            item.get("trackId")
                .and_then(|value| value.as_str())
                .map(|track_id| !known_track_ids.contains(track_id))
                .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    rebuilt.extend(remainder);
    *items = rebuilt;
    Ok(())
}

fn ensure_package_asset_entry(
    package_path: &std::path::Path,
    asset: &MediaAssetRecord,
    package_kind: Option<&str>,
    label: Option<&str>,
    role: Option<&str>,
) -> Result<(), String> {
    let mut assets = read_json_value_or(&package_assets_path(package_path), json!({ "items": [] }));
    let Some(items) = assets.get_mut("items").and_then(Value::as_array_mut) else {
        return Err("Package assets items missing".to_string());
    };
    let mut next_entry = json!({
        "assetId": asset.id,
        "title": asset.title.clone(),
        "mimeType": asset.mime_type.clone(),
        "relativePath": asset.relative_path.clone(),
        "absolutePath": asset.absolute_path.clone(),
        "mediaPath": asset.absolute_path.clone().or(asset.relative_path.clone()),
        "previewUrl": asset.preview_url.clone(),
        "boundManuscriptPath": asset.bound_manuscript_path.clone(),
        "exists": asset.exists,
        "updatedAt": asset.updated_at.clone(),
    });
    if let Some(value) = package_kind
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        next_entry
            .as_object_mut()
            .ok_or_else(|| "Package asset entry must be an object".to_string())?
            .insert("kind".to_string(), json!(value));
    }
    if let Some(value) = label.map(str::trim).filter(|value| !value.is_empty()) {
        next_entry
            .as_object_mut()
            .ok_or_else(|| "Package asset entry must be an object".to_string())?
            .insert("label".to_string(), json!(value));
    }
    if let Some(value) = role.map(str::trim).filter(|value| !value.is_empty()) {
        next_entry
            .as_object_mut()
            .ok_or_else(|| "Package asset entry must be an object".to_string())?
            .insert("role".to_string(), json!(value));
    }
    if let Some(existing) = items.iter_mut().find(|item| {
        item.get("assetId")
            .and_then(|value| value.as_str())
            .map(|value| value == asset.id)
            .unwrap_or(false)
    }) {
        *existing = next_entry;
    } else {
        items.push(next_entry);
    }
    write_json_value(&package_assets_path(package_path), &assets)?;
    let editor_project_path = package_editor_project_path(package_path);
    if editor_project_path.exists() {
        let mut editor_project = read_json_value_or(&editor_project_path, json!({}));
        if let Some(editor_assets) = editor_project
            .get_mut("assets")
            .and_then(Value::as_array_mut)
        {
            let editor_asset = json!({
                "id": asset.id,
                "kind": infer_editor_asset_kind(
                    asset.mime_type.as_deref(),
                    asset.absolute_path.as_deref().or(asset.relative_path.as_deref())
                ),
                "title": asset.title.clone().unwrap_or_else(|| asset.id.clone()),
                "src": asset.absolute_path.clone().or(asset.relative_path.clone()).unwrap_or_default(),
                "mimeType": asset.mime_type.clone(),
                "durationMs": Value::Null,
                "metadata": {
                    "relativePath": asset.relative_path.clone(),
                    "absolutePath": asset.absolute_path.clone(),
                    "previewUrl": asset.preview_url.clone(),
                    "boundManuscriptPath": asset.bound_manuscript_path.clone(),
                    "exists": asset.exists
                }
            });
            if let Some(existing) = editor_assets.iter_mut().find(|item| {
                item.get("id")
                    .and_then(|value| value.as_str())
                    .map(|value| value == asset.id)
                    .unwrap_or(false)
            }) {
                *existing = editor_asset;
            } else {
                editor_assets.push(editor_asset);
            }
            write_json_value(&editor_project_path, &editor_project)?;
        }
    }
    let file_name = package_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled");
    if get_package_kind_from_file_name(file_name) == Some("video") {
        let manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
        let title = manifest
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or("RedBox Motion");
        let mut remotion = read_json_value_or(
            &package_remotion_path(package_path),
            build_default_remotion_scene(title, &[]),
        );
        let asset_src = asset
            .absolute_path
            .clone()
            .or(asset.relative_path.clone())
            .unwrap_or_default();
        let asset_kind = infer_editor_asset_kind(asset.mime_type.as_deref(), Some(&asset_src));
        let can_seed_base_media = matches!(asset_kind, "video" | "image");
        let has_base_media = remotion
            .pointer("/baseMedia/outputPath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some();
        if can_seed_base_media && !has_base_media {
            if let Some(object) = remotion.as_object_mut() {
                let fallback_duration_in_frames =
                    object.get("durationInFrames").cloned().unwrap_or(json!(90));
                object.insert("version".to_string(), json!(2));
                object.insert("renderMode".to_string(), json!("full"));
                object.insert(
                    "baseMedia".to_string(),
                    json!({
                        "sourceAssetIds": [asset.id.clone()],
                        "outputPath": asset_src,
                        "durationMs": object
                            .get("baseMedia")
                            .and_then(|value| value.get("durationMs"))
                            .and_then(Value::as_i64)
                            .unwrap_or(0),
                        "status": "ready",
                        "updatedAt": now_i64()
                    }),
                );
                let scenes = object
                    .entry("scenes".to_string())
                    .or_insert_with(|| json!([]));
                if !scenes.is_array() {
                    *scenes = json!([]);
                }
                let scenes_array = scenes
                    .as_array_mut()
                    .ok_or_else(|| "Remotion scenes must be an array".to_string())?;
                if scenes_array.is_empty() {
                    scenes_array.push(json!({
                        "id": "scene-1",
                        "clipId": Value::Null,
                        "assetId": asset.id,
                        "assetKind": asset_kind,
                        "src": asset.absolute_path.clone().or(asset.relative_path.clone()).unwrap_or_default(),
                        "startFrame": 0,
                        "durationInFrames": fallback_duration_in_frames,
                        "trimInFrames": 0,
                        "motionPreset": "static",
                        "overlayTitle": Value::Null,
                        "overlayBody": Value::Null,
                        "overlays": [],
                        "entities": []
                    }));
                } else if let Some(primary_scene) =
                    scenes_array.first_mut().and_then(Value::as_object_mut)
                {
                    let current_src = primary_scene
                        .get("src")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or("");
                    if current_src.is_empty() {
                        primary_scene.insert(
                            "src".to_string(),
                            json!(asset
                                .absolute_path
                                .clone()
                                .or(asset.relative_path.clone())
                                .unwrap_or_default()),
                        );
                        primary_scene.insert("assetKind".to_string(), json!(asset_kind));
                        primary_scene.insert("assetId".to_string(), json!(asset.id.clone()));
                    }
                }
            }
            persist_remotion_composition_artifacts(package_path, &remotion)?;
        }
    }
    Ok(())
}

fn split_timeline_clip_value(clip: &Value, clip_id: &str, split_ratio: f64) -> (Value, Value) {
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

fn ffmpeg_seconds(ms: i64) -> String {
    format!("{:.3}", (ms.max(0) as f64) / 1000.0)
}

fn ffmpeg_asset_items(package_state: &Value) -> Vec<Value> {
    package_state
        .pointer("/assets/items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn ffmpeg_asset_id(asset: &Value) -> Option<String> {
    asset
        .get("assetId")
        .or_else(|| asset.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn ffmpeg_asset_path(asset: &Value) -> Option<String> {
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

fn resolve_ffmpeg_asset_path(assets: &[Value], asset_id: &str) -> Result<String, String> {
    assets
        .iter()
        .find(|asset| {
            ffmpeg_asset_id(asset)
                .map(|candidate| candidate == asset_id)
                .unwrap_or(false)
        })
        .and_then(ffmpeg_asset_path)
        .ok_or_else(|| format!("未找到素材 `{asset_id}` 的可用路径"))
}

fn ffmpeg_output_path(
    package_path: &std::path::Path,
    step_index: usize,
    op_name: &str,
    extension: &str,
) -> Result<std::path::PathBuf, String> {
    let dir = package_path.join("cache").join("ai-edits");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join(format!(
        "{:02}-{}-{}.{}",
        step_index + 1,
        op_name,
        now_ms(),
        extension
    )))
}

fn run_ffmpeg_args(args: &[String]) -> Result<(), String> {
    let output = std::process::Command::new("ffmpeg")
        .args(args)
        .output()
        .map_err(|error| format!("执行 ffmpeg 失败: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("ffmpeg 执行失败，退出码 {}", output.status)
    } else {
        stderr
    })
}

fn ffmpeg_operation_input_path(
    operation: &Value,
    current_path: Option<&std::path::PathBuf>,
    assets: &[Value],
) -> Result<String, String> {
    if let Some(input_path) = operation.get("inputPath").and_then(Value::as_str) {
        let trimmed = input_path.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    if let Some(asset_id) = operation.get("assetId").and_then(Value::as_str) {
        let trimmed = asset_id.trim();
        if !trimmed.is_empty() {
            return resolve_ffmpeg_asset_path(assets, trimmed);
        }
    }
    current_path
        .map(|path| path.display().to_string())
        .ok_or_else(|| "当前操作缺少输入视频，请提供 assetId 或 inputPath".to_string())
}

fn ffmpeg_recipe_source_asset_ids(operations: &[Value]) -> Vec<String> {
    let mut ids = Vec::<String>::new();
    let push_id = |ids: &mut Vec<String>, candidate: Option<&str>| {
        let Some(candidate) = candidate.map(str::trim).filter(|value| !value.is_empty()) else {
            return;
        };
        if !ids.iter().any(|value| value == candidate) {
            ids.push(candidate.to_string());
        }
    };
    for operation in operations {
        push_id(&mut ids, operation.get("assetId").and_then(Value::as_str));
        if let Some(asset_ids) = operation.get("assetIds").and_then(Value::as_array) {
            for asset_id in asset_ids {
                push_id(&mut ids, asset_id.as_str());
            }
        }
        push_id(
            &mut ids,
            operation.get("audioAssetId").and_then(Value::as_str),
        );
    }
    ids
}

fn ffmpeg_recipe_duration_ms(operations: &[Value], fallback_duration_ms: i64) -> i64 {
    let trimmed_sum = operations
        .iter()
        .filter(|operation| operation.get("type").and_then(Value::as_str) == Some("trim"))
        .filter_map(|operation| operation.get("durationMs").and_then(Value::as_i64))
        .sum::<i64>();
    if trimmed_sum > 0 {
        return trimmed_sum;
    }
    operations
        .iter()
        .rev()
        .find_map(|operation| operation.get("durationMs").and_then(Value::as_i64))
        .unwrap_or(fallback_duration_ms.max(0))
}

fn execute_ffmpeg_edit_recipe(
    package_path: &std::path::Path,
    assets: &[Value],
    operations: &[Value],
) -> Result<(std::path::PathBuf, Vec<Value>), String> {
    let mut current_path: Option<std::path::PathBuf> = None;
    let mut segment_paths: Vec<std::path::PathBuf> = Vec::new();
    let mut artifacts = Vec::<Value>::new();

    for (index, operation) in operations.iter().enumerate() {
        let op_name = operation
            .get("type")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "ffmpeg operation 缺少 type".to_string())?;
        match op_name {
            "trim" => {
                let input_path =
                    ffmpeg_operation_input_path(operation, current_path.as_ref(), assets)?;
                let output_path = ffmpeg_output_path(package_path, index, "trim", "mp4")?;
                let mut args = vec!["-y".to_string()];
                let start_ms = operation
                    .get("startMs")
                    .and_then(Value::as_i64)
                    .unwrap_or_else(|| {
                        operation
                            .get("trimInMs")
                            .and_then(Value::as_i64)
                            .unwrap_or(0)
                    });
                if start_ms > 0 {
                    args.push("-ss".to_string());
                    args.push(ffmpeg_seconds(start_ms));
                }
                args.push("-i".to_string());
                args.push(input_path.clone());
                if let Some(duration_ms) = operation.get("durationMs").and_then(Value::as_i64) {
                    if duration_ms > 0 {
                        args.push("-t".to_string());
                        args.push(ffmpeg_seconds(duration_ms));
                    }
                }
                args.extend([
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-preset".to_string(),
                    "veryfast".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    output_path.display().to_string(),
                ]);
                run_ffmpeg_args(&args)?;
                current_path = Some(output_path.clone());
                segment_paths.push(output_path.clone());
                artifacts.push(json!({
                    "type": op_name,
                    "path": output_path.display().to_string(),
                    "sourcePath": input_path
                }));
            }
            "concat" => {
                let mut inputs = operation
                    .get("assetIds")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(|asset_id| resolve_ffmpeg_asset_path(assets, asset_id))
                            .collect::<Result<Vec<_>, _>>()
                    })
                    .transpose()?
                    .unwrap_or_default()
                    .into_iter()
                    .map(std::path::PathBuf::from)
                    .collect::<Vec<_>>();
                if inputs.is_empty() {
                    inputs = segment_paths.clone();
                }
                if inputs.is_empty() {
                    if let Some(path) = current_path.clone() {
                        inputs.push(path);
                    }
                }
                if inputs.is_empty() {
                    return Err("concat 操作缺少可拼接的输入片段".to_string());
                }
                if inputs.len() == 1 {
                    current_path = inputs.first().cloned();
                    continue;
                }
                let output_path = ffmpeg_output_path(package_path, index, "concat", "mp4")?;
                let mut args = vec!["-y".to_string()];
                for input in &inputs {
                    args.push("-i".to_string());
                    args.push(input.display().to_string());
                }
                let mut filter = String::new();
                for input_index in 0..inputs.len() {
                    filter.push_str(&format!("[{input_index}:v:0]"));
                }
                filter.push_str(&format!("concat=n={}:v=1:a=0[v]", inputs.len()));
                args.extend([
                    "-filter_complex".to_string(),
                    filter,
                    "-map".to_string(),
                    "[v]".to_string(),
                    "-pix_fmt".to_string(),
                    "yuv420p".to_string(),
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    output_path.display().to_string(),
                ]);
                run_ffmpeg_args(&args)?;
                current_path = Some(output_path.clone());
                segment_paths = vec![output_path.clone()];
                artifacts.push(json!({
                    "type": op_name,
                    "path": output_path.display().to_string(),
                    "inputs": inputs.iter().map(|input| input.display().to_string()).collect::<Vec<_>>()
                }));
            }
            "crop_scale" => {
                let input_path =
                    ffmpeg_operation_input_path(operation, current_path.as_ref(), assets)?;
                let output_path = ffmpeg_output_path(package_path, index, "crop-scale", "mp4")?;
                let crop_width = operation.get("width").and_then(Value::as_i64).unwrap_or(0);
                let crop_height = operation.get("height").and_then(Value::as_i64).unwrap_or(0);
                let crop_x = operation.get("x").and_then(Value::as_i64).unwrap_or(0);
                let crop_y = operation.get("y").and_then(Value::as_i64).unwrap_or(0);
                let target_width = operation
                    .get("targetWidth")
                    .or_else(|| operation.get("outputWidth"))
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let target_height = operation
                    .get("targetHeight")
                    .or_else(|| operation.get("outputHeight"))
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let mut filters = Vec::<String>::new();
                if crop_width > 0 && crop_height > 0 {
                    filters.push(format!("crop={crop_width}:{crop_height}:{crop_x}:{crop_y}"));
                }
                if target_width > 0 && target_height > 0 {
                    filters.push(format!("scale={target_width}:{target_height}"));
                }
                if filters.is_empty() {
                    return Err("crop_scale 至少需要裁剪参数或目标尺寸".to_string());
                }
                let args = vec![
                    "-y".to_string(),
                    "-i".to_string(),
                    input_path.clone(),
                    "-vf".to_string(),
                    filters.join(","),
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-preset".to_string(),
                    "veryfast".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    output_path.display().to_string(),
                ];
                run_ffmpeg_args(&args)?;
                current_path = Some(output_path.clone());
                artifacts.push(json!({
                    "type": op_name,
                    "path": output_path.display().to_string(),
                    "sourcePath": input_path
                }));
            }
            "speed" => {
                let input_path =
                    ffmpeg_operation_input_path(operation, current_path.as_ref(), assets)?;
                let output_path = ffmpeg_output_path(package_path, index, "speed", "mp4")?;
                let speed = operation
                    .get("speed")
                    .and_then(Value::as_f64)
                    .unwrap_or(1.0);
                if speed <= 0.0 {
                    return Err("speed 必须大于 0".to_string());
                }
                let setpts = 1.0 / speed;
                let args = vec![
                    "-y".to_string(),
                    "-i".to_string(),
                    input_path.clone(),
                    "-filter:v".to_string(),
                    format!("setpts={setpts:.6}*PTS"),
                    "-an".to_string(),
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    output_path.display().to_string(),
                ];
                run_ffmpeg_args(&args)?;
                current_path = Some(output_path.clone());
                artifacts.push(json!({
                    "type": op_name,
                    "path": output_path.display().to_string(),
                    "sourcePath": input_path,
                    "speed": speed
                }));
            }
            "mute" => {
                let input_path =
                    ffmpeg_operation_input_path(operation, current_path.as_ref(), assets)?;
                let output_path = ffmpeg_output_path(package_path, index, "mute", "mp4")?;
                let args = vec![
                    "-y".to_string(),
                    "-i".to_string(),
                    input_path.clone(),
                    "-an".to_string(),
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    output_path.display().to_string(),
                ];
                run_ffmpeg_args(&args)?;
                current_path = Some(output_path.clone());
                artifacts.push(json!({
                    "type": op_name,
                    "path": output_path.display().to_string(),
                    "sourcePath": input_path
                }));
            }
            "replace_audio" => {
                let input_path =
                    ffmpeg_operation_input_path(operation, current_path.as_ref(), assets)?;
                let audio_asset_id = operation
                    .get("audioAssetId")
                    .or_else(|| operation.get("assetId"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "replace_audio 缺少 audioAssetId".to_string())?;
                let audio_path = resolve_ffmpeg_asset_path(assets, audio_asset_id)?;
                let output_path = ffmpeg_output_path(package_path, index, "replace-audio", "mp4")?;
                let args = vec![
                    "-y".to_string(),
                    "-i".to_string(),
                    input_path.clone(),
                    "-i".to_string(),
                    audio_path.clone(),
                    "-map".to_string(),
                    "0:v:0".to_string(),
                    "-map".to_string(),
                    "1:a:0".to_string(),
                    "-c:v".to_string(),
                    "copy".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-shortest".to_string(),
                    output_path.display().to_string(),
                ];
                run_ffmpeg_args(&args)?;
                current_path = Some(output_path.clone());
                artifacts.push(json!({
                    "type": op_name,
                    "path": output_path.display().to_string(),
                    "sourcePath": input_path,
                    "audioPath": audio_path
                }));
            }
            _ => {
                return Err(format!("暂不支持的 ffmpeg operation: {op_name}"));
            }
        }
    }

    let final_path = current_path.ok_or_else(|| "ffmpeg_edit 没有生成任何输出".to_string())?;
    Ok((final_path, artifacts))
}

pub fn handle_manuscripts_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !channel.starts_with("manuscripts:") {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "manuscripts:list" => {
                let root = manuscripts_root(state)?;
                serde_json::to_value(list_tree(&root, &root)?).map_err(|error| error.to_string())
            }
            "manuscripts:read" => {
                let relative = payload_value_as_string(&payload).unwrap_or_default();
                let direct_path = std::path::PathBuf::from(&relative);
                let path = if direct_path.is_absolute() && direct_path.exists() {
                    direct_path
                } else {
                    resolve_manuscript_path(state, &relative)?
                };
                if path.is_dir()
                    && is_manuscript_package_name(
                        path.file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or(""),
                    )
                {
                    let file_name = path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("");
                    let manifest = read_json_value_or(&package_manifest_path(&path), json!({}));
                    let content =
                        fs::read_to_string(package_entry_path(&path, file_name, Some(&manifest)))
                            .unwrap_or_default();
                    return Ok(json!({
                        "content": content,
                        "metadata": manifest
                    }));
                }
                let content = fs::read_to_string(&path).unwrap_or_default();
                Ok(json!({
                    "content": content,
                    "metadata": {
                        "id": slug_from_relative_path(&relative),
                        "title": title_from_relative_path(&relative),
                        "draftType": get_draft_type_from_file_name(&relative),
                    }
                }))
            }
            "manuscripts:save" => {
                let target = payload_string(&payload, "path").unwrap_or_default();
                let content = payload_string(&payload, "content").unwrap_or_default();
                save_manuscript_content(
                    state,
                    &target,
                    &content,
                    payload_field(&payload, "metadata").and_then(Value::as_object),
                    "user",
                )
            }
            "manuscripts:get-write-proposal" => {
                let file_path = payload_string(&payload, "filePath")
                    .or_else(|| payload_string(&payload, "path"))
                    .unwrap_or_default();
                let proposal = get_manuscript_write_proposal(state, &file_path)?;
                Ok(json!({
                    "success": true,
                    "proposal": proposal,
                }))
            }
            "manuscripts:accept-write-proposal" => {
                let file_path = payload_string(&payload, "filePath")
                    .or_else(|| payload_string(&payload, "path"))
                    .unwrap_or_default();
                accept_manuscript_write_proposal(app, state, &file_path)
            }
            "manuscripts:reject-write-proposal" => {
                let file_path = payload_string(&payload, "filePath")
                    .or_else(|| payload_string(&payload, "path"))
                    .unwrap_or_default();
                let removed = reject_manuscript_write_proposal(app, state, &file_path)?;
                Ok(json!({
                    "success": true,
                    "removed": removed,
                }))
            }
            "manuscripts:create-folder" => {
                let parent_path = payload_string(&payload, "parentPath").unwrap_or_default();
                let name =
                    payload_string(&payload, "name").unwrap_or_else(|| "New Folder".to_string());
                let relative = join_relative(&parent_path, &name);
                let path = resolve_manuscript_path(state, &relative)?;
                fs::create_dir_all(&path).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true, "path": normalize_relative_path(&relative) }))
            }
            "manuscripts:create-file" => {
                let parent_path = payload_string(&payload, "parentPath").unwrap_or_default();
                let name =
                    payload_string(&payload, "name").unwrap_or_else(|| "Untitled.md".to_string());
                let content = payload_string(&payload, "content").unwrap_or_default();
                let fallback_extension = if is_manuscript_package_name(&name) {
                    ""
                } else {
                    ".md"
                };
                let relative = normalize_relative_path(&join_relative(
                    &parent_path,
                    &ensure_manuscript_file_name(&name, fallback_extension),
                ));
                let path = resolve_manuscript_path(state, &relative)?;
                if is_manuscript_package_name(&relative) {
                    let title = payload_string(&payload, "title")
                        .unwrap_or_else(|| title_from_relative_path(&relative));
                    create_manuscript_package(&path, &content, &relative, &title)?;
                } else {
                    if let Some(parent) = path.parent() {
                        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                    }
                    fs::write(&path, content).map_err(|error| error.to_string())?;
                }
                Ok(json!({ "success": true, "path": normalize_relative_path(&relative) }))
            }
            "manuscripts:upgrade-to-package" => {
                let source_path = payload_string(&payload, "sourcePath").unwrap_or_default();
                let target_kind =
                    payload_string(&payload, "targetKind").unwrap_or_else(|| "article".to_string());
                let target_extension = if target_kind == "post" {
                    POST_DRAFT_EXTENSION
                } else {
                    ARTICLE_DRAFT_EXTENSION
                };
                let new_path =
                    upgrade_markdown_manuscript_to_package(state, &source_path, target_extension)?;
                Ok(json!({ "success": true, "newPath": new_path }))
            }
            "manuscripts:delete" => {
                let relative = payload_value_as_string(&payload).unwrap_or_default();
                let path = resolve_manuscript_path(state, &relative)?;
                if path.is_dir() {
                    fs::remove_dir_all(&path).map_err(|error| error.to_string())?;
                } else if path.exists() {
                    fs::remove_file(&path).map_err(|error| error.to_string())?;
                }
                Ok(json!({ "success": true }))
            }
            "manuscripts:rename" => {
                let old_path = payload_string(&payload, "oldPath").unwrap_or_default();
                let new_name = payload_string(&payload, "newName").unwrap_or_default();
                if new_name.is_empty() {
                    return Ok(json!({ "success": false, "error": "缺少新名称" }));
                }
                let source = resolve_manuscript_path(state, &old_path)?;
                let source_name = source
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("");
                let parent_rel = normalize_relative_path(
                    old_path
                        .rsplit_once('/')
                        .map(|(parent, _)| parent)
                        .unwrap_or(""),
                );
                let mut target_relative = join_relative(&parent_rel, &new_name);
                if !target_relative.contains('.') {
                    if source_name.ends_with(ARTICLE_DRAFT_EXTENSION) {
                        target_relative = format!(
                            "{}{}",
                            normalize_relative_path(&target_relative),
                            ARTICLE_DRAFT_EXTENSION
                        );
                    } else if source_name.ends_with(POST_DRAFT_EXTENSION) {
                        target_relative = format!(
                            "{}{}",
                            normalize_relative_path(&target_relative),
                            POST_DRAFT_EXTENSION
                        );
                    } else if source_name.ends_with(VIDEO_DRAFT_EXTENSION) {
                        target_relative = format!(
                            "{}{}",
                            normalize_relative_path(&target_relative),
                            VIDEO_DRAFT_EXTENSION
                        );
                    } else if source_name.ends_with(AUDIO_DRAFT_EXTENSION) {
                        target_relative = format!(
                            "{}{}",
                            normalize_relative_path(&target_relative),
                            AUDIO_DRAFT_EXTENSION
                        );
                    } else if source.is_file() {
                        target_relative = ensure_markdown_extension(&target_relative);
                    } else {
                        target_relative = normalize_relative_path(&target_relative);
                    }
                } else if source.is_file() && !source_name.contains('.') {
                    target_relative = ensure_markdown_extension(&target_relative);
                } else {
                    target_relative = normalize_relative_path(&target_relative);
                }
                let target = resolve_manuscript_path(state, &target_relative)?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::rename(&source, &target).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true, "newPath": target_relative }))
            }
            "manuscripts:move" => {
                let source_path = payload_string(&payload, "sourcePath").unwrap_or_default();
                let target_dir = payload_string(&payload, "targetDir").unwrap_or_default();
                let source = resolve_manuscript_path(state, &source_path)?;
                let file_name = source
                    .file_name()
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "Invalid manuscript source".to_string())?;
                let target_relative =
                    normalize_relative_path(&join_relative(&target_dir, file_name));
                let target = resolve_manuscript_path(state, &target_relative)?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::rename(&source, &target).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true, "newPath": target_relative }))
            }
            "manuscripts:get-package-state" => {
                let file_path = payload_value_as_string(&payload).unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir()
                    || !is_manuscript_package_name(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or(""),
                    )
                {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:save-package-template"
            | "manuscripts:save-package-template-html"
            | "manuscripts:save-package-html" => {
                let channel = channel;
                let file_path = payload_string(&payload, "filePath")
                    .or_else(|| payload_string(&payload, "path"))
                    .unwrap_or_default();
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
                let package_kind = get_package_kind_from_file_name(file_name).unwrap_or("");
                let target = normalize_package_html_target(
                    package_kind,
                    &payload_string(&payload, "target").unwrap_or_default(),
                )?;
                let html = payload_string(&payload, "html").unwrap_or_default();
                if html.trim().is_empty() {
                    return Ok(json!({ "success": false, "error": "html is required" }));
                }
                let template_mode = channel != "manuscripts:save-package-html";
                Ok(json!({
                    "success": true,
                    "target": target,
                    "state": if package_kind == "post" || template_mode {
                        persist_package_html_template(state, &full_path, file_name, target, &html)?
                    } else {
                        persist_package_html_document(&full_path, target, &html)?
                    },
                }))
            }
            "manuscripts:generate-package-template"
            | "manuscripts:generate-package-template-html"
            | "manuscripts:generate-package-html" => {
                let channel = channel;
                let file_path = payload_string(&payload, "filePath")
                    .or_else(|| payload_string(&payload, "path"))
                    .unwrap_or_default();
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
                let package_kind = get_package_kind_from_file_name(file_name).unwrap_or("");
                let target = normalize_package_html_target(
                    package_kind,
                    &payload_string(&payload, "target").unwrap_or_default(),
                )?;
                let manifest = read_json_value_or(&package_manifest_path(&full_path), json!({}));
                let title = manifest
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(ToString::to_string)
                    .unwrap_or_else(|| title_from_relative_path(file_name));
                let content =
                    fs::read_to_string(package_entry_path(&full_path, file_name, Some(&manifest)))
                        .unwrap_or_default();
                let template_mode = channel != "manuscripts:generate-package-html";
                let html = if package_kind == "post" || template_mode {
                    generate_package_html_template(
                        state,
                        &full_path,
                        file_name,
                        target,
                        &title,
                        &content,
                        payload_field(&payload, "modelConfig"),
                    )?
                } else {
                    generate_package_html_document(
                        state,
                        &full_path,
                        file_name,
                        target,
                        &title,
                        &content,
                        payload_field(&payload, "modelConfig"),
                    )?
                };
                Ok(json!({
                    "success": true,
                    "target": target,
                    "html": html,
                    "state": if package_kind == "post" || template_mode {
                        persist_package_html_template(state, &full_path, file_name, target, &html)?
                    } else {
                        persist_package_html_document(&full_path, target, &html)?
                    },
                }))
            }
            "manuscripts:generate-richpost-page-plan" => {
                let file_path = payload_string(&payload, "filePath")
                    .or_else(|| payload_string(&payload, "path"))
                    .unwrap_or_default();
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
                if get_package_kind_from_file_name(file_name) != Some("post") {
                    return Ok(
                        json!({ "success": false, "error": "Only richpost packages support page plans" }),
                    );
                }
                let manifest = read_json_value_or(&package_manifest_path(&full_path), json!({}));
                let title = manifest
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(ToString::to_string)
                    .unwrap_or_else(|| title_from_relative_path(file_name));
                let content =
                    fs::read_to_string(package_entry_path(&full_path, file_name, Some(&manifest)))
                        .unwrap_or_default();
                let blocks =
                    build_package_content_blocks(&package_content_map_path(&full_path), &content);
                let (cover_asset, image_assets) =
                    collect_package_bound_assets(Some(state), &full_path)?;
                let plan = generate_richpost_page_plan(
                    state,
                    &full_path,
                    file_name,
                    &title,
                    &content,
                    payload_field(&payload, "modelConfig"),
                )?;
                Ok(json!({
                    "success": true,
                    "plan": plan,
                    "state": persist_richpost_page_plan(
                        &full_path,
                        &title,
                        &blocks,
                        cover_asset.as_ref(),
                        &image_assets,
                        &plan,
                        "ai",
                    )?,
                }))
            }
            "manuscripts:set-richpost-theme" => {
                let file_path = payload_string(&payload, "filePath")
                    .or_else(|| payload_string(&payload, "path"))
                    .unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let theme_id = payload_string(&payload, "themeId").unwrap_or_default();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let file_name = full_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("Untitled");
                if get_package_kind_from_file_name(file_name) != Some("post") {
                    return Ok(
                        json!({ "success": false, "error": "Only richpost packages support themes" }),
                    );
                }
                let theme = richpost_theme_spec_by_id(Some(&full_path), &theme_id);
                let mut manifest =
                    read_json_value_or(&package_manifest_path(&full_path), json!({}));
                write_applied_richpost_theme_to_manifest(&mut manifest, &theme);
                write_json_value(&package_manifest_path(&full_path), &manifest)?;
                sync_package_from_richpost_theme_root(&full_path, &theme)?;
                Ok(json!({
                    "success": true,
                    "themeId": theme.id,
                    "state": sync_manuscript_package_html_assets(Some(state), &full_path, file_name, None, None)?,
                }))
            }
            "manuscripts:preview-richpost-theme-draft" => {
                let file_path = payload_string(&payload, "filePath")
                    .or_else(|| payload_string(&payload, "path"))
                    .unwrap_or_default();
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
                if get_package_kind_from_file_name(file_name) != Some("post") {
                    return Ok(json!({
                        "success": false,
                        "error": "Only richpost packages support richpost theme previews"
                    }));
                }
                let manifest = read_json_value_or(&package_manifest_path(&full_path), json!({}));
                let typography = richpost_typography_settings_from_manifest(&manifest);
                let _ = ensure_richpost_layout_scaffold(&full_path, &manifest)?;
                let base_theme_id = payload_string(&payload, "baseThemeId")
                    .or_else(|| {
                        manifest
                            .get("richpostThemeId")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                    })
                    .unwrap_or_default();
                let base_theme = richpost_theme_spec_by_id(Some(&full_path), &base_theme_id);
                let draft_theme = normalize_richpost_theme_draft(
                    payload_field(&payload, "theme").unwrap_or(&Value::Null),
                    &base_theme,
                    payload_string(&payload, "existingThemeId").as_deref(),
                    &full_path,
                );
                Ok(json!({
                    "success": true,
                    "theme": richpost_theme_spec_payload_value(&draft_theme),
                    "previews": render_richpost_theme_preview_pages(&full_path, &draft_theme, typography),
                    "html": render_richpost_theme_preview_html(&full_path, &draft_theme, typography),
                }))
            }
            "manuscripts:create-richpost-custom-theme" => {
                let file_path = payload_string(&payload, "filePath")
                    .or_else(|| payload_string(&payload, "path"))
                    .unwrap_or_default();
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
                if get_package_kind_from_file_name(file_name) != Some("post") {
                    return Ok(json!({
                        "success": false,
                        "error": "Only richpost packages support custom themes"
                    }));
                }
                let manifest = read_json_value_or(&package_manifest_path(&full_path), json!({}));
                let create_from_blank = payload_field(&payload, "createFromBlank")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let base_theme_id = if create_from_blank {
                    String::new()
                } else {
                    payload_string(&payload, "baseThemeId")
                        .or_else(|| {
                            manifest
                                .get("richpostThemeId")
                                .and_then(Value::as_str)
                                .map(ToString::to_string)
                        })
                        .unwrap_or_default()
                };
                let base_theme = if create_from_blank {
                    blank_richpost_theme_spec()
                } else {
                    richpost_theme_spec_by_id(Some(&full_path), &base_theme_id)
                };
                let default_label = next_richpost_custom_theme_label(&full_path);
                let requested_theme = payload_field(&payload, "theme")
                    .cloned()
                    .unwrap_or_else(|| json!({ "label": default_label }));
                let theme =
                    normalize_richpost_theme_draft(&requested_theme, &base_theme, None, &full_path);
                let mut custom_themes = read_custom_richpost_theme_specs(&full_path);
                custom_themes.retain(|item| item.id != theme.id);
                custom_themes.push(theme.clone());
                custom_themes.sort_by(|left, right| {
                    left.label.cmp(&right.label).then(left.id.cmp(&right.id))
                });
                write_custom_richpost_theme_specs(&full_path, &custom_themes)?;
                sync_richpost_theme_root_from_package(&full_path, &theme, create_from_blank)?;
                let package_state =
                    crate::manuscript_package::get_manuscript_package_state(&full_path)?;
                let theme_id = sanitize_richpost_theme_id_fragment(&theme.id);
                Ok(json!({
                    "success": true,
                    "themeId": theme.id,
                    "themeRoot": package_richpost_theme_root_dir(&full_path, &theme_id).display().to_string(),
                    "themeFile": package_richpost_theme_config_path(&full_path, &theme_id).display().to_string(),
                    "themeIndexFile": package_richpost_themes_path(&full_path).display().to_string(),
                    "themeTemplateFile": package_richpost_theme_template_path(&full_path).display().to_string(),
                    "theme": richpost_theme_spec_payload_value(&theme),
                    "state": package_state,
                }))
            }
            "manuscripts:save-richpost-custom-theme" => {
                let file_path = payload_string(&payload, "filePath")
                    .or_else(|| payload_string(&payload, "path"))
                    .unwrap_or_default();
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
                if get_package_kind_from_file_name(file_name) != Some("post") {
                    return Ok(json!({
                        "success": false,
                        "error": "Only richpost packages support custom themes"
                    }));
                }
                let mut manifest =
                    read_json_value_or(&package_manifest_path(&full_path), json!({}));
                let base_theme_id = payload_string(&payload, "baseThemeId")
                    .or_else(|| {
                        manifest
                            .get("richpostThemeId")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                    })
                    .unwrap_or_default();
                let base_theme = richpost_theme_spec_by_id(Some(&full_path), &base_theme_id);
                let theme = normalize_richpost_theme_draft(
                    payload_field(&payload, "theme").unwrap_or(&Value::Null),
                    &base_theme,
                    payload_string(&payload, "existingThemeId").as_deref(),
                    &full_path,
                );
                let mut custom_themes = read_custom_richpost_theme_specs(&full_path);
                custom_themes.retain(|item| item.id != theme.id);
                custom_themes.push(theme.clone());
                custom_themes.sort_by(|left, right| {
                    left.label.cmp(&right.label).then(left.id.cmp(&right.id))
                });
                write_custom_richpost_theme_specs(&full_path, &custom_themes)?;
                sync_richpost_theme_root_from_package(&full_path, &theme, false)?;
                let apply_immediately = payload_field(&payload, "apply")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let state = if apply_immediately {
                    write_applied_richpost_theme_to_manifest(&mut manifest, &theme);
                    write_json_value(&package_manifest_path(&full_path), &manifest)?;
                    sync_package_from_richpost_theme_root(&full_path, &theme)?;
                    sync_manuscript_package_html_assets(
                        Some(state),
                        &full_path,
                        file_name,
                        None,
                        None,
                    )?
                } else {
                    if manifest
                        .get("richpostThemeId")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        == Some(theme.id.as_str())
                    {
                        write_applied_richpost_theme_to_manifest(&mut manifest, &theme);
                        write_json_value(&package_manifest_path(&full_path), &manifest)?;
                    }
                    crate::manuscript_package::get_manuscript_package_state(&full_path)?
                };
                Ok(json!({
                    "success": true,
                    "themeId": theme.id,
                    "themeRoot": package_richpost_theme_root_dir(&full_path, &sanitize_richpost_theme_id_fragment(&theme.id)).display().to_string(),
                    "themeFile": package_richpost_theme_config_path(&full_path, &sanitize_richpost_theme_id_fragment(&theme.id)).display().to_string(),
                    "theme": richpost_theme_spec_payload_value(&theme),
                    "state": state,
                }))
            }
            "manuscripts:upload-richpost-theme-background" => {
                let file_path = payload_string(&payload, "filePath")
                    .or_else(|| payload_string(&payload, "path"))
                    .unwrap_or_default();
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
                if get_package_kind_from_file_name(file_name) != Some("post") {
                    return Ok(json!({
                        "success": false,
                        "error": "Only richpost packages support theme backgrounds"
                    }));
                }
                let theme_id = payload_string(&payload, "themeId").unwrap_or_default();
                if theme_id.trim().is_empty() {
                    return Ok(json!({ "success": false, "error": "themeId is required" }));
                }
                let role = payload_string(&payload, "role")
                    .unwrap_or_else(|| RICHPOST_MASTER_BODY.to_string());
                let Some(role) = sanitize_richpost_master_name(&role) else {
                    return Ok(json!({ "success": false, "error": "role is invalid" }));
                };
                if !RICHPOST_DEFAULT_MASTER_NAMES
                    .iter()
                    .any(|item| *item == role)
                {
                    return Ok(json!({ "success": false, "error": "role is invalid" }));
                }
                let picked = pick_files_native("选择背景图片", false, false)?;
                let Some(selected) = picked.first() else {
                    return Ok(json!({ "success": true, "canceled": true }));
                };
                let (_mime_type, kind, _) = guess_mime_and_kind(selected);
                if kind != "image" {
                    return Ok(json!({ "success": false, "error": "只能选择图片文件" }));
                }
                let mut custom_themes = read_custom_richpost_theme_specs(&full_path);
                let Some(theme_index) = custom_themes
                    .iter()
                    .position(|theme| theme.id == theme_id && theme.source == "custom")
                else {
                    return Ok(json!({
                        "success": false,
                        "error": "Only custom themes support background uploads"
                    }));
                };
                let extension = selected
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("png");
                let backgrounds_dir = richpost_theme_background_storage_dir(&full_path, &theme_id);
                fs::create_dir_all(&backgrounds_dir).map_err(|error| error.to_string())?;
                let background_file_name =
                    richpost_theme_background_relative_file_name(&theme_id, &role, extension);
                let relative_path = global_richpost_theme_background_relative_path(
                    &full_path,
                    &theme_id,
                    &background_file_name,
                );
                let target_path = backgrounds_dir.join(&background_file_name);
                fs::copy(selected, &target_path).map_err(|error| error.to_string())?;
                let current_background =
                    richpost_theme_background_relative_path(&custom_themes[theme_index], &role);
                if !current_background.trim().is_empty() && current_background != relative_path {
                    if let Some(stale_path) = resolve_richpost_theme_background_absolute_path(
                        &full_path,
                        &current_background,
                    ) {
                        let _ = fs::remove_file(stale_path);
                    }
                }
                match role.as_str() {
                    RICHPOST_MASTER_COVER => {
                        custom_themes[theme_index].cover_background_path = relative_path.clone()
                    }
                    RICHPOST_MASTER_ENDING => {
                        custom_themes[theme_index].ending_background_path = relative_path.clone()
                    }
                    _ => custom_themes[theme_index].body_background_path = relative_path.clone(),
                }
                let theme = custom_themes[theme_index].clone();
                custom_themes.sort_by(|left, right| {
                    left.label.cmp(&right.label).then(left.id.cmp(&right.id))
                });
                write_custom_richpost_theme_specs(&full_path, &custom_themes)?;
                sync_richpost_theme_root_from_package(&full_path, &theme, false)?;
                let mut manifest =
                    read_json_value_or(&package_manifest_path(&full_path), json!({}));
                write_applied_richpost_theme_to_manifest(&mut manifest, &theme);
                write_json_value(&package_manifest_path(&full_path), &manifest)?;
                sync_package_from_richpost_theme_root(&full_path, &theme)?;
                Ok(json!({
                    "success": true,
                    "themeId": theme.id,
                    "theme": richpost_theme_spec_payload_value(&theme),
                    "state": sync_manuscript_package_html_assets(Some(state), &full_path, file_name, None, None)?,
                }))
            }
            "manuscripts:delete-richpost-custom-theme" => {
                let file_path = payload_string(&payload, "filePath")
                    .or_else(|| payload_string(&payload, "path"))
                    .unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let theme_id = payload_string(&payload, "themeId").unwrap_or_default();
                if theme_id.trim().is_empty() {
                    return Ok(json!({ "success": false, "error": "themeId is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let file_name = full_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("Untitled");
                if get_package_kind_from_file_name(file_name) != Some("post") {
                    return Ok(json!({
                        "success": false,
                        "error": "Only richpost packages support custom themes"
                    }));
                }
                let mut custom_themes = read_custom_richpost_theme_specs(&full_path);
                let removed_theme = custom_themes
                    .iter()
                    .find(|theme| theme.id == theme_id && theme.source == "custom")
                    .cloned();
                if removed_theme.is_none() {
                    return Ok(json!({
                        "success": false,
                        "error": "Only custom themes can be deleted"
                    }));
                }
                if let Some(theme) = removed_theme.as_ref() {
                    let _ = fs::remove_dir_all(package_richpost_theme_root_dir(
                        &full_path,
                        &sanitize_richpost_theme_id_fragment(&theme.id),
                    ));
                }
                custom_themes.retain(|theme| theme.id != theme_id);
                write_custom_richpost_theme_specs(&full_path, &custom_themes)?;
                let mut manifest =
                    read_json_value_or(&package_manifest_path(&full_path), json!({}));
                let was_applied = manifest
                    .get("richpostThemeId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    == Some(theme_id.trim());
                let state = if was_applied {
                    let fallback_theme = custom_themes
                        .first()
                        .cloned()
                        .unwrap_or_else(default_richpost_theme_spec);
                    write_applied_richpost_theme_to_manifest(&mut manifest, &fallback_theme);
                    write_json_value(&package_manifest_path(&full_path), &manifest)?;
                    sync_package_from_richpost_theme_root(&full_path, &fallback_theme)?;
                    sync_manuscript_package_html_assets(
                        Some(state),
                        &full_path,
                        file_name,
                        None,
                        None,
                    )?
                } else {
                    crate::manuscript_package::get_manuscript_package_state(&full_path)?
                };
                Ok(json!({
                    "success": true,
                    "deletedThemeId": theme_id,
                    "state": state,
                }))
            }
            "manuscripts:get-richpost-theme-previews" => {
                let file_path = payload_string(&payload, "filePath")
                    .or_else(|| payload_string(&payload, "path"))
                    .unwrap_or_default();
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
                if get_package_kind_from_file_name(file_name) != Some("post") {
                    return Ok(json!({
                        "success": false,
                        "error": "Only richpost packages support richpost theme previews"
                    }));
                }
                let manifest = read_json_value_or(&package_manifest_path(&full_path), json!({}));
                let typography = richpost_typography_settings_from_manifest(&manifest);
                let _ = ensure_richpost_layout_scaffold(&full_path, &manifest)?;
                let requested_ids = payload_field(&payload, "themeIds")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(ToString::to_string)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_else(|| {
                        richpost_theme_catalog_for_package(Some(&full_path))
                            .into_iter()
                            .map(|theme| theme.id)
                            .collect::<Vec<_>>()
                    });
                let catalog = richpost_theme_catalog_for_package(Some(&full_path));
                let previews = requested_ids
                    .into_iter()
                    .filter_map(|theme_id| {
                        catalog
                            .iter()
                            .find(|theme| theme.id == theme_id)
                            .cloned()
                            .map(|theme| {
                                json!({
                                    "id": theme.id,
                                    "label": theme.label,
                                    "html": render_richpost_theme_preview_html(&full_path, &theme, typography),
                                })
                            })
                    })
                    .collect::<Vec<_>>();
                Ok(json!({
                    "success": true,
                    "previews": previews,
                }))
            }
            "manuscripts:set-longform-layout-preset" => {
                let file_path = payload_string(&payload, "filePath")
                    .or_else(|| payload_string(&payload, "path"))
                    .unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let preset_id = payload_string(&payload, "presetId").unwrap_or_default();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let file_name = full_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("Untitled");
                if get_package_kind_from_file_name(file_name) != Some("article") {
                    return Ok(
                        json!({ "success": false, "error": "Only longform packages support layout presets" }),
                    );
                }
                let preset = longform_layout_preset(&preset_id);
                let target = normalize_package_html_target(
                    "article",
                    &payload_string(&payload, "target")
                        .unwrap_or_else(|| PACKAGE_HTML_LAYOUT_TARGET.to_string()),
                )?;
                let mut manifest =
                    read_json_value_or(&package_manifest_path(&full_path), json!({}));
                if let Some(object) = manifest.as_object_mut() {
                    object.insert("longformLayoutPresetId".to_string(), json!(preset.id));
                    object.insert("updatedAt".to_string(), json!(now_i64()));
                }
                write_json_value(&package_manifest_path(&full_path), &manifest)?;
                let title = manifest
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(ToString::to_string)
                    .unwrap_or_else(|| title_from_relative_path(file_name));
                let content =
                    fs::read_to_string(package_entry_path(&full_path, file_name, Some(&manifest)))
                        .unwrap_or_default();
                let html = generate_package_html_document(
                    state,
                    &full_path,
                    file_name,
                    target,
                    &title,
                    &content,
                    payload_field(&payload, "modelConfig"),
                )?;
                Ok(json!({
                    "success": true,
                    "presetId": preset.id,
                    "target": target,
                    "state": persist_package_html_document(&full_path, target, &html)?,
                }))
            }
            "manuscripts:render-richpost-pages" => {
                let file_path = payload_string(&payload, "filePath")
                    .or_else(|| payload_string(&payload, "path"))
                    .unwrap_or_default();
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
                if get_package_kind_from_file_name(file_name) != Some("post") {
                    return Ok(
                        json!({ "success": false, "error": "Only richpost packages support page plans" }),
                    );
                }
                let mut manifest =
                    read_json_value_or(&package_manifest_path(&full_path), json!({}));
                let current_typography = richpost_typography_settings_from_manifest(&manifest);
                let requested_font_scale =
                    payload_field(&payload, "fontScale").and_then(Value::as_f64);
                let requested_line_height_scale =
                    payload_field(&payload, "lineHeightScale").and_then(Value::as_f64);
                if requested_font_scale.is_some() || requested_line_height_scale.is_some() {
                    let next_typography = richpost_typography_settings(
                        requested_font_scale.or(Some(current_typography.font_scale)),
                        requested_line_height_scale.or(Some(current_typography.line_height_scale)),
                    );
                    write_richpost_typography_settings_to_manifest(&mut manifest, next_typography);
                    if let Some(object) = manifest.as_object_mut() {
                        object.insert("updatedAt".to_string(), json!(now_i64()));
                    }
                    write_json_value(&package_manifest_path(&full_path), &manifest)?;
                }
                Ok(json!({
                    "success": true,
                    "state": sync_manuscript_package_html_assets(Some(state), &full_path, file_name, None, None)?,
                }))
            }
            "manuscripts:render-package-html" => {
                let file_path = payload_string(&payload, "filePath")
                    .or_else(|| payload_string(&payload, "path"))
                    .unwrap_or_default();
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
                let package_kind = get_package_kind_from_file_name(file_name).unwrap_or("");
                let target = payload_string(&payload, "target")
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| normalize_package_html_target(package_kind, &value))
                    .transpose()?;
                Ok(json!({
                    "success": true,
                    "target": target,
                    "state": sync_manuscript_package_html_assets(
                        Some(state),
                        &full_path,
                        file_name,
                        None,
                        target,
                    )?,
                }))
            }
            "manuscripts:get-video-project-state" => {
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
                let file_name = full_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("Untitled");
                if get_package_kind_from_file_name(file_name) != Some("video") {
                    return Ok(
                        json!({ "success": false, "error": "Not a video manuscript package" }),
                    );
                }
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
                let project =
                    read_json_value_or(&package_editor_project_path(&full_path), Value::Null);
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
            }
            "manuscripts:save-video-project-brief" => {
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
                let file_name = full_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("Untitled");
                if get_package_kind_from_file_name(file_name) != Some("video") {
                    return Ok(
                        json!({ "success": false, "error": "Not a video manuscript package" }),
                    );
                }
                let brief = payload_string(&payload, "content")
                    .or_else(|| payload_string(&payload, "brief"))
                    .unwrap_or_default();
                let source =
                    payload_string(&payload, "source").unwrap_or_else(|| "user".to_string());
                let (next_state, brief_state) =
                    persist_video_project_brief(&full_path, &brief, &source)?;
                Ok(json!({
                    "success": true,
                    "brief": brief_state,
                    "project": next_state.get("videoProject").cloned().unwrap_or(Value::Null),
                    "state": next_state
                }))
            }
            "manuscripts:ffmpeg-edit" => {
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
                if get_package_kind_from_file_name(file_name) != Some("video") {
                    return Ok(json!({ "success": false, "error": "ffmpeg_edit 仅支持视频稿件" }));
                }
                let operations = payload
                    .get("operations")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if operations.is_empty() {
                    return Ok(json!({ "success": false, "error": "operations 不能为空" }));
                }
                let intent_summary = payload_string(&payload, "intentSummary")
                    .unwrap_or_else(|| "AI video edit".to_string());
                let package_state = get_manuscript_package_state(&full_path)?;
                let assets = ffmpeg_asset_items(&package_state);
                let remotion = package_state.get("remotion").cloned().unwrap_or_else(|| {
                    build_default_remotion_scene(
                        package_state
                            .pointer("/manifest/title")
                            .and_then(Value::as_str)
                            .unwrap_or("RedBox Motion"),
                        &[],
                    )
                });
                let (output_path, artifacts) =
                    execute_ffmpeg_edit_recipe(&full_path, &assets, &operations)?;
                let fallback_duration_ms = remotion
                    .pointer("/baseMedia/durationMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let duration_ms = ffmpeg_recipe_duration_ms(&operations, fallback_duration_ms);
                let source_asset_ids = ffmpeg_recipe_source_asset_ids(&operations);
                let mut next_remotion = remotion.clone();
                if let Some(object) = next_remotion.as_object_mut() {
                    object.insert("version".to_string(), json!(2));
                    object.insert("renderMode".to_string(), json!("full"));
                    object.insert(
                        "baseMedia".to_string(),
                        json!({
                            "sourceAssetIds": source_asset_ids,
                            "outputPath": output_path.display().to_string(),
                            "durationMs": duration_ms,
                            "status": "ready",
                            "updatedAt": now_i64()
                        }),
                    );
                    object.insert(
                        "ffmpegRecipe".to_string(),
                        json!({
                            "operations": operations,
                            "artifacts": artifacts,
                            "summary": intent_summary,
                            "updatedAt": now_i64()
                        }),
                    );
                    if !object.contains_key("scenes") {
                        object.insert("scenes".to_string(), json!([]));
                    }
                    if !object.contains_key("transitions") {
                        object.insert("transitions".to_string(), json!([]));
                    }
                    let fps = object
                        .get("fps")
                        .and_then(Value::as_i64)
                        .filter(|value| *value > 0)
                        .unwrap_or(30);
                    if duration_ms > 0 {
                        object.insert(
                            "durationInFrames".to_string(),
                            json!(((duration_ms as f64 / 1000.0) * fps as f64).round() as i64),
                        );
                    }
                    if let Some(scene) = object
                        .get_mut("scenes")
                        .and_then(Value::as_array_mut)
                        .and_then(|items| items.first_mut())
                        .and_then(Value::as_object_mut)
                    {
                        scene.insert("src".to_string(), json!(output_path.display().to_string()));
                        scene.insert("assetKind".to_string(), json!("video"));
                        if duration_ms > 0 {
                            scene.insert(
                                "durationInFrames".to_string(),
                                json!(((duration_ms as f64 / 1000.0) * fps as f64).round() as i64),
                            );
                        }
                    }
                }
                persist_remotion_composition_artifacts(&full_path, &next_remotion)?;
                Ok(json!({
                    "success": true,
                    "outputPath": output_path.display().to_string(),
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:get-editor-project" => {
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
                Ok(json!({
                    "success": true,
                    "project": ensure_editor_project(&full_path)?,
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:save-editor-project" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let mut project = payload_field(&payload, "project")
                    .cloned()
                    .unwrap_or(Value::Null);
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let existing_project = ensure_editor_project(&full_path)?;
                let next_script_body = project
                    .pointer("/script/body")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string);
                let existing_script_body = existing_project
                    .pointer("/script/body")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string);
                if let Some(script_body) = next_script_body.as_deref() {
                    if existing_script_body.as_deref() != Some(script_body) {
                        mark_editor_project_script_pending(&mut project, script_body, "user")?;
                    } else {
                        let _ = ensure_editor_project_ai_state(&mut project)?;
                    }
                }
                let _ = hydrate_editor_project_motion_from_remotion(&mut project, &full_path)?;
                if existing_project != project {
                    push_editor_project_undo_snapshot(state, &file_path, &existing_project)?;
                }
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                if let Some(script_body) = next_script_body.as_deref() {
                    let manifest =
                        read_json_value_or(package_manifest_path(&full_path).as_path(), json!({}));
                    let entry_path = package_entry_path(&full_path, &file_path, Some(&manifest));
                    write_text_file(&entry_path, script_body)?;
                }
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:duplicate-editor-project-clip" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
                if file_path.is_empty() || clip_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath and clipId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let mut project = ensure_editor_project(&full_path)?;
                push_editor_project_undo_snapshot(state, &file_path, &project)?;
                let items = project
                    .pointer_mut("/items")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Editor project items missing".to_string())?;
                let Some(source_item) = items
                    .iter()
                    .find(|item| item.get("id").and_then(Value::as_str) == Some(clip_id.as_str()))
                    .cloned()
                else {
                    return Ok(
                        json!({ "success": false, "error": "Clip not found in editor project" }),
                    );
                };
                let mut duplicate = source_item;
                let from_ms = payload_field(&payload, "fromMs")
                    .and_then(Value::as_i64)
                    .unwrap_or_else(|| {
                        duplicate.get("fromMs").and_then(Value::as_i64).unwrap_or(0)
                            + duplicate
                                .get("durationMs")
                                .and_then(Value::as_i64)
                                .unwrap_or(0)
                    });
                if let Some(object) = duplicate.as_object_mut() {
                    object.insert("id".to_string(), json!(create_timeline_clip_id()));
                    object.insert("fromMs".to_string(), json!(from_ms.max(0)));
                    if let Some(track_id) = payload_string(&payload, "trackId") {
                        object.insert("trackId".to_string(), json!(track_id));
                    }
                }
                items.push(duplicate);
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:replace-editor-project-clip-asset" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
                let asset_id = payload_string(&payload, "assetId").unwrap_or_default();
                if file_path.is_empty() || clip_id.is_empty() || asset_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath, clipId, and assetId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let mut project = ensure_editor_project(&full_path)?;
                push_editor_project_undo_snapshot(state, &file_path, &project)?;
                let items = project
                    .pointer_mut("/items")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Editor project items missing".to_string())?;
                let Some(target_item) = items
                    .iter_mut()
                    .find(|item| item.get("id").and_then(Value::as_str) == Some(clip_id.as_str()))
                else {
                    return Ok(
                        json!({ "success": false, "error": "Clip not found in editor project" }),
                    );
                };
                if let Some(object) = target_item.as_object_mut() {
                    object.insert("assetId".to_string(), json!(asset_id));
                }
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:add-editor-project-marker" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut project = ensure_editor_project(&full_path)?;
                push_editor_project_undo_snapshot(state, &file_path, &project)?;
                let markers = project
                    .as_object_mut()
                    .ok_or_else(|| "Editor project malformed".to_string())?
                    .entry("markers".to_string())
                    .or_insert_with(|| json!([]));
                let markers = markers
                    .as_array_mut()
                    .ok_or_else(|| "Editor project markers malformed".to_string())?;
                markers.push(json!({
                    "id": make_id("marker"),
                    "frame": payload_field(&payload, "frame").and_then(Value::as_i64).unwrap_or(0).max(0),
                    "color": payload_string(&payload, "color").unwrap_or_else(|| "#3B82F6".to_string()),
                    "label": payload_string(&payload, "label").unwrap_or_default(),
                }));
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:update-editor-project-marker" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let marker_id = payload_string(&payload, "markerId").unwrap_or_default();
                if file_path.is_empty() || marker_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath and markerId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut project = ensure_editor_project(&full_path)?;
                push_editor_project_undo_snapshot(state, &file_path, &project)?;
                let markers = project
                    .as_object_mut()
                    .and_then(|object| object.get_mut("markers"))
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Editor project markers missing".to_string())?;
                let Some(marker) = markers.iter_mut().find(|item| {
                    item.get("id").and_then(Value::as_str) == Some(marker_id.as_str())
                }) else {
                    return Ok(
                        json!({ "success": false, "error": "Marker not found in editor project" }),
                    );
                };
                if let Some(object) = marker.as_object_mut() {
                    if let Some(frame) = payload_field(&payload, "frame").and_then(Value::as_i64) {
                        object.insert("frame".to_string(), json!(frame.max(0)));
                    }
                    if let Some(color) = payload_string(&payload, "color") {
                        object.insert("color".to_string(), json!(color));
                    }
                    if let Some(label) = payload_string(&payload, "label") {
                        object.insert("label".to_string(), json!(label));
                    }
                }
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:delete-editor-project-marker" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let marker_id = payload_string(&payload, "markerId").unwrap_or_default();
                if file_path.is_empty() || marker_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath and markerId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut project = ensure_editor_project(&full_path)?;
                push_editor_project_undo_snapshot(state, &file_path, &project)?;
                let markers = project
                    .as_object_mut()
                    .and_then(|object| object.get_mut("markers"))
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Editor project markers missing".to_string())?;
                let before = markers.len();
                markers.retain(|marker| {
                    marker.get("id").and_then(Value::as_str) != Some(marker_id.as_str())
                });
                if before == markers.len() {
                    return Ok(
                        json!({ "success": false, "error": "Marker not found in editor project" }),
                    );
                }
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:undo-editor-project" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                restore_editor_project_from_history(state, &file_path, &full_path, "undo")
            }
            "manuscripts:redo-editor-project" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                restore_editor_project_from_history(state, &file_path, &full_path, "redo")
            }
            "manuscripts:import-legacy-editor-project" => {
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
                let project = build_editor_project_from_legacy(&full_path, file_name)?;
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:apply-editor-commands" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let commands = payload_field(&payload, "commands")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let mut project = ensure_editor_project(&full_path)?;
                apply_editor_commands(&mut project, &commands)?;
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:generate-motion-items" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let instructions = payload_string(&payload, "instructions").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let selected_item_ids = payload_field(&payload, "selectedItemIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let mut project = ensure_editor_project(&full_path)?;
                let (motion_items, brief) = generate_motion_items_for_project(
                    state,
                    &project,
                    &instructions,
                    &selected_item_ids,
                    payload_field(&payload, "modelConfig"),
                )?;
                ensure_motion_track(&mut project)?;
                let target_bind_ids = motion_items
                    .iter()
                    .filter_map(|item| {
                        item.get("bindItemId")
                            .and_then(|value| value.as_str())
                            .map(ToString::to_string)
                    })
                    .collect::<Vec<_>>();
                editor_project_items_mut(&mut project)?.retain(|item| {
                    if item.get("type").and_then(|value| value.as_str()) != Some("motion") {
                        return true;
                    }
                    let bind_item_id = item
                        .get("bindItemId")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !target_bind_ids.iter().any(|value| value == bind_item_id)
                });
                editor_project_items_mut(&mut project)?.extend(motion_items.clone());
                if let Some(ai) = project.get_mut("ai").and_then(Value::as_object_mut) {
                    ai.insert("lastMotionBrief".to_string(), json!(brief.clone()));
                    ai.insert("motionPrompt".to_string(), json!(instructions));
                }
                write_json_value(&package_editor_project_path(&full_path), &project)?;
                Ok(json!({
                    "success": true,
                    "brief": brief,
                    "items": motion_items,
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:generate-editor-commands" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let instructions = payload_string(&payload, "instructions").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let project = ensure_editor_project(&full_path)?;
                let (commands, brief) = generate_editor_commands_for_project(
                    state,
                    &project,
                    &instructions,
                    payload_field(&payload, "modelConfig"),
                )?;
                Ok(json!({
                    "success": true,
                    "brief": brief,
                    "commands": commands
                }))
            }
            "manuscripts:get-package-script-state" => {
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
                if get_package_kind_from_file_name(file_name) == Some("video") {
                    let manifest =
                        read_json_value_or(&package_manifest_path(&full_path), json!({}));
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
            }
            "manuscripts:update-package-script" => {
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
                let (next_state, script_state) = persist_package_script_body(
                    state, &full_path, file_name, &content, None, &source,
                )?;
                Ok(json!({
                    "success": true,
                    "state": next_state,
                    "script": script_state
                }))
            }
            "manuscripts:confirm-package-script" => {
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
                if get_package_kind_from_file_name(file_name) == Some("video") {
                    let mut manifest =
                        read_json_value_or(&package_manifest_path(&full_path), json!({}));
                    let approval = confirm_manifest_video_script(&mut manifest)?;
                    write_json_value(&package_manifest_path(&full_path), &manifest)?;
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
                Ok(json!({
                    "success": true,
                    "script": package_script_state_value(&project),
                    "approval": approval,
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:transcribe-package-subtitles" => {
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

                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
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
                                    let kind =
                                        track.get("kind").and_then(Value::as_str).unwrap_or("");
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
            }
            "manuscripts:get-editor-runtime-state" => {
                let file_path = payload_value_as_string(&payload)
                    .or_else(|| payload_string(&payload, "filePath"))
                    .unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                Ok(json!({
                    "success": true,
                    "state": editor_runtime_state_value(state, &file_path)?
                }))
            }
            "manuscripts:get-remotion-context" => {
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
                Ok(json!({
                    "success": true,
                    "state": remotion_context_value(state, &full_path, &file_path)?
                }))
            }
            "manuscripts:update-editor-runtime-state" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let mut guard = state
                    .editor_runtime_states
                    .lock()
                    .map_err(|_| "editor runtime state lock 已损坏".to_string())?;
                let previous = guard.get(&file_path).cloned();
                let updated_at = now_ms();
                guard.insert(
                    file_path.clone(),
                    EditorRuntimeStateRecord {
                        file_path: file_path.clone(),
                        session_id: payload_string(&payload, "sessionId"),
                        playhead_seconds: payload_field(&payload, "playheadSeconds")
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                        selected_clip_id: payload_string(&payload, "selectedClipId"),
                        selected_clip_ids: payload_field(&payload, "selectedClipIds")
                            .cloned()
                            .or_else(|| {
                                previous
                                    .as_ref()
                                    .and_then(|record| record.selected_clip_ids.clone())
                            }),
                        active_track_id: payload_string(&payload, "activeTrackId"),
                        selected_track_ids: payload_field(&payload, "selectedTrackIds")
                            .cloned()
                            .or_else(|| {
                                previous
                                    .as_ref()
                                    .and_then(|record| record.selected_track_ids.clone())
                            }),
                        selected_scene_id: payload_string(&payload, "selectedSceneId"),
                        preview_tab: payload_string(&payload, "previewTab"),
                        canvas_ratio_preset: payload_string(&payload, "canvasRatioPreset"),
                        active_panel: payload_string(&payload, "activePanel"),
                        drawer_panel: payload_string(&payload, "drawerPanel"),
                        scene_item_transforms: payload_field(&payload, "sceneItemTransforms")
                            .cloned(),
                        scene_item_visibility: payload_field(&payload, "sceneItemVisibility")
                            .cloned(),
                        scene_item_order: payload_field(&payload, "sceneItemOrder").cloned(),
                        scene_item_locks: payload_field(&payload, "sceneItemLocks").cloned(),
                        scene_item_groups: payload_field(&payload, "sceneItemGroups").cloned(),
                        focused_group_id: payload_string(&payload, "focusedGroupId"),
                        track_ui: payload_field(&payload, "trackUi").cloned(),
                        viewport_scroll_left: payload_field(&payload, "viewportScrollLeft")
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                        viewport_max_scroll_left: payload_field(&payload, "viewportMaxScrollLeft")
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                        viewport_scroll_top: payload_field(&payload, "viewportScrollTop")
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                        viewport_max_scroll_top: payload_field(&payload, "viewportMaxScrollTop")
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                        timeline_zoom_percent: payload_field(&payload, "timelineZoomPercent")
                            .and_then(|value| value.as_f64())
                            .unwrap_or(100.0),
                        undo_stack: previous
                            .as_ref()
                            .map(|record| record.undo_stack.clone())
                            .unwrap_or_default(),
                        redo_stack: previous
                            .as_ref()
                            .map(|record| record.redo_stack.clone())
                            .unwrap_or_default(),
                        updated_at,
                    },
                );
                drop(guard);
                Ok(json!({
                    "success": true,
                    "state": editor_runtime_state_value(state, &file_path)?
                }))
            }
            "manuscripts:update-package-track-ui" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let track_ui = payload_field(&payload, "trackUi")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                write_json_value(&package_track_ui_path(&full_path), &track_ui)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:update-package-scene-ui" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let scene_ui = payload_field(&payload, "sceneUi")
                    .cloned()
                    .unwrap_or_else(|| {
                        json!({
                            "itemVisibility": {},
                            "itemOrder": [],
                            "itemLocks": {},
                            "itemGroups": {},
                            "focusedGroupId": Value::Null
                        })
                    });
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                write_json_value(&package_scene_ui_path(&full_path), &scene_ui)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:add-package-track" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let kind = payload_string(&payload, "kind").unwrap_or_else(|| "video".to_string());
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let (prefix, kind_label) = match kind.as_str() {
                    "audio" => ("A", "Audio"),
                    "subtitle" | "caption" | "text" => ("S", "Subtitle"),
                    _ => ("V", "Video"),
                };
                let existing_indexes = timeline
                    .pointer("/tracks/children")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|track| {
                        track
                            .get("name")
                            .and_then(|value| value.as_str())
                            .map(ToString::to_string)
                    })
                    .filter(|name| name.starts_with(prefix))
                    .filter_map(|name| name[1..].parse::<i64>().ok())
                    .collect::<Vec<_>>();
                let next_index = existing_indexes.into_iter().max().unwrap_or(0) + 1;
                let _ = ensure_timeline_track(
                    &mut timeline,
                    &format!("{prefix}{next_index}"),
                    kind_label,
                );
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:delete-package-track" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let track_id = payload_string(&payload, "trackId").unwrap_or_default();
                if file_path.is_empty() || track_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath and trackId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let tracks = timeline
                    .pointer_mut("/tracks/children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline tracks missing".to_string())?;
                let Some(track_index) = tracks.iter().position(|track| {
                    track
                        .get("name")
                        .and_then(|value| value.as_str())
                        .map(|value| value == track_id)
                        .unwrap_or(false)
                }) else {
                    return Ok(json!({ "success": false, "error": "Track not found in timeline" }));
                };
                let track_kind = timeline_track_kind(&track_id);
                let same_kind_count = tracks
                    .iter()
                    .filter(|track| {
                        track
                            .get("name")
                            .and_then(|value| value.as_str())
                            .map(timeline_track_kind)
                            .unwrap_or("Video")
                            == track_kind
                    })
                    .count();
                if same_kind_count <= 1 {
                    return Ok(
                        json!({ "success": false, "error": "At least one track per media kind must remain" }),
                    );
                }
                let has_children = tracks[track_index]
                    .get("children")
                    .and_then(Value::as_array)
                    .map(|children| !children.is_empty())
                    .unwrap_or(false);
                if has_children {
                    return Ok(
                        json!({ "success": false, "error": "Only empty tracks can be deleted" }),
                    );
                }
                tracks.remove(track_index);
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:move-package-track" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let track_id = payload_string(&payload, "trackId").unwrap_or_default();
                let direction =
                    payload_string(&payload, "direction").unwrap_or_else(|| "up".to_string());
                if file_path.is_empty() || track_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath and trackId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let tracks = timeline
                    .pointer_mut("/tracks/children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline tracks missing".to_string())?;
                let Some(track_index) = tracks.iter().position(|track| {
                    track
                        .get("name")
                        .and_then(|value| value.as_str())
                        .map(|value| value == track_id)
                        .unwrap_or(false)
                }) else {
                    return Ok(json!({ "success": false, "error": "Track not found in timeline" }));
                };
                let target_index = if direction == "down" {
                    (track_index + 1).min(tracks.len().saturating_sub(1))
                } else {
                    track_index.saturating_sub(1)
                };
                if target_index == track_index {
                    return Ok(
                        json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }),
                    );
                }
                let track = tracks.remove(track_index);
                tracks.insert(target_index, track);
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:add-package-clip" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let asset_id = payload_string(&payload, "assetId").unwrap_or_default();
                if file_path.is_empty() || asset_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath and assetId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let asset = with_store(state, |store| {
                    Ok(store
                        .media_assets
                        .iter()
                        .find(|item| item.id == asset_id)
                        .cloned())
                })?;
                let Some(asset) = asset else {
                    return Ok(json!({ "success": false, "error": "Media asset not found" }));
                };
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let preferred_track_name = payload_string(&payload, "track")
                    .unwrap_or_else(|| default_track_name_for_asset(&asset).to_string());
                let kind_label = if preferred_track_name.starts_with('A') {
                    "Audio"
                } else {
                    "Video"
                };
                let target_track =
                    ensure_timeline_track(&mut timeline, &preferred_track_name, kind_label);
                let target_children = target_track
                    .get_mut("children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline track children missing".to_string())?;
                let desired_order = payload_field(&payload, "order")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(target_children.len() as i64)
                    .clamp(0, target_children.len() as i64)
                    as usize;
                let clip = build_timeline_clip_from_asset(
                    &asset,
                    desired_order,
                    payload_field(&payload, "durationMs").and_then(|value| value.as_i64()),
                );
                let inserted_clip_id = clip
                    .get("metadata")
                    .and_then(|value| value.get("clipId"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
                target_children.insert(desired_order, clip);
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                ensure_package_asset_entry(&full_path, &asset, None, None, None)?;
                Ok(json!({
                    "success": true,
                    "insertedClipId": inserted_clip_id,
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:attach-package-file" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let source_path = payload_string(&payload, "sourcePath").unwrap_or_default();
                if file_path.is_empty() || source_path.is_empty() {
                    return Ok(json!({
                        "success": false,
                        "error": "filePath and sourcePath are required"
                    }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir()
                    || !is_manuscript_package_name(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or(""),
                    )
                {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let source = std::path::PathBuf::from(source_path.trim());
                if !source.exists() || !source.is_file() {
                    return Ok(json!({ "success": false, "error": "Source file not found" }));
                }
                let package_asset_kind = normalize_video_project_asset_kind(
                    payload_string(&payload, "kind").as_deref(),
                )?;
                let label = payload_string(&payload, "label");
                let role = payload_string(&payload, "role");
                let imports_root = media_root(state)?.join("imports");
                fs::create_dir_all(&imports_root).map_err(|error| error.to_string())?;
                let (relative_name, target) = copy_file_into_dir(&source, &imports_root)?;
                let (mime_type, _kind, _) = guess_mime_and_kind(&target);
                let asset = with_store_mut(state, |store| {
                    let asset = MediaAssetRecord {
                        id: make_id("media"),
                        source: "imported".to_string(),
                        source_domain: None,
                        source_link: None,
                        project_id: None,
                        title: source
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
                        relative_path: Some(format!("imports/{}", relative_name)),
                        bound_manuscript_path: Some(file_path.clone()),
                        created_at: now_rfc3339(),
                        updated_at: now_rfc3339(),
                        absolute_path: Some(target.display().to_string()),
                        preview_url: Some(file_url_for_path(&target)),
                        exists: true,
                    };
                    store.media_assets.push(asset.clone());
                    Ok(asset)
                })?;
                persist_media_workspace_catalog(state)?;
                ensure_package_asset_entry(
                    &full_path,
                    &asset,
                    package_asset_kind.as_deref(),
                    label.as_deref(),
                    role.as_deref(),
                )?;
                Ok(json!({
                    "success": true,
                    "asset": {
                        "id": asset.id,
                        "title": asset.title,
                        "mimeType": asset.mime_type,
                        "relativePath": asset.relative_path,
                        "absolutePath": asset.absolute_path,
                        "previewUrl": asset.preview_url,
                        "kind": package_asset_kind,
                        "label": label,
                        "role": role
                    },
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:insert-package-subtitle-at-playhead" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let playhead_seconds = editor_runtime_state_record(state, &file_path)?
                    .map(|record| record.playhead_seconds)
                    .unwrap_or(0.0)
                    .max(0.0);
                let playhead_ms = (playhead_seconds * 1000.0).round() as i64;

                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let preferred_track_name = payload_string(&payload, "track")
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| {
                        timeline
                            .pointer("/tracks/children")
                            .and_then(Value::as_array)
                            .and_then(|tracks| {
                                tracks
                                    .iter()
                                    .filter_map(|track| {
                                        track
                                            .get("name")
                                            .and_then(|value| value.as_str())
                                            .map(ToString::to_string)
                                    })
                                    .filter(|name| name.starts_with('S'))
                                    .last()
                            })
                            .unwrap_or_else(|| "S1".to_string())
                    });
                let target_track =
                    ensure_timeline_track(&mut timeline, &preferred_track_name, "Subtitle");
                let target_children = target_track
                    .get_mut("children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline track children missing".to_string())?;

                let mut desired_order = target_children.len();
                if let Some(order) =
                    payload_field(&payload, "order").and_then(|value| value.as_i64())
                {
                    desired_order = order.clamp(0, target_children.len() as i64) as usize;
                } else {
                    let mut cursor_ms = 0_i64;
                    for (index, clip) in target_children.iter().enumerate() {
                        let next_cursor_ms = cursor_ms + timeline_clip_duration_ms(clip);
                        if playhead_ms <= cursor_ms {
                            desired_order = index;
                            break;
                        }
                        desired_order = index + 1;
                        cursor_ms = next_cursor_ms;
                        if playhead_ms < next_cursor_ms {
                            break;
                        }
                    }
                }

                let clip = build_timeline_subtitle_clip(
                    desired_order,
                    &payload_string(&payload, "text").unwrap_or_default(),
                    payload_field(&payload, "durationMs").and_then(|value| value.as_i64()),
                );
                let inserted_clip_id = clip
                    .get("metadata")
                    .and_then(|value| value.get("clipId"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
                target_children.insert(desired_order.min(target_children.len()), clip);
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({
                    "success": true,
                    "insertedClipId": inserted_clip_id,
                    "playheadSeconds": playhead_seconds,
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:insert-package-clip-at-playhead" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let asset_id = payload_string(&payload, "assetId").unwrap_or_default();
                if file_path.is_empty() || asset_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath and assetId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let asset = with_store(state, |store| {
                    Ok(store
                        .media_assets
                        .iter()
                        .find(|item| item.id == asset_id)
                        .cloned())
                })?;
                let Some(asset) = asset else {
                    return Ok(json!({ "success": false, "error": "Media asset not found" }));
                };

                let playhead_seconds = editor_runtime_state_record(state, &file_path)?
                    .map(|record| record.playhead_seconds)
                    .unwrap_or(0.0)
                    .max(0.0);
                let playhead_ms = (playhead_seconds * 1000.0).round() as i64;

                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let requested_track = payload_string(&payload, "track")
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());
                let default_track_name = default_track_name_for_asset(&asset).to_string();
                let track_prefix = if default_track_name.starts_with('A') {
                    'A'
                } else {
                    'V'
                };
                let preferred_track_name = requested_track.unwrap_or_else(|| {
                    timeline
                        .pointer("/tracks/children")
                        .and_then(Value::as_array)
                        .and_then(|tracks| {
                            tracks
                                .iter()
                                .filter_map(|track| {
                                    track
                                        .get("name")
                                        .and_then(|value| value.as_str())
                                        .map(ToString::to_string)
                                })
                                .filter(|name| name.starts_with(track_prefix))
                                .last()
                        })
                        .unwrap_or(default_track_name)
                });
                let kind_label = if preferred_track_name.starts_with('A') {
                    "Audio"
                } else {
                    "Video"
                };
                let target_track =
                    ensure_timeline_track(&mut timeline, &preferred_track_name, kind_label);
                let target_children = target_track
                    .get_mut("children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline track children missing".to_string())?;

                let mut desired_order = target_children.len();
                let mut split_target: Option<(usize, f64)> = None;
                if let Some(order) =
                    payload_field(&payload, "order").and_then(|value| value.as_i64())
                {
                    desired_order = order.clamp(0, target_children.len() as i64) as usize;
                } else {
                    let mut cursor_ms = 0_i64;
                    for (index, clip) in target_children.iter().enumerate() {
                        let next_cursor_ms = cursor_ms + timeline_clip_duration_ms(clip);
                        if playhead_ms > cursor_ms && playhead_ms < next_cursor_ms {
                            let duration_ms = (next_cursor_ms - cursor_ms).max(1000);
                            let split_ratio = ((playhead_ms - cursor_ms) as f64
                                / duration_ms as f64)
                                .clamp(0.1, 0.9);
                            split_target = Some((index, split_ratio));
                            desired_order = index + 1;
                            break;
                        }
                        if playhead_ms <= cursor_ms {
                            desired_order = index;
                            break;
                        }
                        desired_order = index + 1;
                        cursor_ms = next_cursor_ms;
                    }
                }

                if let Some((split_index, split_ratio)) = split_target {
                    let original_clip = target_children.remove(split_index);
                    let original_clip_id =
                        timeline_clip_identity(&original_clip, &preferred_track_name, split_index);
                    let (first_clip, second_clip) =
                        split_timeline_clip_value(&original_clip, &original_clip_id, split_ratio);
                    target_children.insert(split_index, first_clip);
                    target_children.insert(split_index + 1, second_clip);
                }

                let clip = build_timeline_clip_from_asset(
                    &asset,
                    desired_order,
                    payload_field(&payload, "durationMs").and_then(|value| value.as_i64()),
                );
                let inserted_clip_id = clip
                    .get("metadata")
                    .and_then(|value| value.get("clipId"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
                let safe_order = desired_order.min(target_children.len());
                target_children.insert(safe_order, clip);
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                ensure_package_asset_entry(&full_path, &asset, None, None, None)?;
                Ok(json!({
                    "success": true,
                    "insertedClipId": inserted_clip_id,
                    "playheadSeconds": playhead_seconds,
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:insert-package-text-at-playhead" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let playhead_seconds = editor_runtime_state_record(state, &file_path)?
                    .map(|record| record.playhead_seconds)
                    .unwrap_or(0.0)
                    .max(0.0);
                let playhead_ms = (playhead_seconds * 1000.0).round() as i64;

                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let preferred_track_name = payload_string(&payload, "track")
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| {
                        timeline
                            .pointer("/tracks/children")
                            .and_then(Value::as_array)
                            .and_then(|tracks| {
                                tracks
                                    .iter()
                                    .filter_map(|track| {
                                        track
                                            .get("name")
                                            .and_then(|value| value.as_str())
                                            .map(ToString::to_string)
                                    })
                                    .filter(|name| name.starts_with('T'))
                                    .last()
                            })
                            .unwrap_or_else(|| "T1".to_string())
                    });
                let target_track =
                    ensure_timeline_track(&mut timeline, &preferred_track_name, "Subtitle");
                let target_children = target_track
                    .get_mut("children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline track children missing".to_string())?;

                let mut desired_order = target_children.len();
                let mut cursor_ms = 0_i64;
                for (index, clip) in target_children.iter().enumerate() {
                    let next_cursor_ms = cursor_ms + timeline_clip_duration_ms(clip);
                    if playhead_ms <= cursor_ms {
                        desired_order = index;
                        break;
                    }
                    desired_order = index + 1;
                    cursor_ms = next_cursor_ms;
                    if playhead_ms < next_cursor_ms {
                        break;
                    }
                }

                let mut clip = build_timeline_text_clip(
                    desired_order,
                    &payload_string(&payload, "text").unwrap_or_default(),
                    payload_field(&payload, "durationMs").and_then(|value| value.as_i64()),
                );
                if let Some(text_style) = payload_field(&payload, "textStyle").cloned() {
                    if let Some(metadata) = clip.get_mut("metadata").and_then(Value::as_object_mut)
                    {
                        metadata.insert("textStyle".to_string(), text_style);
                    }
                }
                let inserted_clip_id = clip
                    .get("metadata")
                    .and_then(|value| value.get("clipId"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
                target_children.insert(desired_order.min(target_children.len()), clip);
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({
                    "success": true,
                    "insertedClipId": inserted_clip_id,
                    "playheadSeconds": playhead_seconds,
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:attach-external-files" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir()
                    || !is_manuscript_package_name(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or(""),
                    )
                {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let package_kind = full_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .and_then(get_package_kind_from_file_name)
                    .unwrap_or("article");
                let picked = pick_files_native("选择要导入的素材文件", false, true)?;
                if picked.is_empty() {
                    return Ok(json!({ "success": true, "canceled": true, "imported": [] }));
                }
                let imports_root = media_root(state)?.join("imports");
                fs::create_dir_all(&imports_root).map_err(|error| error.to_string())?;
                let mut imported = Vec::<Value>::new();
                for file in picked {
                    let (relative_name, target) = copy_file_into_dir(&file, &imports_root)?;
                    let (mime_type, _kind, _) = guess_mime_and_kind(&target);
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
                            relative_path: Some(format!("imports/{}", relative_name)),
                            bound_manuscript_path: Some(file_path.clone()),
                            created_at: now_rfc3339(),
                            updated_at: now_rfc3339(),
                            absolute_path: Some(target.display().to_string()),
                            preview_url: Some(file_url_for_path(&target)),
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
            }
            "manuscripts:update-package-clip" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
                if file_path.is_empty() || clip_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath and clipId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let tracks = timeline
                    .pointer_mut("/tracks/children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline tracks missing".to_string())?;
                let mut clip_to_move: Option<Value> = None;
                let mut current_track_index = 0usize;
                for (track_index, track) in tracks.iter_mut().enumerate() {
                    let track_name = track
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    let Some(children) = track.get_mut("children").and_then(Value::as_array_mut)
                    else {
                        continue;
                    };
                    if let Some(index) = children
                        .iter()
                        .position(|clip| timeline_clip_identity(clip, &track_name, 0) == clip_id)
                    {
                        clip_to_move = Some(children.remove(index));
                        current_track_index = track_index;
                        break;
                    }
                }
                let Some(mut clip) = clip_to_move else {
                    return Ok(json!({ "success": false, "error": "Clip not found in timeline" }));
                };
                let target_track_name = payload_string(&payload, "track").unwrap_or_else(|| {
                    tracks[current_track_index]
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("V1")
                        .to_string()
                });
                let target_track = ensure_timeline_track(
                    &mut timeline,
                    &target_track_name,
                    if target_track_name.starts_with('A') {
                        "Audio"
                    } else {
                        "Video"
                    },
                );
                let target_children = target_track
                    .get_mut("children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline target children missing".to_string())?;
                let desired_order = payload_field(&payload, "order")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(target_children.len() as i64)
                    .clamp(0, target_children.len() as i64)
                    as usize;
                if let Some(metadata) = clip.get_mut("metadata").and_then(Value::as_object_mut) {
                    metadata.insert("clipId".to_string(), json!(clip_id));
                    if let Some(duration_ms) = payload_field(&payload, "durationMs") {
                        metadata.insert("durationMs".to_string(), duration_ms.clone());
                    }
                    if let Some(trim_in_ms) = payload_field(&payload, "trimInMs") {
                        metadata.insert("trimInMs".to_string(), trim_in_ms.clone());
                    }
                    if let Some(trim_out_ms) = payload_field(&payload, "trimOutMs") {
                        metadata.insert("trimOutMs".to_string(), trim_out_ms.clone());
                    }
                    if let Some(enabled) = payload_field(&payload, "enabled") {
                        metadata.insert("enabled".to_string(), enabled.clone());
                    }
                    if let Some(asset_kind) = payload_field(&payload, "assetKind") {
                        metadata.insert("assetKind".to_string(), asset_kind.clone());
                    }
                    if let Some(subtitle_style) = payload_field(&payload, "subtitleStyle") {
                        metadata.insert("subtitleStyle".to_string(), subtitle_style.clone());
                    }
                    if let Some(text_style) = payload_field(&payload, "textStyle") {
                        metadata.insert("textStyle".to_string(), text_style.clone());
                    }
                    if let Some(transition_style) = payload_field(&payload, "transitionStyle") {
                        metadata.insert("transitionStyle".to_string(), transition_style.clone());
                    }
                }
                if let Some(name) = payload_string(&payload, "name") {
                    if let Some(object) = clip.as_object_mut() {
                        object.insert("name".to_string(), json!(name));
                    }
                }
                target_children.insert(desired_order, clip);
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:delete-package-clip" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let tracks = timeline
                    .pointer_mut("/tracks/children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline tracks missing".to_string())?;
                let mut removed = false;
                for track in tracks.iter_mut() {
                    let track_name = track
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    if let Some(children) = track.get_mut("children").and_then(Value::as_array_mut)
                    {
                        let before = children.len();
                        children
                            .retain(|clip| timeline_clip_identity(clip, &track_name, 0) != clip_id);
                        if before != children.len() {
                            removed = true;
                        }
                    }
                }
                if !removed {
                    return Ok(json!({ "success": false, "error": "Clip not found in timeline" }));
                }
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:split-package-clip" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
                let split_ratio = payload_field(&payload, "splitRatio")
                    .and_then(|value| value.as_f64())
                    .unwrap_or(0.5)
                    .clamp(0.1, 0.9);
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let tracks = timeline
                    .pointer_mut("/tracks/children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline tracks missing".to_string())?;
                let mut split_done = false;
                for track in tracks.iter_mut() {
                    let track_name = track
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    let Some(children) = track.get_mut("children").and_then(Value::as_array_mut)
                    else {
                        continue;
                    };
                    let mut next_children = Vec::new();
                    for clip in children.iter() {
                        let mut clip_value = clip.clone();
                        next_children.push(clip_value.clone());
                        if timeline_clip_identity(clip, &track_name, 0) != clip_id {
                            continue;
                        }
                        let min_duration =
                            min_clip_duration_ms_for_asset_kind(&timeline_clip_asset_kind(clip));
                        let current_duration = timeline_clip_duration_ms(clip);
                        let first_duration =
                            ((current_duration as f64) * split_ratio).round() as i64;
                        let first_duration = first_duration.max(min_duration);
                        let second_duration = (current_duration - first_duration).max(min_duration);
                        if let Some(obj) = clip_value
                            .get_mut("metadata")
                            .and_then(Value::as_object_mut)
                        {
                            obj.insert("clipId".to_string(), json!(clip_id.clone()));
                            obj.insert("durationMs".to_string(), json!(first_duration));
                        }
                        if let Some(last) = next_children.last_mut() {
                            *last = clip_value.clone();
                        }
                        let mut new_clip = clip.clone();
                        if let Some(obj) =
                            new_clip.get_mut("metadata").and_then(Value::as_object_mut)
                        {
                            let trim_in = obj.get("trimInMs").and_then(|v| v.as_i64()).unwrap_or(0);
                            obj.insert("clipId".to_string(), json!(create_timeline_clip_id()));
                            obj.insert("durationMs".to_string(), json!(second_duration));
                            obj.insert("trimInMs".to_string(), json!(trim_in + first_duration));
                        }
                        next_children.push(new_clip);
                        split_done = true;
                    }
                    *children = next_children;
                    if split_done {
                        break;
                    }
                }
                if !split_done {
                    return Ok(json!({ "success": false, "error": "Clip not found in timeline" }));
                }
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:save-remotion-scene" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let package_state = get_manuscript_package_state(&full_path)?;
                let title = package_state
                    .pointer("/manifest/title")
                    .and_then(|value| value.as_str())
                    .unwrap_or("RedBox Motion")
                    .to_string();
                let clips = package_state
                    .pointer("/timelineSummary/clips")
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
                let existing_scene = package_state
                    .get("remotion")
                    .cloned()
                    .unwrap_or_else(|| build_default_remotion_scene(&title, &clips));
                let raw_scene = payload_field(&payload, "scene")
                    .cloned()
                    .unwrap_or(Value::Null);
                let merged_scene = merge_remotion_scene_patch(&existing_scene, &raw_scene);
                let normalized =
                    normalize_ai_remotion_scene(&merged_scene, &existing_scene, &clips, &title);
                persist_remotion_composition_artifacts(&full_path, &normalized)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:generate-remotion-scene" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let instructions = payload_string(&payload, "instructions").unwrap_or_default();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let package_state = get_manuscript_package_state(&full_path)?;
                let title = package_state
                    .pointer("/manifest/title")
                    .and_then(|value| value.as_str())
                    .unwrap_or("RedBox Motion")
                    .to_string();
                let clips = package_state
                    .pointer("/timelineSummary/clips")
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
                let remotion_context = remotion_context_value(state, &full_path, &file_path)?;
                let fallback = package_state
                    .get("remotion")
                    .cloned()
                    .unwrap_or_else(|| build_default_remotion_scene(&title, &clips));
                let prompt = format!(
                    "请基于当前视频脚本、时间线和当前 Remotion 工程状态，为 RedBox 设计一份 Remotion JSON 动画方案。\n\
要求：\n\
1. 一个视频工程对应一个 Remotion 工程文件；默认只维护一个主 scene（通常就是 scene-1），后续动画默认都加到这个 scene 里，而不是按底层片段数量机械拆多个场景。\n\
2. 先确定动画主体元素，再设计动画表达。像“苹果下落”必须先落成一个 element，例如 `shape=apple`，再给它配置 `fall-bounce` 等动画；不要退化成说明性文字。\n\
3. 只有当脚本明确要求动画跟随某个现有镜头时，才填写 clipId / assetId；否则它们保持为空，让动画独立存在于默认 scene / M1 动画轨道。\n\
4. Remotion 的时序是按帧控制的；请用 durationInFrames 和 overlay.startFrame / overlay.durationInFrames 表达节奏，不要描述宿主不存在的自由动画系统。\n\
5. 每个场景内部等价于一个 Sequence，overlay.startFrame + overlay.durationInFrames 必须落在该场景 durationInFrames 之内。\n\
6. 如需真正的对象动画（例如苹果掉落、图形弹跳、logo reveal），优先使用 scenes[].entities[]，不要退化成说明性文字。\n\
7. entities 支持 text / shape / image / svg / video / group；shape 优先使用 rect / circle / apple。\n\
8. 对象动画优先用 entities[].animations[] 表达，例如 fall-bounce、slide-in-left、pop、fade-in。\n\
9. 不要通过文字轨道片段模拟动画；动画只能体现在 Remotion scene / M1 动画轨道。\n\
10. 不要修改 src / assetKind / trimInFrames，这些字段由宿主兜底；如果是独立动画层，src 可以为空。\n\
11. 默认只生成动画主体本身；如果脚本没有明确要求标题、字幕、说明或其他屏幕文字，请把 overlayTitle / overlayBody 设为 null，overlays 设为空数组。\n\
12. 只有当脚本明确要求屏幕文字时，才使用 overlayTitle / overlayBody / overlays 或 text entity；不要自动补顶部标题或底部说明。\n\
13. entities 默认使用 `positionMode=\"canvas-space\"`；如果任务明确要求与视频中已有元素精准对位，才使用 `positionMode=\"video-space\"`，并同时提供 `referenceWidth` / `referenceHeight`，其基准应与 baseMedia 一致。\n\
14. `x` / `y` 表示实体最终停留位置的左上角坐标，不是中心点坐标；如果需要水平居中，必须按 `(referenceWidth - width) / 2` 计算。\n\
15. `fall-bounce` 的 `params.fromY` / `params.floorY` 是相对位移，不是绝对位置；常规下落动画应把实体最终落点写在 `entity.y`，并把 `floorY` 设为 `0`。\n\
16. 如果对象需要跨越较大画面范围运动，位移幅度必须与 `referenceHeight` / `referenceWidth` 成比例，不要只写很小的固定像素，避免动画只停留在画面一角。\n\
17. 对于 `video-space` 实体，x / y / width / height 与动画位移参数都必须按同一参考坐标系表达，不要混用画布像素和视频像素。\n\
18. 如果任务涉及镜头切换，可以使用顶层 transitions[]，字段必须遵守 leftClipId / rightClipId / presentation / timing / durationInFrames；不要把转场偷偷降级成说明文字。\n\
\n\
工程标题：{}\n\
脚本：{}\n\
Remotion 读取结果 JSON：{}\n\
时间线片段 JSON：{}",
                    title,
                    instructions,
                    serde_json::to_string(&remotion_context).map_err(|error| error.to_string())?,
                    serde_json::to_string(&clips).map_err(|error| error.to_string())?
                );
                let model_config = payload_field(&payload, "modelConfig").cloned();
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let auth_runtime = state
                    .auth_runtime
                    .lock()
                    .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
                let settings_snapshot =
                    crate::auth::project_settings_for_runtime(&settings_snapshot, &auth_runtime);
                let resolved_config =
                    resolve_chat_config(&settings_snapshot, model_config.as_ref());
                let session_id = payload_string(&payload, "sessionId");
                let model_config_summary = model_config
                    .as_ref()
                    .and_then(Value::as_object)
                    .map(|object| {
                        format!(
                            "baseURL={} | modelName={} | protocol={} | apiKeyPresent={}",
                            object.get("baseURL").and_then(Value::as_str).unwrap_or(""),
                            object
                                .get("modelName")
                                .and_then(Value::as_str)
                                .unwrap_or(""),
                            object.get("protocol").and_then(Value::as_str).unwrap_or(""),
                            object
                                .get("apiKey")
                                .and_then(Value::as_str)
                                .map(|value| !value.trim().is_empty())
                                .unwrap_or(false)
                        )
                    })
                    .unwrap_or_else(|| "none".to_string());
                let resolved_config_summary = resolved_config
                    .as_ref()
                    .map(|config| {
                        format!(
                            "base_url={} | model_name={} | protocol={} | api_key_present={}",
                            config.base_url,
                            config.model_name,
                            config.protocol,
                            config
                                .api_key
                                .as_ref()
                                .map(|value| !value.trim().is_empty())
                                .unwrap_or(false)
                        )
                    })
                    .unwrap_or_else(|| "none".to_string());
                let start_log = format!(
                    "[video][remotion_generate] start | filePath={} | sessionId={} | clips={} | instructionsChars={} | payloadModelConfig={} | resolvedConfig={}",
                    file_path,
                    session_id.clone().unwrap_or_default(),
                    clips.len(),
                    instructions.chars().count(),
                    model_config_summary,
                    resolved_config_summary
                );
                eprintln!("{}", start_log);
                append_debug_log_state(state, start_log);
                let (candidate, subagent_summary) = run_animation_director_subagent(
                    app,
                    state,
                    session_id.as_deref(),
                    model_config.as_ref(),
                    &prompt,
                )?;
                let raw_log = format!(
                    "[video][remotion_generate] subagent-response | parsedJson=true | summary={}",
                    subagent_summary.replace('\n', "\\n")
                );
                eprintln!("{}", raw_log);
                append_debug_log_state(state, raw_log);
                let mut normalized =
                    normalize_ai_remotion_scene(&candidate, &fallback, &clips, &title);
                if !instructions_request_visual_text_layers(&instructions) {
                    strip_incidental_remotion_text_layers(&mut normalized);
                }
                let normalized_scene_count = normalized
                    .get("scenes")
                    .and_then(Value::as_array)
                    .map(|items| items.len())
                    .unwrap_or(0);
                let normalized_log = format!(
                    "[video][remotion_generate] normalized | scenes={} | title={}",
                    normalized_scene_count,
                    normalized
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                );
                eprintln!("{}", normalized_log);
                append_debug_log_state(state, normalized_log);
                persist_remotion_composition_artifacts(&full_path, &normalized)?;
                Ok(json!({
                    "success": true,
                    "state": get_manuscript_package_state(&full_path)?,
                    "summary": subagent_summary
                }))
            }
            "manuscripts:pick-export-path" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let resolution_preset = payload_string(&payload, "resolutionPreset")
                    .unwrap_or_else(|| "1080p".to_string());
                let render_mode = payload_string(&payload, "renderMode")
                    .filter(|value| value == "full" || value == "motion-layer")
                    .unwrap_or_else(|| "full".to_string());
                let export_dir = full_path.join("exports");
                fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;
                let file_stem = full_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(slug_from_relative_path)
                    .unwrap_or_else(|| "redbox-video".to_string());
                let extension = if render_mode == "motion-layer" {
                    "mov"
                } else {
                    "mp4"
                };
                let default_name = if resolution_preset.is_empty() || resolution_preset == "source"
                {
                    format!("{file_stem}.{extension}")
                } else {
                    format!("{file_stem}-{resolution_preset}.{extension}")
                };
                let picked =
                    pick_save_file_native("选择导出位置", &default_name, Some(&export_dir))?;
                let Some(path) = picked else {
                    return Ok(json!({ "success": true, "canceled": true }));
                };
                let normalized_path = ensure_export_extension(path, extension);
                Ok(json!({
                    "success": true,
                    "canceled": false,
                    "path": normalized_path.display().to_string(),
                }))
            }
            "manuscripts:pick-richpost-export-path" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let file_name = full_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("Untitled");
                if get_package_kind_from_file_name(file_name) != Some("post") {
                    return Ok(
                        json!({ "success": false, "error": "Only richpost packages support image export" }),
                    );
                }
                let fallback_export_dir = full_path.join("exports").join("xiaohongshu");
                let export_dir = dirs::download_dir().unwrap_or(fallback_export_dir);
                let _ = fs::create_dir_all(&export_dir);
                let file_stem = full_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(slug_from_relative_path)
                    .unwrap_or_else(|| "redbox-richpost".to_string());
                let picked = pick_save_file_native(
                    "选择导出压缩包位置",
                    &format!("{file_stem}.zip"),
                    Some(&export_dir),
                )?;
                let Some(path) = picked else {
                    return Ok(json!({ "success": true, "canceled": true }));
                };
                let normalized_path = ensure_export_extension(path, "zip");
                Ok(json!({
                    "success": true,
                    "canceled": false,
                    "path": normalized_path.display().to_string(),
                }))
            }
            "manuscripts:save-richpost-export-archive" => {
                let output_path = payload_string(&payload, "outputPath").unwrap_or_default();
                let entries = payload
                    .get("entries")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if output_path.trim().is_empty() {
                    return Ok(json!({ "success": false, "error": "outputPath is required" }));
                }
                if entries.is_empty() {
                    return Ok(json!({ "success": false, "error": "entries is required" }));
                }
                let path = ensure_export_extension(std::path::PathBuf::from(output_path), "zip");
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                let file = fs::File::create(&path).map_err(|error| error.to_string())?;
                let mut archive = zip::ZipWriter::new(file);
                let options = zip::write::FileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated);

                for (index, entry) in entries.iter().enumerate() {
                    let name = entry
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| format!("第 {} 个导出文件缺少 name", index + 1))?;
                    let data_base64 = entry
                        .get("dataBase64")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| format!("第 {} 个导出文件缺少 dataBase64", index + 1))?;
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(data_base64.as_bytes())
                        .or_else(|_| {
                            base64::engine::general_purpose::STANDARD_NO_PAD
                                .decode(data_base64.as_bytes())
                        })
                        .map_err(|error| error.to_string())?;
                    archive
                        .start_file(name, options)
                        .map_err(|error| error.to_string())?;
                    archive
                        .write_all(&bytes)
                        .map_err(|error| error.to_string())?;
                }

                archive.finish().map_err(|error| error.to_string())?;
                Ok(json!({
                    "success": true,
                    "path": path.display().to_string(),
                    "entryCount": entries.len(),
                }))
            }
            "manuscripts:save-richpost-export-image" => {
                let output_path = payload_string(&payload, "outputPath").unwrap_or_default();
                let data_base64 = payload_string(&payload, "dataBase64").unwrap_or_default();
                if output_path.trim().is_empty() {
                    return Ok(json!({ "success": false, "error": "outputPath is required" }));
                }
                if data_base64.trim().is_empty() {
                    return Ok(json!({ "success": false, "error": "dataBase64 is required" }));
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data_base64.as_bytes())
                    .or_else(|_| {
                        base64::engine::general_purpose::STANDARD_NO_PAD
                            .decode(data_base64.as_bytes())
                    })
                    .map_err(|error| error.to_string())?;
                let path = std::path::PathBuf::from(output_path);
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::write(&path, bytes).map_err(|error| error.to_string())?;
                Ok(json!({
                    "success": true,
                    "path": path.display().to_string(),
                }))
            }
            "manuscripts:save-richpost-card-preview" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let data_base64 = payload_string(&payload, "dataBase64").unwrap_or_default();
                if file_path.trim().is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                if data_base64.trim().is_empty() {
                    return Ok(json!({ "success": false, "error": "dataBase64 is required" }));
                }
                let package_path = resolve_manuscript_path(state, &file_path)?;
                if !package_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data_base64.as_bytes())
                    .or_else(|_| {
                        base64::engine::general_purpose::STANDARD_NO_PAD
                            .decode(data_base64.as_bytes())
                    })
                    .map_err(|error| error.to_string())?;
                let preview_path = package_richpost_card_preview_image_path(&package_path);
                if let Some(parent) = preview_path.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::write(&preview_path, bytes).map_err(|error| error.to_string())?;
                let updated_at = fs::metadata(&preview_path)
                    .ok()
                    .and_then(|meta| meta.modified().ok())
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as i64);
                Ok(json!({
                    "success": true,
                    "path": preview_path.display().to_string(),
                    "fileUrl": file_url_for_path(&preview_path),
                    "updatedAt": updated_at,
                }))
            }
            "manuscripts:render-remotion-video" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let package_state = get_manuscript_package_state(&full_path)?;
                let mut scene = package_state
                    .get("remotion")
                    .cloned()
                    .unwrap_or_else(|| build_default_remotion_scene("RedBox Motion", &[]));
                let render_mode = payload_string(&payload, "renderMode")
                    .filter(|value| value == "full" || value == "motion-layer")
                    .unwrap_or_else(|| {
                        if scene
                            .pointer("/baseMedia/outputPath")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .is_some()
                        {
                            "full".to_string()
                        } else {
                            scene
                                .get("renderMode")
                                .and_then(Value::as_str)
                                .filter(|value| *value == "full" || *value == "motion-layer")
                                .unwrap_or("motion-layer")
                                .to_string()
                        }
                    });
                if let Some(object) = scene.as_object_mut() {
                    object.insert("renderMode".to_string(), json!(render_mode.clone()));
                }
                let width = scene.get("width").and_then(Value::as_i64).unwrap_or(1920);
                let height = scene.get("height").and_then(Value::as_i64).unwrap_or(1080);
                let resolution_preset = payload_string(&payload, "resolutionPreset")
                    .unwrap_or_else(|| "source".to_string());
                let scale = remotion_export_scale(width, height, &resolution_preset);
                let extension = if render_mode == "motion-layer" {
                    "mov"
                } else {
                    "mp4"
                };
                let output_path = payload_string(&payload, "outputPath")
                    .map(std::path::PathBuf::from)
                    .map(|path| ensure_export_extension(path, extension))
                    .unwrap_or_else(|| {
                        let export_dir = full_path.join("exports");
                        let _ = fs::create_dir_all(&export_dir);
                        let file_stem = full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .map(slug_from_relative_path)
                            .unwrap_or_else(|| "redbox-video".to_string());
                        export_dir.join(format!("{file_stem}-remotion-{}.{extension}", now_ms()))
                    });
                let render_result = render_remotion_video(
                    &scene,
                    &output_path,
                    scale,
                    Some(app),
                    Some(&file_path),
                )?;
                let scene_title = scene
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("RedBox Motion")
                    .to_string();
                if let Some(object) = scene.as_object_mut() {
                    object.insert(
                        "render".to_string(),
                        normalized_remotion_render_config(
                            Some(&json!({
                                "defaultOutName": render_result.get("defaultOutName").cloned().unwrap_or(Value::Null),
                                "codec": render_result.get("codec").cloned().unwrap_or(Value::Null),
                                "imageFormat": render_result.get("imageFormat").cloned().unwrap_or(Value::Null),
                                "pixelFormat": render_result.get("pixelFormat").cloned().unwrap_or(Value::Null),
                                "proResProfile": render_result.get("proResProfile").cloned().unwrap_or(Value::Null),
                                "outputPath": output_path.display().to_string(),
                                "renderedAt": now_i64(),
                                "durationInFrames": render_result.get("durationInFrames").cloned().unwrap_or(Value::Null),
                                "renderMode": render_mode,
                                "compositionId": render_result.get("compositionId").cloned().unwrap_or_else(|| json!("RedBoxVideoMotion"))
                            })),
                            &scene_title,
                            &render_mode,
                        ),
                    );
                }
                persist_remotion_composition_artifacts(&full_path, &scene)?;
                Ok(json!({
                    "success": true,
                    "outputPath": output_path.display().to_string(),
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:get-layout" => {
                let path = manuscript_layouts_path(state)?;
                if path.exists() {
                    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
                    let layout: Value =
                        serde_json::from_str(&content).map_err(|error| error.to_string())?;
                    Ok(layout)
                } else {
                    Ok(json!({}))
                }
            }
            "manuscripts:save-layout" => {
                let path = manuscript_layouts_path(state)?;
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::write(
                    &path,
                    serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?,
                )
                .map_err(|error| error.to_string())?;
                Ok(json!({ "success": true }))
            }
            "manuscripts:format-wechat" => {
                let title = payload_string(&payload, "title").unwrap_or_default();
                let content = payload_string(&payload, "content").unwrap_or_default();
                Ok(json!({
                    "success": true,
                    "html": markdown_to_html(&title, &content),
                    "plainText": content,
                }))
            }
            _ => Err(format!(
                "RedBox host does not recognize channel `{channel}`."
            )),
        }
    })())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_project_motion_items_from_remotion_scene_updates_animation_layers_and_items() {
        let mut project = json!({
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
            "items": [{
                "id": "old-motion",
                "type": "motion",
                "trackId": "M1",
                "fromMs": 0,
                "durationMs": 1000,
                "templateId": "static",
                "props": {},
                "enabled": true
            }, {
                "id": "clip-1",
                "type": "media",
                "trackId": "V1",
                "assetId": "asset-1",
                "fromMs": 0,
                "durationMs": 1000,
                "trimInMs": 0,
                "trimOutMs": 0,
                "enabled": true
            }],
            "animationLayers": [{
                "id": "old-motion",
                "name": "旧动画",
                "trackId": "M1",
                "enabled": true,
                "fromMs": 0,
                "durationMs": 1000,
                "zIndex": 0,
                "renderMode": "motion-layer",
                "componentType": "scene-sequence",
                "props": { "templateId": "static" },
                "entities": [],
                "bindings": []
            }]
        });
        let composition = json!({
            "fps": 30,
            "renderMode": "motion-layer",
            "scenes": [{
                "id": "scene-1",
                "clipId": Value::Null,
                "assetId": Value::Null,
                "startFrame": 0,
                "durationInFrames": 30,
                "motionPreset": "static",
                "overlayTitle": "苹果下落",
                "overlayBody": Value::Null,
                "overlays": [],
                "entities": [{
                    "id": "apple-1",
                    "type": "shape",
                    "shape": "apple",
                    "color": "#FF0000",
                    "x": 100,
                    "y": 0,
                    "width": 120,
                    "height": 120,
                    "animations": [{
                        "id": "anim-1",
                        "kind": "fall-bounce",
                        "fromFrame": 0,
                        "durationInFrames": 30
                    }]
                }]
            }]
        });

        sync_project_motion_items_from_remotion_scene(&mut project, &composition).unwrap();

        let layers = project
            .get("animationLayers")
            .and_then(Value::as_array)
            .expect("animation layers should exist");
        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].get("id").and_then(Value::as_str), Some("scene-1"));
        assert_eq!(
            layers[0]
                .pointer("/entities/0/shape")
                .and_then(Value::as_str),
            Some("apple")
        );
        assert_eq!(
            layers[0]
                .pointer("/entities/0/color")
                .and_then(Value::as_str),
            Some("#FF0000")
        );

        let motion_items = project
            .get("items")
            .and_then(Value::as_array)
            .expect("items should exist")
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("motion"))
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(motion_items.len(), 1);
        assert_eq!(
            motion_items[0].get("id").and_then(Value::as_str),
            Some("scene-1")
        );
        assert_eq!(
            motion_items[0]
                .pointer("/props/entities/0/animations/0/kind")
                .and_then(Value::as_str),
            Some("fall-bounce")
        );
        assert_eq!(
            motion_items[0]
                .pointer("/props/entities/0/color")
                .and_then(Value::as_str),
            Some("#FF0000")
        );
    }

    #[test]
    fn selected_remotion_rule_names_loads_all_builtin_remotion_rules() {
        let bundle = load_skill_bundle_sections_from_sources("remotion-best-practices", None);
        let rules = selected_remotion_rule_names(&bundle);
        assert!(rules.contains(&"animations.md".to_string()));
        assert!(rules.contains(&"assets.md".to_string()));
        assert!(rules.contains(&"calculate-metadata.md".to_string()));
        assert!(rules.contains(&"compositions.md".to_string()));
        assert!(rules.contains(&"sequencing.md".to_string()));
        assert!(rules.contains(&"subtitles.md".to_string()));
        assert!(rules.contains(&"text-animations.md".to_string()));
        assert!(rules.contains(&"timing.md".to_string()));
        assert!(rules.contains(&"transitions.md".to_string()));
    }

    #[test]
    fn merge_remotion_scene_patch_preserves_unmodified_existing_scene_data() {
        let existing = json!({
            "title": "Demo",
            "fps": 30,
            "scenes": [{
                "id": "scene-1",
                "startFrame": 0,
                "durationInFrames": 90,
                "overlayTitle": "旧标题",
                "entities": [{
                    "id": "apple-1",
                    "type": "shape",
                    "shape": "apple"
                }]
            }]
        });
        let patch = json!({
            "scenes": [{
                "id": "scene-1",
                "overlayTitle": "新标题"
            }]
        });

        let merged = merge_remotion_scene_patch(&existing, &patch);
        assert_eq!(
            merged
                .pointer("/scenes/0/overlayTitle")
                .and_then(Value::as_str),
            Some("新标题")
        );
        assert_eq!(
            merged
                .pointer("/scenes/0/entities/0/shape")
                .and_then(Value::as_str),
            Some("apple")
        );
    }
}
