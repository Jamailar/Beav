use base64::Engine;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;

mod image;
mod video;

pub(crate) use image::*;
pub(crate) use video::*;

use crate::{
    decode_base64_bytes, format_http_error_message, http_error_details_from_value,
    normalize_base_url, payload_field, payload_string, run_curl_json, run_curl_json_response,
};

const VIDEO_TASK_POLL_INTERVAL_MS: u64 = 3000;
const VIDEO_TASK_POLL_TIMEOUT_MS: u64 = 6 * 60 * 1000;
const IMAGE_TASK_POLL_INTERVAL_MS: u64 = 2000;
const IMAGE_TASK_POLL_TIMEOUT_MS: u64 = 10 * 60 * 1000;
const IMAGE_REQUEST_TIMEOUT_SECONDS: u64 = 10 * 60;
const DEFAULT_IMAGE_ASPECT_RATIO: &str = "1:1";
const DEFAULT_IMAGE_QUALITY: &str = "medium";
const DEFAULT_IMAGE_RESOLUTION: &str = "2K";

fn redbox_official_route_suffixes() -> Vec<String> {
    let mut suffixes = vec![
        format!("/{}/v1", crate::app_brand_slug()),
        "/redbox/v1".to_string(),
        "/thrive/v1".to_string(),
    ];
    suffixes.dedup();
    suffixes
}

pub(crate) fn is_redbox_official_endpoint(endpoint: &str) -> bool {
    let normalized = normalize_base_url(endpoint).to_lowercase();
    is_redbox_compatible_endpoint(&normalized)
        && redbox_official_route_suffixes()
            .iter()
            .any(|suffix| normalized.contains(suffix))
}

pub(crate) fn resolve_image_generation_settings_with_override(
    settings: &Value,
    request_override: Option<&Value>,
) -> Option<(String, Option<String>, String, String, String)> {
    let resolved = crate::ai_model_manager::AiModelManager::resolve(
        settings,
        crate::ai_model_manager::AiModelScope::Image,
        request_override,
    );
    let endpoint = resolved
        .as_ref()
        .map(|route| route.base_url.clone())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| payload_string(settings, "image_endpoint"))
        .or_else(|| payload_string(settings, "api_endpoint"))?;
    let api_key = resolved
        .as_ref()
        .and_then(|route| route.api_key.clone())
        .or_else(|| payload_string(settings, "image_api_key"))
        .or_else(|| payload_string(settings, "api_key"));
    let model = resolved
        .as_ref()
        .map(|route| route.model_name.clone())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| payload_string(settings, "image_model"))?;
    let provider = resolved
        .as_ref()
        .and_then(|route| route.provider.clone())
        .or_else(|| payload_string(settings, "image_provider"))
        .unwrap_or_else(|| "openai-compatible".to_string());
    let template = resolved
        .as_ref()
        .and_then(|route| route.provider_template.clone())
        .or_else(|| payload_string(settings, "image_provider_template"))
        .unwrap_or_else(|| "openai-images".to_string());
    Some((endpoint, api_key, model, provider, template))
}

pub(crate) fn resolve_video_generation_settings_with_override(
    settings: &Value,
    request_override: Option<&Value>,
) -> Option<(String, Option<String>, String)> {
    let resolved = crate::ai_model_manager::AiModelManager::resolve(
        settings,
        crate::ai_model_manager::AiModelScope::Video,
        request_override,
    );
    let endpoint = resolved
        .as_ref()
        .map(|route| route.base_url.clone())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| payload_string(settings, "video_endpoint"))
        .map(|endpoint| {
            let normalized = normalize_base_url(&endpoint);
            let normalized_lower = normalized.to_lowercase();
            if normalized_lower.contains("api.ziz.hk")
                && !is_redbox_official_endpoint(&normalized_lower)
            {
                crate::official_base_url_for_realm("cn")
            } else if normalized_lower.contains("api.thrivingos.com")
                && !is_redbox_official_endpoint(&normalized_lower)
            {
                crate::official_base_url_for_realm("global")
            } else {
                normalized
            }
        })?;
    let api_key = resolved
        .as_ref()
        .and_then(|route| route.api_key.clone())
        .or_else(|| payload_string(settings, "video_api_key"))
        .or_else(|| payload_string(settings, "api_key"));
    let model = resolved
        .as_ref()
        .map(|route| route.model_name.clone())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| payload_string(settings, "video_model"))?;
    Some((endpoint, api_key, model))
}

