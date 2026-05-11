use std::path::{Component, Path, PathBuf};

use dirs::home_dir;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::cli_runtime::{
    CliApproveEscalationRequest, CliDenyEscalationRequest, CliEnvironmentRecord,
    CliEscalationReason, CliEscalationRequestRecord, CliEscalationStatus, CliExecuteRequest,
    CliExecutionRecord, CliExecutionStatus, CliPermissionGrantSet, active_workspace_root,
    find_cli_execution_by_id, upsert_cli_execution_record,
};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::create_review_docket;
use crate::{AppState, AppStore, make_id, now_i64};

#[derive(Debug, Clone)]
pub struct CliPolicyCheckResult {
    pub allowed: bool,
    pub escalation: Option<CliEscalationRequestRecord>,
    pub approved_by_existing_grant: bool,
    pub permissions: CliPermissionGrantSet,
}

#[derive(Debug, Clone)]
pub struct CliEscalationResolution {
    pub escalation: CliEscalationRequestRecord,
    pub execution: Option<CliExecutionRecord>,
    pub changed: bool,
}

#[derive(Debug, Clone)]
struct CliPolicyFinding {
    command_preview: String,
    command_fingerprint: String,
    permissions: CliPermissionGrantSet,
    primary_reason: CliEscalationReason,
    permission_summary: Vec<String>,
    description: String,
    triggered_rules: Vec<String>,
    workspace_root: Option<String>,
}

fn escalation_metadata_object_mut(metadata: &mut Option<Value>) -> &mut Map<String, Value> {
    if !matches!(metadata, Some(Value::Object(_))) {
        *metadata = Some(Value::Object(Map::new()));
    }
    match metadata {
        Some(Value::Object(object)) => object,
        _ => unreachable!("metadata should always be an object"),
    }
}

