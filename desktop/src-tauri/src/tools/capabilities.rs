use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use tauri::State;

use crate::persistence::{with_store, with_store_mut};
use crate::skills::{build_skill_runtime_state, resolve_skill_records};
use crate::tools::catalog::{approval_level_max, ApprovalLevel, ToolDescriptor};
use crate::tools::packs::tool_names_for_runtime_mode;
use crate::tools::registry::base_tool_names_for_session_metadata;
use crate::{make_id, now_i64, now_iso, payload_field, payload_string, workspace_root, AppState, AppStore};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityEntryKind {
    Interactive,
    BackgroundTask,
    Subagent,
    Diagnostics,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityApprovalOverride {
    pub tool_name: String,
    pub level: ApprovalLevel,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityApprovalPolicy {
    pub default_level: ApprovalLevel,
    pub tool_overrides: Vec<CapabilityApprovalOverride>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityMcpScope {
    pub mode: String,
    pub allowed_actions: Vec<String>,
    pub blocked_actions: Vec<String>,
    pub allowed_server_ids: Vec<String>,
    pub allowed_server_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySet {
    pub fingerprint: String,
    pub runtime_mode: String,
    pub entry_kind: CapabilityEntryKind,
    pub active_skills: Vec<String>,
    pub allowed_tools: Vec<String>,
    pub blocked_tools: Vec<String>,
    pub approval_policy: CapabilityApprovalPolicy,
    pub write_scope: Vec<String>,
    pub network_scope: Vec<String>,
    pub mcp_scope: CapabilityMcpScope,
    pub memory_write_policy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityAuditRecord {
    pub id: String,
    pub actor: String,
    pub runtime_mode: String,
    pub entry_kind: CapabilityEntryKind,
    pub session_id: Option<String>,
    pub tool_name: String,
    pub tool_action: Option<String>,
    pub approval_level: ApprovalLevel,
    pub outcome: String,
    pub reason: String,
    pub capability_fingerprint: String,
    pub arguments_summary: Value,
    pub created_at: i64,
    pub created_at_iso: String,
}

#[derive(Debug, Clone)]
pub struct CapabilityGuardDecision {
    pub capability_set: CapabilitySet,
    pub descriptor: ToolDescriptor,
    pub tool_action: Option<String>,
    pub approval_level: ApprovalLevel,
    pub arguments_summary: Value,
}

fn metadata_for_session<'a>(store: &'a AppStore, session_id: Option<&str>) -> Option<&'a Value> {
    session_id.and_then(|id| {
        store
            .chat_sessions
            .iter()
            .find(|item| item.id == id)
            .and_then(|item| item.metadata.as_ref())
    })
}

fn resolve_entry_kind(runtime_mode: &str, metadata: Option<&Value>) -> CapabilityEntryKind {
    if metadata
        .and_then(|value| payload_field(value, "isSubagentSession"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return CapabilityEntryKind::Subagent;
    }
    if runtime_mode == "background-maintenance"
        || metadata
            .and_then(|value| payload_field(value, "scheduledTaskId"))
            .is_some()
        || metadata
            .and_then(|value| payload_field(value, "backgroundTaskId"))
            .is_some()
    {
        return CapabilityEntryKind::BackgroundTask;
    }
    if runtime_mode == "diagnostics" {
        return CapabilityEntryKind::Diagnostics;
    }
    CapabilityEntryKind::Interactive
}

fn unique_sorted(items: Vec<String>) -> Vec<String> {
    let mut items = items
        .into_iter()
        .filter(|item| !item.trim().is_empty())
        .collect::<Vec<_>>();
    items.sort();
    items.dedup();
    items
}

fn mcp_scope_for_entry(store: &AppStore, entry_kind: &CapabilityEntryKind) -> CapabilityMcpScope {
    let (mode, allowed_actions, blocked_actions) = match entry_kind {
        CapabilityEntryKind::Interactive | CapabilityEntryKind::Diagnostics => (
            "interactive",
            vec![
                "list",
                "test",
                "call",
                "list_tools",
                "list_resources",
                "list_resource_templates",
                "sessions",
                "disconnect",
                "disconnect_all",
                "discover_local",
                "import_local",
                "oauth_status",
                "save",
            ],
            Vec::<&str>::new(),
        ),
        CapabilityEntryKind::BackgroundTask => (
            "read_only",
            vec![
                "list",
                "list_tools",
                "list_resources",
                "list_resource_templates",
                "sessions",
                "oauth_status",
            ],
            vec![
                "save",
                "disconnect",
                "disconnect_all",
                "discover_local",
                "import_local",
                "call",
                "test",
            ],
        ),
        CapabilityEntryKind::Subagent => (
            "metadata_only",
            vec!["list", "sessions", "oauth_status"],
            vec![
                "save",
                "disconnect",
                "disconnect_all",
                "discover_local",
                "import_local",
                "call",
                "test",
                "list_tools",
                "list_resources",
                "list_resource_templates",
            ],
        ),
    };
    CapabilityMcpScope {
        mode: mode.to_string(),
        allowed_actions: allowed_actions
            .into_iter()
            .map(ToString::to_string)
            .collect(),
        blocked_actions: blocked_actions
            .into_iter()
            .map(ToString::to_string)
            .collect(),
        allowed_server_ids: unique_sorted(
            store
                .mcp_servers
                .iter()
                .filter(|item| item.enabled)
                .map(|item| item.id.clone())
                .collect(),
        ),
        allowed_server_names: unique_sorted(
            store
                .mcp_servers
                .iter()
                .filter(|item| item.enabled)
                .map(|item| item.name.clone())
                .collect(),
        ),
    }
}

fn write_scope_for_runtime_mode(
    runtime_mode: &str,
    entry_kind: &CapabilityEntryKind,
) -> Vec<String> {
    let mut scope = vec!["currentSpaceRoot:read".to_string()];
    match runtime_mode {
        "redclaw" | "diagnostics" => {
            scope.push("redclawProfileDocs".to_string());
            scope.push("currentSpaceRoot:write".to_string());
        }
        "video-editor" | "audio-editor" => {
            scope.push("editorBoundPackage".to_string());
        }
        "background-maintenance" => {
            scope.push("taskArtifacts".to_string());
        }
        _ => {
            scope.push("currentSpaceRoot:write".to_string());
        }
    }
    if matches!(entry_kind, CapabilityEntryKind::Subagent) {
        scope.retain(|item| item != "redclawProfileDocs");
    }
    unique_sorted(scope)
}

fn network_scope_for_entry(
    entry_kind: &CapabilityEntryKind,
    allowed_tools: &[String],
) -> Vec<String> {
    let mut scope = vec![];
    if allowed_tools.iter().any(|item| item == "redbox_mcp") {
        scope.push("mcp".to_string());
    }
    if matches!(
        entry_kind,
        CapabilityEntryKind::Interactive | CapabilityEntryKind::Diagnostics
    ) {
        scope.push("hostConfiguredModelEndpoints".to_string());
    }
    unique_sorted(scope)
}

fn memory_write_policy_for_entry(entry_kind: &CapabilityEntryKind) -> String {
    match entry_kind {
        CapabilityEntryKind::Interactive | CapabilityEntryKind::Diagnostics => {
            "interactive_allowed"
        }
        CapabilityEntryKind::BackgroundTask => "system_only",
        CapabilityEntryKind::Subagent => "disabled",
    }
    .to_string()
}

fn approval_policy_for_entry(
    entry_kind: &CapabilityEntryKind,
    allowed_tools: &[String],
) -> CapabilityApprovalPolicy {
    let default_level = match entry_kind {
        CapabilityEntryKind::Interactive => ApprovalLevel::Light,
        CapabilityEntryKind::Diagnostics => ApprovalLevel::Light,
        CapabilityEntryKind::BackgroundTask => ApprovalLevel::Explicit,
        CapabilityEntryKind::Subagent => ApprovalLevel::Explicit,
    };
    let mut overrides = Vec::new();
    let mut push_override = |tool_name: &str, level: ApprovalLevel, reason: &str| {
        if allowed_tools.iter().any(|item| item == tool_name) {
            overrides.push(CapabilityApprovalOverride {
                tool_name: tool_name.to_string(),
                level,
                reason: reason.to_string(),
            });
        }
    };
    push_override(
        "redbox_profile_doc",
        if matches!(
            entry_kind,
            CapabilityEntryKind::Interactive | CapabilityEntryKind::Diagnostics
        ) {
            ApprovalLevel::Explicit
        } else {
            ApprovalLevel::AlwaysHold
        },
        "durable profile doc mutation must stay in user-facing RedClaw flows",
    );
    push_override(
        "redbox_mcp",
        ApprovalLevel::Explicit,
        "MCP actions can touch network, credentials, or external side effects",
    );
    push_override(
        "redbox_skill",
        if matches!(
            entry_kind,
            CapabilityEntryKind::Interactive | CapabilityEntryKind::Diagnostics
        ) {
            ApprovalLevel::Explicit
        } else {
            ApprovalLevel::AlwaysHold
        },
        "skill mutations change runtime capability surfaces",
    );
    push_override(
        "redbox_runtime_control",
        if matches!(
            entry_kind,
            CapabilityEntryKind::Interactive | CapabilityEntryKind::Diagnostics
        ) {
            ApprovalLevel::Light
        } else {
            ApprovalLevel::Explicit
        },
        "runtime control can spawn, resume, cancel, or bridge execution",
    );
    CapabilityApprovalPolicy {
        default_level,
        tool_overrides: overrides,
    }
}

fn fingerprint_capability_set(set: &CapabilitySet) -> String {
    let mut hasher = DefaultHasher::new();
    set.runtime_mode.hash(&mut hasher);
    set.entry_kind.hash(&mut hasher);
    set.active_skills.hash(&mut hasher);
    set.allowed_tools.hash(&mut hasher);
    set.blocked_tools.hash(&mut hasher);
    set.write_scope.hash(&mut hasher);
    set.network_scope.hash(&mut hasher);
    set.mcp_scope.mode.hash(&mut hasher);
    set.mcp_scope.allowed_actions.hash(&mut hasher);
    set.mcp_scope.blocked_actions.hash(&mut hasher);
    set.mcp_scope.allowed_server_ids.hash(&mut hasher);
    set.memory_write_policy.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

pub fn approval_level_for_tool(set: &CapabilitySet, descriptor: &ToolDescriptor) -> ApprovalLevel {
    let mut level = approval_level_max(
        set.approval_policy.default_level,
        descriptor.default_approval,
    );
    if let Some(override_level) = set
        .approval_policy
        .tool_overrides
        .iter()
        .find(|item| item.tool_name == descriptor.name)
        .map(|item| item.level)
    {
        level = approval_level_max(level, override_level);
    }
    level
}

pub fn resolve_capability_set_for_store(
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> CapabilitySet {
    let metadata = metadata_for_session(store, session_id);
    let base_tools = base_tool_names_for_session_metadata(runtime_mode, metadata);
    let skill_state =
        build_skill_runtime_state(&store.skills, runtime_mode, metadata, &base_tools, None);
    let entry_kind = resolve_entry_kind(runtime_mode, metadata);
    let original_allowed_tools = skill_state.allowed_tools.clone();
    let mut allowed_tools = unique_sorted(skill_state.allowed_tools);
    let entry_kind_for_set = resolve_entry_kind(runtime_mode, metadata);
    let mut blocked_tools = tool_names_for_runtime_mode(runtime_mode)
        .iter()
        .filter(|item| !allowed_tools.iter().any(|allowed| allowed == **item))
        .map(|item| item.to_string())
        .collect::<Vec<_>>();
    if matches!(
        entry_kind,
        CapabilityEntryKind::Subagent | CapabilityEntryKind::BackgroundTask
    ) {
        for blocked in ["redbox_profile_doc", "redbox_skill"] {
            if allowed_tools.iter().any(|item| item == blocked) {
                allowed_tools.retain(|item| item != blocked);
                blocked_tools.push(blocked.to_string());
            }
        }
    }
    let approval_policy = approval_policy_for_entry(&entry_kind, &allowed_tools);
    let mcp_scope = mcp_scope_for_entry(store, &entry_kind);
    let mut set = CapabilitySet {
        fingerprint: String::new(),
        runtime_mode: runtime_mode.to_string(),
        entry_kind,
        active_skills: unique_sorted(
            skill_state
                .active_skills
                .iter()
                .map(|item| item.name.clone())
                .collect(),
        ),
        allowed_tools,
        blocked_tools: unique_sorted(blocked_tools),
        approval_policy,
        write_scope: write_scope_for_runtime_mode(runtime_mode, &entry_kind_for_set),
        network_scope: network_scope_for_entry(&entry_kind_for_set, &original_allowed_tools),
        mcp_scope,
        memory_write_policy: memory_write_policy_for_entry(&entry_kind_for_set),
    };
    set.fingerprint = fingerprint_capability_set(&set);
    set
}

pub fn resolve_capability_set(
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> Result<CapabilitySet, String> {
    let workspace = workspace_root(state).ok();
    with_store(state, |store| {
        let resolved_skills = resolve_skill_records(&store.skills, workspace.as_deref());
        let metadata = metadata_for_session(&store, session_id);
        let base_tools = base_tool_names_for_session_metadata(runtime_mode, metadata);
        let skill_state = build_skill_runtime_state(
            &resolved_skills,
            runtime_mode,
            metadata,
            &base_tools,
            None,
        );
        let entry_kind = resolve_entry_kind(runtime_mode, metadata);
        let original_allowed_tools = skill_state.allowed_tools.clone();
        let mut allowed_tools = unique_sorted(skill_state.allowed_tools);
        let entry_kind_for_set = resolve_entry_kind(runtime_mode, metadata);
        let mut blocked_tools = tool_names_for_runtime_mode(runtime_mode)
            .iter()
            .filter(|item| !allowed_tools.iter().any(|allowed| allowed == **item))
            .map(|item| item.to_string())
            .collect::<Vec<_>>();
        if matches!(
            entry_kind,
            CapabilityEntryKind::Subagent | CapabilityEntryKind::BackgroundTask
        ) {
            for blocked in ["redbox_profile_doc", "redbox_skill"] {
                if allowed_tools.iter().any(|item| item == blocked) {
                    allowed_tools.retain(|item| item != blocked);
                    blocked_tools.push(blocked.to_string());
                }
            }
        }
        let approval_policy = approval_policy_for_entry(&entry_kind, &allowed_tools);
        let mcp_scope = mcp_scope_for_entry(&store, &entry_kind);
        let network_scope = network_scope_for_entry(&entry_kind_for_set, &allowed_tools);
        let mut set = CapabilitySet {
            fingerprint: String::new(),
            runtime_mode: runtime_mode.to_string(),
            entry_kind,
            active_skills: unique_sorted(
                skill_state
                    .active_skills
                    .iter()
                    .map(|item| item.name.clone())
                    .collect(),
            ),
            allowed_tools,
            blocked_tools: unique_sorted(blocked_tools),
            approval_policy,
            write_scope: write_scope_for_runtime_mode(runtime_mode, &entry_kind_for_set),
            network_scope,
            mcp_scope,
            memory_write_policy: memory_write_policy_for_entry(&entry_kind_for_set),
        };
        let _ = original_allowed_tools;
        set.fingerprint = fingerprint_capability_set(&set);
        Ok(set)
    })
}

pub fn resolve_capability_set_value(
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> Result<Value, String> {
    resolve_capability_set(state, runtime_mode, session_id).map(|item| json!(item))
}

fn action_from_arguments(tool_name: &str, arguments: &Value) -> Option<String> {
    match tool_name {
        "redbox_fs"
        | "redbox_profile_doc"
        | "redbox_mcp"
        | "redbox_skill"
        | "redbox_runtime_control"
        | "redbox_editor" => payload_string(arguments, "action"),
        "redbox_app_query" => payload_string(arguments, "operation"),
        _ => None,
    }
}

pub fn summarize_tool_arguments(tool_name: &str, arguments: &Value) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("toolName".to_string(), json!(tool_name));
    if let Some(action) = action_from_arguments(tool_name, arguments) {
        object.insert("action".to_string(), json!(action));
    }
    for key in [
        "path",
        "docType",
        "query",
        "sessionId",
        "runtimeId",
        "taskId",
        "serverId",
        "serverName",
        "method",
        "name",
        "slug",
        "location",
    ] {
        if let Some(value) = payload_field(arguments, key) {
            object.insert(key.to_string(), value.clone());
        }
    }
    if let Some(server) = payload_field(arguments, "server") {
        object.insert(
            "server".to_string(),
            json!({
                "id": payload_string(server, "id"),
                "name": payload_string(server, "name"),
                "transport": payload_string(server, "transport"),
            }),
        );
    }
    Value::Object(object)
}

pub fn approval_blocks_automated_entry(
    entry_kind: &CapabilityEntryKind,
    level: ApprovalLevel,
) -> bool {
    match level {
        ApprovalLevel::None | ApprovalLevel::Light => false,
        ApprovalLevel::Explicit => matches!(
            entry_kind,
            CapabilityEntryKind::BackgroundTask | CapabilityEntryKind::Subagent
        ),
        ApprovalLevel::AlwaysHold => true,
    }
}

pub fn append_capability_audit_record(
    state: &State<'_, AppState>,
    record: CapabilityAuditRecord,
) -> Result<(), String> {
    with_store_mut(state, |store| {
        store.capability_audit_records.insert(0, record);
        if store.capability_audit_records.len() > 200 {
            store.capability_audit_records.truncate(200);
        }
        Ok(())
    })
}

pub fn build_audit_record(
    decision: &CapabilityGuardDecision,
    session_id: Option<&str>,
    outcome: &str,
    reason: &str,
) -> CapabilityAuditRecord {
    CapabilityAuditRecord {
        id: make_id("cap-audit"),
        actor: "runtime-agent".to_string(),
        runtime_mode: decision.capability_set.runtime_mode.clone(),
        entry_kind: decision.capability_set.entry_kind.clone(),
        session_id: session_id.map(ToString::to_string),
        tool_name: decision.descriptor.name.to_string(),
        tool_action: decision.tool_action.clone(),
        approval_level: decision.approval_level,
        outcome: outcome.to_string(),
        reason: reason.to_string(),
        capability_fingerprint: decision.capability_set.fingerprint.clone(),
        arguments_summary: decision.arguments_summary.clone(),
        created_at: now_i64(),
        created_at_iso: now_iso(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn background_runtime_blocks_profile_doc_and_skill_tools() {
        let store = crate::persistence::default_store();
        let set = resolve_capability_set_for_store(&store, "background-maintenance", None);
        assert!(set
            .allowed_tools
            .iter()
            .all(|item| item != "redbox_profile_doc"));
        assert!(set.allowed_tools.iter().all(|item| item != "redbox_skill"));
        assert_eq!(set.memory_write_policy, "system_only".to_string());
    }

    #[test]
    fn subagent_session_resolves_subagent_entry_kind_and_disables_memory_writes() {
        let mut store = crate::persistence::default_store();
        store.chat_sessions.push(crate::ChatSessionRecord {
            id: "session-sub".to_string(),
            title: "Child".to_string(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            metadata: Some(json!({
                "isSubagentSession": true,
                "allowedTools": ["redbox_fs", "redbox_runtime_control"]
            })),
        });

        let set = resolve_capability_set_for_store(&store, "chatroom", Some("session-sub"));
        assert_eq!(set.entry_kind, CapabilityEntryKind::Subagent);
        assert_eq!(set.memory_write_policy, "disabled".to_string());
        assert_eq!(
            set.allowed_tools,
            vec![
                "redbox_fs".to_string(),
                "redbox_runtime_control".to_string()
            ]
        );
    }
}
