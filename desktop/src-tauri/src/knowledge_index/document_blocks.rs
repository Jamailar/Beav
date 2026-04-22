use glob::Pattern;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::Path;
use tauri::State;

use crate::{
    knowledge_index::{catalog_db_path, schema::ensure_catalog_ready},
    AppState,
};

const MAX_INDEXED_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_BLOCK_CHARS: usize = 1600;
const MAX_BLOCK_LINES: usize = 24;

#[derive(Debug, Clone)]
pub(crate) struct DocumentBlockRecord {
    pub block_id: String,
    pub document_id: String,
    pub source_id: String,
    pub source_name: String,
    pub root_path: String,
    pub absolute_path: String,
    pub relative_path: String,
    pub file_extension: Option<String>,
    pub title: Option<String>,
    pub language: Option<String>,
    pub block_index: i64,
    pub line_start: i64,
    pub line_end: i64,
    pub text: String,
    pub normalized_text: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentBlockHit {
    pub block_id: String,
    pub document_id: String,
    pub source_id: String,
    pub source_name: String,
    pub root_path: String,
    pub path: String,
    pub absolute_path: String,
    pub file_extension: Option<String>,
    pub title: Option<String>,
    pub language: Option<String>,
    pub block_index: i64,
    pub line_start: i64,
    pub line_end: i64,
    pub snippet: String,
}

fn connection(state: &State<'_, AppState>) -> Result<Connection, String> {
    ensure_catalog_ready(state)?;
    Connection::open(catalog_db_path(state)?).map_err(|error| error.to_string())
}

pub(crate) fn replace_blocks(
    state: &State<'_, AppState>,
    blocks: &[DocumentBlockRecord],
) -> Result<(), String> {
    let mut conn = connection(state)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM knowledge_document_blocks", [])
        .map_err(|error| error.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO knowledge_document_blocks (
                    block_id, document_id, source_id, source_name, root_path, absolute_path,
                    relative_path, file_extension, title, language, block_index, line_start,
                    line_end, text, normalized_text, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6,
                    ?7, ?8, ?9, ?10, ?11, ?12,
                    ?13, ?14, ?15, ?16
                )
                "#,
            )
            .map_err(|error| error.to_string())?;
        for block in blocks {
            stmt.execute(params![
                block.block_id,
                block.document_id,
                block.source_id,
                block.source_name,
                block.root_path,
                block.absolute_path,
                block.relative_path,
                block.file_extension,
                block.title,
                block.language,
                block.block_index,
                block.line_start,
                block.line_end,
                block.text,
                block.normalized_text,
                block.updated_at
            ])
            .map_err(|error| error.to_string())?;
        }
    }
    tx.commit().map_err(|error| error.to_string())
}

