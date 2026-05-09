use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::runtime::RuntimeApprovalDetails;
use crate::{now_i64, AppState};

const APPROVAL_RECENT_LIMIT: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct RuntimeApprovalRecord {
    pub approval_id: String,
    pub source_kind: String,
    pub source_key: String,
    pub session_id: Option<String>,
    pub task_id: Option<String>,
    pub runtime_id: Option<String>,
    pub call_id: Option<String>,
    pub name: String,
    pub status: String,
    pub details: RuntimeApprovalDetails,
    pub metadata: Option<Value>,
    pub created_at: i64,
    pub updated_at: i64,
    pub resolved_at: Option<i64>,
    pub confirmed: Option<bool>,
}

impl RuntimeApprovalRecord {
    pub fn pending(
        approval_id: impl Into<String>,
        source_kind: impl Into<String>,
        source_key: impl Into<String>,
        name: impl Into<String>,
        details: RuntimeApprovalDetails,
    ) -> Self {
        let now = now_i64();
        Self {
            approval_id: approval_id.into(),
            source_kind: source_kind.into(),
            source_key: source_key.into(),
            session_id: None,
            task_id: None,
            runtime_id: None,
            call_id: None,
            name: name.into(),
            status: "pending".to_string(),
            details,
            metadata: None,
            created_at: now,
            updated_at: now,
            resolved_at: None,
            confirmed: None,
        }
    }

    pub fn with_scope(
        mut self,
        session_id: Option<&str>,
        task_id: Option<&str>,
        runtime_id: Option<&str>,
        call_id: Option<&str>,
    ) -> Self {
        self.session_id = session_id.map(ToString::to_string);
        self.task_id = task_id.map(ToString::to_string);
        self.runtime_id = runtime_id.map(ToString::to_string);
        self.call_id = call_id.map(ToString::to_string);
        self
    }

