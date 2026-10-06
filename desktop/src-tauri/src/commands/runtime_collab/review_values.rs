use super::emit_collab_event;
use super::review_approval::{request_review_docket_runtime_approval, route_review_docket_action};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    archive_review_docket, create_review_docket, decide_review_docket, get_review_docket,
    list_review_dockets, resolve_review_docket_waiters, resolve_runtime_approval_by_approval_id,
    review_docket_stats,
};
use crate::{payload_string, AppState};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

pub fn list_review_dockets_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    with_store(state, |store| {
        Ok(json!(list_review_dockets(&store, payload)))
    })
}

pub fn get_review_docket_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let docket_id =
        payload_string(payload, "docketId").ok_or_else(|| "缺少 docketId".to_string())?;
    with_store(state, |store| {
        get_review_docket(&store, &docket_id)
            .map(|docket| json!(docket))
            .ok_or_else(|| "审批项不存在".to_string())
    })
}

pub fn review_docket_stats_value(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| Ok(review_docket_stats(&store)))
}

pub fn create_review_docket_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let docket = with_store_mut(state, |store| create_review_docket(store, payload))?;
    let call_id = payload_string(payload, "callId").or_else(|| {
        payload
            .get("proposedAction")
            .and_then(Value::as_object)
            .and_then(|value| value.get("callId"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
    });
    let approval = request_review_docket_runtime_approval(state, &docket, call_id.as_deref())?;
    let docket_id = docket.id.clone();
    emit_collab_event(
        app,
        "runtime:review-docket-changed",
        None,
        json!({ "docketId": docket_id, "docket": docket.clone(), "approval": approval }),
    );
    Ok(json!(docket))
}

pub fn decide_review_docket_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let decision = with_store_mut(state, |store| decide_review_docket(store, payload))?;
    let docket_id = decision.docket_id.clone();
    let action_result = route_review_docket_action(app, state, &docket_id, &decision)?;
    let confirmed = decision.decision == "approved";
    let runtime_approval = resolve_runtime_approval_by_approval_id(state, &docket_id, confirmed)?;
    let outcome = json!({
        "docketId": docket_id,
        "decision": decision.clone(),
        "confirmed": confirmed,
        "runtimeApproval": runtime_approval,
        "actionResult": action_result.json(),
    });
    resolve_review_docket_waiters(state, &docket_id, outcome.clone())?;
    emit_collab_event(app, "runtime:review-docket-changed", None, outcome);
    Ok(json!(decision))
}

pub fn archive_review_docket_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
    status: &str,
) -> Result<Value, String> {
    let docket = with_store_mut(state, |store| archive_review_docket(store, payload, status))?;
    let docket_id = docket.id.clone();
    let runtime_approval = resolve_runtime_approval_by_approval_id(state, &docket_id, false)?;
    let outcome = json!({
        "docketId": docket_id,
        "docket": docket.clone(),
        "confirmed": false,
        "runtimeApproval": runtime_approval,
        "actionResult": {
            "kind": "archive",
            "status": status,
        },
    });
    resolve_review_docket_waiters(state, &docket_id, outcome.clone())?;
    emit_collab_event(app, "runtime:review-docket-changed", None, outcome);
    Ok(json!(docket))
}
