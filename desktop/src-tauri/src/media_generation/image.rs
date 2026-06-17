use super::*;

pub(crate) fn normalize_image_generation_url(endpoint: &str) -> String {
    let normalized = normalize_base_url(endpoint);
    if normalized.ends_with("/images/generations") {
        normalized
    } else {
        format!("{normalized}/images/generations")
    }
}

pub(crate) fn normalize_image_edit_url(endpoint: &str) -> String {
    let normalized = normalize_base_url(endpoint);
    if normalized.ends_with("/images/edits") {
        normalized
    } else {
        format!("{normalized}/images/edits")
    }
}

pub(crate) fn ensure_successful_image_response(
    operation: &str,
    method: &str,
    url: &str,
    response: crate::HttpJsonResponse,
) -> Result<Value, String> {
    if (200..300).contains(&response.status) {
        return Ok(response.body);
    }
    let raw_body =
        serde_json::to_string(&response.body).unwrap_or_else(|_| response.body.to_string());
    let raw_body_head = raw_body.chars().take(3000).collect::<String>();
    let raw_body_log = if raw_body.chars().count() > 3000 {
        format!(
            "{}...<truncated:{}>",
            raw_body_head,
            raw_body.chars().count() - 3000
        )
    } else {
        raw_body
    };
    let upstream_preview = format!(
        "[image-http] upstream_error_body_preview operation={} status={} url={} body={} ",
        operation,
        response.status,
        url,
        raw_body_log.replace('\n', "\\n").replace('\r', "\\r")
    );
    eprintln!("{upstream_preview}");
    crate::append_debug_trace_global(upstream_preview);
    let details = http_error_details_from_value(response.status, &response.body);
    let line = format!(
        "{} operation={} url={}",
        crate::http_error_debug_line("image-http", method, url, &details),
        operation,
        url
    );
    eprintln!("{line}");
    crate::append_debug_trace_global(line);
    if operation == "openai-images.edit" && response.status == 404 {
        return Err(format!(
            "当前图片源不支持参考图生图：{url} 返回 404。请切换到支持 /images/edits 的图片服务，或关闭参考图模式。"
        ));
    }
    Err(format_http_error_message("Image generation", &details))
}

pub(crate) fn log_image_http_body_preview(
    attempt: &str,
    operation: &str,
    method: &str,
    url: &str,
    status: u16,
    body: &Value,
) {
    let raw_body = serde_json::to_string(body).unwrap_or_else(|_| body.to_string());
    let raw_body_head = raw_body.chars().take(3000).collect::<String>();
    let raw_body_log = if raw_body.chars().count() > 3000 {
        format!(
            "{}...<truncated:{}>",
            raw_body_head,
            raw_body.chars().count() - 3000
        )
    } else {
        raw_body
    };
    let line = format!(
        "[image-http] upstream_body_preview attempt={} operation={} method={} status={} url={} body={}",
        attempt,
        operation,
        method,
        status,
        url,
        raw_body_log.replace('\n', "\\n").replace('\r', "\\r")
    );
    eprintln!("{line}");
    crate::append_debug_trace_global(line);
}

pub(crate) fn is_official_gemini_endpoint(endpoint: &str) -> bool {
    let normalized = normalize_base_url(endpoint).to_lowercase();
    normalized.contains("generativelanguage.googleapis.com")
        || normalized.contains("googleapis.com")
}

pub(crate) fn is_redbox_official_image_endpoint(endpoint: &str) -> bool {
    is_redbox_official_endpoint(endpoint)
}

pub(crate) fn is_openai_official_endpoint(endpoint: &str) -> bool {
    normalize_base_url(endpoint)
        .to_lowercase()
        .contains("api.openai.com")
}

