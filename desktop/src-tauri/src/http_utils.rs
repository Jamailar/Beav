use base64::Engine;
use serde_json::{json, Value};
use std::io::Write;

use crate::configure_background_command;

pub(crate) const HTTP_STATUS_MARKER: &str = "__REDBOX_HTTP_STATUS__:";

#[derive(Debug, Clone)]
pub(crate) struct HttpJsonResponse {
    pub status: u16,
    pub body: Value,
}

#[derive(Debug, Clone)]
pub(crate) struct HttpErrorDetails {
    pub status: u16,
    pub error_code: Option<String>,
    pub message: String,
    pub raw: String,
}

pub(crate) fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn build_curl_json_command(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    has_body: bool,
    max_time_seconds: Option<u64>,
    no_buffer: bool,
    force_http1_1: bool,
) -> Result<std::process::Command, String> {
    let mut command = std::process::Command::new("curl");
    configure_background_command(&mut command);
    command.arg("-sS").arg("-X").arg(method).arg(url);
    if no_buffer {
        command.arg("-N");
    }
    if force_http1_1 {
        command.arg("--http1.1");
    }
    if let Some(seconds) = max_time_seconds.filter(|value| *value > 0) {
        command.arg("--max-time").arg(seconds.to_string());
    }
    command.arg("-H").arg("Content-Type: application/json");
    if let Some(key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        command
            .arg("-H")
            .arg(format!("Authorization: Bearer {key}"));
    }
    for (header, value) in extra_headers {
        command.arg("-H").arg(format!("{header}: {value}"));
    }
    if has_body {
        command.arg("--data-binary").arg("@-");
    }
    Ok(command)
}

fn payload_error_code(value: &Value) -> Option<String> {
    ["errorCode", "error_code", "code", "statusCode", "status"]
        .into_iter()
        .find_map(|key| {
            value.get(key).and_then(|item| {
                item.as_str()
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .map(ToString::to_string)
                    .or_else(|| item.as_i64().map(|number| number.to_string()))
                    .or_else(|| item.as_u64().map(|number| number.to_string()))
            })
        })
}

fn payload_error_message(value: &Value) -> Option<String> {
    [
        "message",
        "error",
        "msg",
        "detail",
        "reason",
        "error_description",
    ]
    .into_iter()
    .find_map(|key| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToString::to_string)
    })
}

pub(crate) fn http_error_details_from_value(status: u16, body: &Value) -> HttpErrorDetails {
    let nested_error = body.get("error").filter(|value| value.is_object());
    let nested_data = body.get("data").filter(|value| value.is_object());
    let error_code = payload_error_code(body)
        .or_else(|| nested_error.and_then(payload_error_code))
        .or_else(|| nested_data.and_then(payload_error_code));
    let message = payload_error_message(body)
        .or_else(|| nested_error.and_then(payload_error_message))
        .or_else(|| nested_data.and_then(payload_error_message))
        .unwrap_or_else(|| format!("HTTP {status}"));
    let raw = if body.is_null() {
        String::new()
    } else {
        serde_json::to_string(body).unwrap_or_else(|_| body.to_string())
    };
    HttpErrorDetails {
        status,
        error_code,
        message,
        raw,
    }
}

pub(crate) fn http_error_details_from_text(status: u16, raw: &str) -> HttpErrorDetails {
    let normalized = raw.trim();
    if let Ok(value) = serde_json::from_str::<Value>(normalized) {
        return http_error_details_from_value(status, &value);
    }
    HttpErrorDetails {
        status,
        error_code: None,
        message: if normalized.is_empty() {
            format!("HTTP {status}")
        } else {
            normalized.to_string()
        },
        raw: normalized.to_string(),
    }
}

pub(crate) fn format_http_error_message(context: &str, details: &HttpErrorDetails) -> String {
    let code_segment = details
        .error_code
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(" [code={value}]"))
        .unwrap_or_default();
    let mut message = format!(
        "{context} failed: HTTP {}{} {}",
        details.status, code_segment, details.message
    );
    if !details.raw.trim().is_empty() {
        message.push_str("\nRaw response: ");
        message.push_str(details.raw.trim());
    }
    message
}