pub(crate) fn count_blocks_for_source(
    state: &State<'_, AppState>,
    source_id: &str,
) -> Result<i64, String> {
    let conn = connection(state)?;
    conn.query_row(
        "SELECT COUNT(*) FROM knowledge_document_blocks WHERE source_id = ?1",
        params![source_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn search_blocks(
    state: &State<'_, AppState>,
    source_id: &str,
    query: &str,
    pattern: &Pattern,
    limit: usize,
    snippet_chars: usize,
) -> Result<Vec<DocumentBlockHit>, String> {
    let conn = connection(state)?;
    let normalized_query = normalize_text(query);
    let mut stmt = conn
        .prepare(
            r#"
            SELECT block_id, document_id, source_id, source_name, root_path, absolute_path,
                   relative_path, file_extension, title, language, block_index, line_start,
                   line_end, text
            FROM knowledge_document_blocks
            WHERE source_id = ?1
              AND normalized_text LIKE ?2
            ORDER BY relative_path ASC, block_index ASC
            LIMIT ?3
            "#,
        )
        .map_err(|error| error.to_string())?;
    let candidates = stmt
        .query_map(
            params![source_id, format!("%{normalized_query}%"), (limit * 6).max(limit)],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, String>(13)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;

    let mut hits = Vec::new();
    for row in candidates {
        let (
            block_id,
            document_id,
            source_id,
            source_name,
            root_path,
            absolute_path,
            relative_path,
            file_extension,
            title,
            language,
            block_index,
            line_start,
            line_end,
            text,
        ) = row.map_err(|error| error.to_string())?;
        if !pattern.matches_path_with(Path::new(&relative_path), glob_match_options()) {
            continue;
        }
        hits.push(DocumentBlockHit {
            block_id,
            document_id,
            source_id,
            source_name,
            root_path,
            path: relative_path,
            absolute_path,
            file_extension,
            title,
            language,
            block_index,
            line_start,
            line_end,
            snippet: build_snippet(&text, query, snippet_chars),
        });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

pub(crate) fn read_block(
    state: &State<'_, AppState>,
    block_id: &str,
) -> Result<Option<DocumentBlockRecord>, String> {
    let conn = connection(state)?;
    conn.query_row(
        r#"
        SELECT block_id, document_id, source_id, source_name, root_path, absolute_path,
               relative_path, file_extension, title, language, block_index, line_start,
               line_end, text, normalized_text, updated_at
        FROM knowledge_document_blocks
        WHERE block_id = ?1
        "#,
        params![block_id],
        |row| {
            Ok(DocumentBlockRecord {
                block_id: row.get(0)?,
                document_id: row.get(1)?,
                source_id: row.get(2)?,
                source_name: row.get(3)?,
                root_path: row.get(4)?,
                absolute_path: row.get(5)?,
                relative_path: row.get(6)?,
                file_extension: row.get(7)?,
                title: row.get(8)?,
                language: row.get(9)?,
                block_index: row.get(10)?,
                line_start: row.get(11)?,
                line_end: row.get(12)?,
                text: row.get(13)?,
                normalized_text: row.get(14)?,
                updated_at: row.get(15)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn build_blocks_for_source(
    source_id: &str,
    source_name: &str,
    root_path: &Path,
    updated_at: &str,
) -> Result<Vec<DocumentBlockRecord>, String> {
    let mut blocks = Vec::new();
    if root_path.is_file() {
        build_blocks_for_file(
            source_id,
            source_name,
            root_path.parent().unwrap_or(root_path),
            root_path,
            updated_at,
            &mut blocks,
        )?;
        return Ok(blocks);
    }
    collect_blocks_recursive(
        source_id,
        source_name,
        root_path,
        root_path,
        updated_at,
        &mut blocks,
    )?;
    Ok(blocks)
}

fn collect_blocks_recursive(
    source_id: &str,
    source_name: &str,
    root_path: &Path,
    current: &Path,
    updated_at: &str,
    blocks: &mut Vec<DocumentBlockRecord>,
) -> Result<(), String> {
    let entries = match fs::read_dir(current) {
        Ok(entries) => entries,
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_blocks_recursive(source_id, source_name, root_path, &path, updated_at, blocks)?;
            continue;
        }
        if !path.is_file() {
            continue;
        }
        build_blocks_for_file(source_id, source_name, root_path, &path, updated_at, blocks)?;
    }
    Ok(())
}

fn build_blocks_for_file(
    source_id: &str,
    source_name: &str,
    root_path: &Path,
    file_path: &Path,
    updated_at: &str,
    blocks: &mut Vec<DocumentBlockRecord>,
) -> Result<(), String> {
    let metadata = match fs::metadata(file_path) {
        Ok(metadata) => metadata,
        Err(error) => return Err(error.to_string()),
    };
    if metadata.len() > MAX_INDEXED_FILE_BYTES {
        return Ok(());
    }
    let Some(raw_text) = extract_text(file_path)? else {
        return Ok(());
    };
    let relative_path = file_path
        .strip_prefix(root_path)
        .unwrap_or(file_path)
        .to_string_lossy()
        .replace('\\', "/");
    let document_id = format!("{source_id}:{relative_path}");
    let title = file_path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string());
    let language = detect_language(&raw_text);
    for (block_index, block) in split_into_blocks(&raw_text).into_iter().enumerate() {
        let normalized_text = normalize_text(&block.text);
        if normalized_text.is_empty() {
            continue;
        }
        blocks.push(DocumentBlockRecord {
            block_id: format!("{document_id}#{block_index}"),
            document_id: document_id.clone(),
            source_id: source_id.to_string(),
            source_name: source_name.to_string(),
            root_path: root_path.display().to_string(),
            absolute_path: file_path.display().to_string(),
            relative_path: relative_path.clone(),
            file_extension: file_path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.to_ascii_lowercase()),
            title: title.clone(),
            language: language.clone(),
            block_index: block_index as i64,
            line_start: block.line_start as i64,
            line_end: block.line_end as i64,
            text: block.text,
            normalized_text,
            updated_at: updated_at.to_string(),
        });
    }
    Ok(())
}

fn extract_text(path: &Path) -> Result<Option<String>, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    match extension.as_deref() {
        Some("txt")
        | Some("md")
        | Some("markdown")
        | Some("csv")
        | Some("tsv")
        | Some("json")
        | Some("yaml")
        | Some("yml")
        | Some("xml")
        | Some("html")
        | Some("htm") => read_utf8(path).map(|value| value.map(|text| html_to_text_if_needed(text, extension.as_deref()))),
        Some("docx") => extract_docx_text(path),
        _ => read_utf8(path),
    }
}

fn read_utf8(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::InvalidData => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn extract_docx_text(path: &Path) -> Result<Option<String>, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    let mut xml = String::new();
    let mut entry = match archive.by_name("word/document.xml") {
        Ok(entry) => entry,
        Err(_) => return Ok(None),
    };
    entry.read_to_string(&mut xml).map_err(|error| error.to_string())?;
    Ok(Some(strip_xml_tags(&xml)))
}

fn html_to_text_if_needed(text: String, extension: Option<&str>) -> String {
    match extension {
        Some("html") | Some("htm") => strip_xml_tags(&text),
        _ => text,
    }
}

fn strip_xml_tags(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut inside_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => inside_tag = true,
            '>' => {
                inside_tag = false;
                output.push(' ');
            }
            _ if !inside_tag => output.push(ch),
            _ => {}
        }
    }
    output
}

fn normalize_text(input: &str) -> String {
    input
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn detect_language(input: &str) -> Option<String> {
    let chinese = input
        .chars()
        .filter(|ch| ('\u{4e00}'..='\u{9fff}').contains(ch))
        .count();
    let ascii = input.chars().filter(|ch| ch.is_ascii_alphabetic()).count();
    if chinese == 0 && ascii == 0 {
        return None;
    }
    if chinese >= ascii {
        Some("zh".to_string())
    } else {
        Some("en".to_string())
    }
}

fn build_snippet(text: &str, query: &str, max_chars: usize) -> String {
    let normalized_query = query.to_lowercase();
    let lowered = text.to_lowercase();
    let start = lowered.find(&normalized_query).unwrap_or(0);
    let safe_start = start.saturating_sub(max_chars / 4);
    let snippet = text.chars().skip(safe_start).take(max_chars).collect::<String>();
    if snippet.chars().count() >= text.chars().count() {
        return snippet.trim().to_string();
    }
    snippet.trim().to_string()
}

fn glob_match_options() -> glob::MatchOptions {
    glob::MatchOptions {
        case_sensitive: false,
        require_literal_separator: false,
        require_literal_leading_dot: false,
    }
}

#[derive(Debug, Clone)]
struct TextBlock {
    line_start: usize,
    line_end: usize,
    text: String,
}

fn split_into_blocks(input: &str) -> Vec<TextBlock> {
    let mut blocks = Vec::new();
    let mut current_lines = Vec::new();
    let mut current_chars = 0usize;
    let mut block_start = 1usize;
    let mut line_no = 0usize;

    for raw_line in input.lines() {
        line_no += 1;
        let line = raw_line.trim_end();
        let is_separator = line.trim().is_empty();
        let next_chars = current_chars + line.chars().count() + 1;
        let should_flush = !current_lines.is_empty()
            && (is_separator || current_lines.len() >= MAX_BLOCK_LINES || next_chars >= MAX_BLOCK_CHARS);
        if should_flush {
            blocks.push(TextBlock {
                line_start: block_start,
                line_end: line_no.saturating_sub(1),
                text: current_lines.join("\n"),
            });
            current_lines.clear();
            current_chars = 0;
            block_start = if is_separator { line_no + 1 } else { line_no };
        }
        if is_separator {
            continue;
        }
        if current_lines.is_empty() {
            block_start = line_no;
        }
        current_chars += line.chars().count() + 1;
        current_lines.push(line.to_string());
    }

    if !current_lines.is_empty() {
        blocks.push(TextBlock {
            line_start: block_start,
            line_end: line_no,
            text: current_lines.join("\n"),
        });
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_html_tags_to_plain_text() {
        let text = strip_xml_tags("<p>Hello <strong>World</strong></p>");
        assert!(text.contains("Hello"));
        assert!(text.contains("World"));
    }

    #[test]
    fn splits_text_into_multiple_blocks() {
        let input = (1..=40)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let blocks = split_into_blocks(&input);
        assert!(blocks.len() >= 2);
        assert_eq!(blocks[0].line_start, 1);
        assert!(blocks[0].line_end >= 1);
    }
}
