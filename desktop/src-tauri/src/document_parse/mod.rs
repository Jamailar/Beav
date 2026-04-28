mod legal_metadata;
mod pdf_pages;
mod visual_llm;
mod visual_manifest;

use base64::Engine;
use calamine::{open_workbook_auto, Data, Reader};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{Cursor, Read};
use std::path::Path;

pub(crate) use legal_metadata::LegalMetadata;
pub(crate) use visual_llm::VisualIndexConfig;

pub(crate) const PARSER_NAME: &str = "redbox-canonical";
pub(crate) const PARSER_VERSION: &str = "stage8-v2";
const MAX_CANONICAL_BLOCK_CHARS: usize = 1600;
const MAX_CANONICAL_BLOCK_LINES: usize = 24;
const MAX_ZIP_ENTRY_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 32;

#[derive(Debug, Clone, Default)]
pub(crate) struct ParserProviderConfig {
    pub docling_endpoint: Option<String>,
    pub tika_endpoint: Option<String>,
    pub unstructured_endpoint: Option<String>,
    pub api_key: Option<String>,
    pub timeout_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ParserInfo {
    pub parser_name: String,
    pub parser_version: String,
    pub strategy: String,
    pub fallback_used: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanonicalBlock {
    pub block_type: String,
    pub section_path: Vec<String>,
    pub page: Option<i64>,
    pub line_start: i64,
    pub line_end: i64,
    pub text: String,
    pub language: Option<String>,
    pub content_origin: String,
    pub ocr_confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanonicalAttachment {
    pub attachment_path: String,
    pub source_type: String,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanonicalDocument {
    pub document_id: String,
    pub source_id: String,
    pub absolute_path: String,
    pub relative_path: String,
    pub source_type: String,
    pub title: Option<String>,
    pub language: Option<String>,
    pub content_origin: String,
    pub ocr_average_confidence: Option<f64>,
    #[serde(default)]
    pub legal_metadata: LegalMetadata,
    pub parser_info: ParserInfo,
    pub blocks: Vec<CanonicalBlock>,
    pub attachments: Vec<CanonicalAttachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visual_manifest: Option<Value>,
}

pub(crate) fn parse_path(
    source_id: &str,
    root_path: &Path,
    path: &Path,
    visual_config: &VisualIndexConfig,
    parser_config: &ParserProviderConfig,
) -> Result<Option<CanonicalDocument>, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    let relative_path = path
        .strip_prefix(root_path)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    let absolute_path = path.display().to_string();
    let title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string());

    let is_visual_image = is_visual_image_extension(&extension);
    let (parsed, visual_manifest) = if !is_visual_image && extension != "pdf" {
        if let Some(external) = parse_external_pipeline(path, &extension, parser_config)? {
            (Some(external), None)
        } else {
            parse_native_path(source_id, &relative_path, path, &extension, visual_config)?
        }
    } else {
        parse_native_path(source_id, &relative_path, path, &extension, visual_config)?
    };

    let Some(parsed) = parsed else {
        return Ok(None);
    };

    let mut blocks = Vec::new();
    let mut attachments = Vec::new();
    let mut fallback_used = false;
    let mut strategy = String::new();
    for section in parsed {
        strategy = section.strategy.clone();
        fallback_used = fallback_used || section.fallback_used;
        if let Some(attachment_path) = section.attachment_path.as_ref() {
            attachments.push(CanonicalAttachment {
                attachment_path: attachment_path.clone(),
                source_type: section.block_type.clone(),
                title: section.section_path.last().cloned(),
            });
        }
        blocks.extend(split_into_canonical_blocks(
            &section.text,
            &section.block_type,
            &section.section_path,
            section.page,
            section.language.clone(),
            &section.content_origin,
            section.ocr_confidence,
        ));
    }
    if blocks.is_empty() {
        return Ok(None);
    }
    let language = dominant_language(&blocks);
    let content_origin = dominant_content_origin(&blocks);
    let ocr_average_confidence = average_ocr_confidence(&blocks);
    let joined_text = blocks
        .iter()
        .take(12)
        .map(|block| block.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let legal_metadata = legal_metadata::extract_legal_metadata(
        title.as_deref(),
        &relative_path,
        &extension,
        &joined_text,
    );
    Ok(Some(CanonicalDocument {
        document_id: format!("{source_id}:{relative_path}"),
        source_id: source_id.to_string(),
        absolute_path,
        relative_path,
        source_type: extension,
        title,
        language,
        content_origin,
        ocr_average_confidence,
        legal_metadata,
        parser_info: ParserInfo {
            parser_name: PARSER_NAME.to_string(),
            parser_version: PARSER_VERSION.to_string(),
            strategy,
            fallback_used,
        },
        blocks,
        attachments,
        visual_manifest,
    }))
}

fn parse_native_path(
    source_id: &str,
    relative_path: &str,
    path: &Path,
    extension: &str,
    visual_config: &VisualIndexConfig,
) -> Result<(Option<Vec<ParsedSection>>, Option<Value>), String> {
    let parsed = match extension {
        "txt" | "md" | "markdown" | "json" | "yaml" | "yml" | "xml" => {
            read_utf8_sections(path, "plain-text", vec!["body".to_string()])?
        }
        "html" | "htm" => {
            read_utf8_sections(path, "html", vec!["body".to_string()])?.map(|value| {
                value
                    .into_iter()
                    .map(|section| ParsedSection {
                        text: strip_xml_tags(&section.text),
                        ..section
                    })
                    .collect()
            })
        }
        "csv" | "tsv" => parse_delimited_file(path)?,
        "pdf" => {
            return parse_pdf_visual_or_native(source_id, relative_path, path, visual_config);
        }
        "docx" => parse_docx(path)?,
        "pptx" => parse_pptx(path)?,
        "xlsx" => parse_xlsx(path)?,
        "eml" => parse_eml(path)?,
        "zip" => parse_zip(path)?,
        "png" | "jpg" | "jpeg" | "tif" | "tiff" | "heic" | "bmp" | "webp" => {
            return parse_image_visual_manifest(source_id, relative_path, path, visual_config);
        }
        _ => read_utf8_sections(path, "plain-text-fallback", vec!["body".to_string()])?,
    };
    Ok((parsed, None))
}

fn parse_external_pipeline(
    path: &Path,
    source_type: &str,
    config: &ParserProviderConfig,
) -> Result<Option<Vec<ParsedSection>>, String> {
    for (provider, endpoint, fallback_used) in [
        ("docling", config.docling_endpoint.as_deref(), false),
        ("tika", config.tika_endpoint.as_deref(), true),
        (
            "unstructured",
            config.unstructured_endpoint.as_deref(),
            true,
        ),
    ] {
        let Some(endpoint) = endpoint.map(str::trim).filter(|value| !value.is_empty()) else {
            continue;
        };
        match run_external_parser(path, source_type, provider, endpoint, config, fallback_used) {
            Ok(Some(sections)) if !sections.is_empty() => return Ok(Some(sections)),
            Ok(_) => {}
            Err(error) => {
                eprintln!("[RedBox document parser] {provider} failed: {error}");
            }
        }
    }
    Ok(None)
}

fn run_external_parser(
    path: &Path,
    source_type: &str,
    provider: &str,
    endpoint: &str,
    config: &ParserProviderConfig,
    fallback_used: bool,
) -> Result<Option<Vec<ParsedSection>>, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let body = json!({
        "provider": provider,
        "fileName": path.file_name().and_then(|value| value.to_str()).unwrap_or("document"),
        "sourceType": source_type,
        "mimeType": mime_type_for_path(path),
        "dataBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
    });
    let response = crate::run_curl_json_with_timeout(
        "POST",
        endpoint,
        config.api_key.as_deref(),
        &[],
        Some(body),
        Some(config.timeout_seconds.clamp(10, 300)),
    )?;
    parse_external_parser_response(provider, fallback_used, &response)
}

fn parse_external_parser_response(
    provider: &str,
    fallback_used: bool,
    value: &Value,
) -> Result<Option<Vec<ParsedSection>>, String> {
    if let Some(blocks) = value.get("blocks").and_then(Value::as_array) {
        let sections = blocks
            .iter()
            .filter_map(|block| {
                extract_response_text(block).map(|text| ParsedSection {
                    strategy: provider.to_string(),
                    block_type: block
                        .get("blockType")
                        .or_else(|| block.get("type"))
                        .and_then(Value::as_str)
                        .unwrap_or("document-block")
                        .to_string(),
                    section_path: block
                        .get("sectionPath")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(Value::as_str)
                                .map(ToString::to_string)
                                .collect::<Vec<_>>()
                        })
                        .filter(|items| !items.is_empty())
                        .unwrap_or_else(|| vec![provider.to_string()]),
                    page: block.get("page").and_then(Value::as_i64),
                    language: block
                        .get("language")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .or_else(|| detect_language(&text)),
                    text,
                    content_origin: block
                        .get("contentOrigin")
                        .and_then(Value::as_str)
                        .unwrap_or("native")
                        .to_string(),
                    ocr_confidence: block
                        .get("ocrConfidence")
                        .or_else(|| block.get("confidence"))
                        .and_then(Value::as_f64),
                    fallback_used,
                    attachment_path: block
                        .get("attachmentPath")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                })
            })
            .collect::<Vec<_>>();
        if !sections.is_empty() {
            return Ok(Some(sections));
        }
    }
    if let Some(pages) = value.get("pages").and_then(Value::as_array) {
        let sections = pages
            .iter()
            .enumerate()
            .filter_map(|(index, page)| {
                extract_response_text(page).map(|text| ParsedSection {
                    strategy: provider.to_string(),
                    block_type: "page".to_string(),
                    section_path: vec!["page".to_string(), (index + 1).to_string()],
                    page: page
                        .get("page")
                        .and_then(Value::as_i64)
                        .or(Some(index as i64 + 1)),
                    language: page
                        .get("language")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .or_else(|| detect_language(&text)),
                    text,
                    content_origin: page
                        .get("contentOrigin")
                        .and_then(Value::as_str)
                        .unwrap_or("native")
                        .to_string(),
                    ocr_confidence: page
                        .get("ocrConfidence")
                        .or_else(|| page.get("confidence"))
                        .and_then(Value::as_f64),
                    fallback_used,
                    attachment_path: None,
                })
            })
            .collect::<Vec<_>>();
        if !sections.is_empty() {
            return Ok(Some(sections));
        }
    }
    if let Some(text) = extract_response_text(value).filter(|text| !text.trim().is_empty()) {
        return Ok(Some(vec![ParsedSection {
            strategy: provider.to_string(),
            block_type: "document".to_string(),
            section_path: vec![provider.to_string()],
            page: Some(1),
            language: detect_language(&text),
            text,
            content_origin: "native".to_string(),
            ocr_confidence: None,
            fallback_used,
            attachment_path: None,
        }]));
    }
    Ok(None)
}