fn metadata_string(metadata: Option<&Value>, key: &str) -> Option<String> {
    metadata
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn metadata_i64(metadata: Option<&Value>, key: &str) -> Option<i64> {
    metadata
        .and_then(|value| value.get(key))
        .and_then(Value::as_i64)
}

fn merge_execution_metadata(existing: Option<Value>, updates: Value) -> Option<Value> {
    let mut merged = Map::<String, Value>::new();
    if let Some(Value::Object(object)) = existing {
        for (key, value) in object {
            merged.insert(key, value);
        }
    }
    if let Value::Object(object) = updates {
        for (key, value) in object {
            merged.insert(key, value);
        }
    }
    if merged.is_empty() {
        None
    } else {
        Some(Value::Object(merged))
    }
}

fn upsert_escalation_record_in_store(
    store: &mut AppStore,
    record: CliEscalationRequestRecord,
) -> CliEscalationRequestRecord {
    if let Some(existing) = store
        .cli_escalations
        .iter_mut()
        .find(|item| item.id == record.id)
    {
        *existing = record.clone();
    } else {
        store.cli_escalations.push(record.clone());
    }
    store
        .cli_escalations
        .sort_by(|left, right| left.id.cmp(&right.id));
    record
}

pub fn upsert_cli_escalation_record(
    state: &State<'_, AppState>,
    record: CliEscalationRequestRecord,
) -> Result<CliEscalationRequestRecord, String> {
    with_store_mut(state, |store| {
        Ok(upsert_escalation_record_in_store(store, record.clone()))
    })
}

fn ensure_cli_escalation_review_docket(
    state: &State<'_, AppState>,
    escalation: &mut CliEscalationRequestRecord,
) -> Result<(), String> {
    let existing_id = metadata_string(escalation.metadata.as_ref(), "reviewDocketId");
    let docket = with_store_mut(state, |store| {
        if let Some(existing_id) = existing_id.as_deref() {
            if let Some(existing) = store
                .review_dockets
                .iter()
                .find(|docket| docket.id == existing_id)
                .cloned()
            {
                return Ok(existing);
            }
        }
        if let Some(existing) = store
            .review_dockets
            .iter()
            .find(|docket| {
                docket.source_kind == "cli_escalation"
                    && docket.source_id.as_deref() == Some(escalation.id.as_str())
            })
            .cloned()
        {
            return Ok(existing);
        }
        let metadata = escalation.metadata.as_ref();
        let command_preview = metadata_string(metadata, "commandPreview").unwrap_or_default();
        let description = metadata_string(metadata, "description")
            .unwrap_or_else(|| "CLI 执行需要额外权限后才能继续。".to_string());
        let permission_summary = metadata
            .and_then(|value| value.get("permissionSummary"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let body = [
            description.as_str(),
            if command_preview.trim().is_empty() {
                ""
            } else {
                "\n命令预览："
            },
            command_preview.as_str(),
        ]
        .join("\n")
        .trim()
        .to_string();
        create_review_docket(
            store,
            &json!({
                "sourceKind": "cli_escalation",
                "sourceId": escalation.id.as_str(),
                "title": "CLI 需要额外权限",
                "summary": description,
                "body": body,
                "decisionType": "approve_reject",
                "priority": "high",
                "riskLevel": "high",
                "proposedAction": {
                    "kind": "cli_escalation",
                    "escalationId": escalation.id.as_str(),
                    "executionId": escalation.execution_id.as_str(),
                    "defaultScope": "once",
                },
                "evidenceRefs": permission_summary,
                "options": [
                    { "id": "once", "label": "仅这一次", "description": "只为当前命令扩权" },
                    { "id": "session", "label": "当前会话", "description": "本次会话内复用授权" },
                    { "id": "always", "label": "始终允许", "description": "持久化同类授权策略" }
                ],
            }),
        )
    })?;
    let metadata = escalation_metadata_object_mut(&mut escalation.metadata);
    metadata.insert("reviewDocketId".to_string(), json!(docket.id));
    upsert_cli_escalation_record(state, escalation.clone())?;
    Ok(())
}

pub fn find_cli_escalation_by_id(
    state: &State<'_, AppState>,
    escalation_id: &str,
) -> Result<Option<CliEscalationRequestRecord>, String> {
    with_store(state, |store| {
        Ok(store
            .cli_escalations
            .iter()
            .find(|item| item.id == escalation_id)
            .cloned())
    })
}

pub fn find_cli_escalation_by_execution_id(
    state: &State<'_, AppState>,
    execution_id: &str,
) -> Result<Option<CliEscalationRequestRecord>, String> {
    with_store(state, |store| {
        Ok(store
            .cli_escalations
            .iter()
            .filter(|item| item.execution_id == execution_id)
            .max_by_key(|item| item.created_at)
            .cloned())
    })
}

fn session_id_for_request(request: &CliExecuteRequest) -> String {
    request
        .session_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "cli-runtime".to_string())
}

fn strip_privilege_wrapper(argv: &[String]) -> (&[String], bool) {
    let Some(first) = argv.first() else {
        return (argv, false);
    };
    let first = first.trim().to_ascii_lowercase();
    if matches!(first.as_str(), "sudo" | "doas") {
        return (&argv[1..], true);
    }
    if first == "su" {
        return (&argv[1..], true);
    }
    (argv, false)
}

fn command_name(argv: &[String]) -> String {
    argv.first()
        .map(|item| item.trim().to_ascii_lowercase())
        .unwrap_or_default()
}

fn has_flag(argv: &[String], flags: &[&str]) -> bool {
    argv.iter()
        .any(|item| flags.iter().any(|flag| item.trim() == *flag))
}

fn has_subcommand(argv: &[String], verbs: &[&str]) -> bool {
    argv.iter()
        .skip(1)
        .map(|item| item.trim().to_ascii_lowercase())
        .any(|item| verbs.iter().any(|verb| item == *verb))
}

fn is_url_like(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn detects_network_access(argv: &[String]) -> bool {
    let (argv, _) = strip_privilege_wrapper(argv);
    if argv.iter().any(|item| is_url_like(item)) {
        return true;
    }
    let command = command_name(argv);
    match command.as_str() {
        "curl" | "wget" | "gh" => true,
        "git" => has_subcommand(argv, &["clone", "fetch", "pull", "push", "ls-remote"]),
        "npm" => has_subcommand(
            argv,
            &["install", "add", "update", "publish", "view", "search"],
        ),
        "pnpm" => has_subcommand(
            argv,
            &["install", "add", "update", "publish", "view", "dlx"],
        ),
        "yarn" => has_subcommand(argv, &["install", "add", "up", "upgrade", "dlx"]),
        "pip" | "pip3" => has_subcommand(argv, &["install", "download"]),
        "uv" => {
            has_subcommand(argv, &["add", "sync"])
                || argv.windows(2).any(|window| {
                    window[0].trim().eq_ignore_ascii_case("tool")
                        && window[1].trim().eq_ignore_ascii_case("install")
                })
                || argv.windows(2).any(|window| {
                    window[0].trim().eq_ignore_ascii_case("pip")
                        && window[1].trim().eq_ignore_ascii_case("install")
                })
        }
        "cargo" => has_subcommand(argv, &["install", "search", "publish", "update"]),
        "go" => {
            has_subcommand(argv, &["get", "install"])
                || argv.windows(2).any(|window| {
                    window[0].trim().eq_ignore_ascii_case("mod")
                        && window[1].trim().eq_ignore_ascii_case("download")
                })
        }
        _ => false,
    }
}

fn has_flag_with_value(argv: &[String], flags: &[&str]) -> bool {
    argv.windows(2).any(|window| {
        flags.iter().any(|flag| window[0].trim() == *flag) && !window[1].trim().is_empty()
    })
}

fn has_local_install_target(request: &CliExecuteRequest) -> bool {
    has_flag_with_value(&request.argv, &["--root", "--prefix", "--dir"])
        || request
            .env
            .get("GOBIN")
            .is_some_and(|value| !value.trim().is_empty())
        || request
            .env
            .get("UV_TOOL_DIR")
            .is_some_and(|value| !value.trim().is_empty())
        || request
            .env
            .get("UV_TOOL_BIN_DIR")
            .is_some_and(|value| !value.trim().is_empty())
}

fn detects_global_install(request: &CliExecuteRequest) -> bool {
    let (argv, _) = strip_privilege_wrapper(&request.argv);
    let local_install_target = has_local_install_target(request);
    let command = command_name(argv);
    match command.as_str() {
        "npm" | "pnpm" => {
            has_subcommand(argv, &["install", "add", "update", "remove", "uninstall"])
                && has_flag(argv, &["-g", "--global"])
        }
        "yarn" => {
            argv.get(1)
                .is_some_and(|item| item.trim().eq_ignore_ascii_case("global"))
                && has_subcommand(argv, &["add", "remove", "upgrade"])
        }
        "cargo" => {
            !local_install_target
                && argv
                    .get(1)
                    .is_some_and(|item| item.trim().eq_ignore_ascii_case("install"))
        }
        "go" => {
            !local_install_target
                && argv
                    .get(1)
                    .is_some_and(|item| item.trim().eq_ignore_ascii_case("install"))
        }
        "uv" => {
            !local_install_target
                && argv.windows(2).any(|window| {
                    window[0].trim().eq_ignore_ascii_case("tool")
                        && window[1].trim().eq_ignore_ascii_case("install")
                })
        }
        _ => false,
    }
}

fn expand_home_path(value: &str) -> Option<PathBuf> {
    let trimmed = value.trim();
    if trimmed == "~" {
        return home_dir();
    }
    trimmed
        .strip_prefix("~/")
        .and_then(|suffix| home_dir().map(|home| home.join(suffix)))
}

fn normalize_path_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component.as_os_str());
                }
            }
            Component::Normal(value) => normalized.push(value),
        }
    }
    normalized
}

