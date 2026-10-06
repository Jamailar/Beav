use std::collections::HashMap;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::events::emit_runtime_event;
use crate::persistence::{with_store, with_store_mut};
use crate::AppState;

use super::artifacts::{get_artifact_value, session_artifacts_value};
use super::audit::acp_events_page_for_session;
use super::auth::authorize_acp_request;
use super::errors::AcpHttpError;
use super::guide::guide_value;
use super::manifest::manifest_value;
use super::normalize_acp_path;
use super::runs::{
    cancel_run_value, create_run_http, get_run_value, run_created_response, run_events_value,
};
use super::sessions::{
    append_inbound_message, client_for_http, create_or_attach_acp_session, session_public_value,
};
use super::types::{body_json, pagination_from_path};

pub(crate) fn is_acp_gateway_path(path: &str) -> bool {
    let normalized = normalize_acp_path(path);
    normalized == "/.well-known/redbox-agent.json"
        || normalized == "/acp/v1"
        || normalized.starts_with("/acp/v1/")
}

fn acp_error_response(error: AcpHttpError) -> (u16, &'static str, Value) {
    (error.status, error.status_text, error.value())
}

fn path_segments(path: &str) -> Vec<String> {
    normalize_acp_path(path)
        .trim_matches('/')
        .split('/')
        .filter(|item| !item.trim().is_empty())
        .map(ToString::to_string)
        .collect()
}

fn method_is(method: &str, expected: &str) -> bool {
    method.eq_ignore_ascii_case(expected)
}

fn get_manifest(app: &AppHandle) -> Result<Value, AcpHttpError> {
    let state = app.state::<AppState>();
    with_store(&state, |store| Ok(manifest_value(&store))).map_err(AcpHttpError::internal)
}

fn get_guide(app: &AppHandle) -> Result<Value, AcpHttpError> {
    let state = app.state::<AppState>();
    with_store(&state, |store| Ok(guide_value(&store))).map_err(AcpHttpError::internal)
}

fn create_session_value(
    app: &AppHandle,
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
    payload: Value,
) -> Result<Value, AcpHttpError> {
    let state = app.state::<AppState>();
    let value = with_store_mut(&state, |store| {
        let result = (|| -> Result<Value, AcpHttpError> {
            authorize_acp_request(store, method, path, headers)?;
            let client = client_for_http(store, &payload, headers);
            let session = create_or_attach_acp_session(store, &payload, &client)?;
            Ok(json!({
                "success": true,
                "session": session_public_value(store, &session)
            }))
        })();
        Ok(result)
    })
    .map_err(AcpHttpError::internal)??;
    let _ = app.emit("acp:session-changed", value.clone());
    Ok(value)
}

fn get_session_value(
    app: &AppHandle,
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
    session_id: &str,
) -> Result<Value, AcpHttpError> {
    let state = app.state::<AppState>();
    with_store(&state, |store| {
        let result = (|| -> Result<Value, AcpHttpError> {
            authorize_acp_request(&store, method, path, headers)?;
            let session = store
                .acp_sessions
                .iter()
                .find(|item| item.id == session_id)
                .ok_or_else(|| {
                    AcpHttpError::not_found("acp_session_not_found", "ACP session not found.")
                })?;
            Ok(json!({
                "success": true,
                "session": session_public_value(&store, session)
            }))
        })();
        Ok(result)
    })
    .map_err(AcpHttpError::internal)?
}

fn append_message_value(
    app: &AppHandle,
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
    session_id: &str,
    payload: Value,
) -> Result<Value, AcpHttpError> {
    let state = app.state::<AppState>();
    let value = with_store_mut(&state, |store| {
        let result = (|| -> Result<Value, AcpHttpError> {
            authorize_acp_request(store, method, path, headers)?;
            let client = client_for_http(store, &payload, headers);
            let message = append_inbound_message(store, session_id, &payload, &client, None)?;
            let session = store
                .acp_sessions
                .iter()
                .find(|item| item.id == session_id)
                .cloned()
                .ok_or_else(|| {
                    AcpHttpError::not_found("acp_session_not_found", "ACP session not found.")
                })?;
            Ok(json!({
                "success": true,
                "message": message,
                "session": session_public_value(store, &session)
            }))
        })();
        Ok(result)
    })
    .map_err(AcpHttpError::internal)??;
    emit_runtime_event(
        app,
        "runtime:acp-message-stored",
        value
            .get("session")
            .and_then(|session| session.get("chatSessionId"))
            .and_then(Value::as_str),
        None,
        value.clone(),
    );
    let _ = app.emit("acp:message-created", value.clone());
    Ok(value)
}