pub(crate) fn http_error_debug_line(
    scope: &str,
    method: &str,
    url: &str,
    details: &HttpErrorDetails,
) -> String {
    format!(
        "[{scope}] method={} status={} code={} url={} message={} raw={}",
        method,
        details.status,
        details.error_code.as_deref().unwrap_or("-"),
        url,
        details.message,
        details.raw,
    )
}

fn serialized_json_body(body: Option<&Value>) -> Result<Option<Vec<u8>>, String> {
    body.map(serde_json::to_vec)
        .transpose()
        .map_err(|error| error.to_string())
}

pub(crate) fn spawn_curl_json_process(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    body: Option<&Value>,
    max_time_seconds: Option<u64>,
    no_buffer: bool,
) -> Result<std::process::Child, String> {
    let serialized_body = serialized_json_body(body)?;
    let mut command = build_curl_json_command(
        method,
        url,
        api_key,
        extra_headers,
        serialized_body.is_some(),
        max_time_seconds,
        no_buffer,
        false,
    )?;
    command
        .arg("-w")
        .arg(format!("\n{HTTP_STATUS_MARKER}%{{http_code}}"));
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    if serialized_body.is_some() {
        command.stdin(std::process::Stdio::piped());
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    if let Some(payload) = serialized_body {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "curl stdin unavailable".to_string())?;
        stdin
            .write_all(&payload)
            .map_err(|error| error.to_string())?;
        drop(stdin);
    }
    Ok(child)
}

pub(crate) fn run_curl_json_with_timeout(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    body: Option<Value>,
    max_time_seconds: Option<u64>,
) -> Result<Value, String> {
    run_curl_json_response(method, url, api_key, extra_headers, body, max_time_seconds)
        .map(|response| response.body)
}

pub(crate) fn run_curl_json_response(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    body: Option<Value>,
    max_time_seconds: Option<u64>,
) -> Result<HttpJsonResponse, String> {
    run_curl_json_response_inner(
        method,
        url,
        api_key,
        extra_headers,
        body,
        max_time_seconds,
        true,
    )
}

fn run_curl_json_response_inner(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    body: Option<Value>,
    max_time_seconds: Option<u64>,
    allow_official_reauth_retry: bool,
) -> Result<HttpJsonResponse, String> {
    run_curl_json_response_attempt(
        method,
        url,
        api_key,
        extra_headers,
        body,
        max_time_seconds,
        allow_official_reauth_retry,
        true,
    )
}

fn run_curl_json_response_attempt(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    body: Option<Value>,
    max_time_seconds: Option<u64>,
    allow_official_reauth_retry: bool,
    allow_http1_retry: bool,
) -> Result<HttpJsonResponse, String> {
    execute_curl_json_response_once(
        method,
        url,
        api_key,
        extra_headers,
        body.clone(),
        max_time_seconds,
        allow_official_reauth_retry,
        false,
    )
    .or_else(|error| {
        if allow_http1_retry && should_retry_with_http1_1(&error) {
            crate::append_debug_trace_global(format!(
                "[http][curl-json] transport retry method={} url={} upgrade=http1.1 reason={}",
                method,
                url,
                truncate_http_error(&error)
            ));
            return execute_curl_json_response_once(
                method,
                url,
                api_key,
                extra_headers,
                body,
                max_time_seconds,
                allow_official_reauth_retry,
                true,
            );
        }
        Err(error)
    })
}