fn resolve_path_candidate(cwd: &Path, value: &str) -> Option<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') || is_url_like(trimmed) {
        return None;
    }
    let candidate = if let Some(path) = expand_home_path(trimmed) {
        path
    } else {
        let path = PathBuf::from(trimmed);
        if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        }
    };
    Some(normalize_path_lexically(&candidate))
}

fn path_within_root(path: &Path, root: &Path) -> bool {
    let normalized_path = normalize_path_lexically(path);
    let normalized_root = normalize_path_lexically(root);
    normalized_path.starts_with(&normalized_root)
}

fn collect_mutating_paths(argv: &[String]) -> Vec<String> {
    let (argv, _) = strip_privilege_wrapper(argv);
    let command = command_name(argv);
    let non_flag_args = || {
        argv.iter()
            .skip(1)
            .filter(|item| !item.trim().starts_with('-'))
            .cloned()
            .collect::<Vec<_>>()
    };
    match command.as_str() {
        "touch" | "mkdir" | "mktemp" | "rm" | "rmdir" | "chmod" | "chown" | "truncate" | "tee" => {
            non_flag_args()
        }
        "cp" | "mv" | "install" | "ln" => non_flag_args().into_iter().rev().take(1).collect(),
        "git" => {
            if argv
                .get(1)
                .is_some_and(|item| item.trim().eq_ignore_ascii_case("clone"))
            {
                non_flag_args()
                    .into_iter()
                    .rev()
                    .find(|item| !is_url_like(item))
                    .into_iter()
                    .collect()
            } else {
                Vec::new()
            }
        }
        "sed" => {
            if has_flag(argv, &["-i", "--in-place"]) {
                non_flag_args().into_iter().rev().take(1).collect()
            } else {
                Vec::new()
            }
        }
        _ => Vec::new(),
    }
}

