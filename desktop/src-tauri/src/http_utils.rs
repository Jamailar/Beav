use base64::Engine;
use regex::Regex;
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::configure_background_command;

pub(crate) const HTTP_STATUS_MARKER: &str = "__REDBOX_HTTP_STATUS__:";

struct CurlJsonDebugCapture {
    dir: PathBuf,
    response_headers_path: PathBuf,
    trace_path: PathBuf,
}

impl CurlJsonDebugCapture {
    fn new() -> Result<Self, String> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "redbox-curl-json-{}-{timestamp}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        Ok(Self {
            response_headers_path: dir.join("response-headers.txt"),
            trace_path: dir.join("trace.txt"),
            dir,
        })
    }

    fn response_headers(&self) -> String {
        read_debug_text_file(&self.response_headers_path)
    }

    fn trace(&self) -> String {
        read_debug_text_file(&self.trace_path)
    }
}

impl Drop for CurlJsonDebugCapture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

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

fn read_debug_text_file(path: &Path) -> String {
    fs::read_to_string(path)
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn split_debug_stdout_sections(stdout: &str) -> (String, Option<String>) {
    match stdout.rsplit_once(HTTP_STATUS_MARKER) {
        Some((body, status_text)) => (
            body.trim().to_string(),
            Some(status_text.trim().to_string()),
        ),
        None => (stdout.trim().to_string(), None),
    }
}

fn debug_request_headers(api_key: Option<&str>, extra_headers: &[(&str, String)]) -> String {
    let mut lines = vec!["Content-Type: application/json".to_string()];
    if api_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        lines.push("Authorization: Bearer <REDACTED>".to_string());
    }
    for (header, value) in extra_headers {
        lines.push(format!("{header}: {value}"));
    }
    lines.join("\n")
}

fn debug_request_body(serialized_body: Option<&[u8]>) -> String {
    serialized_body
        .map(|payload| String::from_utf8_lossy(payload).trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "<empty>".to_string())
}

fn redact_http_debug_text(raw: &str, api_key: Option<&str>) -> String {
    let mut redacted = raw.to_string();
    if let Some(api_key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        redacted = redacted.replace(api_key, "<REDACTED>");
    }
    if let Ok(pattern) = Regex::new(r"(?im)(authorization:\s*bearer\s+)[^\r\n]+") {
        redacted = pattern
            .replace_all(&redacted, "${1}<REDACTED>")
            .into_owned();
    }
    if let Ok(pattern) = Regex::new(r"sk-[A-Za-z0-9_-]+") {
        redacted = pattern.replace_all(&redacted, "<REDACTED>").into_owned();
    }
    redacted.trim().to_string()
}

fn render_debug_section(label: &str, content: &str) -> String {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        format!("{label}:\n<empty>")
    } else {
        format!("{label}:\n{trimmed}")
    }
}

fn emit_curl_json_diagnostics(
    method: &str,
    url: &str,
    transport: &str,
    exit_status: &str,
    error: Option<&str>,
    request_headers: &str,
    request_body: &str,
    response_headers: &str,
    response_body: &str,
    response_status_trailer: Option<&str>,
    stderr: &str,
    trace: &str,
) {
    let mut sections = vec![format!(
        "[http][curl-json] diagnostic method={} url={} transport={} exit_status={}",
        method, url, transport, exit_status
    )];
    if let Some(error) = error.map(str::trim).filter(|value| !value.is_empty()) {
        sections.push(format!("error:\n{error}"));
    }
    if let Some(status) = response_status_trailer
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        sections.push(format!("response_status_trailer:\n{status}"));
    }
    sections.push(render_debug_section("request_headers", request_headers));
    sections.push(render_debug_section("request_body", request_body));
    sections.push(render_debug_section("response_headers", response_headers));
    sections.push(render_debug_section("response_body", response_body));
    sections.push(render_debug_section("stderr", stderr));
    sections.push(render_debug_section("trace", trace));
    let line = sections.join("\n");
    eprintln!("{line}");
    crate::append_debug_trace_global(line);
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

fn append_http_error_debug_log(
    scope: &str,
    method: &str,
    url: &str,
    status: u16,
    raw: &str,
    transport: Option<&str>,
) {
    let details = http_error_details_from_text(status, raw);
    let mut line = http_error_debug_line(scope, method, url, &details);
    if let Some(transport) = transport.map(str::trim).filter(|value| !value.is_empty()) {
        line.push_str(&format!(" transport={transport}"));
    }
    crate::append_debug_trace_global(line);
}