fn extract_response_text(value: &Value) -> Option<String> {
    ["text", "content", "markdown", "body"]
        .into_iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))
        .map(ToString::to_string)
}

fn mime_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("pdf") => "application/pdf",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("pptx") => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("html") | Some("htm") => "text/html",
        Some("csv") => "text/csv",
        Some("txt") | Some("md") | Some("markdown") => "text/plain",
        Some("eml") => "message/rfc822",
        Some("zip") => "application/zip",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("tif") | Some("tiff") => "image/tiff",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

fn is_visual_image_extension(extension: &str) -> bool {
    matches!(
        extension,
        "png" | "jpg" | "jpeg" | "tif" | "tiff" | "heic" | "bmp" | "webp"
    )
}

#[derive(Debug, Clone)]
struct ParsedSection {
    strategy: String,
    block_type: String,
    section_path: Vec<String>,
    page: Option<i64>,
    text: String,
    language: Option<String>,
    content_origin: String,
    ocr_confidence: Option<f64>,
    fallback_used: bool,
    attachment_path: Option<String>,
}

fn read_utf8_sections(
    path: &Path,
    block_type: &str,
    section_path: Vec<String>,
) -> Result<Option<Vec<ParsedSection>>, String> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(vec![ParsedSection {
            strategy: block_type.to_string(),
            block_type: block_type.to_string(),
            section_path,
            page: Some(1),
            language: detect_language(&content),
            text: content,
            content_origin: "native".to_string(),
            ocr_confidence: None,
            fallback_used: false,
            attachment_path: None,
        }])),
        Err(error) if error.kind() == std::io::ErrorKind::InvalidData => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn parse_delimited_file(path: &Path) -> Result<Option<Vec<ParsedSection>>, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("csv");
    read_utf8_sections(
        path,
        extension,
        vec!["sheet".to_string(), "Sheet1".to_string()],
    )
}