fn session_events_value(
    app: &AppHandle,
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
    session_id: &str,
) -> Result<Value, AcpHttpError> {
    let state = app.state::<AppState>();
    with_store(&state, |store| {
        let result = (|| -> Result<Value, AcpHttpError> {
            authorize_acp_request(&store, method, path, headers)?;
            if !store.acp_sessions.iter().any(|item| item.id == session_id) {
                return Err(AcpHttpError::not_found(
                    "acp_session_not_found",
                    "ACP session not found.",
                ));
            }
            let (cursor, limit) = pagination_from_path(path, 100, 500);
            let page = acp_events_page_for_session(&store, session_id, cursor.as_deref(), limit);
            Ok(json!({
                "success": true,
                "sessionId": session_id,
                "cursor": cursor,
                "limit": limit,
                "nextCursor": page.next_cursor,
                "hasMore": page.has_more,
                "events": page.events
            }))
        })();
        Ok(result)
    })
    .map_err(AcpHttpError::internal)?
}

pub(crate) fn handle_acp_gateway_http_request(
    app: &AppHandle,
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
    body: &str,
) -> Result<(u16, &'static str, Value), String> {
    if method_is(method, "OPTIONS") {
        return Ok((204, "No Content", Value::Null));
    }

    let normalized = normalize_acp_path(path);
    let segments = path_segments(path);
    let payload =
        if method_is(method, "POST") || method_is(method, "PUT") || method_is(method, "PATCH") {
            match body_json(body) {
                Ok(value) => value,
                Err(error) => return Ok(acp_error_response(error)),
            }
        } else {
            Value::Object(Default::default())
        };

    let result = if method_is(method, "GET") && normalized == "/.well-known/redbox-agent.json"
        || method_is(method, "GET") && normalized == "/acp/v1/manifest"
        || method_is(method, "GET") && normalized == "/acp/v1"
    {
        get_manifest(app).map(|value| (200, "OK", value))
    } else if method_is(method, "GET") && normalized == "/acp/v1/guide" {
        get_guide(app).map(|value| (200, "OK", value))
    } else if method_is(method, "POST")
        && segments.len() == 3
        && segments[0] == "acp"
        && segments[1] == "v1"
        && segments[2] == "sessions"
    {
        create_session_value(app, method, path, headers, payload)
            .map(|value| (201, "Created", value))
    } else if method_is(method, "GET")
        && segments.len() == 4
        && segments[0] == "acp"
        && segments[1] == "v1"
        && segments[2] == "sessions"
    {
        get_session_value(app, method, path, headers, &segments[3]).map(|value| (200, "OK", value))
    } else if method_is(method, "POST")
        && segments.len() == 5
        && segments[0] == "acp"
        && segments[1] == "v1"
        && segments[2] == "sessions"
        && segments[4] == "messages"
    {
        append_message_value(app, method, path, headers, &segments[3], payload)
            .map(|value| (201, "Created", value))
    } else if method_is(method, "GET")
        && segments.len() == 5
        && segments[0] == "acp"
        && segments[1] == "v1"
        && segments[2] == "sessions"
        && segments[4] == "events"
    {
        session_events_value(app, method, path, headers, &segments[3])
            .map(|value| (200, "OK", value))
    } else if method_is(method, "GET")
        && segments.len() == 5
        && segments[0] == "acp"
        && segments[1] == "v1"
        && segments[2] == "sessions"
        && segments[4] == "artifacts"
    {
        session_artifacts_value(app, method, path, headers, &segments[3])
            .map(|value| (200, "OK", value))
    } else if method_is(method, "POST")
        && segments.len() == 3
        && segments[0] == "acp"
        && segments[1] == "v1"
        && segments[2] == "runs"
    {
        create_run_http(app, method, path, headers, payload)
            .map(|(run, session)| (202, "Accepted", run_created_response(&run, session)))
    } else if method_is(method, "GET")
        && segments.len() == 4
        && segments[0] == "acp"
        && segments[1] == "v1"
        && segments[2] == "runs"
    {
        get_run_value(app, method, path, headers, &segments[3]).map(|value| (200, "OK", value))
    } else if method_is(method, "GET")
        && segments.len() == 5
        && segments[0] == "acp"
        && segments[1] == "v1"
        && segments[2] == "runs"
        && segments[4] == "events"
    {
        run_events_value(app, method, path, headers, &segments[3]).map(|value| (200, "OK", value))
    } else if method_is(method, "POST")
        && segments.len() == 5
        && segments[0] == "acp"
        && segments[1] == "v1"
        && segments[2] == "runs"
        && segments[4] == "cancel"
    {
        cancel_run_value(app, method, path, headers, &segments[3]).map(|value| (200, "OK", value))
    } else if method_is(method, "GET")
        && segments.len() == 4
        && segments[0] == "acp"
        && segments[1] == "v1"
        && segments[2] == "artifacts"
    {
        get_artifact_value(app, method, path, headers, &segments[3]).map(|value| (200, "OK", value))
    } else {
        Err(AcpHttpError::not_found(
            "acp_route_not_found",
            format!("No ACP route for {method} {normalized}."),
        ))
    };

    Ok(match result {
        Ok(response) => response,
        Err(error) => acp_error_response(error),
    })
}