fn outside_workspace_write_targets(
    cwd: &Path,
    workspace_root: Option<&Path>,
    argv: &[String],
) -> Vec<String> {
    let Some(workspace_root) = workspace_root else {
        return Vec::new();
    };
    collect_mutating_paths(argv)
        .into_iter()
        .filter_map(|item| resolve_path_candidate(cwd, &item))
        .filter(|path| !path_within_root(path, workspace_root))
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

fn primary_reason_for_permissions(permissions: &CliPermissionGrantSet) -> CliEscalationReason {
    if permissions.elevated_privilege {
        CliEscalationReason::ElevatedPrivilege
    } else if permissions.global_install {
        CliEscalationReason::GlobalInstall
    } else if permissions.write_outside_workspace {
        CliEscalationReason::PathOutsideWorkspace
    } else if permissions.network {
        CliEscalationReason::NetworkAccess
    } else if permissions.sensitive_paths {
        CliEscalationReason::SensitivePath
    } else {
        CliEscalationReason::DangerousCommand
    }
}

fn policy_summary_for_permissions(permissions: &CliPermissionGrantSet) -> Vec<String> {
    let mut summary = Vec::new();
    if permissions.elevated_privilege {
        summary.push("请求提升权限（sudo/doas）".to_string());
    }
    if permissions.global_install {
        summary.push("将执行全局安装".to_string());
    }
    if permissions.network {
        summary.push("需要网络访问".to_string());
    }
    if permissions.write_outside_workspace {
        if permissions.paths.is_empty() {
            summary.push("将写入工作区外路径".to_string());
        } else {
            summary.push(format!(
                "将写入工作区外路径: {}",
                permissions.paths.join(", ")
            ));
        }
    }
    if permissions.sensitive_paths {
        summary.push("将访问敏感路径".to_string());
    }
    summary
}

fn approval_scope(scope: &str) -> Result<String, String> {
    let normalized = scope.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "once" | "session" | "always" => Ok(normalized),
        _ => Err("scope must be one of once, session, always".to_string()),
    }
}

fn command_fingerprint(argv: &[String], cwd: &Path, permissions: &CliPermissionGrantSet) -> String {
    let mut hasher = Sha256::new();
    hasher.update(argv.join("\u{1f}").as_bytes());
    hasher.update(cwd.to_string_lossy().as_bytes());
    hasher.update(if permissions.network { b"1" } else { b"0" });
    hasher.update(if permissions.write_outside_workspace {
        b"1"
    } else {
        b"0"
    });
    hasher.update(if permissions.global_install {
        b"1"
    } else {
        b"0"
    });
    hasher.update(if permissions.elevated_privilege {
        b"1"
    } else {
        b"0"
    });
    for path in &permissions.paths {
        hasher.update(path.as_bytes());
    }
    format!("{:x}", hasher.finalize())
        .chars()
        .take(16)
        .collect()
}

fn active_policy_workspace_root(
    state: &State<'_, AppState>,
    environment: &CliEnvironmentRecord,
) -> Option<PathBuf> {
    environment
        .workspace_root
        .as_deref()
        .map(PathBuf::from)
        .or_else(|| active_workspace_root(state).ok())
}