fn parse_pdf_visual_or_native(
    source_id: &str,
    relative_path: &str,
    path: &Path,
    visual_config: &VisualIndexConfig,
) -> Result<(Option<Vec<ParsedSection>>, Option<Value>), String> {
    match pdf_extract::extract_text(path) {
        Ok(text) if !text.trim().is_empty() => Ok((
            Some(vec![ParsedSection {
                strategy: "pdf-extract".to_string(),
                block_type: "pdf-page".to_string(),
                section_path: vec!["page".to_string(), "1".to_string()],
                page: Some(1),
                language: detect_language(&text),
                text,
                content_origin: "native".to_string(),
                ocr_confidence: None,
                fallback_used: false,
                attachment_path: None,
            }]),
            None,
        )),
        Ok(_) | Err(_) => {
            parse_scanned_pdf_visual_manifest(source_id, relative_path, path, visual_config)
        }
    }
}

fn parse_image_visual_manifest(
    source_id: &str,
    relative_path: &str,
    path: &Path,
    visual_config: &VisualIndexConfig,
) -> Result<(Option<Vec<ParsedSection>>, Option<Value>), String> {
    let unit = visual_manifest::VisualSourceUnit::image_file(source_id, relative_path, path);
    let manifest = visual_llm::analyze_visual_source(path, &unit, visual_config)?;
    let sections = visual_manifest::sections_from_manifest(&manifest, None);
    Ok((sections, Some(manifest)))
}

