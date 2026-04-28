use image::GenericImageView;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

use super::{detect_language, mime_type_for_path, ParsedSection};

pub(super) const VISUAL_SCHEMA_VERSION: &str = "redbox.visual_manifest.v1";
pub(super) const VISUAL_PARSER_NAME: &str = "redbox-visual-llm-indexer";
pub(super) const VISUAL_PARSER_VERSION: &str = "v1";
pub(super) const DEFAULT_PROMPT_VERSION: &str = "visual-manifest-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VisualSourceUnit {
    pub unit_id: String,
    pub unit_kind: String,
    pub document_id: String,
    pub source_document_id: String,
    pub source_id: String,
    pub relative_path: String,
    pub absolute_path: String,
    pub mime_type: String,
    pub content_hash: String,
    pub rendered_image_hash: Option<String>,
    pub page_number: Option<i64>,
    pub page_count: Option<i64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

impl VisualSourceUnit {
    pub(super) fn image_file(source_id: &str, relative_path: &str, path: &Path) -> Self {
        let source_document_id = format!("{source_id}:{relative_path}");
        let (width, height) = image_dimensions(path);
        let content_hash = file_hash(path).unwrap_or_default();
        let hash_fragment = short_hash(&content_hash);
        Self {
            unit_id: format!("{source_document_id}#image={hash_fragment}"),
            unit_kind: "image_file".to_string(),
            document_id: source_document_id.clone(),
            source_document_id,
            source_id: source_id.to_string(),
            relative_path: relative_path.to_string(),
            absolute_path: path.display().to_string(),
            mime_type: mime_type_for_path(path).to_string(),
            content_hash,
            rendered_image_hash: None,
            page_number: None,
            page_count: None,
            width,
            height,
        }
    }

    pub(super) fn pdf_page(
        source_id: &str,
        relative_path: &str,
        source_path: &Path,
        rendered_path: &Path,
        page_number: i64,
        page_count: i64,
    ) -> Self {
        let source_document_id = format!("{source_id}:{relative_path}");
        let document_id = format!("{source_document_id}#page={page_number}");
        let (width, height) = image_dimensions(rendered_path);
        let content_hash = file_hash(source_path).unwrap_or_default();
        let rendered_image_hash = file_hash(rendered_path);
        let source_hash_fragment = short_hash(&content_hash);
        let rendered_hash_fragment = short_hash(rendered_image_hash.as_deref().unwrap_or(""));
        Self {
            unit_id: format!(
                "{document_id}#source={source_hash_fragment}#render={rendered_hash_fragment}"
            ),
            unit_kind: "pdf_page".to_string(),
            document_id,
            source_document_id,
            source_id: source_id.to_string(),
            relative_path: format!("{relative_path}#page={page_number}"),
            absolute_path: source_path.display().to_string(),
            mime_type: "image/png".to_string(),
            content_hash,
            rendered_image_hash,
            page_number: Some(page_number),
            page_count: Some(page_count),
            width,
            height,
        }
    }
}

pub(super) fn metadata_only_manifest(
    unit: &VisualSourceUnit,
    model: Option<&str>,
    prompt_version: &str,
    warning: Option<String>,
) -> Value {
    let name = Path::new(&unit.relative_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&unit.relative_path);
    let dimensions = match (unit.width, unit.height) {
        (Some(width), Some(height)) => format!("{width}x{height}"),
        _ => "unknown dimensions".to_string(),
    };
    let text = if unit.unit_kind == "pdf_page" {
        format!(
            "Scanned PDF page image. File: {}. Page: {}. Dimensions: {}. Mime: {}.",
            unit.source_document_id,
            unit.page_number.unwrap_or(1),
            dimensions,
            unit.mime_type
        )
    } else {
        format!(
            "Image file. File: {name}. Path: {}. Dimensions: {}. Mime: {}.",
            unit.relative_path, dimensions, unit.mime_type
        )
    };
    json!({
        "schemaVersion": VISUAL_SCHEMA_VERSION,
        "documentKind": "visual_semantic_manifest",
        "source": unit,
        "analysis": {
            "parserName": VISUAL_PARSER_NAME,
            "parserVersion": VISUAL_PARSER_VERSION,
            "model": model.unwrap_or("metadata-only"),
            "promptVersion": prompt_version,
            "processingMode": "metadata_only",
            "warnings": warning.into_iter().collect::<Vec<_>>()
        },
        "summary": {
            "title": name,
            "short": text,
            "detailed": text,
            "languageHints": []
        },
        "visualTypes": [],
        "factBlocks": [{
            "id": "fact_metadata",
            "kind": "metadata",
            "title": "Source metadata",
            "text": text,
            "confidence": 1.0
        }],
        "retrievalProjection": [{
            "id": "rp_metadata",
            "purpose": "metadata",
            "text": text,
            "keywords": [name, unit.relative_path],
            "evidenceIds": ["fact_metadata"]
        }],
        "tags": [unit.unit_kind],
        "uncertainties": []
    })
}

