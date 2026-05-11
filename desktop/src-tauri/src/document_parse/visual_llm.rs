use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

use super::visual_manifest::{
    DEFAULT_PROMPT_VERSION, VisualSourceUnit, metadata_only_manifest, normalize_manifest,
};

#[derive(Debug, Clone)]
pub(crate) struct VisualIndexConfig {
    pub enabled: bool,
    pub endpoint: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub prompt_version: String,
    pub timeout_seconds: u64,
    pub max_image_edge: u32,
    pub skip_small_images: bool,
    pub pdf_max_pages: usize,
    pub pdf_render_dpi: u32,
    pub concurrency: usize,
}

impl Default for VisualIndexConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: None,
            api_key: None,
            model: None,
            prompt_version: DEFAULT_PROMPT_VERSION.to_string(),
            timeout_seconds: 90,
            max_image_edge: 1536,
            skip_small_images: true,
            pdf_max_pages: 12,
            pdf_render_dpi: 144,
            concurrency: 1,
        }
    }
}

impl VisualIndexConfig {
    pub(crate) fn has_callable_model(&self) -> bool {
        self.enabled
            && self
                .endpoint
                .as_deref()
                .map(str::trim)
                .is_some_and(|value| !value.is_empty())
            && self
                .model
                .as_deref()
                .map(str::trim)
                .is_some_and(|value| !value.is_empty())
    }

    pub(crate) fn endpoint_hash(&self) -> Option<String> {
        self.endpoint
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(stable_hash)
    }

    pub(crate) fn model_name(&self) -> Option<&str> {
        self.model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }

    pub(crate) fn payload_policy_version(&self) -> String {
        format!(
            "visual-payload-v1-edge-{}-pdfdpi-{}-pdfpages-{}-skip-small-{}",
            self.max_image_edge, self.pdf_render_dpi, self.pdf_max_pages, self.skip_small_images
        )
    }

    pub(crate) fn config_signature(&self) -> String {
        stable_hash(&format!(
            "endpoint={};model={};prompt={};payload={}",
            self.endpoint_hash().unwrap_or_default(),
            self.model_name().unwrap_or_default(),
            self.prompt_version,
            self.payload_policy_version()
        ))
    }
}