fn execute_curl_json_response_once(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    body: Option<Value>,
    max_time_seconds: Option<u64>,
    allow_official_reauth_retry: bool,
    force_http1_1: bool,
) -> Result<HttpJsonResponse, String> {
    let serialized_body = serialized_json_body(body.as_ref())?;
    let mut command = build_curl_json_command(
        method,
        url,
        api_key,
        extra_headers,
        serialized_body.is_some(),
        max_time_seconds,
        false,
        force_http1_1,
    )?;
    command
        .arg("-w")
        .arg(format!("\n{HTTP_STATUS_MARKER}%{{http_code}}"));
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    if serialized_body.is_some() {
        command.stdin(std::process::Stdio::piped());
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    if let Some(payload) = serialized_body {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "curl stdin unavailable".to_string())?;
        stdin
            .write_all(&payload)
            .map_err(|error| error.to_string())?;
        drop(stdin);
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let error = if stderr.is_empty() {
            format!("curl failed with status {}", output.status)
        } else {
            stderr
        };
        crate::append_debug_trace_global(format!(
            "[http][curl-json] curl_error method={} url={} transport={} exit_status={} error={}",
            method,
            url,
            if force_http1_1 { "http1.1" } else { "default" },
            output.status,
            truncate_http_error(&error)
        ));
        return Err(error);
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let (body_text, status_text) = stdout
        .rsplit_once(HTTP_STATUS_MARKER)
        .ok_or_else(|| "Invalid HTTP response trailer".to_string())?;
    let status = status_text
        .trim()
        .parse::<u16>()
        .map_err(|error| format!("Invalid HTTP status code: {error}"))?;
    let normalized_body = body_text.trim();

    if normalized_body.is_empty() {
        crate::append_debug_trace_global(format!(
            "[http][curl-json] empty_json_body method={} url={} transport={} status={}",
            method,
            url,
            if force_http1_1 { "http1.1" } else { "default" },
            status
        ));
        return Ok(HttpJsonResponse {
            status,
            body: json!({}),
        });
    }

    let parsed = serde_json::from_str(normalized_body).map_err(|error| {
        let message = format!("Invalid JSON response: {error}");
        crate::append_debug_trace_global(format!(
            "[http][curl-json] invalid_json method={} url={} transport={} status={} body_preview={} error={}",
            method,
            url,
            if force_http1_1 { "http1.1" } else { "default" },
            status,
            truncate_http_error(normalized_body),
            truncate_http_error(&message)
        ));
        message
    })?;
    let response = HttpJsonResponse {
        status,
        body: parsed,
    };
    if allow_official_reauth_retry && response.status == 401 {
        if let Some(refreshed_api_key) =
            crate::try_refresh_official_auth_for_ai_request(url, api_key, "json-http-401")?
        {
            return run_curl_json_response_attempt(
                method,
                url,
                Some(refreshed_api_key.as_str()),
                extra_headers,
                body,
                max_time_seconds,
                false,
                !force_http1_1,
            );
        }
    }
    Ok(response)
}

fn should_retry_with_http1_1(error: &str) -> bool {
    let normalized = error.trim().to_ascii_lowercase();
    normalized.contains("curl: (16)")
        || normalized.contains("curl: (52)")
        || normalized.contains("empty reply from server")
        || normalized.contains("http2 framing layer")
        || normalized.contains("http/2 framing layer")
        || normalized.contains("http2 stream")
        || normalized.contains("http/2 stream")
}

fn truncate_http_error(raw: &str) -> String {
    let trimmed = raw.trim();
    const LIMIT: usize = 240;
    if trimmed.chars().count() <= LIMIT {
        trimmed.to_string()
    } else {
        let prefix = trimmed.chars().take(LIMIT).collect::<String>();
        format!("{prefix}...")
    }
}

pub(crate) fn run_curl_json(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    body: Option<Value>,
) -> Result<Value, String> {
    run_curl_json_with_timeout(method, url, api_key, extra_headers, body, None)
}

pub(crate) fn run_curl_text(
    method: &str,
    url: &str,
    extra_headers: &[(&str, String)],
    body: Option<String>,
) -> Result<String, String> {
    let mut command = std::process::Command::new("curl");
    configure_background_command(&mut command);
    command.arg("-sS").arg("-L").arg("-X").arg(method).arg(url);
    for (header, value) in extra_headers {
        command.arg("-H").arg(format!("{header}: {value}"));
    }
    if body.is_some() {
        command.arg("--data-binary").arg("@-");
        command.stdin(std::process::Stdio::piped());
    }
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    if let Some(payload) = body {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "curl stdin unavailable".to_string())?;
        stdin
            .write_all(payload.as_bytes())
            .map_err(|error| error.to_string())?;
        drop(stdin);
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("curl failed with status {}", output.status)
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub(crate) fn run_curl_bytes(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    body: Option<Value>,
) -> Result<Vec<u8>, String> {
    let serialized_body = serialized_json_body(body.as_ref())?;
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
    if serialized_body.is_some() {
        command.arg("-H").arg("Content-Type: application/json");
        command.arg("--data-binary").arg("@-");
        command.stdin(std::process::Stdio::piped());
    }
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    if let Some(payload) = serialized_body {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "curl stdin unavailable".to_string())?;
        stdin
            .write_all(&payload)
            .map_err(|error| error.to_string())?;
        drop(stdin);
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("curl failed with status {}", output.status)
        } else {
            stderr
        });
    }
    Ok(output.stdout)
}