pub(super) fn normalize_manifest(mut value: Value, unit: &VisualSourceUnit) -> Value {
    if !value.is_object() {
        return metadata_only_manifest(
            unit,
            None,
            DEFAULT_PROMPT_VERSION,
            Some("visual model returned a non-object manifest".to_string()),
        );
    }
    value["schemaVersion"] = json!(VISUAL_SCHEMA_VERSION);
    value["documentKind"] = json!("visual_semantic_manifest");
    value["source"] = json!(unit);
    if !value.get("analysis").is_some_and(Value::is_object) {
        value["analysis"] = json!({});
    }
    value["analysis"]["parserName"] = json!(VISUAL_PARSER_NAME);
    value["analysis"]["parserVersion"] = json!(VISUAL_PARSER_VERSION);
    if value["analysis"]
        .get("promptVersion")
        .and_then(Value::as_str)
        .is_none()
    {
        value["analysis"]["promptVersion"] = json!(DEFAULT_PROMPT_VERSION);
    }
    if value["analysis"]
        .get("processingMode")
        .and_then(Value::as_str)
        .is_none()
    {
        value["analysis"]["processingMode"] = json!("visual_llm");
    }
    if !value.get("summary").is_some_and(Value::is_object) {
        value["summary"] = json!({});
    }
    let fallback_title = Path::new(&unit.relative_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&unit.relative_path)
        .to_string();
    if value["summary"]
        .get("title")
        .and_then(Value::as_str)
        .is_none()
    {
        value["summary"]["title"] = json!(fallback_title);
    }
    let summary_text = first_string(
        &value["summary"],
        &["detailed", "short", "title", "description", "caption"],
    )
    .unwrap_or_else(|| fallback_summary(unit));
    if value["summary"]
        .get("short")
        .and_then(Value::as_str)
        .is_none()
    {
        value["summary"]["short"] = json!(summary_text.clone());
    }
    if value["summary"]
        .get("detailed")
        .and_then(Value::as_str)
        .is_none()
    {
        value["summary"]["detailed"] = json!(summary_text.clone());
    }
    if !value.get("factBlocks").is_some_and(Value::is_array) {
        value["factBlocks"] = json!([{
            "id": "fact_summary",
            "kind": "summary",
            "title": "Visual summary",
            "text": summary_text,
            "confidence": 0.5
        }]);
    }
    if !value
        .get("retrievalProjection")
        .is_some_and(Value::is_array)
    {
        value["retrievalProjection"] = json!([{
            "id": "rp_summary",
            "purpose": "summary",
            "text": summary_text,
            "keywords": [],
            "evidenceIds": ["fact_summary"]
        }]);
    }
    value
}

pub(super) fn sections_from_manifest(
    manifest: &Value,
    page: Option<i64>,
) -> Option<Vec<ParsedSection>> {
    let projections = manifest
        .get("retrievalProjection")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut sections = Vec::new();
    for (index, projection) in projections.iter().enumerate() {
        let purpose = projection
            .get("purpose")
            .and_then(Value::as_str)
            .unwrap_or("summary")
            .trim()
            .replace([' ', '/', '\\'], "_");
        let text = projection_text(projection);
        if text.trim().is_empty() {
            continue;
        }
        let id = projection
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("rp_{index}"));
        sections.push(ParsedSection {
            strategy: "visual-semantic-manifest".to_string(),
            block_type: format!("image.{purpose}"),
            section_path: vec!["visual".to_string(), purpose, id],
            page,
            language: detect_language(&text),
            text,
            content_origin: "visual_llm".to_string(),
            ocr_confidence: None,
            fallback_used: false,
            attachment_path: None,
        });
    }
    if sections.is_empty() {
        None
    } else {
        Some(sections)
    }
}

fn projection_text(projection: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(text) = projection.get("text").and_then(Value::as_str) {
        parts.push(text.trim().to_string());
    }
    if let Some(keywords) = projection.get("keywords").and_then(Value::as_array) {
        let keywords = keywords
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        if !keywords.is_empty() {
            parts.push(format!("关键词: {}", keywords.join(", ")));
        }
    }
    parts.join("\n")
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToString::to_string)
    })
}

fn fallback_summary(unit: &VisualSourceUnit) -> String {
    if unit.unit_kind == "pdf_page" {
        format!(
            "Scanned PDF page {} from {}.",
            unit.page_number.unwrap_or(1),
            unit.source_document_id
        )
    } else {
        format!("Image file {}.", unit.relative_path)
    }
}

