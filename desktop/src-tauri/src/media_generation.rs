use base64::Engine;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;

use crate::{
    configure_background_command, decode_base64_bytes, normalize_base_url, payload_field,
    payload_string, run_curl_bytes, run_curl_json, run_curl_json_response,
};

const VIDEO_TASK_POLL_INTERVAL_MS: u64 = 3000;
const VIDEO_TASK_POLL_TIMEOUT_MS: u64 = 6 * 60 * 1000;

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

pub(crate) fn normalize_image_generation_url(endpoint: &str) -> String {
    let normalized = normalize_base_url(endpoint);
    if normalized.ends_with("/images/generations") {
        normalized
    } else {
        format!("{normalized}/images/generations")
    }
}

fn normalize_image_edit_url(endpoint: &str) -> String {
    let normalized = normalize_base_url(endpoint);
    if normalized.ends_with("/images/edits") {
        normalized
    } else {
        format!("{normalized}/images/edits")
    }
}

fn is_official_gemini_endpoint(endpoint: &str) -> bool {
    let normalized = normalize_base_url(endpoint).to_lowercase();
    normalized.contains("generativelanguage.googleapis.com")
        || normalized.contains("googleapis.com")
}

fn resolve_gemini_openai_endpoint(endpoint: &str) -> String {
    let base = normalize_base_url(endpoint);
    if base.contains("/images/generations") {
        return base;
    }
    if base.contains("/openai") {
        return normalize_endpoint(&base, "/images/generations");
    }
    if base.contains("generativelanguage.googleapis.com") {
        return normalize_endpoint(&base, "/openai/images/generations");
    }
    normalize_endpoint(&base, "/images/generations")
}

fn resolve_jimeng_wrapper_endpoint(endpoint: &str) -> String {
    let base = normalize_base_url(endpoint);
    if base.contains("/images/generations") {
        return base;
    }
    if base.contains("/v1") {
        return normalize_endpoint(&base, "/images/generations");
    }
    normalize_endpoint(&base, "/v1/images/generations")
}

fn normalize_dashscope_base_endpoint(endpoint: &str) -> String {
    let base = normalize_base_url(endpoint);
    if base.is_empty() {
        return String::new();
    }
    if base.contains("/services/aigc/") || base.contains("/api/v1/tasks/") {
        return endpoint_origin(&base);
    }
    match url::Url::parse(&base) {
        Ok(mut parsed) => {
            let path = parsed.path().trim_end_matches('/').to_string();
            let marker_indexes = [
                path.find("/compatible-mode/"),
                path.find("/api/v1/services/"),
                path.find("/api/v1/tasks/"),
                path.find("/api/v1"),
                path.find("/v1"),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
            if let Some(cut) = marker_indexes.into_iter().min() {
                let next_path = if cut > 0 { &path[..cut] } else { "/" };
                parsed.set_path(next_path);
            }
            parsed.set_query(None);
            parsed.set_fragment(None);
            normalize_base_url(parsed.as_str())
        }
        Err(_) => base
            .replace("/compatible-mode/v1", "")
            .replace("/api/v1", "")
            .replace("/v1", ""),
    }
}

fn resolve_dashscope_wan_endpoints(
    endpoint: &str,
    model: &str,
    generation_mode: &str,
    reference_count: usize,
) -> Vec<String> {
    let explicit = normalize_base_url(endpoint);
    let base = normalize_dashscope_base_endpoint(endpoint);
    let normalized_model = model.trim().to_lowercase();
    let is_wan26 = normalized_model.contains("wan2.6");
    let require_image_input = reference_count > 0
        || generation_mode == "image-to-image"
        || generation_mode == "reference-guided";
    let mut candidates = Vec::<String>::new();
    if explicit.contains("/services/aigc/") {
        candidates.push(explicit.clone());
    }
    if is_wan26 {
        candidates.push(normalize_endpoint(
            &base,
            "/api/v1/services/aigc/image-generation/generation",
        ));
        candidates.push(normalize_endpoint(
            &base,
            "/api/v1/services/aigc/multimodal-generation/generation",
        ));
        if require_image_input {
            candidates.push(normalize_endpoint(
                &base,
                "/api/v1/services/aigc/image2image/image-synthesis",
            ));
        }
    } else if require_image_input {
        candidates.push(normalize_endpoint(
            &base,
            "/api/v1/services/aigc/image-generation/generation",
        ));
        candidates.push(normalize_endpoint(
            &base,
            "/api/v1/services/aigc/image2image/image-synthesis",
        ));
        candidates.push(normalize_endpoint(
            &base,
            "/api/v1/services/aigc/multimodal-generation/generation",
        ));
        candidates.push(normalize_endpoint(
            &base,
            "/api/v1/services/aigc/text2image/image-synthesis",
        ));
    } else {
        candidates.push(normalize_endpoint(
            &base,
            "/api/v1/services/aigc/image-generation/generation",
        ));
        candidates.push(normalize_endpoint(
            &base,
            "/api/v1/services/aigc/text2image/image-synthesis",
        ));
        candidates.push(normalize_endpoint(
            &base,
            "/api/v1/services/aigc/multimodal-generation/generation",
        ));
    }
    let mut unique = Vec::<String>::new();
    for candidate in candidates {
        if !candidate.trim().is_empty() && !unique.contains(&candidate) {
            unique.push(candidate);
        }
    }
    unique
}

fn resolve_dashscope_task_endpoint(endpoint: &str, task_id: &str) -> String {
    let base = normalize_dashscope_base_endpoint(endpoint);
    normalize_endpoint(
        &base,
        &format!("/api/v1/tasks/{}", urlencoding::encode(task_id)),
    )
}

fn endpoint_origin(endpoint: &str) -> String {
    match url::Url::parse(endpoint) {
        Ok(parsed) => format!(
            "{}://{}",
            parsed.scheme(),
            parsed.host_str().unwrap_or_default()
        ),
        Err(_) => normalize_base_url(endpoint),
    }
}

fn normalize_video_aspect_ratio(value: &str) -> &'static str {
    if value.trim() == "9:16" {
        "9:16"
    } else {
        "16:9"
    }
}