pub(crate) fn decode_base64_bytes(encoded: &str) -> Result<Vec<u8>, String> {
    let normalized = encoded
        .trim()
        .replace('\n', "")
        .replace('\r', "")
        .replace(' ', "");
    base64::engine::general_purpose::STANDARD
        .decode(normalized.as_bytes())
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(normalized.as_bytes()))
        .map_err(|error| error.to_string())
}

pub(crate) fn parse_sse_endpoint_hint(body: &str) -> Option<String> {
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("data:") {
            let data = value.trim();
            if let Ok(json) = serde_json::from_str::<Value>(data) {
                if let Some(url) = json
                    .get("endpoint")
                    .or_else(|| json.get("url"))
                    .and_then(|item| item.as_str())
                    .filter(|item| !item.trim().is_empty())
                {
                    return Some(url.to_string());
                }
            }
            if data.starts_with("http://") || data.starts_with("https://") {
                return Some(data.to_string());
            }
        }
    }
    None
}

pub(crate) fn resolve_sse_post_url(url: &str) -> String {
    let normalized = normalize_base_url(url);
    if let Some(hint) = parse_sse_endpoint_hint(&String::from_utf8_lossy(
        &run_curl_bytes(
            "GET",
            &normalized,
            None,
            &[("Accept", "text/event-stream".to_string())],
            None,
        )
        .unwrap_or_default(),
    )) {
        return hint;
    }
    if normalized.ends_with("/sse") {
        return format!("{}/message", normalized.trim_end_matches("/sse"));
    }
    if normalized.ends_with("/events") {
        return format!("{}/message", normalized.trim_end_matches("/events"));
    }
    if normalized.ends_with("/stream") {
        return format!("{}/message", normalized.trim_end_matches("/stream"));
    }
    format!("{normalized}/message")
}

pub(crate) fn run_sse_mcp_method(url: &str, method: &str, params: Value) -> Result<Value, String> {
    let post_url = resolve_sse_post_url(url);
    run_curl_json(
        "POST",
        &post_url,
        None,
        &[],
        Some(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params
        })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_curl_json_command_uses_stdin_transport_when_body_exists() {
        let command = build_curl_json_command(
            "POST",
            "https://example.com/v1/videos/generations/async",
            Some("secret"),
            &[],
            true,
            Some(30),
            false,
            false,
        )
        .expect("command");
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(args.iter().any(|value| value == "--data-binary"));
        assert!(args.iter().any(|value| value == "@-"));
        assert!(!args.iter().any(|value| value.contains("\"prompt\"")));
    }

    #[test]
    fn build_curl_json_command_omits_stdin_transport_without_body() {
        let command = build_curl_json_command(
            "GET",
            "https://example.com/v1/videos/generations/tasks/query",
            None,
            &[],
            false,
            None,
            false,
            false,
        )
        .expect("command");
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(!args.iter().any(|value| value == "--data-binary"));
        assert!(!args.iter().any(|value| value == "@-"));
    }

    #[test]
    fn build_curl_json_command_enables_http1_when_requested() {
        let command = build_curl_json_command(
            "POST",
            "https://example.com/v1/chat/completions",
            None,
            &[],
            true,
            None,
            false,
            true,
        )
        .expect("command");
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(args.iter().any(|value| value == "--http1.1"));
    }

    #[test]
    fn retries_on_http2_framing_errors() {
        assert!(should_retry_with_http1_1(
            "curl: (16) Error in the HTTP2 framing layer"
        ));
        assert!(should_retry_with_http1_1(
            "curl: (16) HTTP/2 stream 0 was not closed cleanly"
        ));
        assert!(should_retry_with_http1_1(
            "curl: (52) Empty reply from server"
        ));
        assert!(!should_retry_with_http1_1("curl: (28) Operation timed out"));
    }
}