fn image_dimensions(path: &Path) -> (Option<u32>, Option<u32>) {
    match image::open(path) {
        Ok(image) => {
            let (width, height) = image.dimensions();
            (Some(width), Some(height))
        }
        Err(_) => (None, None),
    }
}

fn file_hash(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Some(format!("{:x}", hasher.finalize()))
}

fn short_hash(hash: &str) -> &str {
    if hash.is_empty() {
        "unknown"
    } else {
        &hash[..hash.len().min(16)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "redbox-visual-manifest-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn normalizes_missing_manifest_fields_and_projects_sections() {
        let unit = VisualSourceUnit::image_file(
            "source-1",
            "photos/mountain.png",
            Path::new("/tmp/mountain.png"),
        );
        let manifest = normalize_manifest(
            json!({
                "summary": {
                    "short": "雪山、湖泊和森林构成的风景图"
                }
            }),
            &unit,
        );

        assert_eq!(
            manifest.get("schemaVersion").and_then(Value::as_str),
            Some(VISUAL_SCHEMA_VERSION)
        );
        assert_eq!(
            manifest
                .get("source")
                .and_then(|source| source.get("unitId"))
                .and_then(Value::as_str),
            Some("source-1:photos/mountain.png#image=unknown")
        );

        let sections = sections_from_manifest(&manifest, None).expect("sections");
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].content_origin, "visual_llm");
        assert_eq!(sections[0].ocr_confidence, None);
        assert!(sections[0].text.contains("雪山"));
    }

    #[test]
    fn non_object_manifest_falls_back_to_metadata_only_with_warning() {
        let unit = VisualSourceUnit::image_file(
            "source-1",
            "photos/mountain.png",
            Path::new("/tmp/mountain.png"),
        );
        let manifest = normalize_manifest(json!("not a manifest"), &unit);

        assert_eq!(
            manifest
                .get("analysis")
                .and_then(|analysis| analysis.get("processingMode"))
                .and_then(Value::as_str),
            Some("metadata_only")
        );
        assert_eq!(
            manifest
                .get("analysis")
                .and_then(|analysis| analysis.get("warnings"))
                .and_then(Value::as_array)
                .and_then(|warnings| warnings.first())
                .and_then(Value::as_str),
            Some("visual model returned a non-object manifest")
        );
    }

    #[test]
    fn pdf_page_unit_keeps_original_pdf_and_rendered_page_identity() {
        let unit = VisualSourceUnit::pdf_page(
            "source-1",
            "scans/contract.pdf",
            Path::new("/tmp/contract.pdf"),
            Path::new("/tmp/contract-page-1.png"),
            1,
            3,
        );

        assert_eq!(unit.unit_kind, "pdf_page");
        assert_eq!(
            unit.unit_id,
            "source-1:scans/contract.pdf#page=1#source=unknown#render=unknown"
        );
        assert_eq!(unit.source_document_id, "source-1:scans/contract.pdf");
        assert_eq!(unit.document_id, "source-1:scans/contract.pdf#page=1");
        assert_eq!(unit.page_number, Some(1));
        assert_eq!(unit.page_count, Some(3));
        assert_eq!(unit.absolute_path, "/tmp/contract.pdf");
    }

    #[test]
    fn pdf_page_rendered_hash_changes_unit_identity_without_changing_source_mapping() {
        let dir = unique_temp_dir("rendered-hash");
        fs::create_dir_all(&dir).expect("create temp dir");
        let source_path = dir.join("scan.pdf");
        let rendered_path_a = dir.join("page-a.png");
        let rendered_path_b = dir.join("page-b.png");
        fs::write(&source_path, b"%PDF-visual-source").expect("write source");
        image::RgbImage::from_pixel(32, 32, image::Rgb([255, 255, 255]))
            .save(&rendered_path_a)
            .expect("write rendered a");
        image::RgbImage::from_pixel(32, 32, image::Rgb([0, 0, 0]))
            .save(&rendered_path_b)
            .expect("write rendered b");

        let unit_a = VisualSourceUnit::pdf_page(
            "source-1",
            "scans/contract.pdf",
            &source_path,
            &rendered_path_a,
            3,
            5,
        );
        let unit_b = VisualSourceUnit::pdf_page(
            "source-1",
            "scans/contract.pdf",
            &source_path,
            &rendered_path_b,
            3,
            5,
        );
        let _ = fs::remove_dir_all(&dir);

        assert_ne!(unit_a.rendered_image_hash, unit_b.rendered_image_hash);
        assert_ne!(unit_a.unit_id, unit_b.unit_id);
        assert_eq!(unit_a.source_document_id, unit_b.source_document_id);
        assert_eq!(unit_a.page_number, Some(3));
        assert_eq!(unit_b.page_number, Some(3));
    }
}