fn normalize_video_resolution(value: &str) -> &'static str {
    if value.trim() == "1080p" {
        "1080p"
    } else {
        "720p"
    }
}

fn normalize_video_duration(value: Option<i64>) -> i64 {
    let parsed = value.unwrap_or(8);
    parsed.clamp(5, 12)
}

fn map_aspect_ratio_to_image_size(aspect_ratio: Option<&str>, size: Option<&str>) -> String {
    if let Some(size) = size.map(str::trim).filter(|item| !item.is_empty()) {
        return size.to_string();
    }
    match aspect_ratio.unwrap_or("1:1").trim() {
        "3:4" => "1536x2048".to_string(),
        "4:3" => "2048x1536".to_string(),
        "9:16" => "1152x2048".to_string(),
        "16:9" => "2048x1152".to_string(),
        _ => "1024x1024".to_string(),
    }
}

fn map_aspect_ratio_to_gemini(aspect_ratio: Option<&str>, size: Option<&str>) -> Option<String> {
    match aspect_ratio
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .or_else(|| infer_aspect_ratio_from_size(size))
    {
        Some("16:9") => Some("16:9".to_string()),
        Some("9:16") => Some("9:16".to_string()),
        Some("4:3") => Some("4:3".to_string()),
        Some("3:4") => Some("3:4".to_string()),
        Some("1:1") => Some("1:1".to_string()),
        _ => None,
    }
}

fn infer_aspect_ratio_from_size(size: Option<&str>) -> Option<&'static str> {
    let size = size?.trim();
    let (width, height) = size.split_once('x')?;
    let width = width.parse::<f64>().ok()?;
    let height = height.parse::<f64>().ok()?;
    if width <= 0.0 || height <= 0.0 {
        return None;
    }
    let ratio = width / height;
    let candidates = [
        ("1:1", 1.0_f64),
        ("3:4", 3.0 / 4.0),
        ("4:3", 4.0 / 3.0),
        ("9:16", 9.0 / 16.0),
        ("16:9", 16.0 / 9.0),
    ];
    let mut best = None;
    let mut best_delta = f64::INFINITY;
    for (label, candidate) in candidates {
        let delta = (ratio - candidate).abs();
        if delta < best_delta {
            best = Some(label);
            best_delta = delta;
        }
    }
    if best_delta <= 0.04 { best } else { None }
}

fn map_quality_to_openai(quality: Option<&str>) -> Option<String> {
    match quality.map(str::trim).unwrap_or_default() {
        "high" | "hd" => Some("high".to_string()),
        "standard" | "medium" | "low" => Some("standard".to_string()),
        "auto" | "" => None,
        other => Some(other.to_string()),
    }
}

fn map_quality_to_jimeng_resolution(quality: Option<&str>) -> Option<String> {
    match quality.map(str::trim).unwrap_or_default() {
        "high" | "hd" => Some("2k".to_string()),
        "standard" | "medium" => Some("1k".to_string()),
        "low" => Some("512".to_string()),
        "auto" | "" => None,
        other => Some(other.to_string()),
    }
}

fn map_aspect_ratio_to_jimeng_ratio(
    aspect_ratio: Option<&str>,
    size: Option<&str>,
) -> Option<String> {
    match aspect_ratio
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .or_else(|| infer_aspect_ratio_from_size(size))
    {
        Some("1:1") => Some("1:1".to_string()),
        Some("3:4") => Some("3:4".to_string()),
        Some("4:3") => Some("4:3".to_string()),
        Some("9:16") => Some("9:16".to_string()),
        Some("16:9") => Some("16:9".to_string()),
        _ => None,
    }
}

fn map_size_to_dashscope(size: Option<&str>, aspect_ratio: Option<&str>) -> String {
    let base = map_aspect_ratio_to_image_size(aspect_ratio, size);
    match base.as_str() {
        "1536x2048" => "1536*2048".to_string(),
        "2048x1536" => "2048*1536".to_string(),
        "1152x2048" => "1152*2048".to_string(),
        "2048x1152" => "2048*1152".to_string(),
        "1024x1024" => "1024*1024".to_string(),
        other => other.replace('x', "*"),
    }
}

fn map_size_to_dashscope_interleave(size: Option<&str>, aspect_ratio: Option<&str>) -> String {
    map_size_to_dashscope(size, aspect_ratio)
}

fn is_http_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

fn infer_mime_type_from_path(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".mp3") {
        "audio/mpeg"
    } else if lower.ends_with(".wav") {
        "audio/wav"
    } else if lower.ends_with(".m4a") {
        "audio/mp4"
    } else if lower.ends_with(".aac") {
        "audio/aac"
    } else if lower.ends_with(".ogg") {
        "audio/ogg"
    } else if lower.ends_with(".mp4") {
        "video/mp4"
    } else if lower.ends_with(".mov") {
        "video/quicktime"
    } else if lower.ends_with(".webm") {
        "video/webm"
    } else {
        "application/octet-stream"
    }
}

fn extension_from_mime_type(mime_type: &str) -> &'static str {
    match mime_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "audio/mpeg" => "mp3",
        "audio/wav" => "wav",
        "audio/mp4" => "m4a",
        "audio/aac" => "aac",
        "audio/ogg" => "ogg",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        _ => "bin",
    }
}

