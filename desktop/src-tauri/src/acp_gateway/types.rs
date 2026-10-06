use serde_json::Value;
use std::collections::HashMap;

use super::errors::AcpHttpError;

#[derive(Debug, Clone)]
pub(crate) struct AcpRequestClient {
    pub(crate) id: Option<String>,
    pub(crate) name: String,
    pub(crate) kind: String,
}

impl AcpRequestClient {
    pub(crate) fn source_label(&self) -> String {
        format!("ACP: {}", self.name)
    }
}

fn clean_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
}

pub(crate) fn body_json(body: &str) -> Result<Value, AcpHttpError> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_str::<Value>(trimmed).map_err(|error| {
        AcpHttpError::bad_request("invalid_json", format!("Invalid JSON body: {error}"))
    })
}

pub(crate) fn payload_string(payload: &Value, key: &str) -> Option<String> {
    clean_string(payload.get(key))
}

pub(crate) fn payload_nested_string(payload: &Value, parent: &str, key: &str) -> Option<String> {
    payload
        .get(parent)
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
}

pub(crate) fn payload_object(payload: &Value, key: &str) -> Option<Value> {
    payload.get(key).filter(|value| value.is_object()).cloned()
}

pub(crate) fn payload_array_strings(payload: &Value, key: &str) -> Vec<String> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn decode_query_value(value: &str) -> String {
    let mut output = String::new();
    let mut chars = value.as_bytes().iter().copied().peekable();
    while let Some(byte) = chars.next() {
        if byte == b'+' {
            output.push(' ');
            continue;
        }
        if byte == b'%' {
            let Some(high) = chars.next() else {
                output.push('%');
                continue;
            };
            let Some(low) = chars.next() else {
                output.push('%');
                output.push(high as char);
                continue;
            };
            let hex = [high, low];
            if let Ok(hex) = std::str::from_utf8(&hex) {
                if let Ok(decoded) = u8::from_str_radix(hex, 16) {
                    output.push(decoded as char);
                    continue;
                }
            }
            output.push('%');
            output.push(high as char);
            output.push(low as char);
            continue;
        }
        output.push(byte as char);
    }
    output
}

pub(crate) fn query_param(path: &str, key: &str) -> Option<String> {
    let query = path
        .split_once('?')?
        .1
        .split_once('#')
        .map(|(head, _)| head)
        .unwrap_or_else(|| {
            path.split_once('?')
                .map(|(_, query)| query)
                .unwrap_or_default()
        });
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find_map(|(candidate, value)| {
            if decode_query_value(candidate).trim() == key {
                let decoded = decode_query_value(value);
                let trimmed = decoded.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            } else {
                None
            }
        })
}

pub(crate) fn pagination_from_path(
    path: &str,
    default_limit: usize,
    max_limit: usize,
) -> (Option<String>, usize) {
    let cursor = query_param(path, "cursor");
    let limit = query_param(path, "limit")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default_limit)
        .min(max_limit);
    (cursor, limit)
}

pub(crate) fn prompt_from_payload(payload: &Value) -> Option<String> {
    payload_string(payload, "prompt")
        .or_else(|| payload_string(payload, "message"))
        .or_else(|| payload_string(payload, "content"))
        .or_else(|| payload_string(payload, "text"))
        .or_else(|| payload_nested_string(payload, "message", "content"))
}

pub(crate) fn acp_session_id_from_payload(payload: &Value) -> Option<String> {
    payload_string(payload, "acpSessionId")
        .or_else(|| payload_string(payload, "sessionId"))
        .or_else(|| {
            let attach = payload.get("attachTo")?;
            let attach_type = clean_string(attach.get("type"))?;
            if attach_type == "acp_session" {
                clean_string(attach.get("id"))
            } else {
                None
            }
        })
}

pub(crate) fn collab_session_id_from_payload(payload: &Value) -> Option<String> {
    payload_string(payload, "collabSessionId").or_else(|| {
        let attach = payload.get("attachTo")?;
        let attach_type = clean_string(attach.get("type"))?;
        if attach_type == "collab_session" {
            clean_string(attach.get("id"))
        } else {
            None
        }
    })
}

pub(crate) fn project_ref_from_payload(payload: &Value) -> Option<Value> {
    if let Some(value) = payload.get("projectRef").filter(|value| !value.is_null()) {
        return Some(value.clone());
    }
    let attach = payload.get("attachTo")?;
    let attach_type = clean_string(attach.get("type"))?;
    if attach_type != "project_ref" {
        return None;
    }
    let mut object = serde_json::Map::new();
    for key in ["id", "type", "name", "path"] {
        if let Some(value) = attach.get(key).cloned().filter(|value| !value.is_null()) {
            object.insert(key.to_string(), value);
        }
    }
    if object.is_empty() {
        None
    } else {
        Some(Value::Object(object))
    }
}

pub(crate) fn chat_session_attach_requested(payload: &Value) -> bool {
    payload
        .get("attachTo")
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .map(|value| matches!(value.trim(), "chat_session" | "runtime_session"))
        .unwrap_or(false)
}

pub(crate) fn client_from_payload_and_headers(
    payload: &Value,
    headers: &HashMap<String, String>,
    fallback_name: &str,
) -> AcpRequestClient {
    let client = payload.get("client").unwrap_or(&Value::Null);
    let id = clean_string(client.get("id"))
        .or_else(|| payload_string(payload, "clientId"))
        .or_else(|| {
            headers
                .get("x-acp-client-id")
                .map(|value| value.trim().to_string())
        })
        .filter(|value| !value.is_empty());
    let name = clean_string(client.get("name"))
        .or_else(|| payload_string(payload, "clientName"))
        .or_else(|| {
            headers
                .get("x-acp-client-name")
                .map(|value| value.trim().to_string())
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback_name.to_string());
    let kind = clean_string(client.get("kind"))
        .or_else(|| payload_string(payload, "clientKind"))
        .or_else(|| {
            headers
                .get("x-acp-client-kind")
                .map(|value| value.trim().to_string())
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "generic_agent".to_string());
    AcpRequestClient { id, name, kind }
}

pub(crate) fn summarize_text(value: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for ch in value.chars().take(max_chars) {
        out.push(ch);
    }
    out
}