fn build_policy_finding(
    request: &CliExecuteRequest,
    workspace_root: Option<&Path>,
    cwd: &Path,
) -> Option<CliPolicyFinding> {
    let (_, elevated) = strip_privilege_wrapper(&request.argv);
    let outside_paths = outside_workspace_write_targets(cwd, workspace_root, &request.argv);

    let permissions = CliPermissionGrantSet {
        network: detects_network_access(&request.argv),
        write_outside_workspace: !outside_paths.is_empty(),
        sensitive_paths: false,
        global_install: detects_global_install(request),
        elevated_privilege: elevated,
        paths: outside_paths,
    };

    if !permissions.network
        && !permissions.write_outside_workspace
        && !permissions.global_install
        && !permissions.elevated_privilege
        && !permissions.sensitive_paths
    {
        return None;
    }

    let command_preview = request.argv.join(" ");
    let permission_summary = policy_summary_for_permissions(&permissions);
    let triggered_rules = permission_summary
        .iter()
        .map(|item| match item.as_str() {
            "请求提升权限（sudo/doas）" => "elevated-privilege".to_string(),
            "将执行全局安装" => "global-install".to_string(),
            "需要网络访问" => "network-access".to_string(),
            other if other.starts_with("将写入工作区外路径") => {
                "outside-workspace-write".to_string()
            }
            _ => "policy-check".to_string(),
        })
        .collect::<Vec<_>>();
    let command_fingerprint = command_fingerprint(&request.argv, cwd, &permissions);
    Some(CliPolicyFinding {
        description: permission_summary.join("；"),
        primary_reason: primary_reason_for_permissions(&permissions),
        command_preview,
        command_fingerprint,
        permission_summary,
        triggered_rules,
        workspace_root: workspace_root.map(|path| path.to_string_lossy().to_string()),
        permissions,
    })
}

fn approved_scope_for_record(record: &CliEscalationRequestRecord) -> Option<String> {
    metadata_string(record.metadata.as_ref(), "approvedScope")
}

fn escalation_matches_fingerprint(
    record: &CliEscalationRequestRecord,
    session_id: &str,
    fingerprint: &str,
) -> bool {
    if record.status != CliEscalationStatus::Approved {
        return false;
    }
    if metadata_string(record.metadata.as_ref(), "commandFingerprint").as_deref()
        != Some(fingerprint)
    {
        return false;
    }
    match approved_scope_for_record(record).as_deref() {
        Some("always") => true,
        Some("session") => record.session_id == session_id,
        Some("once") => {
            record.session_id == session_id
                && metadata_i64(record.metadata.as_ref(), "consumedAt").is_none()
        }
        _ => false,
    }
}

fn find_matching_approved_escalation(
    state: &State<'_, AppState>,
    session_id: &str,
    fingerprint: &str,
) -> Result<Option<CliEscalationRequestRecord>, String> {
    with_store(state, |store| {
        Ok(store
            .cli_escalations
            .iter()
            .filter(|item| escalation_matches_fingerprint(item, session_id, fingerprint))
            .max_by_key(|item| item.resolved_at.unwrap_or(item.created_at))
            .cloned())
    })
}

fn consume_approved_escalation(
    state: &State<'_, AppState>,
    escalation: CliEscalationRequestRecord,
    execution_id: &str,
) -> Result<CliEscalationRequestRecord, String> {
    if approved_scope_for_record(&escalation).as_deref() != Some("once") {
        return Ok(escalation);
    }
    let mut updated = escalation.clone();
    let metadata = escalation_metadata_object_mut(&mut updated.metadata);
    metadata.insert("consumedAt".to_string(), json!(now_i64()));
    metadata.insert(
        "consumedByExecutionId".to_string(),
        json!(execution_id.to_string()),
    );
    upsert_cli_escalation_record(state, updated)
}

