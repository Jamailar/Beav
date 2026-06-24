use std::collections::HashMap;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::persistence::with_store;
use crate::{AcpArtifactRecord, AppState};

use super::auth::authorize_acp_request;
use super::errors::AcpHttpError;

fn artifact_public_value(artifact: &AcpArtifactRecord) -> Value {
    json!({
        "id": artifact.id.clone(),
        "sessionId": artifact.session_id.clone(),
        "runId": artifact.run_id.clone(),
        "kind": artifact.kind.clone(),
        "title": artifact.title.clone(),
        "summary": artifact.summary.clone(),
        "refs": artifact.refs.clone(),
        "payload": artifact.payload.clone(),
        "createdAt": artifact.created_at
    })
}

pub(crate) fn get_artifact_value(
    app: &AppHandle,
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
    artifact_id: &str,
) -> Result<Value, AcpHttpError> {
    let state = app.state::<AppState>();
    with_store(&state, |store| {
        let result = (|| -> Result<Value, AcpHttpError> {
            authorize_acp_request(&store, method, path, headers)?;
            let artifact = store
                .acp_artifacts
                .iter()
                .find(|item| item.id == artifact_id)
                .ok_or_else(|| {
                    AcpHttpError::not_found("acp_artifact_not_found", "ACP artifact not found.")
                })?;
            Ok(json!({
                "success": true,
                "artifact": artifact_public_value(artifact)
            }))
        })();
        Ok(result)
    })
    .map_err(AcpHttpError::internal)?
}

pub(crate) fn session_artifacts_value(
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
            let artifacts = store
                .acp_artifacts
                .iter()
                .filter(|item| item.session_id == session_id)
                .map(artifact_public_value)
                .collect::<Vec<_>>();
            Ok(json!({
                "success": true,
                "sessionId": session_id,
                "artifacts": artifacts
            }))
        })();
        Ok(result)
    })
    .map_err(AcpHttpError::internal)?
}