fn normalize_endpoint(endpoint: &str, suffix: &str) -> String {
    let base = normalize_base_url(endpoint);
    if suffix.is_empty() {
        return base;
    }
    if base.ends_with(suffix) {
        base
    } else {
        format!("{base}{suffix}")
    }
}

pub(crate) fn extract_first_media_result<'a>(response: &'a Value) -> Option<&'a Value> {
    response
        .get("data")
        .and_then(|item| item.as_array())
        .and_then(|items| items.first())
        .or_else(|| response.get("result"))
        .or_else(|| response.get("output"))
        .or_else(|| response.get("predictions"))
        .or_else(|| Some(response))
}

pub(crate) fn extract_media_url(value: &Value) -> Option<String> {
    fn visit(value: &Value) -> Option<String> {
        match value {
            Value::String(text) => {
                let trimmed = text.trim();
                if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                    Some(trimmed.to_string())
                } else {
                    None
                }
            }
            Value::Array(items) => items.iter().find_map(visit),
            Value::Object(map) => {
                for key in [
                    "url",
                    "image_url",
                    "imageUrl",
                    "video_url",
                    "videoUrl",
                    "output_url",
                    "outputUrl",
                    "resource_url",
                    "resourceUrl",
                    "file_url",
                    "fileUrl",
                ] {
                    if let Some(found) = map.get(key).and_then(visit) {
                        return Some(found);
                    }
                }
                for key in [
                    "data",
                    "output",
                    "result",
                    "results",
                    "images",
                    "videos",
                    "video",
                    "image",
                    "predictions",
                ] {
                    if let Some(found) = map.get(key).and_then(visit) {
                        return Some(found);
                    }
                }
                map.values().find_map(visit)
            }
            _ => None,
        }
    }
    visit(value)
}

pub(crate) fn extract_media_base64(value: &Value) -> Option<&str> {
    fn visit(value: &Value) -> Option<&str> {
        match value {
            Value::String(text) => {
                let trimmed = text.trim();
                if trimmed.starts_with("data:image/") {
                    trimmed.split_once(',').map(|(_, body)| body)
                } else {
                    None
                }
            }
            Value::Array(items) => items.iter().find_map(visit),
            Value::Object(map) => {
                if let Some(image_data) = map.get("data").and_then(Value::as_str).filter(|_| {
                    map.get("mimeType")
                        .or_else(|| map.get("mime_type"))
                        .and_then(Value::as_str)
                        .map(|mime| mime.starts_with("image/"))
                        .unwrap_or(false)
                }) {
                    return Some(image_data);
                }
                if let Some(inline_data) = map.get("inlineData").or_else(|| map.get("inline_data"))
                {
                    if let Some(found) = visit(inline_data) {
                        return Some(found);
                    }
                }
                for key in [
                    "b64_json",
                    "base64",
                    "image_base64",
                    "imageBase64",
                    "bytesBase64Encoded",
                ] {
                    if let Some(found) = map.get(key).and_then(Value::as_str) {
                        return Some(found);
                    }
                }
                map.values().find_map(visit)
            }
            _ => None,
        }
    }
    value
        .get("b64_json")
        .and_then(|item| item.as_str())
        .or_else(|| visit(value))
}

