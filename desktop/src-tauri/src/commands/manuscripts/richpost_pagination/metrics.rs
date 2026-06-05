use super::*;

pub(super) fn richpost_body_font_size_px(settings: RichpostTypographySettings) -> f64 {
    (RICHPOST_PAGINATION_CANVAS_WIDTH_PX * 0.032).clamp(17.0, 34.0) * settings.font_scale
}

pub(super) fn richpost_body_line_height_px(settings: RichpostTypographySettings) -> f64 {
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

pub(super) fn richpost_block_gap_px() -> f64 {
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
    (frame_width_px / (font_size_px * 1.02)).clamp(6.0, 44.0)
}

fn richpost_heading_units_per_line(
    level: u8,
    settings: RichpostTypographySettings,
    frame_width_ratio: f64,
) -> f64 {
    let frame_width_px = RICHPOST_PAGINATION_CANVAS_WIDTH_PX * frame_width_ratio.clamp(0.1, 1.0);
    let font_size_px = richpost_heading_font_size_px(level, settings).max(1.0);
    (frame_width_px / (font_size_px * 1.08)).clamp(4.0, 28.0)
}

pub(super) fn richpost_page_height_limit_px(
    settings: RichpostTypographySettings,
    frame_height_ratio: f64,
) -> f64 {
    let frame_height_px = RICHPOST_PAGINATION_CANVAS_HEIGHT_PX * frame_height_ratio.clamp(0.1, 1.0);
    let safe_bottom_padding_px =
        richpost_body_line_height_px(settings) * 0.85 + richpost_block_gap_px() * 0.5;
    (frame_height_px - safe_bottom_padding_px).max(richpost_body_line_height_px(settings) * 6.0)
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

pub(super) fn richpost_block_height_px_from_parts(
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
        let level = level.unwrap_or(2);
        let units_per_line = richpost_heading_units_per_line(level, settings, frame.w);
        let wrapped_lines = richpost_estimated_wrapped_line_count(text, units_per_line);
        let line_height_px = richpost_heading_line_height_px(level, settings);
        let block_margin_px = match level {
            1 => line_height_px * 0.52,
            2 => line_height_px * 0.42,
            _ => line_height_px * 0.24,
        };
        return wrapped_lines as f64 * line_height_px + block_margin_px;
    }
    let wrapped_lines = richpost_estimated_wrapped_line_count(
        text,
        richpost_body_units_per_line(settings, frame.w),
    );
    let line_height_px = richpost_body_line_height_px(settings);
    wrapped_lines as f64 * line_height_px + line_height_px * 0.12
}

pub(super) fn richpost_default_block_height_px(
    block: &PackageContentBlock,
    settings: RichpostTypographySettings,
    frame: &RichpostZoneFrame,
) -> f64 {
    richpost_block_height_px_from_parts(&block.kind, block.level, &block.text, settings, frame)
}

pub(super) fn richpost_split_text_for_unit_budget(text: &str, max_units: f64) -> (String, String) {
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

pub(super) fn richpost_split_paragraph_for_available_lines(
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