pub fn authorize_cli_execution(
    state: &State<'_, AppState>,
    execution_id: &str,
    request: &CliExecuteRequest,
    environment: &CliEnvironmentRecord,
    cwd: &Path,
) -> Result<CliPolicyCheckResult, String> {
    let workspace_root = active_policy_workspace_root(state, environment);
    let Some(finding) = build_policy_finding(request, workspace_root.as_deref(), cwd) else {
        return Ok(CliPolicyCheckResult {
            allowed: true,
            escalation: None,
            approved_by_existing_grant: false,
            permissions: CliPermissionGrantSet::default(),
        });
    };
    let permissions = finding.permissions.clone();

    let session_id = session_id_for_request(request);
    if let Some(existing) =
        find_matching_approved_escalation(state, &session_id, &finding.command_fingerprint)?
    {
        let consumed = consume_approved_escalation(state, existing, execution_id)?;
        return Ok(CliPolicyCheckResult {
            allowed: true,
            escalation: Some(consumed),
            approved_by_existing_grant: true,
            permissions,
        });
    }

    let escalation = CliEscalationRequestRecord {
        id: make_id("cli-escalation"),
        execution_id: execution_id.to_string(),
        session_id,
        task_id: request.task_id.clone(),
        reason: finding.primary_reason,
        requested_permissions: finding.permissions,
        status: CliEscalationStatus::Pending,
        created_at: now_i64(),
        resolved_at: None,
        metadata: Some(json!({
            "commandPreview": finding.command_preview,
            "commandFingerprint": finding.command_fingerprint,
            "description": finding.description,
            "permissionSummary": finding.permission_summary,
            "scopeOptions": ["once", "session", "always"],
            "triggeredRules": finding.triggered_rules,
            "workspaceRoot": finding.workspace_root,
            "toolId": request.tool_id,
        })),
    };
    let mut escalation = upsert_cli_escalation_record(state, escalation)?;
    ensure_cli_escalation_review_docket(state, &mut escalation)?;
    Ok(CliPolicyCheckResult {
        allowed: false,
        escalation: Some(escalation),
        approved_by_existing_grant: false,
        permissions,
    })
}

pub fn collect_cli_requested_permissions(
    state: &State<'_, AppState>,
    request: &CliExecuteRequest,
    environment: &CliEnvironmentRecord,
    cwd: &Path,
) -> CliPermissionGrantSet {
    let workspace_root = active_policy_workspace_root(state, environment);
    build_policy_finding(request, workspace_root.as_deref(), cwd)
        .map(|finding| finding.permissions)
        .unwrap_or_default()
}

fn update_execution_for_resolution(
    state: &State<'_, AppState>,
    escalation: &CliEscalationRequestRecord,
    approved: bool,
    resolution_scope: Option<&str>,
    resolution_note: Option<&str>,
) -> Result<Option<CliExecutionRecord>, String> {
    let Some(mut execution) = find_cli_execution_by_id(state, &escalation.execution_id)? else {
        return Ok(None);
    };
    if approved {
        if execution.status == CliExecutionStatus::AwaitingEscalation {
            execution.status = CliExecutionStatus::Pending;
        }
    } else {
        execution.status = CliExecutionStatus::Cancelled;
        execution.finished_at = Some(now_i64());
    }
    execution.metadata = merge_execution_metadata(
        execution.metadata.clone(),
        json!({
            "escalationId": escalation.id,
            "escalationStatus": escalation.status,
            "escalationScope": resolution_scope,
            "escalationNote": resolution_note,
            "escalationResolvedAt": escalation.resolved_at,
        }),
    );
    upsert_cli_execution_record(state, execution).map(Some)
}

fn resolve_cli_escalation_inner(
    state: &State<'_, AppState>,
    escalation_id: &str,
    approved: bool,
    resolution_scope: Option<&str>,
    resolution_note: Option<&str>,
) -> Result<CliEscalationResolution, String> {
    let Some(existing) = find_cli_escalation_by_id(state, escalation_id)? else {
        return Err(format!("cli escalation not found: {escalation_id}"));
    };
    if existing.status != CliEscalationStatus::Pending {
        let execution = find_cli_execution_by_id(state, &existing.execution_id)?;
        return Ok(CliEscalationResolution {
            escalation: existing,
            execution,
            changed: false,
        });
    }

    let mut escalation = existing.clone();
    escalation.status = if approved {
        CliEscalationStatus::Approved
    } else {
        CliEscalationStatus::Denied
    };
    escalation.resolved_at = Some(now_i64());
    let metadata = escalation_metadata_object_mut(&mut escalation.metadata);
    if let Some(scope) = resolution_scope {
        metadata.insert("approvedScope".to_string(), json!(scope));
    }
    if let Some(note) = resolution_note.filter(|value| !value.trim().is_empty()) {
        metadata.insert("resolutionNote".to_string(), json!(note));
    }
    let escalation = upsert_cli_escalation_record(state, escalation)?;
    let execution = update_execution_for_resolution(
        state,
        &escalation,
        approved,
        resolution_scope,
        resolution_note,
    )?;
    Ok(CliEscalationResolution {
        escalation,
        execution,
        changed: true,
    })
}