pub(super) fn analyze_visual_source(
    image_path: &Path,
    unit: &VisualSourceUnit,
    config: &VisualIndexConfig,
) -> Result<Value, String> {
    if !config.enabled {
        return Ok(stamp_manifest_config(
            metadata_only_manifest(
                unit,
                config.model.as_deref(),
                &config.prompt_version,
                Some("visual index is disabled".to_string()),
            ),
            config,
            config.model_name(),
        ));
    }
    if config.skip_small_images {
        if let (Some(width), Some(height)) = (unit.width, unit.height) {
            if width < 64 || height < 64 {
                return Ok(stamp_manifest_config(
                    metadata_only_manifest(
                        unit,
                        config.model.as_deref(),
                        &config.prompt_version,
                        Some("image is below visual index size threshold".to_string()),
                    ),
                    config,
                    config.model_name(),
                ));
            }
        }
    }
    let Some(endpoint) = config
        .endpoint
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(stamp_manifest_config(
            metadata_only_manifest(
                unit,
                config.model.as_deref(),
                &config.prompt_version,
                Some("visual index endpoint is not configured".to_string()),
            ),
            config,
            config.model_name(),
        ));
    };
    let Some(model) = config
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(stamp_manifest_config(
            metadata_only_manifest(
                unit,
                None,
                &config.prompt_version,
                Some("visual index model is not configured".to_string()),
            ),
            config,
            None,
        ));
    };
    let payload = match visual_payload_for_model(image_path, unit, config.max_image_edge) {
        Ok(payload) => payload,
        Err(error) => {
            visual_index_log(format!(
                "payload_failed unit={} kind={} source={} path={} error={}",
                unit.unit_id,
                unit.unit_kind,
                unit.source_id,
                unit.relative_path,
                truncate_log_value(&error, 320)
            ));
            return Ok(stamp_manifest_config(
                metadata_only_manifest(
                    unit,
                    Some(model),
                    &config.prompt_version,
                    Some(format!("visual payload preparation failed: {error}")),
                ),
                config,
                Some(model),
            ));
        }
    };
    let timeout_seconds = config.timeout_seconds.clamp(10, 300);
    let endpoint_url = normalize_chat_completions_endpoint(endpoint);
    let payload_hash = stable_hash_bytes(&payload.bytes);
    visual_index_log(format!(
        "request_start unit={} kind={} source={} path={} page={} model={} endpointHash={} mime={} bytes={} payloadHash={} size={} timeout={}s",
        unit.unit_id,
        unit.unit_kind,
        unit.source_id,
        unit.relative_path,
        unit.page_number
            .map(|value| value.to_string())
            .unwrap_or_else(|| "-".to_string()),
        model,
        config.endpoint_hash().unwrap_or_else(|| "-".to_string()),
        payload.mime_type,
        payload.bytes.len(),
        payload_hash,
        format_unit_size(unit),
        timeout_seconds
    ));
    let data_url = format!(
        "data:{};base64,{}",
        payload.mime_type,
        base64::engine::general_purpose::STANDARD.encode(&payload.bytes)
    );
    let body = json!({
        "model": model,
        "temperature": 0.1,
        "response_format": { "type": "json_object" },
        "messages": [
            {
                "role": "system",
                "content": visual_manifest_system_prompt(&config.prompt_version)
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": format!(
                            "Create a visual semantic manifest for this source unit. Source metadata JSON: {}",
                            serde_json::to_string(unit).unwrap_or_default()
                        )
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": data_url,
                            "detail": detail_for_edge(config.max_image_edge)
                        }
                    }
                ]
            }
        ]
    });
    let response = crate::run_curl_json_response(
        "POST",
        &endpoint_url,
        config.api_key.as_deref(),
        &[],
        Some(body),
        Some(timeout_seconds),
    );
    let response = match response {
        Ok(response) => {
            visual_index_log(format!(
                "request_done unit={} status={} responseBytes={} responsePreview={}",
                unit.unit_id,
                response.status,
                json_text_len(&response.body),
                json_preview(&response.body, 420)
            ));
            response
        }
        Err(error) => {
            visual_index_log(format!(
                "request_failed unit={} kind={} source={} path={} error={}",
                unit.unit_id,
                unit.unit_kind,
                unit.source_id,
                unit.relative_path,
                truncate_log_value(&error, 420)
            ));
            return Ok(stamp_manifest_config(
                metadata_only_manifest(
                    unit,
                    Some(model),
                    &config.prompt_version,
                    Some(format!("visual model request failed: {error}")),
                ),
                config,
                Some(model),
            ));
        }
    };
    if !(200..300).contains(&response.status) {
        let preview = json_preview(&response.body, 420);
        visual_index_log(format!(
            "request_http_error unit={} status={} responsePreview={}",
            unit.unit_id, response.status, preview
        ));
        return Ok(stamp_manifest_config(
            metadata_only_manifest(
                unit,
                Some(model),
                &config.prompt_version,
                Some(format!(
                    "visual model request failed: HTTP {}; body: {}",
                    response.status, preview
                )),
            ),
            config,
            Some(model),
        ));
    }
    let value = extract_manifest_json(&response.body).unwrap_or_else(|| {
        visual_index_log(format!(
            "manifest_missing unit={} status={} responsePreview={}",
            unit.unit_id,
            response.status,
            json_preview(&response.body, 420)
        ));
        metadata_only_manifest(
            unit,
            Some(model),
            &config.prompt_version,
            Some(format!(
                "visual model response did not contain JSON manifest; HTTP {}",
                response.status
            )),
        )
    });
    let manifest = normalize_manifest(value, unit);
    visual_index_log(format!(
        "manifest_ready unit={} status={} facts={} retrieval={} warnings={}",
        unit.unit_id,
        response.status,
        array_len_at(&manifest, "factBlocks"),
        array_len_at(&manifest, "retrievalProjection"),
        manifest
            .get("analysis")
            .and_then(|analysis| analysis.get("warnings"))
            .and_then(Value::as_array)
            .map(|value| value.len())
            .unwrap_or(0)
    ));
    Ok(stamp_manifest_config(manifest, config, Some(model)))
}

fn stamp_manifest_config(
    mut manifest: Value,
    config: &VisualIndexConfig,
    model: Option<&str>,
) -> Value {
    if !manifest.get("analysis").is_some_and(Value::is_object) {
        manifest["analysis"] = json!({});
    }
    if let Some(model) = model {
        manifest["analysis"]["model"] = json!(model);
    }
    manifest["analysis"]["promptVersion"] = json!(config.prompt_version);
    manifest["analysis"]["provider"] = json!("openai-compatible-chat-completions");
    manifest["analysis"]["endpointHash"] = json!(config.endpoint_hash());
    manifest["analysis"]["payloadPolicyVersion"] = json!(config.payload_policy_version());
    manifest["analysis"]["configSignature"] = json!(config.config_signature());
    manifest
}