fn parse_scanned_pdf_visual_manifest(
    source_id: &str,
    relative_path: &str,
    path: &Path,
    visual_config: &VisualIndexConfig,
) -> Result<(Option<Vec<ParsedSection>>, Option<Value>), String> {
    let rendered_pages = pdf_pages::render_pdf_pages(
        path,
        visual_config.pdf_max_pages,
        visual_config.pdf_render_dpi,
    )?;
    if rendered_pages.is_empty() {
        return Ok((None, None));
    }
    let mut page_manifests = Vec::new();
    let concurrency = visual_config.concurrency.max(1);
    for chunk in rendered_pages
        .iter()
        .enumerate()
        .collect::<Vec<_>>()
        .chunks(concurrency)
    {
        let mut handles = Vec::new();
        for (index, rendered_path) in chunk {
            let config = visual_config.clone();
            let source_id = source_id.to_string();
            let relative_path = relative_path.to_string();
            let source_path = path.to_path_buf();
            let rendered_path = (*rendered_path).clone();
            let page_count = rendered_pages.len() as i64;
            let page_number = (*index + 1) as i64;
            handles.push(std::thread::spawn(move || {
                let unit = visual_manifest::VisualSourceUnit::pdf_page(
                    &source_id,
                    &relative_path,
                    &source_path,
                    &rendered_path,
                    page_number,
                    page_count,
                );
                visual_llm::analyze_visual_source(&rendered_path, &unit, &config)
                    .map(|manifest| (page_number, manifest))
            }));
        }
        for handle in handles {
            let result = handle
                .join()
                .map_err(|_| "visual PDF page analysis thread panicked".to_string())??;
            page_manifests.push(result);
        }
    }
    page_manifests.sort_by_key(|(page_number, _)| *page_number);
    let mut sections = Vec::new();
    let mut manifests = Vec::new();
    for (page_number, manifest) in page_manifests {
        if let Some(mut page_sections) =
            visual_manifest::sections_from_manifest(&manifest, Some(page_number))
        {
            sections.append(&mut page_sections);
        }
        manifests.push(manifest);
    }
    let _ = pdf_pages::cleanup_rendered_pages(&rendered_pages);
    if sections.is_empty() {
        return Ok((None, Some(json!({ "pages": manifests }))));
    }
    Ok((Some(sections), Some(json!({ "pages": manifests }))))
}

fn parse_docx(path: &Path) -> Result<Option<Vec<ParsedSection>>, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    let mut xml = String::new();
    let mut entry = match archive.by_name("word/document.xml") {
        Ok(entry) => entry,
        Err(_) => return Ok(None),
    };
    entry
        .read_to_string(&mut xml)
        .map_err(|error| error.to_string())?;
    let text = strip_xml_tags(&xml);
    if text.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(vec![ParsedSection {
        strategy: "docx-zip-xml".to_string(),
        block_type: "docx-body".to_string(),
        section_path: vec!["body".to_string()],
        page: Some(1),
        language: detect_language(&text),
        text,
        content_origin: "native".to_string(),
        ocr_confidence: None,
        fallback_used: false,
        attachment_path: None,
    }]))
}

