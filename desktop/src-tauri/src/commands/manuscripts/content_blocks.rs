use super::*;
use pulldown_cmark::{
    html::push_html, Event as MarkdownEvent, Options as MarkdownOptions, Parser as MarkdownParser,
};

#[derive(Debug, Clone)]
pub(super) struct ParsedPackageBlock {
    kind: String,
    level: Option<u8>,
    text: String,
}

#[derive(Debug, Clone)]
pub(super) struct PackageContentBlock {
    pub(super) id: String,
    pub(super) slot: String,
    pub(super) kind: String,
    pub(super) level: Option<u8>,
    pub(super) text: String,
    pub(super) order: usize,
    pub(super) char_count: usize,
}

#[derive(Debug, Clone)]
pub(super) struct PackageBoundAsset {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) url: String,
    pub(super) role: String,
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

pub(super) fn parse_markdown_heading(line: &str) -> Option<(u8, String)> {
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

pub(super) fn build_package_content_blocks(
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

pub(super) fn package_content_map_value(
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

pub(super) fn render_package_block_fragment_parts(
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

pub(super) fn render_package_block_fragment(block: &PackageContentBlock) -> String {
    render_package_block_fragment_parts(&block.kind, block.level, &block.text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_markdown_blocks_and_stable_ids() {
        let temp = std::env::temp_dir().join(format!("redbox-content-blocks-{}", now_ms()));
        fs::create_dir_all(&temp).unwrap();
        let map_path = temp.join("content-map.json");
        write_json_value(
            &map_path,
            &json!({
                "blocks": [
                    { "id": "h2_003", "type": "heading", "level": 2, "text": "旧标题" },
                    { "id": "p_004", "type": "paragraph", "text": "同一段落" }
                ]
            }),
        )
        .unwrap();

        let blocks = build_package_content_blocks(&map_path, "## 新标题\n\n同一段落\n\n\n\n新段落");

        assert_eq!(blocks.len(), 4);
        assert_eq!(blocks[1].id, "p_004");
        assert_eq!(blocks[2].kind, "page-break");
        assert_eq!(blocks[3].id, "p_005");
        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn renders_heading_and_paragraph_fragments() {
        assert_eq!(
            render_package_block_fragment_parts("heading", Some(2), "标题"),
            "<section class=\"rb-block rb-heading rb-heading-level-2\"><h2>标题</h2></section>"
        );
        assert_eq!(
            render_package_block_fragment_parts("paragraph", None, "第一行\n第二行"),
            "<section class=\"rb-block rb-paragraph\"><p>第一行<br />\n第二行</p></section>"
        );
    }
}
