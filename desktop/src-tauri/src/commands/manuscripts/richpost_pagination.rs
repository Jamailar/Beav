use super::*;

#[path = "richpost_pagination/metrics.rs"]
mod metrics;

use metrics::{
    richpost_block_gap_px, richpost_block_height_px_from_parts, richpost_body_line_height_px,
    richpost_default_block_height_px, richpost_page_height_limit_px,
    richpost_split_paragraph_for_available_lines,
};

#[derive(Default)]
pub(super) struct RichpostAutoPageDraft {
    pub(super) title_block_ids: Vec<String>,
    pub(super) body_block_ids: Vec<String>,
    pub(super) body_fragments: Vec<Value>,
    pub(super) title_height_px: f64,
    pub(super) body_height_px: f64,
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
        let (head, tail) = metrics::richpost_split_text_for_unit_budget(
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