fn serialized_json_body(body: Option<&Value>) -> Result<Option<Vec<u8>>, String> {
    body.map(serde_json::to_vec)
        .transpose()
        .map_err(|error| error.to_string())
}

#[allow(dead_code)]
pub(crate) fn spawn_curl_json_process_with_transport(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    body: Option<&Value>,
    max_time_seconds: Option<u64>,
    no_buffer: bool,
    force_http1_1: bool,
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
    if let Some(ref payload) = serialized_body {
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
    let debug_capture = CurlJsonDebugCapture::new()?;
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
        .arg("-D")
        .arg(&debug_capture.response_headers_path)
        .arg("--trace-ascii")
        .arg(&debug_capture.trace_path)
        .arg("-w")
        .arg(format!("\n{HTTP_STATUS_MARKER}%{{http_code}}"));
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    if serialized_body.is_some() {
        command.stdin(std::process::Stdio::piped());
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    if let Some(ref payload) = serialized_body {
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
    let transport = if force_http1_1 { "http1.1" } else { "default" };
    let stderr_text = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout_text = String::from_utf8_lossy(&output.stdout).to_string();
    let (response_body, response_status_trailer) = split_debug_stdout_sections(&stdout_text);
    let request_headers = debug_request_headers(api_key, extra_headers);
    let request_body = debug_request_body(serialized_body.as_deref());
    let response_headers = redact_http_debug_text(&debug_capture.response_headers(), api_key);
    let trace = redact_http_debug_text(&debug_capture.trace(), api_key);

    if !output.status.success() {
        let stdout = stdout_text.trim().to_string();
        let error = if stderr_text.is_empty() {
            format!("curl failed with status {}", output.status)
        } else {
            stderr_text.clone()
        };
        let line = format!(
            "[http][curl-json] curl_error method={} url={} transport={} exit_status={} error={} stdout={}",
            method,
            url,
            transport,
            output.status,
            truncate_http_error(&error),
            truncate_http_debug_payload(&stdout)
        );
        eprintln!("{line}");
        crate::append_debug_trace_global(line);
        emit_curl_json_diagnostics(
            method,
            url,
            transport,
            &output.status.to_string(),
            Some(&error),
            &request_headers,
            &request_body,
            &response_headers,
            &response_body,
            response_status_trailer.as_deref(),
            &stderr_text,
            &trace,
        );
        return Err(error);
    }

    let stdout = stdout_text;
    let (body_text, status_text) = stdout
        .rsplit_once(HTTP_STATUS_MARKER)
        .ok_or_else(|| "Invalid HTTP response trailer".to_string())?;
    let status = status_text
        .trim()
        .parse::<u16>()
        .map_err(|error| format!("Invalid HTTP status code: {error}"))?;
    let normalized_body = body_text.trim();

    if normalized_body.is_empty() {
        let line = format!(
            "[http][curl-json] empty_json_body method={} url={} transport={} status={}",
            method, url, transport, status
        );
        eprintln!("{line}");
        crate::append_debug_trace_global(line);
        if !(200..300).contains(&status) {
            emit_curl_json_diagnostics(
                method,
                url,
                transport,
                &output.status.to_string(),
                None,
                &request_headers,
                &request_body,
                &response_headers,
                "",
                Some(status_text.trim()),
                &stderr_text,
                &trace,
            );
            append_http_error_debug_log("http-json", method, url, status, "", Some(transport));
        }
        return Ok(HttpJsonResponse {
            status,
            body: json!({}),
        });
    }

    let parsed = serde_json::from_str(normalized_body).map_err(|error| {
        let message = format!("Invalid JSON response: {error}");
        let line = format!(
            "[http][curl-json] invalid_json method={} url={} transport={} status={} body={} error={}",
            method,
            url,
            transport,
            status,
            normalized_body,
            truncate_http_error(&message)
        );
        eprintln!("{line}");
        crate::append_debug_trace_global(line);
        message
    })?;
    let response = HttpJsonResponse {
        status,
        body: parsed,
    };
    if !(200..300).contains(&response.status) {
        emit_curl_json_diagnostics(
            method,
            url,
            transport,
            &output.status.to_string(),
            None,
            &request_headers,
            &request_body,
            &response_headers,
            normalized_body,
            Some(status_text.trim()),
            &stderr_text,
            &trace,
        );
        append_http_error_debug_log(
            "http-json",
            method,
            url,
            response.status,
            normalized_body,
            Some(transport),
        );
    }
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

pub(crate) fn should_retry_with_http1_1(error: &str) -> bool {
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

fn truncate_http_debug_payload(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "<empty>".to_string();
    }
    truncate_http_error(trimmed)
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