fn decode_data_url(raw: &str) -> Option<(String, Vec<u8>)> {
    let trimmed = raw.trim();
    let without_prefix = trimmed.strip_prefix("data:")?;
    let (meta, body) = without_prefix.split_once(',')?;
    let is_base64 = meta.contains(";base64");
    let mime_type = meta
        .split(';')
        .next()
        .filter(|item| !item.trim().is_empty())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = if is_base64 {
        decode_base64_bytes(body).ok()?
    } else {
        body.as_bytes().to_vec()
    };
    Some((mime_type, bytes))
}

fn normalize_media_value_for_remote(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if is_http_url(trimmed) || trimmed.starts_with("data:") {
        return Ok(trimmed.to_string());
    }
    if trimmed.len() > 128
        && trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '/' || ch == '=')
    {
        return Ok(trimmed.to_string());
    }
    let buffer = fs::read(trimmed).map_err(|error| error.to_string())?;
    let mime_type = infer_mime_type_from_path(trimmed);
    Ok(format!(
        "data:{mime_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(buffer)
    ))
}

fn materialize_transport_value_to_temp_file(raw: &str, prefix: &str) -> Result<PathBuf, String> {
    let normalized = normalize_media_value_for_remote(raw)?;
    let (mime_type, bytes) = if let Some(decoded) = decode_data_url(&normalized) {
        decoded
    } else if is_http_url(&normalized) {
        (
            "application/octet-stream".to_string(),
            run_curl_bytes("GET", &normalized, None, &[], None)?,
        )
    } else {
        let mime_type = infer_mime_type_from_path(raw).to_string();
        let bytes = if Path::new(raw).exists() {
            fs::read(raw).map_err(|error| error.to_string())?
        } else {
            decode_base64_bytes(&normalized)?
        };
        (mime_type, bytes)
    };
    let ext = extension_from_mime_type(&mime_type);
    let path = std::env::temp_dir().join(format!(
        "redbox-{prefix}-{}-{}.{}",
        std::process::id(),
        crate::now_ms(),
        ext
    ));
    fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(path)
}