pub(crate) fn extract_task_id_details(value: &Value) -> Option<(String, &'static str)> {
    fn visit_scalar(value: &Value) -> Option<String> {
        match value {
            Value::String(text) => {
                let trimmed = text.trim();
                if !trimmed.is_empty()
                    && !trimmed.starts_with("http://")
                    && !trimmed.starts_with("https://")
                {
                    Some(trimmed.to_string())
                } else {
                    None
                }
            }
            _ => None,
        }
    }
    fn visit(value: &Value) -> Option<(String, &'static str)> {
        match value {
            Value::Object(map) => {
                for (key, source) in [
                    ("task_id", "task_id"),
                    ("taskId", "taskId"),
                    ("job_id", "job_id"),
                    ("jobId", "jobId"),
                    ("request_id", "request_id"),
                    ("requestId", "requestId"),
                    ("id", "id"),
                ] {
                    if let Some(found) = map.get(key).and_then(visit_scalar) {
                        return Some((found, source));
                    }
                }
                for key in ["task", "job", "request", "output", "result", "data"] {
                    if let Some(found) = map.get(key).and_then(visit) {
                        return Some(found);
                    }
                }
                None
            }
            Value::Array(items) => items.iter().find_map(visit),
            _ => None,
        }
    }
    visit(value)
}

pub(crate) fn extract_status_url(value: &Value) -> Option<String> {
    fn visit(value: &Value) -> Option<String> {
        match value {
            Value::String(text) => {
                let trimmed = text.trim();
                if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                    Some(trimmed.to_string())
                } else {
                    None
                }
            }
            Value::Object(map) => {
                for key in [
                    "status_url",
                    "statusUrl",
                    "polling_url",
                    "pollingUrl",
                    "task_url",
                    "taskUrl",
                    "query_url",
                    "queryUrl",
                ] {
                    if let Some(found) = map.get(key).and_then(visit) {
                        return Some(found);
                    }
                }
                None
            }
            Value::Array(items) => items.iter().find_map(visit),
            _ => None,
        }
    }
    visit(value)
}

pub(crate) fn is_redbox_compatible_endpoint(endpoint: &str) -> bool {
    let normalized = normalize_base_url(endpoint).to_lowercase();
    (normalized.contains("api.ziz.hk") || normalized.contains("api.thrivingos.com"))
        && normalized.contains("/v1")
}

pub(crate) fn build_compatible_video_route_urls(endpoint: &str, suffix: &str) -> Vec<String> {
    vec![normalize_endpoint(&normalize_base_url(endpoint), suffix)]
}

pub(crate) fn normalize_embedding_url(endpoint: &str) -> String {
    let normalized = normalize_base_url(endpoint);
    if normalized.ends_with("/embeddings") {
        normalized
    } else {
        format!("{normalized}/embeddings")
    }
}

pub(crate) fn resolve_embedding_settings(
    settings: &Value,
) -> Option<(String, Option<String>, String)> {
    let resolved = crate::ai_model_manager::AiModelManager::resolve(
        settings,
        crate::ai_model_manager::AiModelScope::Embedding,
        None,
    );
    let endpoint = resolved
        .as_ref()
        .map(|route| route.base_url.clone())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| payload_string(settings, "embedding_endpoint"))
        .or_else(|| payload_string(settings, "api_endpoint"))?;
    let api_key = resolved
        .as_ref()
        .and_then(|route| route.api_key.clone())
        .or_else(|| payload_string(settings, "embedding_key"))
        .or_else(|| payload_string(settings, "api_key"));
    let model = resolved
        .as_ref()
        .map(|route| route.model_name.clone())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| payload_string(settings, "embedding_model"))?;
    Some((endpoint, api_key, model))
}

pub(crate) fn compute_local_embedding(text: &str) -> Vec<f64> {
    let mut vector = vec![0.0_f64; 64];
    for (index, byte) in text.bytes().enumerate() {
        let slot = (index.wrapping_mul(31).wrapping_add(byte as usize)) % vector.len();
        let sign = if byte % 2 == 0 { 1.0 } else { -1.0 };
        vector[slot] += sign * ((byte as f64 % 17.0) + 1.0);
    }
    let norm = vector.iter().map(|value| value * value).sum::<f64>().sqrt();
    if norm > 0.0 {
        for value in &mut vector {
            *value /= norm;
        }
    }
    vector
}