fn parse_pptx(path: &Path) -> Result<Option<Vec<ParsedSection>>, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    let mut sections = Vec::new();
    let mut slide_names = archive
        .file_names()
        .filter(|name| name.starts_with("ppt/slides/slide") && name.ends_with(".xml"))
        .map(|name| name.to_string())
        .collect::<Vec<_>>();
    slide_names.sort();
    for (index, name) in slide_names.into_iter().enumerate() {
        let mut xml = String::new();
        let mut entry = archive.by_name(&name).map_err(|error| error.to_string())?;
        entry
            .read_to_string(&mut xml)
            .map_err(|error| error.to_string())?;
        let text = strip_xml_tags(&xml);
        if text.trim().is_empty() {
            continue;
        }
        sections.push(ParsedSection {
            strategy: "pptx-zip-xml".to_string(),
            block_type: "ppt-slide".to_string(),
            section_path: vec!["slide".to_string(), format!("{}", index + 1)],
            page: Some((index + 1) as i64),
            language: detect_language(&text),
            text,
            content_origin: "native".to_string(),
            ocr_confidence: None,
            fallback_used: false,
            attachment_path: None,
        });
    }
    if sections.is_empty() {
        return Ok(None);
    }
    Ok(Some(sections))
}

fn parse_xlsx(path: &Path) -> Result<Option<Vec<ParsedSection>>, String> {
    let mut workbook = open_workbook_auto(path).map_err(|error| error.to_string())?;
    let sheet_names = workbook.sheet_names().to_vec();
    let mut sections = Vec::new();
    for sheet_name in sheet_names {
        let range = match workbook.worksheet_range(&sheet_name) {
            Ok(range) => range,
            Err(_) => continue,
        };
        if range.is_empty() {
            continue;
        }
        let mut rows = Vec::new();
        for row in range.rows() {
            let cells = row
                .iter()
                .map(data_to_string)
                .collect::<Vec<_>>()
                .join("\t");
            if !cells.trim().is_empty() {
                rows.push(cells);
            }
        }
        let text = rows.join("\n");
        if text.trim().is_empty() {
            continue;
        }
        sections.push(ParsedSection {
            strategy: "xlsx-calamine".to_string(),
            block_type: "xlsx-sheet".to_string(),
            section_path: vec!["sheet".to_string(), sheet_name.clone()],
            page: None,
            language: detect_language(&text),
            text,
            content_origin: "native".to_string(),
            ocr_confidence: None,
            fallback_used: false,
            attachment_path: None,
        });
    }
    if sections.is_empty() {
        return Ok(None);
    }
    Ok(Some(sections))
}

fn parse_eml(path: &Path) -> Result<Option<Vec<ParsedSection>>, String> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::InvalidData => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let normalized = content.replace("\r\n", "\n");
    let mut headers = Vec::new();
    let mut body = String::new();
    let mut in_body = false;
    let mut attachments = Vec::new();
    for line in normalized.lines() {
        if !in_body {
            if line.trim().is_empty() {
                in_body = true;
                continue;
            }
            headers.push(line.to_string());
            if let Some(filename) = extract_header_value(line, "filename=") {
                attachments.push(filename);
            }
        } else {
            body.push_str(line);
            body.push('\n');
        }
    }
    let subject = headers
        .iter()
        .find_map(|line| extract_header_value(line, "Subject:"))
        .unwrap_or_else(|| "Email".to_string());
    let text = if body.contains('<') && body.contains('>') {
        strip_xml_tags(&body)
    } else {
        body
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    let mut sections = vec![ParsedSection {
        strategy: "eml-basic".to_string(),
        block_type: "email-body".to_string(),
        section_path: vec!["body".to_string()],
        page: None,
        language: detect_language(&text),
        text,
        content_origin: "native".to_string(),
        ocr_confidence: None,
        fallback_used: false,
        attachment_path: None,
    }];
    for attachment in attachments {
        sections.push(ParsedSection {
            strategy: "eml-basic".to_string(),
            block_type: "email-attachment".to_string(),
            section_path: vec!["attachment".to_string(), attachment.clone()],
            page: None,
            language: None,
            text: format!("Attachment: {attachment}"),
            content_origin: "native".to_string(),
            ocr_confidence: None,
            fallback_used: false,
            attachment_path: Some(attachment),
        });
    }
    sections[0].section_path.insert(0, subject);
    Ok(Some(sections))
}

