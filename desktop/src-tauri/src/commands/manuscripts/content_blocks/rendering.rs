use super::*;
use pulldown_cmark::{
    html::push_html, Event as MarkdownEvent, Options as MarkdownOptions, Parser as MarkdownParser,
};

fn render_package_slot_text(value: &str) -> String {
    escape_html(value).replace('\n', "<br />")
}

pub(super) fn render_markdown_fragment_html(value: &str) -> String {
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

pub(in crate::commands::manuscripts) fn render_package_block_fragment_parts(
    kind: &str,
    level: Option<u8>,
    text: &str,
) -> String {
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

pub(in crate::commands::manuscripts) fn render_package_block_fragment(
    block: &PackageContentBlock,
) -> String {
    render_package_block_fragment_parts(&block.kind, block.level, &block.text)
}