pub(crate) fn compute_embedding_with_settings(settings: &Value, text: &str) -> Vec<f64> {
    if let Some((endpoint, api_key, model)) = resolve_embedding_settings(settings) {
        if let Ok(response) = run_curl_json(
            "POST",
            &normalize_embedding_url(&endpoint),
            api_key.as_deref(),
            &[],
            Some(json!({ "model": model, "input": text })),
        ) {
            if let Some(values) = response
                .pointer("/data/0/embedding")
                .and_then(|item| item.as_array())
            {
                let vector = values
                    .iter()
                    .filter_map(|item| item.as_f64())
                    .collect::<Vec<_>>();
                if !vector.is_empty() {
                    return vector;
                }
            }
        }
    }
    compute_local_embedding(text)
}

pub(crate) fn cosine_similarity(left: &[f64], right: &[f64]) -> f64 {
    let len = left.len().min(right.len());
    if len == 0 {
        return 0.0;
    }
    let mut dot = 0.0_f64;
    let mut left_norm = 0.0_f64;
    let mut right_norm = 0.0_f64;
    for index in 0..len {
        dot += left[index] * right[index];
        left_norm += left[index] * left[index];
        right_norm += right[index] * right[index];
    }
    if left_norm <= 0.0 || right_norm <= 0.0 {
        0.0
    } else {
        dot / (left_norm.sqrt() * right_norm.sqrt())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_video_generation_status_details_reports_status_field_path() {
        let legacy_direct =
            extract_video_generation_status_details(&json!({ "task_status": "PENDING" }));
        let direct = extract_video_generation_status_details(&json!({ "status": "queued" }));
        let nested_data = extract_video_generation_status_details(&json!({
            "data": { "task_status": "RUNNING" }
        }));
        let nested = extract_video_generation_status_details(&json!({
            "output": { "task_status": "PROCESSING" }
        }));

        assert_eq!(legacy_direct, Some(("pending".to_string(), "task_status")));
        assert_eq!(direct, Some(("queued".to_string(), "status")));
        assert_eq!(
            nested_data,
            Some(("running".to_string(), "data.task_status"))
        );
        assert_eq!(
            nested,
            Some(("processing".to_string(), "output.task_status"))
        );
    }

    #[test]
    fn extract_task_id_details_reports_source_field() {
        let direct = extract_task_id_details(&json!({ "task_id": "task-123" }));
        let nested = extract_task_id_details(&json!({ "data": { "id": "job-456" } }));

        assert_eq!(direct, Some(("task-123".to_string(), "task_id")));
        assert_eq!(nested, Some(("job-456".to_string(), "id")));
    }

    #[test]
    fn build_video_request_body_adds_redbox_fields_only_for_redbox_endpoint() {
        let official_cn_base_url = crate::official_base_url_for_realm("cn");
        let payload = json!({
            "prompt": "test",
            "aspectRatio": "9:16",
            "resolution": "1080p",
            "durationSeconds": 6,
        });

        let redbox = build_video_request_body(&official_cn_base_url, "wan-test", &payload)
            .expect("redbox body");
        let generic = build_video_request_body("https://example.com/v1", "wan-test", &payload)
            .expect("generic body");

        assert_eq!(
            redbox.get("resolution").and_then(Value::as_str),
            Some("1080P")
        );
        assert_eq!(redbox.get("duration").and_then(Value::as_i64), Some(6));
        assert!(generic.get("resolution").is_none());
        assert!(generic.get("duration").is_none());
    }

    #[test]
    fn build_video_request_body_accepts_duration_aliases_for_redbox_endpoint() {
        let endpoint = "https://api.ziz.hk/redbox/v1/videos/generations/async";
        let payload = json!({
            "prompt": "test",
            "duration": "6",
        });

        let body = build_video_request_body(endpoint, "wan-test", &payload).expect("body");

        assert_eq!(body.get("duration").and_then(Value::as_i64), Some(6));
        assert_eq!(body.get("seconds").and_then(Value::as_str), Some("4"));
    }

    #[test]
    fn build_video_request_body_adds_reference_media_for_redbox_reference_guided() {
        let official_cn_base_url = crate::official_base_url_for_realm("cn");
        let payload = json!({
            "prompt": "test",
            "generationMode": "reference-guided",
            "referenceImages": [
                "data:image/jpeg;base64,AAA=",
                "data:image/jpeg;base64,BBB="
            ],
        });

        let redbox = build_video_request_body(&official_cn_base_url, "wan-test", &payload)
            .expect("redbox body");
        let generic = build_video_request_body("https://example.com/v1", "wan-test", &payload)
            .expect("generic body");

        assert_eq!(
            redbox.pointer("/media/0/type").and_then(Value::as_str),
            Some("reference_image")
        );
        assert_eq!(
            redbox.pointer("/media/0/url").and_then(Value::as_str),
            Some("data:image/jpeg;base64,AAA=")
        );
        assert!(generic.get("media").is_none());
    }

    #[test]
    fn build_openai_edit_form_fields_uses_official_openai_shape_for_gpt_models() {
        let fields = build_openai_edit_form_fields(
            "gpt-image-1",
            "test",
            2,
            Some("4:3"),
            None,
            Some("auto"),
        );

        assert!(!fields.iter().any(|(key, _value)| key == "response_format"));
        assert!(fields
            .iter()
            .any(|(key, value)| key == "size" && value == "1536x1024"));
    }

    #[test]
    fn image_quality_uses_three_level_contract_for_compatible_requests() {
        assert_eq!(
            map_quality_to_strict_openai("gpt-image-1", Some("auto"), false).as_deref(),
            Some("medium")
        );
        assert_eq!(
            map_quality_to_strict_openai("gpt-image-1", Some("low"), false).as_deref(),
            Some("medium")
        );
        assert_eq!(map_quality_to_openai(Some("")).as_deref(), Some("medium"));
        assert_eq!(map_quality_to_openai(Some("low")).as_deref(), Some("low"));
        assert_eq!(
            map_quality_to_openai(Some("standard")).as_deref(),
            Some("medium")
        );
        assert_eq!(
            map_resolution_or_quality_to_jimeng_resolution(None, Some("auto")).as_deref(),
            Some("2k")
        );
        assert_eq!(
            map_resolution_or_quality_to_jimeng_resolution(None, Some("low")).as_deref(),
            Some("2k")
        );
    }

    #[test]
    fn image_resolution_overrides_quality_for_native_resolution_fields() {
        assert_eq!(
            map_resolution_or_quality_to_image_size(Some("2K"), Some("standard")),
            "2K"
        );
        assert_eq!(
            map_resolution_or_quality_to_jimeng_resolution(Some("1K"), Some("high")).as_deref(),
            Some("1k")
        );
        assert_eq!(
            payload_image_resolution(&json!({ "resolution": "2048" })).as_deref(),
            Some("2K")
        );
        assert!(payload_image_resolution(&json!({ "resolution": "1024x1024" })).is_none());
    }

    #[test]
    fn compatible_image_body_preserves_resolution_aspect_ratio_and_images() {
        let payload = json!({
            "prompt": "融合参考图风格，生成一张电商主图",
            "images": [
                "https://example.com/ref-1.png",
                "https://example.com/ref-2.png"
            ],
            "quality": "high",
            "resolution": "2K",
            "aspectRatio": "1:1"
        });
        let refs = extract_reference_images(&payload, 4);
        let extra = build_compatible_image_extra_fields(&payload, &refs).expect("extra fields");
        let body = build_openai_json_image_body("test-image-model", &payload, extra);

        assert_eq!(body.get("quality").and_then(Value::as_str), Some("high"));
        assert_eq!(body.get("resolution").and_then(Value::as_str), Some("2K"));
        assert_eq!(body.get("aspectRatio").and_then(Value::as_str), Some("1:1"));
        assert_eq!(
            body.get("images").and_then(Value::as_array).map(Vec::len),
            Some(2)
        );
    }

    #[test]
    fn compatible_image_body_defaults_required_image_fields() {
        let payload = json!({
            "prompt": "生成一张电商主图",
            "quality": "",
            "resolution": "",
            "aspectRatio": ""
        });
        let extra = build_compatible_image_extra_fields(&payload, &[]).expect("extra fields");
        let body = build_openai_json_image_body("test-image-model", &payload, extra);

        assert_eq!(body.get("quality").and_then(Value::as_str), Some("medium"));
        assert_eq!(body.get("resolution").and_then(Value::as_str), Some("2K"));
        assert_eq!(body.get("aspectRatio").and_then(Value::as_str), Some("1:1"));
    }

    #[test]
    fn build_openai_edit_file_fields_repeats_image_field_for_multiple_refs() {
        let fields = build_openai_edit_file_fields(&[
            PathBuf::from("/tmp/ref-a.png"),
            PathBuf::from("/tmp/ref-b.png"),
        ]);

        assert_eq!(fields.len(), 2);
        assert!(fields.iter().all(|(key, _path)| key == "image"));
        assert!(!fields.iter().any(|(key, _path)| key == "image[]"));
    }

    #[test]
    fn redbox_official_reference_images_use_json_generation_endpoint() {
        let official_cn_base_url = crate::official_base_url_for_realm("cn");
        let official_global_base_url = crate::official_base_url_for_realm("global");
        assert!(is_redbox_official_image_endpoint(&official_cn_base_url));
        assert!(is_redbox_official_image_endpoint(&official_global_base_url));
        assert!(is_redbox_official_image_endpoint(
            "https://api.ziz.hk/thrive/v1"
        ));
        assert_eq!(
            normalize_image_generation_url(&official_cn_base_url),
            format!("{official_cn_base_url}/images/generations")
        );
    }

    #[test]
    fn resolve_video_generation_settings_preserves_legacy_thrive_official_endpoint() {
        let settings = json!({
            "video_endpoint": "https://api.ziz.hk/thrive/v1",
            "video_model": "seedance-2.0"
        });
        let (endpoint, _api_key, model) =
            resolve_video_generation_settings_with_override(&settings, None)
                .expect("video settings");

        assert_eq!(endpoint, "https://api.ziz.hk/thrive/v1");
        assert_eq!(model, "seedance-2.0");
        assert!(is_redbox_official_endpoint(&endpoint));
    }

    #[test]
    fn specialized_media_settings_do_not_use_provider_chat_model() {
        let settings = json!({
            "api_endpoint": "https://custom.example/v1",
            "default_ai_source_id": "custom-source",
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "custom-source",
                "baseURL": "https://custom.example/v1",
                "model": "chat-model"
            })]).unwrap(),
            "ai_model_routes_json": serde_json::to_string(&json!({})).unwrap()
        });

        assert!(resolve_image_generation_settings_with_override(&settings, None).is_none());
        assert!(resolve_video_generation_settings_with_override(&settings, None).is_none());
        assert!(resolve_embedding_settings(&settings).is_none());
    }

    #[test]
    fn run_form_json_posts_multipart_without_external_curl() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let url = format!(
            "http://{}/images/edits",
            listener.local_addr().expect("listener addr")
        );
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 4096];
            let mut expected_len = None;
            loop {
                let read = stream.read(&mut chunk).expect("read request");
                assert!(read > 0, "connection closed before full request");
                buffer.extend_from_slice(&chunk[..read]);
                if expected_len.is_none() {
                    if let Some(header_end) = buffer.windows(4).position(|item| item == b"\r\n\r\n")
                    {
                        let headers = String::from_utf8_lossy(&buffer[..header_end]);
                        let content_length = headers
                            .lines()
                            .find_map(|line| {
                                line.split_once(':').and_then(|(name, value)| {
                                    name.eq_ignore_ascii_case("content-length")
                                        .then(|| value.trim().parse::<usize>().ok())
                                        .flatten()
                                })
                            })
                            .expect("content-length");
                        expected_len = Some(header_end + 4 + content_length);
                    }
                }
                if expected_len
                    .map(|total| buffer.len() >= total)
                    .unwrap_or(false)
                {
                    break;
                }
            }
            let response_body = br#"{"ok":true}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                response_body.len()
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response headers");
            stream
                .write_all(response_body)
                .expect("write response body");
            String::from_utf8_lossy(&buffer).to_string()
        });

        let file_a =
            std::env::temp_dir().join(format!("redbox-form-test-a-{}.png", crate::now_ms()));
        let file_b =
            std::env::temp_dir().join(format!("redbox-form-test-b-{}.png", crate::now_ms()));
        fs::write(&file_a, b"PNG-A").expect("write file a");
        fs::write(&file_b, b"PNG-B").expect("write file b");
        let response = run_form_json(
            "POST",
            &url,
            Some("test-key"),
            &[],
            &[("prompt".to_string(), "cover prompt".to_string())],
            &[
                ("image".to_string(), file_a.clone()),
                ("image".to_string(), file_b.clone()),
            ],
        )
        .expect("multipart response");
        let _ = fs::remove_file(file_a);
        let _ = fs::remove_file(file_b);
        let request = server.join().expect("server join");

        assert_eq!(response.status, 200);
        assert_eq!(response.body.get("ok").and_then(Value::as_bool), Some(true));
        assert!(request.starts_with("POST /images/edits "));
        assert_eq!(request.matches("name=\"image\"").count(), 2);
        assert!(request.contains("name=\"prompt\""));
        assert!(!request.contains("name=\"image[]\""));
    }

    #[test]
    fn materialize_http_reference_uses_builtin_downloader() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let url = format!("http://{}/template.png", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut buffer = [0u8; 1024];
            let read = stream.read(&mut buffer).expect("read request");
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let response_body = b"PNG-REFERENCE";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\n\r\n",
                response_body.len()
            );
            stream
                .write_all(response.as_bytes())
                .expect("write headers");
            stream.write_all(response_body).expect("write body");
            request
        });

        let path =
            materialize_transport_value_to_temp_file(&url, "http-ref").expect("materialize ref");
        let bytes = fs::read(&path).expect("read materialized ref");
        let _ = fs::remove_file(&path);
        let request = server.join().expect("server join");

        assert_eq!(bytes, b"PNG-REFERENCE");
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("png")
        );
        assert!(request.starts_with("GET /template.png "));
    }

    #[test]
    fn materialize_file_url_reference_decodes_escaped_path() {
        let source_path =
            std::env::temp_dir().join(format!("redbox file url ref {}.png", crate::now_ms()));
        fs::write(&source_path, b"PNG-FILE-URL").expect("write source image");
        let source_url = crate::file_url_for_path(&source_path);

        let path = materialize_transport_value_to_temp_file(&source_url, "file-url-ref")
            .expect("materialize file url ref");
        let bytes = fs::read(&path).expect("read materialized image");
        let _ = fs::remove_file(&source_path);
        let _ = fs::remove_file(&path);

        assert_eq!(bytes, b"PNG-FILE-URL");
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("png")
        );
    }

    #[test]
    fn write_generated_image_asset_downloads_url_without_external_curl() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let url = format!("http://{}/generated.png", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut buffer = [0u8; 1024];
            let read = stream.read(&mut buffer).expect("read request");
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let response_body = b"PNG-GENERATED";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\n\r\n",
                response_body.len()
            );
            stream
                .write_all(response.as_bytes())
                .expect("write headers");
            stream.write_all(response_body).expect("write body");
            request
        });

        let path =
            std::env::temp_dir().join(format!("redbox-generated-test-{}.png", crate::now_ms()));
        write_generated_image_asset(&path, &json!({ "url": url })).expect("write asset");
        let bytes = fs::read(&path).expect("read generated asset");
        let _ = fs::remove_file(&path);
        let request = server.join().expect("server join");

        assert_eq!(bytes, b"PNG-GENERATED");
        assert!(request.starts_with("GET /generated.png "));
    }
}