fn parse_zip(path: &Path) -> Result<Option<Vec<ParsedSection>>, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    let mut sections = Vec::new();
    let mut processed = 0usize;
    for index in 0..archive.len() {
        if processed >= MAX_ZIP_ENTRIES {
            break;
        }
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if entry.is_dir() || entry.size() > MAX_ZIP_ENTRY_BYTES {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        let extension = name
            .rsplit('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !matches!(
            extension.as_str(),
            "txt"
                | "md"
                | "markdown"
                | "html"
                | "htm"
                | "csv"
                | "tsv"
                | "json"
                | "yaml"
                | "yml"
                | "xml"
                | "eml"
                | "docx"
                | "pptx"
        ) {
            continue;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if let Some(inner_sections) = parse_zip_entry_bytes(&name, &bytes)? {
            for mut section in inner_sections {
                section.section_path.insert(0, "attachment".to_string());
                section.section_path.insert(1, name.clone());
                section.attachment_path = Some(name.clone());
                sections.push(section);
            }
            processed += 1;
        }
    }
    if sections.is_empty() {
        return Ok(None);
    }
    Ok(Some(sections))
}

fn parse_zip_entry_bytes(name: &str, bytes: &[u8]) -> Result<Option<Vec<ParsedSection>>, String> {
    let extension = name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "txt" | "md" | "markdown" | "csv" | "tsv" | "json" | "yaml" | "yml" | "xml" => {
            let text = String::from_utf8(bytes.to_vec()).ok();
            Ok(text.filter(|value| !value.trim().is_empty()).map(|text| {
                vec![ParsedSection {
                    strategy: "zip-text".to_string(),
                    block_type: extension.to_string(),
                    section_path: vec!["body".to_string()],
                    page: Some(1),
                    language: detect_language(&text),
                    text,
                    content_origin: "native".to_string(),
                    ocr_confidence: None,
                    fallback_used: false,
                    attachment_path: Some(name.to_string()),
                }]
            }))
        }
        "html" | "htm" => {
            let text = String::from_utf8(bytes.to_vec())
                .ok()
                .map(|value| strip_xml_tags(&value));
            Ok(text.filter(|value| !value.trim().is_empty()).map(|text| {
                vec![ParsedSection {
                    strategy: "zip-html".to_string(),
                    block_type: "html".to_string(),
                    section_path: vec!["body".to_string()],
                    page: Some(1),
                    language: detect_language(&text),
                    text,
                    content_origin: "native".to_string(),
                    ocr_confidence: None,
                    fallback_used: false,
                    attachment_path: Some(name.to_string()),
                }]
            }))
        }
        "eml" => parse_eml_bytes(name, bytes),
        "docx" => parse_docx_bytes(name, bytes),
        "pptx" => parse_pptx_bytes(name, bytes),
        _ => Ok(None),
    }
}

fn parse_eml_bytes(name: &str, bytes: &[u8]) -> Result<Option<Vec<ParsedSection>>, String> {
    let content = String::from_utf8(bytes.to_vec()).ok();
    let Some(content) = content else {
        return Ok(None);
    };
    let temp = std::env::temp_dir().join(format!("redbox-eml-{}", sanitize_temp_name(name)));
    fs::write(&temp, content).map_err(|error| error.to_string())?;
    let parsed = parse_eml(&temp);
    let _ = fs::remove_file(&temp);
    parsed
}

fn parse_docx_bytes(name: &str, bytes: &[u8]) -> Result<Option<Vec<ParsedSection>>, String> {
    let cursor = Cursor::new(bytes.to_vec());
    let mut archive = zip::ZipArchive::new(cursor).map_err(|error| error.to_string())?;
    let mut xml = String::new();
    let mut entry = match archive.by_name("word/document.xml") {
        Ok(entry) => entry,
        Err(_) => return Ok(None),
    };
    entry
        .read_to_string(&mut xml)
        .map_err(|error| error.to_string())?;
    let text = strip_xml_tags(&xml);
    if text.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(vec![ParsedSection {
        strategy: "zip-docx".to_string(),
        block_type: "docx-body".to_string(),
        section_path: vec!["body".to_string(), name.to_string()],
        page: Some(1),
        language: detect_language(&text),
        text,
        content_origin: "native".to_string(),
        ocr_confidence: None,
        fallback_used: false,
        attachment_path: Some(name.to_string()),
    }]))
}

fn parse_pptx_bytes(name: &str, bytes: &[u8]) -> Result<Option<Vec<ParsedSection>>, String> {
    let cursor = Cursor::new(bytes.to_vec());
    let mut archive = zip::ZipArchive::new(cursor).map_err(|error| error.to_string())?;
    let mut sections = Vec::new();
    let mut slide_names = archive
        .file_names()
        .filter(|entry| entry.starts_with("ppt/slides/slide") && entry.ends_with(".xml"))
        .map(|entry| entry.to_string())
        .collect::<Vec<_>>();
    slide_names.sort();
    for (index, slide_name) in slide_names.into_iter().enumerate() {
        let mut xml = String::new();
        let mut entry = archive
            .by_name(&slide_name)
            .map_err(|error| error.to_string())?;
        entry
            .read_to_string(&mut xml)
            .map_err(|error| error.to_string())?;
        let text = strip_xml_tags(&xml);
        if text.trim().is_empty() {
            continue;
        }
        sections.push(ParsedSection {
            strategy: "zip-pptx".to_string(),
            block_type: "ppt-slide".to_string(),
            section_path: vec![
                "slide".to_string(),
                format!("{}", index + 1),
                name.to_string(),
            ],
            page: Some((index + 1) as i64),
            language: detect_language(&text),
            text,
            content_origin: "native".to_string(),
            ocr_confidence: None,
            fallback_used: false,
            attachment_path: Some(name.to_string()),
        });
    }
    if sections.is_empty() {
        return Ok(None);
    }
    Ok(Some(sections))
}

