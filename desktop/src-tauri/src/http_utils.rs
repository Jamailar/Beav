use base64::Engine;
use serde_json::{Value, json};
use std::io::Write;

use crate::configure_background_command;

#[derive(Debug, Clone)]
pub(crate) struct HttpJsonResponse {
    pub status: u16,
    pub body: Value,
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
) -> Result<std::process::Command, String> {
    let mut command = std::process::Command::new("curl");
    configure_background_command(&mut command);
    command.arg("-sS").arg("-X").arg(method).arg(url);
    if no_buffer {
        command.arg("-N");
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

fn serialized_json_body(body: Option<&Value>) -> Result<Option<Vec<u8>>, String> {
    body.map(serde_json::to_vec)
        .transpose()
        .map_err(|error| error.to_string())
}

fn spawn_curl_json_child(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    body: Option<&Value>,
    max_time_seconds: Option<u64>,
    no_buffer: bool,
    stdout_piped: bool,
    stderr_piped: bool,
) -> Result<std::process::Child, String> {
    use std::process::Stdio;

    let serialized_body = serialized_json_body(body)?;
    let mut command = build_curl_json_command(
        method,
        url,
        api_key,
        extra_headers,
        serialized_body.is_some(),
        max_time_seconds,
        no_buffer,
    )?;
    if serialized_body.is_some() {
        command.stdin(Stdio::piped());
    }
    if stdout_piped {
        command.stdout(Stdio::piped());
    }
    if stderr_piped {
        command.stderr(Stdio::piped());
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

pub(crate) fn spawn_curl_json_process(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    body: Option<&Value>,
    max_time_seconds: Option<u64>,
    no_buffer: bool,
) -> Result<std::process::Child, String> {
    spawn_curl_json_child(
        method,
        url,
        api_key,
        extra_headers,
        body,
        max_time_seconds,
        no_buffer,
        true,
        true,
    )
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
    const STATUS_MARKER: &str = "__REDBOX_HTTP_STATUS__:";

    let serialized_body = serialized_json_body(body.as_ref())?;
    let mut command = build_curl_json_command(
        method,
        url,
        api_key,
        extra_headers,
        serialized_body.is_some(),
        max_time_seconds,
        false,
    )?;
    command
        .arg("-w")
        .arg(format!("\n{STATUS_MARKER}%{{http_code}}"));
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
        return Err(if stderr.is_empty() {
            format!("curl failed with status {}", output.status)
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let (body_text, status_text) = stdout
        .rsplit_once(STATUS_MARKER)
        .ok_or_else(|| "Invalid HTTP response trailer".to_string())?;
    let status = status_text
        .trim()
        .parse::<u16>()
        .map_err(|error| format!("Invalid HTTP status code: {error}"))?;
    let normalized_body = body_text.trim();

    if normalized_body.is_empty() {
        return Ok(HttpJsonResponse {
            status,
            body: json!({}),
        });
    }

    let parsed = serde_json::from_str(normalized_body)
        .map_err(|error| format!("Invalid JSON response: {error}"))?;
    Ok(HttpJsonResponse {
        status,
        body: parsed,
    })
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
        )
        .expect("command");
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(!args.iter().any(|value| value == "--data-binary"));
        assert!(!args.iter().any(|value| value == "@-"));
    }
}