fn stable_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let hash = hasher.finalize();
    hash[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn stable_hash_bytes(value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value);
    let hash = hasher.finalize();
    hash[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn visual_index_log(message: impl Into<String>) {
    let line = format!("[visual-index] {}", message.into());
    eprintln!("{line}");
    crate::append_debug_trace_global(line);
}

fn format_unit_size(unit: &VisualSourceUnit) -> String {
    match (unit.width, unit.height) {
        (Some(width), Some(height)) => format!("{width}x{height}"),
        _ => "unknown".to_string(),
    }
}

fn json_text_len(value: &Value) -> usize {
    serde_json::to_string(value)
        .map(|text| text.chars().count())
        .unwrap_or(0)
}

fn json_preview(value: &Value, limit: usize) -> String {
    let raw = serde_json::to_string(value).unwrap_or_else(|_| value.to_string());
    truncate_log_value(&crate::redact_debug_data_urls(&raw), limit)
}

fn truncate_log_value(raw: &str, limit: usize) -> String {
    let trimmed = raw.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let prefix = trimmed.chars().take(limit).collect::<String>();
    format!("{prefix}...")
}

fn array_len_at(value: &Value, key: &str) -> usize {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
struct VisualModelPayload {
    mime_type: String,
    bytes: Vec<u8>,
}

fn visual_payload_for_model(
    image_path: &Path,
    unit: &VisualSourceUnit,
    max_image_edge: u32,
) -> Result<VisualModelPayload, String> {
    let bytes = fs::read(image_path).map_err(|error| error.to_string())?;
    let bounded_edge = max_image_edge.max(64);
    let should_resize = match (unit.width, unit.height) {
        (Some(width), Some(height)) => width.max(height) > bounded_edge,
        _ => false,
    };
    if !should_resize {
        return Ok(VisualModelPayload {
            mime_type: unit.mime_type.clone(),
            bytes,
        });
    }
    let Ok(image) = image::load_from_memory(&bytes) else {
        return Ok(VisualModelPayload {
            mime_type: unit.mime_type.clone(),
            bytes,
        });
    };
    let resized = image.thumbnail(bounded_edge, bounded_edge);
    let mut encoded = Vec::new();
    JpegEncoder::new_with_quality(&mut encoded, 85)
        .encode_image(&resized)
        .map_err(|error| format!("failed to encode resized visual payload: {error}"))?;
    Ok(VisualModelPayload {
        mime_type: "image/jpeg".to_string(),
        bytes: encoded,
    })
}

fn visual_manifest_system_prompt(prompt_version: &str) -> String {
    format!(
        r#"你是视觉索引编制器。只返回严格 JSON，schemaVersion 必须是 redbox.visual_manifest.v1。
你需要用多模态视觉理解来描述图片、扫描型 PDF 页面、截图、图表、海报、商品图、UI、表格和其他视觉内容。

语言规则非常重要：
- 除图片中实际可见的文字/OCR 文字以外，所有由你生成的描述、摘要、标题、标签、关键词、检索短语、疑点都必须使用简体中文。
- 图片里看到的原文必须原样保留，不能翻译、改写或纠错；把它放入 kind=visible_text 的 factBlocks 和 purpose=visible_text 的 retrievalProjection。
- 如果可见文字不是中文，可以在同一个 visible_text projection 中追加简短中文说明和中文关键词，但原文必须一字不差保留。
- 没有文字的风景、人物、物品、截图、图表也必须生成可检索的中文自然语言描述，覆盖主体、场景、布局、风格、颜色、情绪、用途、可能的搜索词。
- summary.languageHints 至少包含 "zh-CN"，如果图片里有其他语言文字，也把对应语言加入。

使用这个稳定的顶层结构：
{{
  "schemaVersion": "redbox.visual_manifest.v1",
  "documentKind": "visual_semantic_manifest",
  "analysis": {{"promptVersion": "{prompt_version}", "processingMode": "visual_llm"}},
  "summary": {{"title": "...", "short": "...", "detailed": "...", "languageHints": []}},
  "visualTypes": [{{"type": "scene|document|chart|table|ui|diagram|poster|product|other", "confidence": 0.0}}],
  "factBlocks": [{{"id": "fact_1", "kind": "scene|visible_text|layout|style|object|chart|table|ui|document", "title": "...", "text": "...", "confidence": 0.0}}],
  "retrievalProjection": [{{"id": "rp_1", "purpose": "scene|visible_text|style|usage|document|chart|table|ui|metadata", "text": "...", "keywords": [], "evidenceIds": []}}],
  "tags": [],
  "uncertainties": []
}}
每个 retrievalProjection.text 都必须是适合全文检索的自然语言。keywords 优先写中文搜索词；只有在保留图片可见原文、品牌名、文件名、代码、英文专有名词时才使用非中文。"#
    )
}

fn detail_for_edge(max_image_edge: u32) -> &'static str {
    if max_image_edge <= 1024 {
        "low"
    } else {
        "high"
    }
}

fn normalize_chat_completions_endpoint(endpoint: &str) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

fn extract_manifest_json(response: &Value) -> Option<Value> {
    if response.get("schemaVersion").and_then(Value::as_str) == Some("redbox.visual_manifest.v1") {
        return Some(response.clone());
    }
    let content = response
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"));
    match content {
        Some(Value::String(text)) => parse_json_from_text(text),
        Some(Value::Array(parts)) => parts.iter().find_map(|part| {
            part.get("text")
                .or_else(|| part.get("output_text"))
                .and_then(Value::as_str)
                .and_then(parse_json_from_text)
        }),
        _ => response
            .get("output_text")
            .and_then(Value::as_str)
            .and_then(parse_json_from_text),
    }
}

fn parse_json_from_text(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Some(value);
    }
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    serde_json::from_str::<Value>(&trimmed[start..=end]).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_base_endpoint_to_chat_completions() {
        assert_eq!(
            normalize_chat_completions_endpoint("https://api.example.com/v1"),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            normalize_chat_completions_endpoint("https://api.example.com/v1/chat/completions"),
            "https://api.example.com/v1/chat/completions"
        );
    }

    #[test]
    fn disabled_visual_index_returns_metadata_only_without_reading_source() {
        let missing_path = Path::new("/tmp/redbox-visual-index-disabled-missing.png");
        let unit = VisualSourceUnit::image_file("source-1", "missing.png", missing_path);
        let manifest = analyze_visual_source(missing_path, &unit, &VisualIndexConfig::default())
            .expect("metadata manifest");

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
            Some("visual index is disabled")
        );
        let expected_signature = VisualIndexConfig::default().config_signature();
        assert_eq!(
            manifest
                .get("analysis")
                .and_then(|analysis| analysis.get("configSignature"))
                .and_then(Value::as_str),
            Some(expected_signature.as_str())
        );
    }

    #[test]
    fn missing_visual_endpoint_returns_metadata_only_without_reading_source() {
        let missing_path = Path::new("/tmp/redbox-visual-index-no-endpoint-missing.png");
        let unit = VisualSourceUnit::image_file("source-1", "missing.png", missing_path);
        let config = VisualIndexConfig {
            enabled: true,
            model: Some("vision-small".to_string()),
            ..VisualIndexConfig::default()
        };
        let manifest =
            analyze_visual_source(missing_path, &unit, &config).expect("metadata manifest");

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
            Some("visual index endpoint is not configured")
        );
    }

    #[test]
    fn extracts_manifest_from_chat_completion_string_content() {
        let response = json!({
            "choices": [{
                "message": {
                    "content": r#"{"schemaVersion":"redbox.visual_manifest.v1","summary":{"short":"snow lake"}}"#
                }
            }]
        });

        let manifest = extract_manifest_json(&response).expect("manifest");
        assert_eq!(
            manifest.get("schemaVersion").and_then(Value::as_str),
            Some("redbox.visual_manifest.v1")
        );
        assert_eq!(
            manifest
                .get("summary")
                .and_then(|summary| summary.get("short"))
                .and_then(Value::as_str),
            Some("snow lake")
        );
    }

    #[test]
    fn extracts_manifest_from_chat_completion_content_parts() {
        let response = json!({
            "choices": [{
                "message": {
                    "content": [
                        { "type": "text", "text": "ignore this" },
                        {
                            "type": "text",
                            "text": r#"{"schemaVersion":"redbox.visual_manifest.v1","summary":{"short":"visible poster"}}"#
                        }
                    ]
                }
            }]
        });

        let manifest = extract_manifest_json(&response).expect("manifest");
        assert_eq!(
            manifest
                .get("summary")
                .and_then(|summary| summary.get("short"))
                .and_then(Value::as_str),
            Some("visible poster")
        );
    }

    #[test]
    fn extracts_manifest_from_output_text_response() {
        let response = json!({
            "output_text": "prefix\n{\"schemaVersion\":\"redbox.visual_manifest.v1\",\"summary\":{\"short\":\"scanned page\"}}\n"
        });

        let manifest = extract_manifest_json(&response).expect("manifest");
        assert_eq!(
            manifest
                .get("summary")
                .and_then(|summary| summary.get("short"))
                .and_then(Value::as_str),
            Some("scanned page")
        );
    }

    #[test]
    fn visual_payload_resizes_large_images_for_model() {
        let path = std::env::temp_dir().join(format!(
            "redbox-visual-payload-{}-{}.png",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let image = image::RgbImage::from_pixel(2000, 1000, image::Rgb([12, 120, 220]));
        image.save(&path).expect("write test image");
        let unit = VisualSourceUnit::image_file("source-1", "large.png", &path);

        let payload = visual_payload_for_model(&path, &unit, 512).expect("payload");
        let decoded = image::load_from_memory(&payload.bytes).expect("decode resized payload");
        let _ = fs::remove_file(&path);

        assert_eq!(payload.mime_type, "image/jpeg");
        assert!(decoded.width().max(decoded.height()) <= 512);
    }
}