fn extract_header_value(line: &str, prefix: &str) -> Option<String> {
    if let Some(value) = line.strip_prefix(prefix) {
        return Some(value.trim().trim_matches('"').to_string());
    }
    line.find(prefix).map(|index| {
        line[index + prefix.len()..]
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .trim_matches('"')
            .to_string()
    })
}

fn sanitize_temp_name(name: &str) -> String {
    name.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect()
}

fn data_to_string(value: &Data) -> String {
    match value {
        Data::Empty => String::new(),
        Data::String(text) => text.clone(),
        Data::Float(number) => number.to_string(),
        Data::Int(number) => number.to_string(),
        Data::Bool(flag) => flag.to_string(),
        Data::DateTime(value) => value.to_string(),
        Data::DateTimeIso(text) => text.clone(),
        Data::DurationIso(text) => text.clone(),
        Data::Error(error) => format!("{error:?}"),
    }
}

fn split_into_canonical_blocks(
    input: &str,
    block_type: &str,
    section_path: &[String],
    page: Option<i64>,
    language: Option<String>,
    content_origin: &str,
    ocr_confidence: Option<f64>,
) -> Vec<CanonicalBlock> {
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
            && (is_separator
                || current_lines.len() >= MAX_CANONICAL_BLOCK_LINES
                || next_chars >= MAX_CANONICAL_BLOCK_CHARS);
        if should_flush {
            blocks.push(CanonicalBlock {
                block_type: block_type.to_string(),
                section_path: section_path.to_vec(),
                page,
                line_start: block_start as i64,
                line_end: line_no.saturating_sub(1) as i64,
                text: current_lines.join("\n"),
                language: language.clone(),
                content_origin: content_origin.to_string(),
                ocr_confidence,
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
        blocks.push(CanonicalBlock {
            block_type: block_type.to_string(),
            section_path: section_path.to_vec(),
            page,
            line_start: block_start as i64,
            line_end: line_no as i64,
            text: current_lines.join("\n"),
            language,
            content_origin: content_origin.to_string(),
            ocr_confidence,
        });
    }
    blocks
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

fn detect_language(input: &str) -> Option<String> {
    let chinese = input
        .chars()
        .filter(|ch| ('\u{4e00}'..='\u{9fff}').contains(ch))
        .count();
    let ascii = input.chars().filter(|ch| ch.is_ascii_alphabetic()).count();
    if chinese == 0 && ascii == 0 {
        return None;
    }
    if chinese >= 4 && ascii >= 12 {
        return Some("multilingual".to_string());
    }
    if chinese >= ascii {
        Some("zh".to_string())
    } else {
        Some("en".to_string())
    }
}

fn dominant_language(blocks: &[CanonicalBlock]) -> Option<String> {
    let mut zh = 0usize;
    let mut en = 0usize;
    for block in blocks {
        match block.language.as_deref() {
            Some("zh") => zh += 1,
            Some("en") => en += 1,
            Some("multilingual") => {
                zh += 1;
                en += 1;
            }
            _ => {}
        }
    }
    if zh == 0 && en == 0 {
        None
    } else if zh > 0 && en > 0 && zh.abs_diff(en) <= 1 {
        Some("multilingual".to_string())
    } else if zh >= en {
        Some("zh".to_string())
    } else {
        Some("en".to_string())
    }
}

fn dominant_content_origin(blocks: &[CanonicalBlock]) -> String {
    let native = blocks
        .iter()
        .filter(|block| block.content_origin == "native")
        .count();
    let visual = blocks
        .iter()
        .filter(|block| block.content_origin == "visual_llm")
        .count();
    let ocr = blocks
        .iter()
        .filter(|block| block.content_origin == "ocr")
        .count();
    if [native, visual, ocr]
        .into_iter()
        .filter(|count| *count > 0)
        .count()
        > 1
    {
        "mixed".to_string()
    } else if visual > 0 {
        "visual_llm".to_string()
    } else if ocr > 0 {
        "ocr".to_string()
    } else {
        "native".to_string()
    }
}

fn average_ocr_confidence(blocks: &[CanonicalBlock]) -> Option<f64> {
    let values = blocks
        .iter()
        .filter_map(|block| block.ocr_confidence)
        .collect::<Vec<_>>();
    if values.is_empty() {
        return None;
    }
    Some(values.iter().sum::<f64>() / values.len() as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_minimal_pptx(path: &Path, text: &str) {
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::default();
        zip.start_file("[Content_Types].xml", options).unwrap();
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>"#).unwrap();
        zip.start_file("ppt/slides/slide1.xml", options).unwrap();
        zip.write_all(
            format!(
                r#"<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><a:t xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">{text}</a:t></p:spTree></p:cSld></p:sld>"#
            )
            .as_bytes(),
        )
        .unwrap();
        zip.finish().unwrap();
    }

    fn write_minimal_xlsx(path: &Path, text: &str) {
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::default();
        zip.start_file("[Content_Types].xml", options).unwrap();
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#).unwrap();
        zip.start_file("_rels/.rels", options).unwrap();
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#).unwrap();
        zip.start_file("xl/workbook.xml", options).unwrap();
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#).unwrap();
        zip.start_file("xl/_rels/workbook.xml.rels", options)
            .unwrap();
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#).unwrap();
        zip.start_file("xl/worksheets/sheet1.xml", options).unwrap();
        zip.write_all(
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>{text}</t></is></c></row></sheetData></worksheet>"#
            )
            .as_bytes(),
        )
        .unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn parses_pptx_slides() {
        let unique = format!(
            "redbox-pptx-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("sample.pptx");
        write_minimal_pptx(&path, "Hello Slide");

        let parsed = parse_pptx(&path).unwrap().unwrap();
        assert!(parsed[0].text.contains("Hello Slide"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parses_basic_eml_body() {
        let unique = format!(
            "redbox-eml-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("sample.eml");
        fs::write(
            &path,
            "Subject: Contract Update\nContent-Type: text/plain\n\nThis is the email body.",
        )
        .unwrap();

        let parsed = parse_eml(&path).unwrap().unwrap();
        assert!(parsed[0].text.contains("email body"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parses_xlsx_sheet_text() {
        let unique = format!(
            "redbox-xlsx-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("sample.xlsx");
        write_minimal_xlsx(&path, "Hello Sheet");

        let parsed = parse_xlsx(&path).unwrap().unwrap();
        assert!(parsed[0].text.contains("Hello Sheet"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parses_zip_text_attachments() {
        let unique = format!(
            "redbox-zip-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("bundle.zip");
        let file = fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::default();
        zip.start_file("notes.txt", options).unwrap();
        zip.write_all(b"zip attachment body").unwrap();
        zip.finish().unwrap();

        let parsed = parse_zip(&path).unwrap().unwrap();
        assert!(parsed
            .iter()
            .any(|section| section.text.contains("zip attachment body")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parse_path_extracts_legal_metadata_and_multilingual_language() {
        let unique = format!(
            "redbox-legal-meta-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("中华人民共和国民法典.md");
        fs::write(
            &path,
            "全国人民代表大会发布。\n自2021年1月1日起施行。\nContract breach 合同违约规则。",
        )
        .unwrap();

        let parsed = parse_path(
            "source-1",
            &root,
            &path,
            &VisualIndexConfig::default(),
            &ParserProviderConfig::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(parsed.language.as_deref(), Some("multilingual"));
        assert_eq!(parsed.legal_metadata.document_type.as_deref(), Some("law"));
        assert_eq!(
            parsed.legal_metadata.authority.as_deref(),
            Some("全国人民代表大会")
        );
        assert_eq!(
            parsed.legal_metadata.effective_date.as_deref(),
            Some("2021-01-01")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn external_parser_response_maps_blocks_to_sections() {
        let response = json!({
            "blocks": [{
                "text": "第一条 合同解除。",
                "blockType": "article",
                "sectionPath": ["民法典", "合同编"],
                "page": 3,
                "language": "zh"
            }]
        });
        let sections = parse_external_parser_response("docling", false, &response)
            .unwrap()
            .unwrap();

        assert_eq!(sections[0].strategy, "docling");
        assert_eq!(sections[0].block_type, "article");
        assert_eq!(sections[0].section_path, vec!["民法典", "合同编"]);
        assert_eq!(sections[0].page, Some(3));
        assert!(!sections[0].fallback_used);
    }
}