pub(crate) fn resolve_gemini_openai_endpoint(endpoint: &str) -> String {
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

pub(crate) fn resolve_jimeng_wrapper_endpoint(endpoint: &str) -> String {
    let base = normalize_base_url(endpoint);
    if base.contains("/images/generations") {
        return base;
    }
    if base.contains("/v1") {
        return normalize_endpoint(&base, "/images/generations");
    }
    normalize_endpoint(&base, "/v1/images/generations")
}

pub(crate) fn normalize_dashscope_base_endpoint(endpoint: &str) -> String {
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

pub(crate) fn resolve_dashscope_wan_endpoints(
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

pub(crate) fn resolve_dashscope_task_endpoint(endpoint: &str, task_id: &str) -> String {
    let base = normalize_dashscope_base_endpoint(endpoint);
    normalize_endpoint(
        &base,
        &format!("/api/v1/tasks/{}", urlencoding::encode(task_id)),
    )
}

pub(crate) fn endpoint_origin(endpoint: &str) -> String {
    match url::Url::parse(endpoint) {
        Ok(parsed) => format!(
            "{}://{}",
            parsed.scheme(),
            parsed.host_str().unwrap_or_default()
        ),
        Err(_) => normalize_base_url(endpoint),
    }
}

pub(crate) fn normalize_video_aspect_ratio(value: &str) -> &'static str {
    if value.trim() == "9:16" {
        "9:16"
    } else {
        "16:9"
    }
}

pub(crate) fn normalize_video_resolution(value: &str) -> &'static str {
    if value.trim() == "1080p" {
        "1080p"
    } else {
        "720p"
    }
}

pub(crate) fn normalize_video_duration(value: Option<i64>) -> i64 {
    let parsed = value.unwrap_or(8);
    parsed.clamp(1, 15)
}

pub(crate) fn payload_video_duration_seconds(payload: &Value) -> i64 {
    for key in ["durationSeconds", "duration_seconds", "duration", "seconds"] {
        if let Some(value) = payload_field(payload, key) {
            let parsed = match value {
                Value::Number(number) => number.as_i64(),
                Value::String(text) => text.trim().parse::<i64>().ok(),
                _ => None,
            };
            if parsed.is_some() {
                return normalize_video_duration(parsed);
            }
        }
    }
    normalize_video_duration(None)
}

pub(crate) fn map_aspect_ratio_to_image_size(
    aspect_ratio: Option<&str>,
    size: Option<&str>,
) -> String {
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

pub(crate) fn payload_string_any(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| payload_string(payload, key))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn normalize_image_aspect_ratio(value: &str) -> Option<String> {
    let compact = value
        .trim()
        .replace('：', ":")
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>();
    match compact.as_str() {
        "1:1" | "3:4" | "4:3" | "9:16" | "16:9" => Some(compact),
        _ => None,
    }
}

pub(crate) fn payload_image_aspect_ratio(payload: &Value) -> Option<String> {
    payload_string_any(payload, &["aspectRatio", "aspect_ratio", "ratio"])
        .and_then(|value| normalize_image_aspect_ratio(&value))
}

pub(crate) fn payload_image_size(payload: &Value) -> Option<String> {
    payload_string_any(payload, &["size", "imageSize", "image_size"])
}

pub(crate) fn payload_image_quality(payload: &Value) -> Option<String> {
    payload_string_any(payload, &["quality", "imageQuality", "image_quality"])
}

pub(crate) fn normalize_image_resolution(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let compact = trimmed
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>()
        .to_ascii_uppercase();
    if compact.contains('X') || compact.contains('*') {
        return None;
    }
    match compact.as_str() {
        "AUTO" => None,
        "1K" | "1024" | "1024P" => Some("1K".to_string()),
        "2K" | "2048" | "2048P" => Some("2K".to_string()),
        "4K" | "4096" | "4096P" => Some("4K".to_string()),
        "720P" => Some("720p".to_string()),
        "1080P" => Some("1080p".to_string()),
        _ => Some(trimmed.to_string()),
    }
}

pub(crate) fn payload_image_resolution(payload: &Value) -> Option<String> {
    payload_string_any(
        payload,
        &["resolution", "imageResolution", "image_resolution"],
    )
    .and_then(|value| normalize_image_resolution(&value))
}

pub(crate) fn required_image_aspect_ratio(payload: &Value) -> String {
    payload_image_aspect_ratio(payload).unwrap_or_else(|| DEFAULT_IMAGE_ASPECT_RATIO.to_string())
}

pub(crate) fn required_image_quality(payload: &Value) -> String {
    map_quality_to_openai(payload_image_quality(payload).as_deref())
        .unwrap_or_else(|| DEFAULT_IMAGE_QUALITY.to_string())
}

pub(crate) fn required_image_resolution(payload: &Value) -> String {
    payload_image_resolution(payload).unwrap_or_else(|| DEFAULT_IMAGE_RESOLUTION.to_string())
}

pub(crate) fn is_openai_gpt_image_model(model: &str) -> bool {
    model.trim().to_ascii_lowercase().starts_with("gpt-image-")
}

pub(crate) fn resolve_openai_official_image_size(
    aspect_ratio: Option<&str>,
    size: Option<&str>,
) -> String {
    if let Some(size) = size.map(str::trim).filter(|item| !item.is_empty()) {
        match size {
            "1024x1024" | "1536x1024" | "1024x1536" | "auto" => return size.to_string(),
            _ => {}
        }
    }
    match aspect_ratio.unwrap_or("1:1").trim() {
        "4:3" | "16:9" => "1536x1024".to_string(),
        "3:4" | "9:16" => "1024x1536".to_string(),
        _ => "1024x1024".to_string(),
    }
}

pub(crate) fn openai_supports_response_format(model: &str, is_edit: bool) -> bool {
    let normalized = model.trim().to_ascii_lowercase();
    if is_openai_gpt_image_model(&normalized) {
        return false;
    }
    if is_edit {
        normalized == "dall-e-2"
    } else {
        normalized == "dall-e-2" || normalized == "dall-e-3"
    }
}

pub(crate) fn map_quality_to_strict_openai(
    model: &str,
    quality: Option<&str>,
    is_edit: bool,
) -> Option<String> {
    let normalized_model = model.trim().to_ascii_lowercase();
    let normalized_quality = quality.map(str::trim).unwrap_or_default();
    if is_openai_gpt_image_model(&normalized_model) {
        return match normalized_quality {
            "high" | "hd" => Some("high".to_string()),
            "medium" | "standard" | "low" | "auto" | "" => Some("medium".to_string()),
            _ => Some("medium".to_string()),
        };
    }
    if normalized_model == "dall-e-3" && !is_edit {
        return match normalized_quality {
            "high" | "hd" => Some("hd".to_string()),
            "standard" | "medium" | "low" | "auto" | "" => Some("standard".to_string()),
            _ => Some("standard".to_string()),
        };
    }
    None
}

pub(crate) fn map_aspect_ratio_to_gemini(
    aspect_ratio: Option<&str>,
    size: Option<&str>,
) -> Option<String> {
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

pub(crate) fn infer_aspect_ratio_from_size(size: Option<&str>) -> Option<&'static str> {
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
    if best_delta <= 0.04 {
        best
    } else {
        None
    }
}

pub(crate) fn map_quality_to_openai(quality: Option<&str>) -> Option<String> {
    match quality.map(str::trim).unwrap_or_default() {
        "high" | "hd" => Some("high".to_string()),
        "low" => Some("low".to_string()),
        "medium" | "standard" | "auto" | "" => Some("medium".to_string()),
        other => Some(other.to_string()),
    }
}

pub(crate) fn map_image_resolution_to_native_tier(resolution: Option<&str>) -> Option<String> {
    match resolution.and_then(normalize_image_resolution).as_deref() {
        Some("1K") | Some("720p") | Some("1080p") => Some("1K".to_string()),
        Some("2K") | Some("4K") => Some("2K".to_string()),
        _ => None,
    }
}

pub(crate) fn map_resolution_or_quality_to_image_size(
    resolution: Option<&str>,
    quality: Option<&str>,
) -> String {
    if let Some(resolution) = map_image_resolution_to_native_tier(resolution) {
        if resolution.eq_ignore_ascii_case("1k") {
            return "1K".to_string();
        }
        return "2K".to_string();
    }
    match quality.map(str::trim).unwrap_or_default() {
        "high" | "hd" => "2K".to_string(),
        _ => "1K".to_string(),
    }
}

pub(crate) fn map_resolution_or_quality_to_jimeng_resolution(
    resolution: Option<&str>,
    quality: Option<&str>,
) -> Option<String> {
    if let Some(resolution) = map_image_resolution_to_native_tier(resolution) {
        if resolution.eq_ignore_ascii_case("1k") {
            return Some("1k".to_string());
        }
        return Some("2k".to_string());
    }
    match quality.map(str::trim).unwrap_or_default() {
        "high" | "hd" | "low" | "auto" | "" => Some("2k".to_string()),
        "standard" | "medium" => Some("1k".to_string()),
        other => Some(other.to_string()),
    }
}

pub(crate) fn map_aspect_ratio_to_jimeng_ratio(
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

pub(crate) fn map_size_to_dashscope(size: Option<&str>, aspect_ratio: Option<&str>) -> String {
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

pub(crate) fn map_size_to_dashscope_interleave(
    size: Option<&str>,
    aspect_ratio: Option<&str>,
) -> String {
    map_size_to_dashscope(size, aspect_ratio)
}

pub(crate) fn is_http_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

pub(crate) fn infer_mime_type_from_path(path: &str) -> &'static str {
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

pub(crate) fn extension_from_mime_type(mime_type: &str) -> &'static str {
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

pub(crate) fn decode_data_url(raw: &str) -> Option<(String, Vec<u8>)> {
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

pub(crate) fn normalize_media_value_for_remote(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if is_http_url(trimmed) || trimmed.starts_with("data:") {
        return Ok(trimmed.to_string());
    }
    if let Some(path) = crate::resolve_local_path(trimmed).filter(|path| path.exists()) {
        let buffer = fs::read(&path).map_err(|error| error.to_string())?;
        let mime_type = infer_mime_type_from_path(&path.to_string_lossy());
        return Ok(format!(
            "data:{mime_type};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(buffer)
        ));
    }
    if trimmed.starts_with("file://") {
        let path = crate::resolve_local_path(trimmed)
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| trimmed.to_string());
        return Err(format!("本地图片不存在或无法读取: {path}"));
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

pub(crate) fn download_http_bytes(url: &str) -> Result<(Option<String>, Vec<u8>), String> {
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client.get(url).send().map_err(|error| error.to_string())?;
    let status = response.status();
    let mime_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    if !status.is_success() {
        let body = response
            .text()
            .unwrap_or_default()
            .chars()
            .take(500)
            .collect::<String>();
        return Err(format!(
            "HTTP GET failed status={} url={} body={}",
            status.as_u16(),
            url,
            body
        ));
    }
    let bytes = response.bytes().map_err(|error| error.to_string())?;
    Ok((mime_type, bytes.to_vec()))
}

pub(crate) fn materialize_transport_value_to_temp_file(
    raw: &str,
    prefix: &str,
) -> Result<PathBuf, String> {
    let normalized = normalize_media_value_for_remote(raw)?;
    let (mime_type, bytes) = if let Some(decoded) = decode_data_url(&normalized) {
        decoded
    } else if is_http_url(&normalized) {
        let (mime_type, bytes) = download_http_bytes(&normalized)?;
        (
            mime_type.unwrap_or_else(|| "application/octet-stream".to_string()),
            bytes,
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

pub(crate) fn run_form_json(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    fields: &[(String, String)],
    file_fields: &[(String, PathBuf)],
) -> Result<crate::HttpJsonResponse, String> {
    let method_name = method;
    let method =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|error| error.to_string())?;
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(
            IMAGE_REQUEST_TIMEOUT_SECONDS,
        ))
        .build()
        .map_err(|error| error.to_string())?;
    let mut form = reqwest::blocking::multipart::Form::new();
    for (name, value) in fields {
        form = form.text(name.clone(), value.clone());
    }
    let mut file_summaries = Vec::<String>::new();
    for (name, file_path) in file_fields {
        let bytes = fs::read(file_path).map_err(|error| {
            format!(
                "Failed to read multipart file field={} path={} error={}",
                name,
                file_path.display(),
                error
            )
        })?;
        if bytes.is_empty() {
            return Err(format!(
                "Multipart file is empty field={} path={}",
                name,
                file_path.display()
            ));
        }
        let file_name = file_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("image")
            .to_string();
        let mime_type = infer_mime_type_from_path(&file_path.to_string_lossy());
        file_summaries.push(format!(
            "{}:{}:{}B:{}",
            name,
            mime_type,
            bytes.len(),
            file_name
        ));
        let part = reqwest::blocking::multipart::Part::bytes(bytes)
            .file_name(file_name)
            .mime_str(mime_type)
            .map_err(|error| error.to_string())?;
        form = form.part(name.clone(), part);
    }
    let mut request = client.request(method.clone(), url).multipart(form);
    if let Some(key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        request = request.bearer_auth(key);
    }
    for (header, value) in extra_headers {
        request = request.header(*header, value.as_str());
    }
    let trace_line = format!(
        "[image-http] multipart_request method={} url={} fields={} files={}",
        method_name,
        url,
        fields
            .iter()
            .map(|(name, _value)| name.as_str())
            .collect::<Vec<_>>()
            .join(","),
        file_summaries.join(",")
    );
    eprintln!("{trace_line}");
    crate::append_debug_trace_global(trace_line);
    let response = request.send().map_err(|error| {
        let line = format!(
            "[image-http] multipart_transport_error stage=send method={} url={} files={} error={}",
            method_name,
            url,
            file_summaries.join(","),
            error
        );
        eprintln!("{line}");
        crate::append_debug_trace_global(line);
        format!(
            "Image multipart request failed during send: {} (method={} url={})",
            error, method_name, url
        )
    })?;
    let status = response.status().as_u16();
    let body_text = response.text().map_err(|error| {
        let line = format!(
            "[image-http] multipart_transport_error stage=read_body method={} url={} status={} error={}",
            method_name, url, status, error
        );
        eprintln!("{line}");
        crate::append_debug_trace_global(line);
        format!(
            "Image multipart response body read failed: {} (method={} url={} status={})",
            error, method_name, url, status
        )
    })?;
    let normalized_body = body_text.trim();
    if normalized_body.is_empty() {
        if !(200..300).contains(&status) {
            let details = crate::http_error_details_from_text(status, "");
            crate::append_debug_trace_global(crate::http_error_debug_line(
                "http-form-json",
                method_name,
                url,
                &details,
            ));
        }
        return Ok(crate::HttpJsonResponse {
            status,
            body: json!({}),
        });
    }
    let parsed = serde_json::from_str(normalized_body).map_err(|error| {
        let body_head = normalized_body.chars().take(3000).collect::<String>();
        let raw_body_log = if normalized_body.chars().count() > 3000 {
            format!("{}...<truncated:{}>", body_head, normalized_body.len() - 3000)
        } else {
            body_head
        };
        let line = format!(
            "[http][form-json] invalid_json method={} url={} status={} raw_body={} error={}",
            method_name,
            url,
            status,
            raw_body_log.replace('\n', "\\n").replace('\r', "\\r"),
            error
        );
        eprintln!("{line}");
        crate::append_debug_trace_global(format!(
            "[image-http] invalid_json_for_response_body method={} url={} status={} raw_body={} error={}",
            method_name,
            url,
            status,
            raw_body_log.replace('\n', "\\n").replace('\r', "\\r"),
            error
        ));
        let message = format!("Invalid JSON response: {error}");
        crate::append_debug_trace_global(format!(
            "[http][form-json] invalid_json_message method={} url={} status={} body={} error={}",
            method_name, url, status, raw_body_log, message
        ));
        format!(
            "上游返回了非 JSON 响应：status={} body={}",
            status,
            raw_body_log
        )
    })?;
    if !(200..300).contains(&status) {
        let details = crate::http_error_details_from_text(status, normalized_body);
        crate::append_debug_trace_global(crate::http_error_debug_line(
            "http-form-json",
            method_name,
            url,
            &details,
        ));
    }
    Ok(crate::HttpJsonResponse {
        status,
        body: parsed,
    })
}

#[cfg(test)]
pub(crate) fn extract_reference_images(payload: &Value, max_count: usize) -> Vec<String> {
    for key in [
        "referenceImages",
        "images",
        "reference_images",
        "imageUrls",
        "image_urls",
    ] {
        let items = payload_field(payload, key)
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
            .unwrap_or_default();
        if !items.is_empty() {
            return items;
        }
    }
    Vec::new()
}

pub(crate) fn extract_reference_image_values(
    payload: &Value,
    max_count: usize,
) -> Result<Vec<String>, String> {
    let budget = crate::runtime::MediaRefBudget::reference_images(max_count);
    let refs = crate::runtime::collect_media_refs_from_payload(
        payload,
        &[
            "referenceImages",
            "images",
            "reference_images",
            "imageUrls",
            "image_urls",
        ],
        crate::runtime::MediaRefKind::Image,
        budget,
    )
    .map_err(|error| {
        let message = format!("参考媒体超出当前请求限制：{error}");
        let line = format!(
            "[media-ref][budget] kind=image max_items={} max_inline_bytes={} max_total_inline_bytes={} error={}",
            budget.max_items, budget.max_inline_bytes, budget.max_total_inline_bytes, error
        );
        crate::logging::emit_legacy_line(
            crate::logging::event::LogSource::Host,
            crate::logging::event::LogLevel::Warn,
            "media-ref",
            "budget_exceeded",
            line,
            json!({
                "kind": "image",
                "maxItems": budget.max_items,
                "maxInlineBytes": budget.max_inline_bytes,
                "maxTotalInlineBytes": budget.max_total_inline_bytes,
                "error": error,
            }),
            None,
        );
        message
    })?;
    Ok(refs.into_iter().map(|item| item.raw).collect())
}

pub(crate) fn payload_has_nonempty_string_array(payload: &Value, key: &str) -> bool {
    payload_field(payload, key)
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items
                .iter()
                .any(|item| item.as_str().is_some_and(|text| !text.trim().is_empty()))
        })
}

pub(crate) fn build_compatible_image_extra_fields(
    payload: &Value,
    refs: &[String],
) -> Result<Value, String> {
    let mut fields = serde_json::Map::<String, Value>::new();
    if !refs.is_empty() {
        fields.insert(
            "images".to_string(),
            json!(refs
                .iter()
                .map(|item| normalize_media_value_for_remote(item))
                .collect::<Result<Vec<_>, _>>()?),
        );
    }
    fields.insert(
        "aspectRatio".to_string(),
        json!(required_image_aspect_ratio(payload)),
    );
    fields.insert(
        "resolution".to_string(),
        json!(required_image_resolution(payload)),
    );
    fields.insert(
        "quality".to_string(),
        json!(required_image_quality(payload)),
    );
    Ok(Value::Object(fields))
}

pub(crate) fn build_gemini_content_parts(
    prompt: &str,
    refs: &[String],
) -> Result<Vec<Value>, String> {
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

pub(crate) fn run_openai_image_request(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    payload: &Value,
) -> Result<Value, String> {
    let prompt = payload_string(payload, "prompt").unwrap_or_default();
    let request_model = model.trim().to_string();
    let count = payload_field(payload, "count")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .clamp(1, 4);
    let aspect_ratio = required_image_aspect_ratio(payload);
    let size = payload_image_size(payload);
    let quality = required_image_quality(payload);
    let generation_mode =
        payload_string(payload, "generationMode").unwrap_or_else(|| "text-to-image".to_string());
    let refs = extract_reference_image_values(payload, 4)?;
    if is_redbox_official_image_endpoint(endpoint) {
        return run_openai_json_image_request(
            &normalize_image_generation_url(endpoint),
            api_key,
            model,
            payload,
            build_compatible_image_extra_fields(payload, &refs)?,
        );
    }
    if !refs.is_empty()
        && payload_has_nonempty_string_array(payload, "images")
        && !is_openai_official_endpoint(endpoint)
    {
        return run_openai_json_image_request(
            &normalize_image_generation_url(endpoint),
            api_key,
            model,
            payload,
            build_compatible_image_extra_fields(payload, &refs)?,
        );
    }
    let should_use_edit_api = !refs.is_empty()
        && (generation_mode == "image-to-image" || generation_mode == "reference-guided");
    if should_use_edit_api {
        let materialized_images = refs
            .iter()
            .map(|item| materialize_transport_value_to_temp_file(item, "image-ref"))
            .collect::<Result<Vec<_>, _>>()?;
        let result = (|| {
            let primary_files = build_openai_edit_file_fields(&materialized_images);

            let fallback_files = materialized_images
                .iter()
                .map(|path| ("image".to_string(), path.clone()))
                .collect::<Vec<_>>();

            let primary_fields = build_openai_edit_form_fields(
                &request_model,
                &prompt,
                count,
                Some(aspect_ratio.as_str()),
                size.as_deref(),
                Some(quality.as_str()),
            );
            let fallback_fields = build_rootflow_edit_form_fields(
                &request_model,
                &prompt,
                count,
                Some(aspect_ratio.as_str()),
                size.as_deref(),
                Some(quality.as_str()),
            );
            let request_url = normalize_image_edit_url(endpoint);

            let primary_response = run_form_json(
                "POST",
                &request_url,
                api_key,
                &[],
                &primary_fields,
                &primary_files,
            )?;

            let final_response = if (500..600).contains(&primary_response.status) {
                log_image_http_body_preview(
                    "reference-fallback-primary",
                    "openai-images.edit",
                    "POST",
                    &request_url,
                    primary_response.status,
                    &primary_response.body,
                );
                let fallback_response = run_form_json(
                    "POST",
                    &request_url,
                    api_key,
                    &[],
                    &fallback_fields,
                    &fallback_files,
                )?;
                log_image_http_body_preview(
                    "reference-fallback-secondary",
                    "openai-images.edit",
                    "POST",
                    &request_url,
                    fallback_response.status,
                    &fallback_response.body,
                );
                fallback_response
            } else {
                primary_response
            };

            ensure_successful_image_response(
                "openai-images.edit",
                "POST",
                &request_url,
                final_response,
            )
        })();

        for path in materialized_images {
            let _ = fs::remove_file(path);
        }
        return result;
    }
    let request_url = normalize_image_generation_url(endpoint);
    let mut body = json!({
        "model": request_model,
        "prompt": prompt,
        "n": count,
        "size": resolve_openai_official_image_size(Some(aspect_ratio.as_str()), size.as_deref())
    });
    if let Some(body_object) = body.as_object_mut() {
        if openai_supports_response_format(&request_model, false) {
            body_object.insert("response_format".to_string(), json!("b64_json"));
        }
        if let Some(quality) =
            map_quality_to_strict_openai(&request_model, Some(quality.as_str()), false)
        {
            body_object.insert("quality".to_string(), json!(quality));
        }
    }
    ensure_successful_image_response(
        "openai-images.generate",
        "POST",
        &request_url,
        run_curl_json_response(
            "POST",
            &request_url,
            api_key,
            &[],
            Some(body),
            Some(IMAGE_REQUEST_TIMEOUT_SECONDS),
        )?,
    )
}

pub(crate) fn build_openai_edit_file_fields(paths: &[PathBuf]) -> Vec<(String, PathBuf)> {
    paths
        .iter()
        .map(|path| ("image".to_string(), path.clone()))
        .collect()
}

pub(crate) fn build_openai_edit_form_fields(
    model: &str,
    prompt: &str,
    count: i64,
    aspect_ratio: Option<&str>,
    size: Option<&str>,
    quality: Option<&str>,
) -> Vec<(String, String)> {
    let mut fields = vec![
        ("model".to_string(), model.to_string()),
        ("prompt".to_string(), prompt.to_string()),
        (
            "size".to_string(),
            resolve_openai_official_image_size(aspect_ratio, size),
        ),
        ("n".to_string(), count.to_string()),
    ];
    if openai_supports_response_format(model, true) {
        fields.push(("response_format".to_string(), "b64_json".to_string()));
    }
    if let Some(quality) = map_quality_to_strict_openai(model, quality, true) {
        fields.push(("quality".to_string(), quality));
    }
    fields
}

pub(crate) fn build_rootflow_edit_form_fields(
    model: &str,
    prompt: &str,
    count: i64,
    aspect_ratio: Option<&str>,
    size: Option<&str>,
    quality: Option<&str>,
) -> Vec<(String, String)> {
    let mut fields = vec![
        ("model".to_string(), model.to_string()),
        ("prompt".to_string(), prompt.to_string()),
        (
            "size".to_string(),
            resolve_openai_official_image_size(aspect_ratio, size),
        ),
        ("n".to_string(), count.to_string()),
    ];
    if let Some(quality) = map_quality_to_strict_openai(model, quality, true) {
        fields.push(("quality".to_string(), quality));
    }
    fields
}

pub(crate) fn run_gemini_generate_content_request(
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
        extract_reference_image_values(payload, 4)?
    };
    let parts = build_gemini_content_parts(&prompt, &refs)?;
    let aspect_ratio = map_aspect_ratio_to_gemini(
        Some(required_image_aspect_ratio(payload).as_str()),
        payload_image_size(payload).as_deref(),
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

pub(crate) fn run_gemini_imagen_request(
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
                "imageSize": map_resolution_or_quality_to_image_size(
                    Some(required_image_resolution(payload).as_str()),
                    Some(required_image_quality(payload).as_str()),
                ),
                "aspectRatio": map_aspect_ratio_to_gemini(
                    Some(required_image_aspect_ratio(payload).as_str()),
                    payload_image_size(payload).as_deref(),
                ),
            }
        })),
    )
}

pub(crate) fn build_openai_json_image_body(
    model: &str,
    payload: &Value,
    extra_fields: Value,
) -> Value {
    let aspect_ratio = required_image_aspect_ratio(payload);
    let resolution = required_image_resolution(payload);
    let quality = required_image_quality(payload);
    let mut body = json!({
        "model": model,
        "prompt": payload_string(payload, "prompt").unwrap_or_default(),
        "n": payload_field(payload, "count").and_then(Value::as_i64).unwrap_or(1).clamp(1, 4),
        "size": map_aspect_ratio_to_image_size(
            Some(aspect_ratio.as_str()),
            payload_image_size(payload).as_deref(),
        ),
        "aspectRatio": aspect_ratio,
        "resolution": resolution,
        "response_format": "b64_json"
    });
    if let Some(body_object) = body.as_object_mut() {
        body_object.insert("quality".to_string(), json!(quality));
        if let Some(extra_object) = extra_fields.as_object() {
            for (key, value) in extra_object {
                if !value.is_null() {
                    body_object.insert(key.clone(), value.clone());
                }
            }
        }
    }
    body
}

pub(crate) fn run_openai_json_image_request(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    payload: &Value,
    extra_fields: Value,
) -> Result<Value, String> {
    let body = build_openai_json_image_body(model, payload, extra_fields);
    ensure_successful_image_response(
        "openai-images.generate",
        "POST",
        endpoint,
        run_curl_json_response(
            "POST",
            endpoint,
            api_key,
            &[],
            Some(body),
            Some(IMAGE_REQUEST_TIMEOUT_SECONDS),
        )?,
    )
}

pub(crate) fn run_dashscope_image_request(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    payload: &Value,
) -> Result<Value, String> {
    let generation_mode =
        payload_string(payload, "generationMode").unwrap_or_else(|| "text-to-image".to_string());
    let refs = extract_reference_image_values(payload, 4)?;
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
    let aspect_ratio = required_image_aspect_ratio(payload);
    let size = map_size_to_dashscope(
        payload_image_size(payload).as_deref(),
        Some(aspect_ratio.as_str()),
    );
    let interleave_size = map_size_to_dashscope_interleave(
        payload_image_size(payload).as_deref(),
        Some(aspect_ratio.as_str()),
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

pub(crate) fn resolve_dashscope_task_payload(
    endpoint: &str,
    api_key: Option<&str>,
    task_id: &str,
) -> Result<Value, String> {
    let task_endpoint = resolve_dashscope_task_endpoint(endpoint, task_id);
    let poll_attempts = IMAGE_TASK_POLL_TIMEOUT_MS / IMAGE_TASK_POLL_INTERVAL_MS;
    for _ in 0..poll_attempts {
        thread::sleep(std::time::Duration::from_millis(
            IMAGE_TASK_POLL_INTERVAL_MS,
        ));
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
    Err(format!(
        "DashScope task timeout after {}ms",
        IMAGE_TASK_POLL_TIMEOUT_MS
    ))
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
                    extract_reference_image_values(payload, 4)?
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
                    extract_reference_image_values(payload, 4)?
                        .into_iter()
                        .map(|item| normalize_media_value_for_remote(&item))
                        .collect::<Result<Vec<_>, _>>()?
                } else {
                    Vec::<String>::new()
                },
                "ratio": map_aspect_ratio_to_jimeng_ratio(
                    Some(required_image_aspect_ratio(payload).as_str()),
                    payload_image_size(payload).as_deref(),
                ),
                "resolution": map_resolution_or_quality_to_jimeng_resolution(
                    Some(required_image_resolution(payload).as_str()),
                    Some(required_image_quality(payload).as_str()),
                ),
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
        let (_mime_type, bytes) = download_http_bytes(&url)?;
        if let Some(parent) = absolute_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(absolute_path, bytes).map_err(|error| error.to_string())?;
        return Ok(());
    }
    Err("image generation response contained neither b64_json nor url".to_string())
}
