use crate::strip_markdown_frontmatter;

#[derive(Debug, Clone)]
pub(super) struct ParsedPackageBlock {
    pub(super) kind: String,
    pub(super) level: Option<u8>,
    pub(super) text: String,
}

pub(super) fn normalize_package_block_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(super) fn package_block_match_key(kind: &str, level: Option<u8>, text: &str) -> String {
    format!(
        "{kind}|{}|{}",
        level.unwrap_or(0),
        normalize_package_block_text(text)
    )
}

pub(in crate::commands::manuscripts) fn parse_markdown_heading(line: &str) -> Option<(u8, String)> {
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

pub(super) fn parse_package_markdown_blocks(content: &str) -> Vec<ParsedPackageBlock> {
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
                    .map(|block| super::package_block_is_page_break(&block.kind))
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

#[cfg(test)]
mod tests {
    use super::{parse_markdown_heading, parse_package_markdown_blocks};

    #[test]
    fn parses_markdown_headings_with_bounds() {
        assert_eq!(
            parse_markdown_heading("## 标题"),
            Some((2, "标题".to_string()))
        );
        assert_eq!(parse_markdown_heading("####### too deep"), None);
        assert_eq!(parse_markdown_heading("#"), None);
        assert_eq!(parse_markdown_heading("not heading"), None);
    }

    #[test]
    fn parses_page_breaks_from_blank_runs() {
        let blocks = parse_package_markdown_blocks("# 标题\n\n第一段\n\n\n\n第二段");

        assert_eq!(blocks.len(), 4);
        assert_eq!(blocks[0].kind, "heading");
        assert_eq!(blocks[1].kind, "paragraph");
        assert_eq!(blocks[2].kind, "page-break");
        assert_eq!(blocks[3].text, "第二段");
    }
}
