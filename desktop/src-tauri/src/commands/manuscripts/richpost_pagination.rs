use super::*;

#[derive(Default)]
pub(super) struct RichpostAutoPageDraft {
    pub(super) title_block_ids: Vec<String>,
    pub(super) body_block_ids: Vec<String>,
    pub(super) body_fragments: Vec<Value>,
    pub(super) title_height_px: f64,
    pub(super) body_height_px: f64,
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

fn richpost_page_height_limit_px(
    settings: RichpostTypographySettings,
    frame_height_ratio: f64,
) -> f64 {
    let frame_height_px = RICHPOST_PAGINATION_CANVAS_HEIGHT_PX * frame_height_ratio.clamp(0.1, 1.0);
    let safe_bottom_padding_px =
        richpost_body_line_height_px(settings) * 0.85 + richpost_block_gap_px() * 0.5;
    (frame_height_px - safe_bottom_padding_px).max(richpost_body_line_height_px(settings) * 6.0)
}

pub(super) fn richpost_zone_fragment_value(
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

pub(super) fn richpost_master_for_page_position(
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
    default_richpost_zone_frame(richpost_master_for_page_position(
        theme,
        page_index,
        total_pages,
    ))
}

pub(super) fn richpost_default_segment_pages(
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

#[cfg(test)]
mod tests {
    use super::*;

    fn paragraph_block(id: &str, text: &str) -> PackageContentBlock {
        PackageContentBlock {
            id: id.to_string(),
            slot: "body".to_string(),
            kind: "paragraph".to_string(),
            level: None,
            text: text.to_string(),
            order: 0,
            char_count: text.chars().count(),
        }
    }

    #[test]
    fn split_text_keeps_tail_when_over_budget() {
        let (head, tail) = richpost_split_text_for_unit_budget(
            "第一句很长很长，第二句也很长很长，第三句继续。",
            12.0,
        );

        assert!(!head.trim().is_empty());
        assert!(!tail.trim().is_empty());
    }

    #[test]
    fn default_segment_pages_splits_long_paragraphs_into_fragments() {
        let long_text = "这是一段用于测试分页的正文。".repeat(80);
        let pages = richpost_default_segment_pages(
            &[paragraph_block("body-1", &long_text)],
            RichpostTypographySettings::default(),
            &default_richpost_theme_spec(),
            0,
            1,
        );

        assert!(pages.len() > 1);
        assert!(pages.iter().any(|page| !page.body_fragments.is_empty()));
    }
}
