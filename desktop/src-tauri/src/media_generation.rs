use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::thread;

use crate::{
    decode_base64_bytes, normalize_base_url, payload_field, payload_string, run_curl_bytes,
    run_curl_json,
};

pub(crate) fn resolve_image_generation_settings(
    settings: &Value,
) -> Option<(String, Option<String>, String, String, String)> {
    let endpoint = payload_string(settings, "image_endpoint")
        .or_else(|| payload_string(settings, "api_endpoint"))?;
    let api_key =
        payload_string(settings, "image_api_key").or_else(|| payload_string(settings, "api_key"));
    let model =
        payload_string(settings, "image_model").or_else(|| Some("gpt-image-1".to_string()))?;
    let provider = payload_string(settings, "image_provider")
        .unwrap_or_else(|| "openai-compatible".to_string());
    let template = payload_string(settings, "image_provider_template")
        .unwrap_or_else(|| "openai-images".to_string());
    Some((endpoint, api_key, model, provider, template))
}

pub(crate) fn resolve_video_generation_settings(
    settings: &Value,
) -> Option<(String, Option<String>, String)> {
    let endpoint = payload_string(settings, "video_endpoint")?;
    let api_key =
        payload_string(settings, "video_api_key").or_else(|| payload_string(settings, "api_key"));
    let model = payload_string(settings, "video_model")?;
    Some((endpoint, api_key, model))
}

pub(crate) fn normalize_image_generation_url(endpoint: &str) -> String {
    let normalized = normalize_base_url(endpoint);
    if normalized.ends_with("/images/generations") {
        normalized
    } else {
        format!("{normalized}/images/generations")
    }
}

pub(crate) fn run_image_generation_request(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    prompt: &str,
    count: i64,
    size: Option<&str>,
    quality: Option<&str>,
) -> Result<Value, String> {
    run_curl_json(
        "POST",
        &normalize_image_generation_url(endpoint),
        api_key,
        &[],
        Some(json!({
            "model": model,
            "prompt": prompt,
            "n": count,
            "size": size.unwrap_or("1024x1024"),
            "quality": quality.unwrap_or("standard"),
            "response_format": "b64_json"
        })),
    )
}

pub(crate) fn write_generated_image_asset(
    absolute_path: &Path,
    response_item: &Value,
) -> Result<(), String> {
    if let Some(b64) = extract_media_base64(response_item) {
        let bytes = decode_base64_bytes(b64)?;
        if let Some(parent) = absolute_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(absolute_path, bytes).map_err(|error| error.to_string())?;
        return Ok(());
    }
    if let Some(url) = extract_media_url(response_item) {
        let bytes = run_curl_bytes("GET", &url, None, &[], None)?;
        if let Some(parent) = absolute_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(absolute_path, bytes).map_err(|error| error.to_string())?;
        return Ok(());
    }
    Err("image generation response contained neither b64_json nor url".to_string())
}

pub(crate) fn extract_first_media_result<'a>(response: &'a Value) -> Option<&'a Value> {
    response
        .get("data")
        .and_then(|item| item.as_array())
        .and_then(|items| items.first())
        .or_else(|| response.get("result"))
        .or_else(|| response.get("output"))
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
                    "data", "output", "result", "results", "images", "videos", "video", "image",
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
                for key in ["b64_json", "base64", "image_base64", "imageBase64", "data"] {
                    if let Some(found) = map.get(key).and_then(visit) {
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

pub(crate) fn extract_task_id(value: &Value) -> Option<String> {
    fn visit(value: &Value) -> Option<String> {
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
            Value::Object(map) => {
                for key in [
                    "task_id",
                    "taskId",
                    "job_id",
                    "jobId",
                    "request_id",
                    "requestId",
                    "id",
                ] {
                    if let Some(found) = map.get(key).and_then(visit) {
                        return Some(found);
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

pub(crate) fn video_poll_url(endpoint: &str, task_id: &str, status_url: Option<String>) -> String {
    if let Some(status_url) = status_url {
        return status_url;
    }
    let base = normalize_base_url(endpoint);
    if base.ends_with("/tasks") {
        format!("{base}/{task_id}")
    } else if base.contains("/tasks/") {
        base
    } else {
        format!("{base}/tasks/{task_id}")
    }
}

pub(crate) fn poll_video_generation_result(
    endpoint: &str,
    api_key: Option<&str>,
    response: &Value,
) -> Option<String> {
    if let Some(url) = extract_media_url(response) {
        return Some(url);
    }
    let task_id = extract_task_id(response)?;
    let status_url = extract_status_url(response);
    let poll_url = video_poll_url(endpoint, &task_id, status_url);
    for _ in 0..6 {
        thread::sleep(std::time::Duration::from_millis(1200));
        if let Ok(next) = run_curl_json("GET", &poll_url, api_key, &[], None) {
            if let Some(url) = extract_media_url(&next) {
                return Some(url);
            }
            let status = next
                .get("status")
                .or_else(|| next.pointer("/output/task_status"))
                .or_else(|| next.pointer("/data/status"))
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_lowercase();
            if status.contains("failed") || status.contains("error") || status.contains("cancel") {
                return None;
            }
        }
    }
    None
}

pub(crate) fn run_video_generation_request(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    payload: &Value,
) -> Result<Value, String> {
    run_curl_json(
        "POST",
        endpoint,
        api_key,
        &[],
        Some(json!({
            "model": model,
            "prompt": payload_string(payload, "prompt").unwrap_or_default(),
            "generationMode": payload_string(payload, "generationMode").unwrap_or_else(|| "text-to-video".to_string()),
            "referenceImages": payload_field(payload, "referenceImages").cloned().unwrap_or_else(|| json!([])),
            "aspectRatio": payload_string(payload, "aspectRatio"),
            "resolution": payload_string(payload, "resolution"),
            "durationSeconds": payload_field(payload, "durationSeconds").and_then(|item| item.as_i64()),
            "generateAudio": payload_field(payload, "generateAudio").and_then(|item| item.as_bool()).unwrap_or(false)
        })),
    )
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
    let endpoint = payload_string(settings, "embedding_endpoint")
        .or_else(|| payload_string(settings, "api_endpoint"))?;
    let api_key =
        payload_string(settings, "embedding_key").or_else(|| payload_string(settings, "api_key"));
    let model = payload_string(settings, "embedding_model")
        .or_else(|| Some("text-embedding-3-small".to_string()))?;
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
