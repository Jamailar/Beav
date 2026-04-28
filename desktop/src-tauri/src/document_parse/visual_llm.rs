use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

use super::visual_manifest::{
    metadata_only_manifest, normalize_manifest, VisualSourceUnit, DEFAULT_PROMPT_VERSION,
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

pub(super) fn analyze_visual_source(
    image_path: &Path,
    unit: &VisualSourceUnit,
    config: &VisualIndexConfig,
) -> Result<Value, String> {
    if !config.enabled {
        return Ok(metadata_only_manifest(
            unit,
            config.model.as_deref(),
            &config.prompt_version,
            Some("visual index is disabled".to_string()),
        ));
    }
    if config.skip_small_images {
        if let (Some(width), Some(height)) = (unit.width, unit.height) {
            if width < 64 || height < 64 {
                return Ok(metadata_only_manifest(
                    unit,
                    config.model.as_deref(),
                    &config.prompt_version,
                    Some("image is below visual index size threshold".to_string()),
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
        return Ok(metadata_only_manifest(
            unit,
            config.model.as_deref(),
            &config.prompt_version,
            Some("visual index endpoint is not configured".to_string()),
        ));
    };
    let Some(model) = config
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(metadata_only_manifest(
            unit,
            None,
            &config.prompt_version,
            Some("visual index model is not configured".to_string()),
        ));
    };
    let payload = visual_payload_for_model(image_path, unit, config.max_image_edge)?;
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
    let response = crate::run_curl_json_with_timeout(
        "POST",
        &normalize_chat_completions_endpoint(endpoint),
        config.api_key.as_deref(),
        &[],
        Some(body),
        Some(config.timeout_seconds.clamp(10, 300)),
    );
    let value = match response {
        Ok(response) => extract_manifest_json(&response).unwrap_or_else(|| {
            metadata_only_manifest(
                unit,
                Some(model),
                &config.prompt_version,
                Some("visual model response did not contain JSON manifest".to_string()),
            )
        }),
        Err(error) => {
            return Ok(metadata_only_manifest(
                unit,
                Some(model),
                &config.prompt_version,
                Some(format!("visual model request failed: {error}")),
            ));
        }
    };
    let mut manifest = normalize_manifest(value, unit);
    manifest["analysis"]["model"] = json!(model);
    manifest["analysis"]["promptVersion"] = json!(config.prompt_version);
    Ok(manifest)
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
        r#"You are RedBox's visual indexer. Return strict JSON only, matching schemaVersion redbox.visual_manifest.v1.
Use holistic multimodal visual understanding. If visible text exists, include it alongside scene, subjects, layout, style, composition, artifacts, likely use, and search phrases.
Use this stable top-level shape:
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
Every retrievalProjection.text must be search-ready natural language. Include multilingual keywords when useful."#
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