fn run_curl_form_json(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    fields: &[(String, String)],
    file_fields: &[(String, PathBuf)],
) -> Result<Value, String> {
    let temp_field_paths = fields
        .iter()
        .enumerate()
        .map(|(index, (_name, value))| {
            let path = std::env::temp_dir().join(format!(
                "redbox-form-field-{}-{}-{index}.txt",
                std::process::id(),
                crate::now_ms()
            ));
            fs::write(&path, value.as_bytes()).map_err(|error| error.to_string())?;
            Ok(path)
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut command = std::process::Command::new("curl");
    configure_background_command(&mut command);
    command.arg("-sS").arg("-L").arg("-X").arg(method).arg(url);
    if let Some(key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        command
            .arg("-H")
            .arg(format!("Authorization: Bearer {key}"));
    }
    for (header, value) in extra_headers {
        command.arg("-H").arg(format!("{header}: {value}"));
    }
    for ((name, _value), path) in fields.iter().zip(temp_field_paths.iter()) {
        command.arg("-F").arg(format!("{name}=<{}", path.display()));
    }
    for (name, file_path) in file_fields {
        command
            .arg("-F")
            .arg(format!("{name}=@{}", file_path.display()));
    }
    let output_result = command.output().map_err(|error| error.to_string());
    for path in temp_field_paths {
        let _ = fs::remove_file(path);
    }
    let output = output_result?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("curl failed with status {}", output.status)
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&stdout).map_err(|error| format!("Invalid JSON response: {error}"))
}

fn extract_reference_images(payload: &Value, max_count: usize) -> Vec<String> {
    payload_field(payload, "referenceImages")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .take(max_count)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn build_gemini_content_parts(prompt: &str, refs: &[String]) -> Result<Vec<Value>, String> {
    let mut parts = Vec::<Value>::new();
    for raw_ref in refs {
        let normalized = normalize_media_value_for_remote(raw_ref)?;
        if let Some((mime_type, bytes)) = decode_data_url(&normalized) {
            parts.push(json!({
                "inlineData": {
                    "mimeType": mime_type,
                    "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                }
            }));
            continue;
        }
        if is_http_url(&normalized) {
            parts.push(json!({
                "fileData": {
                    "mimeType": "image/png",
                    "fileUri": normalized,
                }
            }));
        }
    }
    parts.push(json!({ "text": prompt }));
    Ok(parts)
}

fn run_openai_image_request(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    payload: &Value,
) -> Result<Value, String> {
    let prompt = payload_string(payload, "prompt").unwrap_or_default();
    let count = payload_field(payload, "count")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .clamp(1, 4);
    let aspect_ratio = payload_string(payload, "aspectRatio");
    let size = payload_string(payload, "size");
    let quality = map_quality_to_openai(payload_string(payload, "quality").as_deref());
    let generation_mode =
        payload_string(payload, "generationMode").unwrap_or_else(|| "text-to-image".to_string());
    let refs = extract_reference_images(payload, 4);
    let should_use_edit_api = !refs.is_empty()
        && (generation_mode == "image-to-image" || generation_mode == "reference-guided");
    if should_use_edit_api {
        let files = refs
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let field_name = if refs.len() == 1 {
                    "image".to_string()
                } else {
                    format!("image[{index}]")
                };
                materialize_transport_value_to_temp_file(item, "image-ref")
                    .map(|path| (field_name, path))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut fields = vec![
            ("model".to_string(), model.to_string()),
            ("prompt".to_string(), prompt),
        ];
        let resolved_size =
            map_aspect_ratio_to_image_size(aspect_ratio.as_deref(), size.as_deref());
        fields.push(("size".to_string(), resolved_size));
        if let Some(quality) = quality.clone() {
            fields.push(("quality".to_string(), quality));
        }
        fields.push(("n".to_string(), count.to_string()));
        let result = run_curl_form_json(
            "POST",
            &normalize_image_edit_url(endpoint),
            api_key,
            &[],
            &fields,
            &files,
        );
        for (_, path) in files {
            let _ = fs::remove_file(path);
        }
        return result;
    }
    run_curl_json(
        "POST",
        &normalize_image_generation_url(endpoint),
        api_key,
        &[],
        Some(json!({
            "model": model,
            "prompt": prompt,
            "n": count,
            "size": map_aspect_ratio_to_image_size(aspect_ratio.as_deref(), size.as_deref()),
            "quality": quality.unwrap_or_else(|| "standard".to_string()),
            "response_format": "b64_json"
        })),
    )
}

fn run_gemini_generate_content_request(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    payload: &Value,
) -> Result<Value, String> {
    let prompt = payload_string(payload, "prompt").unwrap_or_default();
    let generation_mode =
        payload_string(payload, "generationMode").unwrap_or_else(|| "text-to-image".to_string());
    let refs = if generation_mode == "text-to-image" {
        Vec::new()
    } else {
        extract_reference_images(payload, 4)
    };
    let parts = build_gemini_content_parts(&prompt, &refs)?;
    let aspect_ratio = map_aspect_ratio_to_gemini(
        payload_string(payload, "aspectRatio").as_deref(),
        payload_string(payload, "size").as_deref(),
    );
    run_curl_json(
        "POST",
        &format!(
            "{}/models/{}:generateContent?key={}",
            normalize_base_url(endpoint),
            urlencoding::encode(model),
            urlencoding::encode(api_key.unwrap_or_default())
        ),
        None,
        &[],
        Some(json!({
            "contents": [
                {
                    "role": "user",
                    "parts": parts,
                }
            ],
            "generationConfig": {
                "responseModalities": ["TEXT", "IMAGE"],
                "imageConfig": {
                    "aspectRatio": aspect_ratio,
                }
            }
        })),
    )
}

fn run_gemini_imagen_request(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    payload: &Value,
) -> Result<Value, String> {
    run_curl_json(
        "POST",
        &format!(
            "{}/models/{}:predict?key={}",
            normalize_base_url(endpoint),
            urlencoding::encode(model),
            urlencoding::encode(api_key.unwrap_or_default())
        ),
        None,
        &[],
        Some(json!({
            "instances": [{ "prompt": payload_string(payload, "prompt").unwrap_or_default() }],
            "parameters": {
                "sampleCount": payload_field(payload, "count").and_then(Value::as_i64).unwrap_or(1).clamp(1, 4),
                "imageSize": payload_string(payload, "quality")
                    .filter(|item| item == "high" || item == "hd")
                    .map(|_| "2K".to_string())
                    .unwrap_or_else(|| "1K".to_string()),
                "aspectRatio": map_aspect_ratio_to_gemini(
                    payload_string(payload, "aspectRatio").as_deref(),
                    payload_string(payload, "size").as_deref(),
                ),
            }
        })),
    )
}

fn run_openai_json_image_request(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    payload: &Value,
    extra_fields: Value,
) -> Result<Value, String> {
    let mut body = json!({
        "model": model,
        "prompt": payload_string(payload, "prompt").unwrap_or_default(),
        "n": payload_field(payload, "count").and_then(Value::as_i64).unwrap_or(1).clamp(1, 4),
        "size": map_aspect_ratio_to_image_size(
            payload_string(payload, "aspectRatio").as_deref(),
            payload_string(payload, "size").as_deref(),
        ),
        "quality": map_quality_to_openai(payload_string(payload, "quality").as_deref()),
        "response_format": "b64_json"
    });
    if let Some(body_object) = body.as_object_mut() {
        if let Some(extra_object) = extra_fields.as_object() {
            for (key, value) in extra_object {
                if !value.is_null() {
                    body_object.insert(key.clone(), value.clone());
                }
            }
        }
    }
    run_curl_json("POST", endpoint, api_key, &[], Some(body))
}

fn run_dashscope_image_request(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    payload: &Value,
) -> Result<Value, String> {
    let generation_mode =
        payload_string(payload, "generationMode").unwrap_or_else(|| "text-to-image".to_string());
    let refs = extract_reference_images(payload, 4);
    let refs_for_transport = refs
        .iter()
        .map(|item| normalize_media_value_for_remote(item))
        .collect::<Result<Vec<_>, _>>()?;
    let endpoints = resolve_dashscope_wan_endpoints(endpoint, model, &generation_mode, refs.len());
    let count = payload_field(payload, "count")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .clamp(1, 4);
    let prompt = payload_string(payload, "prompt").unwrap_or_default();
    let size = map_size_to_dashscope(
        payload_string(payload, "size").as_deref(),
        payload_string(payload, "aspectRatio").as_deref(),
    );
    let interleave_size = map_size_to_dashscope_interleave(
        payload_string(payload, "size").as_deref(),
        payload_string(payload, "aspectRatio").as_deref(),
    );

    for candidate in endpoints {
        let mut payload_variants = Vec::<Value>::new();
        if candidate.contains("/text2image/") {
            payload_variants.push(json!({
                "model": model,
                "input": { "prompt": prompt },
                "parameters": { "n": count, "size": size }
            }));
        } else if candidate.contains("/image2image/") {
            payload_variants.push(json!({
                "model": model,
                "input": { "prompt": prompt, "images": refs_for_transport.iter().take(2).cloned().collect::<Vec<_>>() },
                "parameters": { "n": count, "size": size }
            }));
        } else if candidate.contains("/image-generation/") {
            let mut content = vec![json!({ "text": prompt })];
            for image in refs_for_transport.iter().take(4) {
                content.push(json!({ "image": image }));
            }
            payload_variants.push(json!({
                "model": model,
                "input": { "messages": [{ "role": "user", "content": content }] },
                "parameters": {
                    "size": if refs_for_transport.is_empty() { interleave_size.clone() } else { size.clone() },
                    "enable_interleave": refs_for_transport.is_empty(),
                    "max_images": if refs_for_transport.is_empty() { Some(count) } else { None::<i64> },
                    "n": if refs_for_transport.is_empty() { None::<i64> } else { Some(count) }
                }
            }));
        } else {
            let mut content = refs_for_transport
                .iter()
                .map(|image| json!({ "image": image }))
                .collect::<Vec<_>>();
            content.push(json!({ "text": prompt }));
            payload_variants.push(json!({
                "model": model,
                "input": { "messages": [{ "role": "user", "content": content.clone() }] },
                "parameters": { "n": count, "size": size, "enable_interleave": false }
            }));
            payload_variants.push(json!({
                "model": model,
                "input": { "messages": [{ "role": "user", "content": content }] },
                "parameters": { "enable_interleave": true, "size": interleave_size }
            }));
        }
        for body in payload_variants {
            if let Ok(response) = run_curl_json("POST", &candidate, api_key, &[], Some(body)) {
                let task_id = response
                    .pointer("/output/task_id")
                    .or_else(|| response.get("task_id"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
                if let Some(task_id) = task_id {
                    return resolve_dashscope_task_payload(&candidate, api_key, &task_id);
                }
                if extract_first_media_result(&response).is_some() {
                    return Ok(response);
                }
            }
        }
    }
    Err("DashScope image generation failed".to_string())
}

fn resolve_dashscope_task_payload(
    endpoint: &str,
    api_key: Option<&str>,
    task_id: &str,
) -> Result<Value, String> {
    let task_endpoint = resolve_dashscope_task_endpoint(endpoint, task_id);
    for _ in 0..60 {
        thread::sleep(std::time::Duration::from_millis(2000));
        if let Ok(response) = run_curl_json("GET", &task_endpoint, api_key, &[], None) {
            let status = response
                .pointer("/output/task_status")
                .or_else(|| response.pointer("/output/status"))
                .or_else(|| response.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            let failed =
                status.contains("fail") || status.contains("cancel") || status.contains("error");
            if failed {
                let reason = response
                    .pointer("/output/message")
                    .or_else(|| response.pointer("/output/code"))
                    .or_else(|| response.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                return Err(if reason.is_empty() {
                    "DashScope task failed".to_string()
                } else {
                    format!("DashScope task failed: {reason}")
                });
            }
            if status.contains("succeed")
                || status.contains("success")
                || status.contains("done")
                || status.contains("finish")
            {
                return Ok(response);
            }
            if extract_first_media_result(&response).is_some() {
                return Ok(response);
            }
        }
    }
    Err("DashScope task timeout".to_string())
}

pub(crate) fn run_image_generation_request(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    provider: &str,
    provider_template: &str,
    payload: &Value,
) -> Result<Value, String> {
    let normalized_template = provider_template.trim().to_lowercase();
    match normalized_template.as_str() {
        "openai-images" => run_openai_image_request(endpoint, api_key, model, payload),
        "gemini-openai-images" => {
            if is_official_gemini_endpoint(endpoint) {
                if model.to_lowercase().contains("imagen") {
                    run_gemini_imagen_request(endpoint, api_key, model, payload)
                } else {
                    run_gemini_generate_content_request(endpoint, api_key, model, payload)
                }
            } else {
                run_openai_json_image_request(
                    &resolve_gemini_openai_endpoint(endpoint),
                    api_key,
                    model,
                    payload,
                    json!({}),
                )
            }
        }
        "gemini-generate-content" => {
            run_gemini_generate_content_request(endpoint, api_key, model, payload)
        }
        "gemini-imagen-native" => {
            if is_official_gemini_endpoint(endpoint) && !model.to_lowercase().contains("gemini") {
                run_gemini_imagen_request(endpoint, api_key, model, payload)
            } else if is_official_gemini_endpoint(endpoint) {
                run_gemini_generate_content_request(endpoint, api_key, model, payload)
            } else {
                run_openai_json_image_request(
                    &resolve_gemini_openai_endpoint(endpoint),
                    api_key,
                    model,
                    payload,
                    json!({}),
                )
            }
        }
        "dashscope-wan-native" => run_dashscope_image_request(endpoint, api_key, model, payload),
        "ark-seedream-native" => run_openai_json_image_request(
            &normalize_image_generation_url(endpoint),
            api_key,
            model,
            payload,
            json!({
                "images": if payload_string(payload, "generationMode").unwrap_or_else(|| "text-to-image".to_string()) != "text-to-image" {
                    extract_reference_images(payload, 4)
                        .into_iter()
                        .map(|item| normalize_media_value_for_remote(&item))
                        .collect::<Result<Vec<_>, _>>()?
                } else {
                    Vec::<String>::new()
                }
            }),
        ),
        "jimeng-openai-wrapper" | "jimeng-images" => run_openai_json_image_request(
            &resolve_jimeng_wrapper_endpoint(endpoint),
            api_key,
            model,
            payload,
            json!({
                "images": if payload_string(payload, "generationMode").unwrap_or_else(|| "text-to-image".to_string()) != "text-to-image" {
                    extract_reference_images(payload, 4)
                        .into_iter()
                        .map(|item| normalize_media_value_for_remote(&item))
                        .collect::<Result<Vec<_>, _>>()?
                } else {
                    Vec::<String>::new()
                },
                "ratio": map_aspect_ratio_to_jimeng_ratio(
                    payload_string(payload, "aspectRatio").as_deref(),
                    payload_string(payload, "size").as_deref(),
                ),
                "resolution": map_quality_to_jimeng_resolution(payload_string(payload, "quality").as_deref()),
            }),
        ),
        "midjourney-proxy" => run_curl_json(
            "POST",
            &normalize_endpoint(endpoint, "/mj/submit/imagine"),
            None,
            &[("mj-api-secret", api_key.unwrap_or_default().to_string())],
            Some(json!({ "prompt": payload_string(payload, "prompt").unwrap_or_default() })),
        ),
        _ => {
            let fallback_provider = provider.trim().to_lowercase();
            if fallback_provider.contains("gemini") {
                run_image_generation_request(
                    endpoint,
                    api_key,
                    model,
                    provider,
                    "gemini-openai-images",
                    payload,
                )
            } else {
                run_image_generation_request(
                    endpoint,
                    api_key,
                    model,
                    provider,
                    "openai-images",
                    payload,
                )
            }
        }
    }
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

fn is_redbox_compatible_endpoint(endpoint: &str) -> bool {
    let normalized = normalize_base_url(endpoint).to_lowercase();
    normalized.contains("api.ziz.hk") && normalized.contains("/v1")
}

fn build_compatible_video_route_urls(endpoint: &str, suffix: &str) -> Vec<String> {
    let base = normalize_base_url(endpoint);
    let primary = normalize_endpoint(&base, suffix);
    if !is_redbox_compatible_endpoint(endpoint) {
        return vec![primary];
    }
    match url::Url::parse(&base) {
        Ok(parsed) => {
            let origin = format!(
                "{}://{}",
                parsed.scheme(),
                parsed.host_str().unwrap_or_default()
            );
            let mut urls = vec![
                primary,
                format!("{origin}/api/v1{suffix}"),
                format!("{origin}/v1{suffix}"),
            ];
            urls.retain(|item| !item.trim().is_empty());
            urls.dedup();
            urls
        }
        Err(_) => vec![primary],
    }
}

fn map_openai_video_size(aspect_ratio: &str, resolution: &str) -> &'static str {
    match (aspect_ratio, resolution) {
        ("9:16", "1080p") => "1024x1792",
        ("9:16", _) => "720x1280",
        (_, "1080p") => "1792x1024",
        _ => "1280x720",
    }
}

fn map_openai_video_seconds(duration_seconds: i64) -> &'static str {
    if duration_seconds <= 6 {
        "4"
    } else if duration_seconds <= 10 {
        "8"
    } else {
        "12"
    }
}

fn build_video_request_body(endpoint: &str, model: &str, payload: &Value) -> Result<Value, String> {
    let prompt = payload_string(payload, "prompt").unwrap_or_default();
    let generation_mode =
        payload_string(payload, "generationMode").unwrap_or_else(|| "text-to-video".to_string());
    let reference_images = extract_reference_images(payload, 5)
        .into_iter()
        .map(|item| normalize_media_value_for_remote(&item))
        .collect::<Result<Vec<_>, _>>()?;
    let driving_audio = payload_string(payload, "drivingAudio")
        .map(|item| normalize_media_value_for_remote(&item))
        .transpose()?
        .filter(|item| !item.trim().is_empty());
    let first_clip = payload_string(payload, "firstClip")
        .map(|item| normalize_media_value_for_remote(&item))
        .transpose()?
        .filter(|item| !item.trim().is_empty());
    let aspect_ratio = normalize_video_aspect_ratio(
        payload_string(payload, "aspectRatio")
            .as_deref()
            .unwrap_or("16:9"),
    );
    let resolution = normalize_video_resolution(
        payload_string(payload, "resolution")
            .as_deref()
            .unwrap_or("720p"),
    );
    let duration_seconds =
        normalize_video_duration(payload_field(payload, "durationSeconds").and_then(Value::as_i64));
    let generate_audio = payload_field(payload, "generateAudio")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut body = json!({
        "model": model,
        "prompt": prompt,
        "size": map_openai_video_size(aspect_ratio, resolution),
        "seconds": map_openai_video_seconds(duration_seconds),
        "n": payload_field(payload, "count").and_then(Value::as_i64).unwrap_or(1).clamp(1, 2),
        "generateAudio": generate_audio,
    });

    if is_redbox_compatible_endpoint(endpoint) {
        body["resolution"] = json!(if resolution == "1080p" {
            "1080P"
        } else {
            "720P"
        });
        body["duration"] = json!(duration_seconds);
    }

    match generation_mode.as_str() {
        "reference-guided" => {
            if !reference_images.is_empty() {
                if is_redbox_compatible_endpoint(endpoint) {
                    body["media"] = json!(
                        reference_images
                            .iter()
                            .map(|item| json!({
                                "type": "reference_image",
                                "url": item,
                            }))
                            .collect::<Vec<_>>()
                    );
                }
                body["images"] = json!(reference_images.clone());
                body["reference_images"] = json!(reference_images.clone());
                body["reference_image_urls"] = json!(reference_images.clone());
                body["image_urls"] = json!(reference_images.clone());
                body["image"] = json!(reference_images[0].clone());
                body["image_url"] = json!(reference_images[0].clone());
                body["reference_image"] = json!(reference_images[0].clone());
                body["img_url"] = json!(reference_images[0].clone());
            }
            if let Some(driving_audio) = driving_audio.clone() {
                body["reference_voice"] = json!(driving_audio.clone());
                body["reference_voice_url"] = json!(driving_audio.clone());
                body["audio_url"] = json!(driving_audio);
            }
        }
        "first-last-frame" => {
            let first_frame = reference_images.first().cloned().unwrap_or_default();
            let last_frame = reference_images.get(1).cloned().unwrap_or_default();
            if !first_frame.is_empty() || !last_frame.is_empty() {
                body["video_mode"] = json!("first_last_frame");
                body["media"] = json!(
                    [
                        if !first_frame.is_empty() {
                            Some(json!({ "type": "first_frame", "url": first_frame.clone() }))
                        } else {
                            None
                        },
                        if !last_frame.is_empty() {
                            Some(json!({ "type": "last_frame", "url": last_frame.clone() }))
                        } else {
                            None
                        },
                        driving_audio
                            .clone()
                            .map(|audio| json!({ "type": "driving_audio", "url": audio })),
                    ]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                );
                if !first_frame.is_empty() {
                    body["image"] = json!(first_frame.clone());
                    body["image_url"] = json!(first_frame.clone());
                    body["reference_image"] = json!(first_frame.clone());
                    body["img_url"] = json!(first_frame.clone());
                }
                if !last_frame.is_empty() {
                    body["images"] = json!(
                        [first_frame.clone(), last_frame.clone()]
                            .into_iter()
                            .filter(|item| !item.is_empty())
                            .collect::<Vec<_>>()
                    );
                    body["last_frame"] = json!(last_frame.clone());
                    body["last_frame_url"] = json!(last_frame.clone());
                    body["last_image_url"] = json!(last_frame);
                }
                if let Some(driving_audio) = driving_audio {
                    body["audio_url"] = json!(driving_audio.clone());
                    body["driving_audio_url"] = json!(driving_audio);
                }
            }
        }
        "continuation" => {
            if let Some(first_clip) = first_clip {
                body["video_mode"] = json!("continuation");
                body["media"] = json!([{ "type": "first_clip", "url": first_clip.clone() }]);
                body["first_clip_url"] = json!(first_clip.clone());
                body["video_url"] = json!(first_clip.clone());
                body["video"] = json!(first_clip);
            }
        }
        _ => {
            if let Some(driving_audio) = driving_audio {
                body["audio_url"] = json!(driving_audio.clone());
                body["driving_audio_url"] = json!(driving_audio);
            }
        }
    }

    Ok(body)
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

fn extract_video_generation_status(value: &Value) -> String {
    value
        .get("task_status")
        .or_else(|| value.get("status"))
        .or_else(|| value.pointer("/data/task_status"))
        .or_else(|| value.pointer("/data/status"))
        .or_else(|| value.pointer("/output/task_status"))
        .or_else(|| value.pointer("/output/status"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

pub(crate) fn extract_video_generation_status_details(
    value: &Value,
) -> Option<(String, &'static str)> {
    [
        ("task_status", value.get("task_status")),
        ("status", value.get("status")),
        ("data.task_status", value.pointer("/data/task_status")),
        ("data.status", value.pointer("/data/status")),
        ("output.task_status", value.pointer("/output/task_status")),
        ("output.status", value.pointer("/output/status")),
    ]
    .into_iter()
    .find_map(|(source, item)| {
        item.and_then(Value::as_str)
            .map(str::trim)
            .filter(|status| !status.is_empty())
            .map(|status| (status.to_ascii_lowercase(), source))
    })
}

fn extract_video_generation_failure_message(value: &Value) -> Option<String> {
    [
        value.get("message"),
        value.get("error"),
        value.get("error_message"),
        value.get("detail"),
        value.pointer("/output/message"),
        value.pointer("/output/code"),
        value.pointer("/data/message"),
        value.pointer("/data/error"),
    ]
    .into_iter()
    .flatten()
    .find_map(Value::as_str)
    .map(str::trim)
    .filter(|item| !item.is_empty())
    .map(ToString::to_string)
}

fn summarize_json_body(value: &Value) -> String {
    let raw = match value {
        Value::String(text) => text.trim().to_string(),
        _ => serde_json::to_string(value).unwrap_or_else(|_| value.to_string()),
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "<empty>".to_string();
    }
    let snippet = trimmed.chars().take(400).collect::<String>();
    if snippet.chars().count() == trimmed.chars().count() {
        snippet
    } else {
        format!("{snippet}...")
    }
}

pub(crate) fn poll_video_generation_result<F>(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    response: &Value,
    mut on_progress: F,
) -> Result<String, String>
where
    F: FnMut(&str),
{
    if let Some(url) = extract_media_url(response) {
        on_progress("provider 已直接返回视频地址，跳过轮询。");
        return Ok(url);
    }
    let (task_id, task_id_source) = extract_task_id_details(response)
        .ok_or_else(|| "video generation response did not include a task id".to_string())?;
    on_progress(&format!(
        "provider 已创建异步任务，task_id={task_id}，来源字段={task_id_source}。"
    ));
    if task_id_source == "id" {
        on_progress(
            "provider 只返回了通用 id 字段，当前按 task_id 继续轮询；如果后续异常，这里是首要怀疑点。",
        );
    }
    let max_attempts = (VIDEO_TASK_POLL_TIMEOUT_MS / VIDEO_TASK_POLL_INTERVAL_MS) as usize;
    let sleep_duration = std::time::Duration::from_millis(VIDEO_TASK_POLL_INTERVAL_MS);
    let mut last_transport_error: Option<String> = None;
    if is_redbox_compatible_endpoint(endpoint) {
        let query_urls =
            build_compatible_video_route_urls(endpoint, "/videos/generations/tasks/query");
        on_progress("开始轮询 provider 任务状态（POST /videos/generations/tasks/query）。");
        for attempt_index in 0..max_attempts {
            thread::sleep(sleep_duration);
            let attempt = attempt_index + 1;
            let mut attempt_transport_error: Option<String> = None;
            let mut logged_status = false;
            for query_url in &query_urls {
                match run_curl_json_response(
                    "POST",
                    query_url,
                    api_key,
                    &[],
                    Some(json!({
                        "model": model,
                        "task_id": task_id,
                    })),
                    None,
                ) {
                    Ok(response) => {
                        if !(200..300).contains(&response.status) {
                            let message = format!(
                                "[{query_url}] HTTP {} {}",
                                response.status,
                                summarize_json_body(&response.body)
                            );
                            last_transport_error = Some(message.clone());
                            attempt_transport_error = Some(message.clone());
                            if response.status != 404 {
                                on_progress(&format!("poll#{attempt} api_error={message}"));
                                return Err(message);
                            }
                            continue;
                        }
                        let next = response.body;
                        if !logged_status {
                            if let Some((status, source)) =
                                extract_video_generation_status_details(&next)
                            {
                                on_progress(&format!(
                                    "poll#{attempt} api_status[{source}]={status}"
                                ));
                            } else {
                                on_progress(&format!("poll#{attempt} api_status=<missing>"));
                            }
                            logged_status = true;
                        }
                        if let Some(url) = extract_media_url(&next) {
                            on_progress(&format!("poll#{attempt} media_url_ready=true"));
                            return Ok(url);
                        }
                        let status = extract_video_generation_status(&next);
                        if status.contains("failed")
                            || status.contains("error")
                            || status.contains("cancel")
                        {
                            let message = extract_video_generation_failure_message(&next)
                                .unwrap_or_else(|| {
                                    format!("video generation failed with status {status}")
                                });
                            on_progress(&format!("provider 任务失败：{message}"));
                            return Err(message);
                        }
                    }
                    Err(error) => {
                        let message = format!("[{query_url}] {error}");
                        last_transport_error = Some(message.clone());
                        attempt_transport_error = Some(message);
                    }
                }
            }
            if !logged_status {
                if let Some(error) = attempt_transport_error.as_deref() {
                    on_progress(&format!("poll#{attempt} api_error={error}"));
                } else {
                    on_progress(&format!("poll#{attempt} api_status=<missing>"));
                }
            }
        }
        let timeout_error = last_transport_error.unwrap_or_else(|| {
            format!(
                "video generation timed out after {} seconds (task_id={task_id})",
                VIDEO_TASK_POLL_TIMEOUT_MS / 1000
            )
        });
        on_progress(&format!("轮询超时：{timeout_error}"));
        return Err(timeout_error);
    }
    let status_url = extract_status_url(response);
    let poll_url = video_poll_url(endpoint, &task_id, status_url);
    on_progress(&format!("开始轮询 provider 任务状态（GET {poll_url}）。"));
    for attempt_index in 0..max_attempts {
        thread::sleep(sleep_duration);
        let attempt = attempt_index + 1;
        match run_curl_json_response("GET", &poll_url, api_key, &[], None, None) {
            Ok(response) => {
                if !(200..300).contains(&response.status) {
                    let message = format!(
                        "[{poll_url}] HTTP {} {}",
                        response.status,
                        summarize_json_body(&response.body)
                    );
                    on_progress(&format!("poll#{attempt} api_error={message}"));
                    return Err(message);
                }
                let next = response.body;
                if let Some((status, source)) = extract_video_generation_status_details(&next) {
                    on_progress(&format!("poll#{attempt} api_status[{source}]={status}"));
                } else {
                    on_progress(&format!("poll#{attempt} api_status=<missing>"));
                }
                if let Some(url) = extract_media_url(&next) {
                    on_progress(&format!("poll#{attempt} media_url_ready=true"));
                    return Ok(url);
                }
                let status = extract_video_generation_status(&next);
                if status.contains("failed")
                    || status.contains("error")
                    || status.contains("cancel")
                {
                    let message = extract_video_generation_failure_message(&next)
                        .unwrap_or_else(|| format!("video generation failed with status {status}"));
                    on_progress(&format!("provider 任务失败：{message}"));
                    return Err(message);
                }
            }
            Err(error) => {
                last_transport_error = Some(error);
                on_progress(&format!(
                    "poll#{attempt} api_error={}",
                    last_transport_error.as_deref().unwrap_or_default()
                ));
            }
        }
    }
    let timeout_error = last_transport_error.unwrap_or_else(|| {
        format!(
            "video generation timed out after {} seconds (task_id={task_id})",
            VIDEO_TASK_POLL_TIMEOUT_MS / 1000
        )
    });
    on_progress(&format!("轮询超时：{timeout_error}"));
    Err(timeout_error)
}

pub(crate) fn run_video_generation_request(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    payload: &Value,
) -> Result<Value, String> {
    let create_urls = build_compatible_video_route_urls(endpoint, "/videos/generations/async");
    let body = build_video_request_body(endpoint, model, payload)?;
    let mut last_error = None;
    for url in create_urls {
        match run_curl_json_response("POST", &url, api_key, &[], Some(body.clone()), None) {
            Ok(response) => {
                if (200..300).contains(&response.status) {
                    return Ok(response.body);
                }
                let error = format!(
                    "[{url}] HTTP {} {}",
                    response.status,
                    summarize_json_body(&response.body)
                );
                if response.status != 404 {
                    return Err(error);
                }
                last_error = Some(error);
            }
            Err(error) => last_error = Some(format!("[{url}] {error}")),
        }
    }
    Err(last_error.unwrap_or_else(|| "video generation request failed".to_string()))
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
        let payload = json!({
            "prompt": "test",
            "aspectRatio": "9:16",
            "resolution": "1080p",
            "durationSeconds": 6,
        });

        let redbox = build_video_request_body("https://api.ziz.hk/redbox/v1", "wan-test", &payload)
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
    fn build_video_request_body_adds_reference_media_for_redbox_reference_guided() {
        let payload = json!({
            "prompt": "test",
            "generationMode": "reference-guided",
            "referenceImages": [
                "data:image/jpeg;base64,AAA=",
                "data:image/jpeg;base64,BBB="
            ],
        });

        let redbox = build_video_request_body("https://api.ziz.hk/redbox/v1", "wan-test", &payload)
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
}