pub fn approve_cli_escalation(
    state: &State<'_, AppState>,
    request: &CliApproveEscalationRequest,
) -> Result<CliEscalationResolution, String> {
    let scope = approval_scope(&request.scope)?;
    resolve_cli_escalation_inner(
        state,
        &request.escalation_id,
        true,
        Some(&scope),
        Some("cli escalation approved; rerun execute to continue"),
    )
}

pub fn deny_cli_escalation(
    state: &State<'_, AppState>,
    request: &CliDenyEscalationRequest,
) -> Result<CliEscalationResolution, String> {
    resolve_cli_escalation_inner(
        state,
        &request.escalation_id,
        false,
        None,
        request
            .reason
            .as_deref()
            .or(Some("cli escalation denied by user")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_request(argv: &[&str]) -> CliExecuteRequest {
        CliExecuteRequest {
            argv: argv.iter().map(|item| item.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn build_policy_finding_flags_network_global_install_and_sudo() {
        let request = build_request(&["sudo", "npm", "install", "-g", "wrangler"]);
        let cwd = Path::new("/tmp/redbox-env");
        let finding = build_policy_finding(&request, Some(Path::new("/tmp/redbox-env")), cwd)
            .expect("policy finding should exist");
        assert!(finding.permissions.elevated_privilege);
        assert!(finding.permissions.global_install);
        assert!(finding.permissions.network);
        assert_eq!(
            finding.primary_reason,
            CliEscalationReason::ElevatedPrivilege
        );
    }

    #[test]
    fn outside_workspace_write_targets_collects_paths_outside_root() {
        let paths = outside_workspace_write_targets(
            Path::new("/tmp/workspace/project"),
            Some(Path::new("/tmp/workspace")),
            &["touch".to_string(), "../../outside.txt".to_string()],
        );
        assert_eq!(paths, vec!["/tmp/outside.txt".to_string()]);
    }

    #[test]
    fn detects_global_install_skips_localized_tool_installs() {
        let request = CliExecuteRequest {
            argv: vec![
                "cargo".to_string(),
                "install".to_string(),
                "--root".to_string(),
                "/tmp/redbox-cli".to_string(),
                "wrangler".to_string(),
            ],
            ..Default::default()
        };
        assert!(!detects_global_install(&request));

        let request = CliExecuteRequest {
            argv: vec![
                "uv".to_string(),
                "tool".to_string(),
                "install".to_string(),
                "ruff".to_string(),
            ],
            env: std::collections::BTreeMap::from([(
                "UV_TOOL_DIR".to_string(),
                "/tmp/redbox-cli/uv-tools".to_string(),
            )]),
            ..Default::default()
        };
        assert!(!detects_global_install(&request));
    }

    #[test]
    fn escalation_matches_fingerprint_respects_scope_and_consumption() {
        let record = CliEscalationRequestRecord {
            id: "cli-escalation-1".to_string(),
            execution_id: "cli-exec-1".to_string(),
            session_id: "session-1".to_string(),
            status: CliEscalationStatus::Approved,
            metadata: Some(json!({
                "commandFingerprint": "abcd1234",
                "approvedScope": "once",
            })),
            ..Default::default()
        };
        assert!(escalation_matches_fingerprint(
            &record,
            "session-1",
            "abcd1234"
        ));

        let consumed = CliEscalationRequestRecord {
            metadata: Some(json!({
                "commandFingerprint": "abcd1234",
                "approvedScope": "once",
                "consumedAt": 123,
            })),
            ..record
        };
        assert!(!escalation_matches_fingerprint(
            &consumed,
            "session-1",
            "abcd1234"
        ));
    }
}
