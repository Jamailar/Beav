use super::*;

#[derive(Debug, Clone)]
pub(super) struct ApprovalActionRouteResult {
    kind: String,
    status: &'static str,
    message: Option<String>,
}

impl ApprovalActionRouteResult {
    pub(super) fn json(&self) -> Value {
        json!({
            "kind": self.kind,
            "status": self.status,
            "message": self.message,
        })
    }
}

pub(super) fn request_review_docket_runtime_approval(
    state: &State<'_, AppState>,
    docket: &ReviewDocketRecord,
    call_id: Option<&str>,
) -> Result<RuntimeApprovalRecord, String> {
    let description = if !docket.summary.trim().is_empty() {
        docket.summary.clone()
    } else if !docket.body.trim().is_empty() {
        docket.body.clone()
    } else {
        docket.title.clone()
    };
    request_runtime_approval(
        state,
        RuntimeApprovalRecord::pending(
            docket.id.clone(),
            "review_docket",
            docket.id.clone(),
            docket.decision_type.clone(),
            RuntimeApprovalDetails {
                r#type: docket.decision_type.clone(),
                title: docket.title.clone(),
                description,
                impact: Some(format!(
                    "source={}, risk={}, priority={}",
                    docket.source_kind, docket.risk_level, docket.priority
                )),
            },
        )
        .with_scope(
            docket.session_id.as_deref(),
            docket.task_id.as_deref(),
            None,
            call_id,
        )
        .with_metadata(Some(json!({
            "docketId": docket.id,
            "sourceKind": docket.source_kind,
            "sourceId": docket.source_id,
            "decisionType": docket.decision_type,
            "riskLevel": docket.risk_level,
            "priority": docket.priority,
            "proposedAction": docket.proposed_action,
            "artifactRefs": docket.artifact_refs,
            "options": docket.options,
        }))),
    )
}

fn proposed_action_kind(action: Option<&Value>) -> Option<&str> {
    action
        .and_then(Value::as_object)
        .and_then(|value| value.get("kind"))
        .and_then(Value::as_str)
}

pub(super) fn route_review_docket_action(
    app: &AppHandle,
    state: &State<'_, AppState>,
    docket_id: &str,
    decision: &crate::runtime::ReviewDecisionRecord,
) -> Result<ApprovalActionRouteResult, String> {
    let docket = with_store(state, |store| {
        get_review_docket(&store, docket_id).ok_or_else(|| "审批项不存在".to_string())
    })?;
    let Some(kind) = proposed_action_kind(docket.proposed_action.as_ref()) else {
        return Ok(ApprovalActionRouteResult {
            kind: "none".to_string(),
            status: "not_applicable",
            message: None,
        });
    };

    match kind {
        "redclaw_task_draft" => {
            apply_redclaw_task_draft_approval(app, state, &docket, &decision.decision)
        }
        "cli_escalation" => apply_cli_escalation_approval(app, state, &docket, decision),
        "agent_approval" => Ok(ApprovalActionRouteResult {
            kind: kind.to_string(),
            status: "resolved",
            message: Some("通用 agent 审批已回填到等待中的 runtime。".to_string()),
        }),
        "collab_task_completion" => Ok(ApprovalActionRouteResult {
            kind: kind.to_string(),
            status: "already_applied",
            message: Some(
                "协作任务状态已由审批 runtime 按 onDecisionTaskStatus 回写。".to_string(),
            ),
        }),
        other => Ok(ApprovalActionRouteResult {
            kind: other.to_string(),
            status: "unsupported",
            message: Some("审批动作 kind 尚未注册业务处理器。".to_string()),
        }),
    }
}

fn apply_cli_escalation_approval(
    app: &AppHandle,
    state: &State<'_, AppState>,
    docket: &ReviewDocketRecord,
    decision: &crate::runtime::ReviewDecisionRecord,
) -> Result<ApprovalActionRouteResult, String> {
    let action = docket
        .proposed_action
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| "CLI 审批项缺少 proposedAction".to_string())?;
    let escalation_id = action
        .get("escalationId")
        .and_then(Value::as_str)
        .or(docket.source_id.as_deref())
        .ok_or_else(|| "CLI 审批项缺少 escalationId".to_string())?;
    if decision.decision == "approved" {
        let scope = decision
            .selected_option_id
            .as_deref()
            .or_else(|| action.get("defaultScope").and_then(Value::as_str))
            .unwrap_or("once");
        let _ = handle_cli_runtime_channel(
            app,
            state,
            "cli-runtime:approve-escalation",
            &json!({
                "escalationId": escalation_id,
                "scope": scope,
            }),
        )
        .ok_or_else(|| "CLI 审批处理器不可用".to_string())??;
        return Ok(ApprovalActionRouteResult {
            kind: "cli_escalation".to_string(),
            status: "succeeded",
            message: Some(format!("CLI 权限已按 {scope} 范围批准。")),
        });
    }
    if decision.decision == "rejected" {
        let _ = handle_cli_runtime_channel(
            app,
            state,
            "cli-runtime:deny-escalation",
            &json!({
                "escalationId": escalation_id,
                "reason": decision.comment,
            }),
        )
        .ok_or_else(|| "CLI 审批处理器不可用".to_string())??;
        return Ok(ApprovalActionRouteResult {
            kind: "cli_escalation".to_string(),
            status: "succeeded",
            message: Some("CLI 权限请求已拒绝。".to_string()),
        });
    }
    Ok(ApprovalActionRouteResult {
        kind: "cli_escalation".to_string(),
        status: "ignored",
        message: Some("该决定不会自动批准或拒绝 CLI 权限。".to_string()),
    })
}

fn apply_redclaw_task_draft_approval(
    app: &AppHandle,
    state: &State<'_, AppState>,
    docket: &ReviewDocketRecord,
    decision: &str,
) -> Result<ApprovalActionRouteResult, String> {
    let action = docket
        .proposed_action
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| "RedClaw 审批项缺少 proposedAction".to_string())?;
    let draft_id = action
        .get("draftId")
        .and_then(Value::as_str)
        .or(docket.source_id.as_deref())
        .ok_or_else(|| "RedClaw 审批项缺少 draftId".to_string())?;
    let confirm = match decision {
        "approved" => Some(true),
        "rejected" => Some(false),
        _ => None,
    };
    if let Some(confirm) = confirm {
        redclaw_task_control::handle_task_confirm(
            app,
            state,
            &json!({
                "draftId": draft_id,
                "confirm": confirm,
            }),
        )?;
        return Ok(ApprovalActionRouteResult {
            kind: "redclaw_task_draft".to_string(),
            status: "succeeded",
            message: Some(if confirm {
                "RedClaw 草稿已确认。".to_string()
            } else {
                "RedClaw 草稿已丢弃。".to_string()
            }),
        });
    }
    Ok(ApprovalActionRouteResult {
        kind: "redclaw_task_draft".to_string(),
        status: "ignored",
        message: Some("该决定不会自动确认或丢弃 RedClaw 草稿。".to_string()),
    })
}