    pub fn with_metadata(mut self, metadata: Option<Value>) -> Self {
        self.metadata = metadata;
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct RuntimeApprovalSnapshot {
    pub pending_count: i64,
    pub resolved_count: i64,
    pub pending: Vec<RuntimeApprovalRecord>,
    pub recent: Vec<RuntimeApprovalRecord>,
}

#[derive(Default)]
pub struct ApprovalRuntimeState {
    pending: HashMap<String, RuntimeApprovalRecord>,
    recent: Vec<RuntimeApprovalRecord>,
    review_waiters: HashMap<String, Vec<Sender<Value>>>,
}

impl ApprovalRuntimeState {
    pub fn request(&mut self, mut approval: RuntimeApprovalRecord) -> RuntimeApprovalRecord {
        let previous = self.pending.get(&approval.approval_id).cloned();
        approval.status = "pending".to_string();
        approval.updated_at = now_i64();
        approval.resolved_at = None;
        approval.confirmed = None;
        if let Some(existing) = previous {
            approval.created_at = existing.created_at;
        }
        self.pending
            .insert(approval.approval_id.clone(), approval.clone());
        approval
    }

    pub fn resolve_by_approval_id(
        &mut self,
        approval_id: &str,
        confirmed: bool,
    ) -> Option<RuntimeApprovalRecord> {
        let mut approval = self.pending.remove(approval_id)?;
        self.finalize_resolution(&mut approval, confirmed);
        Some(approval)
    }

    pub fn resolve_by_source_key(
        &mut self,
        source_key: &str,
        confirmed: bool,
    ) -> Option<RuntimeApprovalRecord> {
        let approval_id = self.pending.iter().find_map(|(approval_id, item)| {
            if item.source_key == source_key {
                Some(approval_id.clone())
            } else {
                None
            }
        })?;
        self.resolve_by_approval_id(&approval_id, confirmed)
    }

    pub fn resolve_by_call_id(
        &mut self,
        call_id: &str,
        confirmed: bool,
    ) -> Option<RuntimeApprovalRecord> {
        let approval_id = self.pending.iter().find_map(|(approval_id, item)| {
            if item.call_id.as_deref() == Some(call_id) {
                Some(approval_id.clone())
            } else {
                None
            }
        })?;
        self.resolve_by_approval_id(&approval_id, confirmed)
    }

    pub fn snapshot(&self) -> RuntimeApprovalSnapshot {
        let mut pending = self.pending.values().cloned().collect::<Vec<_>>();
        pending.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        let mut recent = self.recent.clone();
        recent.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        RuntimeApprovalSnapshot {
            pending_count: pending.len() as i64,
            resolved_count: recent.len() as i64,
            pending,
            recent,
        }
    }

    pub fn register_review_docket_waiter(&mut self, docket_id: &str) -> Receiver<Value> {
        let (sender, receiver) = mpsc::channel();
        self.review_waiters
            .entry(docket_id.to_string())
            .or_default()
            .push(sender);
        receiver
    }

    pub fn resolve_review_docket_waiters(&mut self, docket_id: &str, outcome: Value) {
        let Some(waiters) = self.review_waiters.remove(docket_id) else {
            return;
        };
        for waiter in waiters {
            let _ = waiter.send(outcome.clone());
        }
    }

    pub fn clear_review_docket_waiters(&mut self, docket_id: &str) {
        self.review_waiters.remove(docket_id);
    }

    fn finalize_resolution(&mut self, approval: &mut RuntimeApprovalRecord, confirmed: bool) {
        let resolved_at = now_i64();
        approval.status = if confirmed {
            "confirmed".to_string()
        } else {
            "rejected".to_string()
        };
        approval.updated_at = resolved_at;
        approval.resolved_at = Some(resolved_at);
        approval.confirmed = Some(confirmed);
        self.recent.insert(0, approval.clone());
        if self.recent.len() > APPROVAL_RECENT_LIMIT {
            self.recent.truncate(APPROVAL_RECENT_LIMIT);
        }
    }
}

pub fn request_runtime_approval(
    state: &State<'_, AppState>,
    approval: RuntimeApprovalRecord,
) -> Result<RuntimeApprovalRecord, String> {
    let mut approvals = state
        .approval_runtime
        .lock()
        .map_err(|_| "approval runtime lock 已损坏".to_string())?;
    Ok(approvals.request(approval))
}

pub fn resolve_runtime_approval_by_approval_id(
    state: &State<'_, AppState>,
    approval_id: &str,
    confirmed: bool,
) -> Result<Option<RuntimeApprovalRecord>, String> {
    let mut approvals = state
        .approval_runtime
        .lock()
        .map_err(|_| "approval runtime lock 已损坏".to_string())?;
    Ok(approvals.resolve_by_approval_id(approval_id, confirmed))
}

pub fn resolve_runtime_approval_by_source_key(
    state: &State<'_, AppState>,
    source_key: &str,
    confirmed: bool,
) -> Result<Option<RuntimeApprovalRecord>, String> {
    let mut approvals = state
        .approval_runtime
        .lock()
        .map_err(|_| "approval runtime lock 已损坏".to_string())?;
    Ok(approvals.resolve_by_source_key(source_key, confirmed))
}

pub fn resolve_runtime_approval_by_call_id(
    state: &State<'_, AppState>,
    call_id: &str,
    confirmed: bool,
) -> Result<Option<RuntimeApprovalRecord>, String> {
    let mut approvals = state
        .approval_runtime
        .lock()
        .map_err(|_| "approval runtime lock 已损坏".to_string())?;
    Ok(approvals.resolve_by_call_id(call_id, confirmed))
}

pub fn runtime_approval_snapshot(
    state: &State<'_, AppState>,
) -> Result<RuntimeApprovalSnapshot, String> {
    let approvals = state
        .approval_runtime
        .lock()
        .map_err(|_| "approval runtime lock 已损坏".to_string())?;
    Ok(approvals.snapshot())
}

pub fn runtime_approval_confirmed_by_call_id(
    state: &State<'_, AppState>,
    call_id: &str,
) -> Result<bool, String> {
    let approvals = state
        .approval_runtime
        .lock()
        .map_err(|_| "approval runtime lock 已损坏".to_string())?;
    Ok(approvals
        .snapshot()
        .recent
        .iter()
        .any(|item| item.call_id.as_deref() == Some(call_id) && item.confirmed == Some(true)))
}

pub fn register_review_docket_waiter(
    state: &State<'_, AppState>,
    docket_id: &str,
) -> Result<Receiver<Value>, String> {
    let mut approvals = state
        .approval_runtime
        .lock()
        .map_err(|_| "approval runtime lock 已损坏".to_string())?;
    Ok(approvals.register_review_docket_waiter(docket_id))
}

pub fn resolve_review_docket_waiters(
    state: &State<'_, AppState>,
    docket_id: &str,
    outcome: Value,
) -> Result<(), String> {
    let mut approvals = state
        .approval_runtime
        .lock()
        .map_err(|_| "approval runtime lock 已损坏".to_string())?;
    approvals.resolve_review_docket_waiters(docket_id, outcome);
    Ok(())
}

pub fn clear_review_docket_waiters(
    state: &State<'_, AppState>,
    docket_id: &str,
) -> Result<(), String> {
    let mut approvals = state
        .approval_runtime
        .lock()
        .map_err(|_| "approval runtime lock 已损坏".to_string())?;
    approvals.clear_review_docket_waiters(docket_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_pending(
        approval_id: &str,
        source_key: &str,
        call_id: Option<&str>,
    ) -> RuntimeApprovalRecord {
        RuntimeApprovalRecord::pending(
            approval_id,
            "tool",
            source_key,
            "bash",
            RuntimeApprovalDetails {
                r#type: "exec".to_string(),
                title: "Run command".to_string(),
                description: "Execute shell command".to_string(),
                impact: Some("May modify workspace".to_string()),
            },
        )
        .with_scope(Some("session-1"), None, None, call_id)
    }

    #[test]
    fn request_upserts_pending_approval_by_id() {
        let mut state = ApprovalRuntimeState::default();
        let first = state.request(build_pending("approval-1", "tool-call", Some("call-1")));
        let second = state.request(build_pending("approval-1", "tool-call", Some("call-1")));

        assert_eq!(state.snapshot().pending_count, 1);
        assert_eq!(first.approval_id, second.approval_id);
        assert_eq!(first.created_at, second.created_at);
    }

    #[test]
    fn resolve_can_match_by_call_id_or_source_key() {
        let mut by_call = ApprovalRuntimeState::default();
        by_call.request(build_pending("approval-1", "tool-call", Some("call-1")));
        let resolved = by_call.resolve_by_call_id("call-1", true).unwrap();
        assert_eq!(resolved.status, "confirmed");
        assert_eq!(resolved.confirmed, Some(true));
        assert_eq!(by_call.snapshot().pending_count, 0);
        assert_eq!(by_call.snapshot().resolved_count, 1);

        let mut by_source = ApprovalRuntimeState::default();
        by_source.request(build_pending("approval-2", "manuscript:/tmp/demo", None));
        let rejected = by_source
            .resolve_by_source_key("manuscript:/tmp/demo", false)
            .unwrap();
        assert_eq!(rejected.status, "rejected");
        assert_eq!(rejected.confirmed, Some(false));
    }

    #[test]
    fn snapshot_keeps_recent_records_bounded() {
        let mut state = ApprovalRuntimeState::default();
        for index in 0..(APPROVAL_RECENT_LIMIT + 5) {
            let approval_id = format!("approval-{index}");
            let call_id = format!("call-{index}");
            state.request(build_pending(&approval_id, &approval_id, Some(&call_id)));
            let _ = state.resolve_by_call_id(&call_id, index % 2 == 0);
        }

        let snapshot = state.snapshot();
        assert_eq!(snapshot.pending_count, 0);
        assert_eq!(snapshot.resolved_count, APPROVAL_RECENT_LIMIT as i64);
        assert_eq!(snapshot.recent.len(), APPROVAL_RECENT_LIMIT);
        assert_eq!(
            snapshot
                .recent
                .first()
                .map(|item| item.approval_id.as_str()),
            Some("approval-54")
        );
    }
}
