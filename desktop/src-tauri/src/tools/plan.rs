use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::hash::{DefaultHasher, Hash, Hasher};

use crate::mcp::tool_exposure::build_mcp_tool_exposure;
use crate::mcp::{McpToolInfo, McpToolInventorySnapshot};
use crate::runtime::RedboxTurnContext;
use crate::skills::build_skill_runtime_state;
use crate::tools::catalog::{
    action_descriptors_for_tool, descriptor_by_name, ActionDescriptor, ActionVisibility,
    ToolDescriptor,
};
use crate::tools::compat::canonical_tool_name;
use crate::tools::families;
use crate::tools::packs::{tool_names_for_runtime_mode, visible_tool_names_for_runtime_mode};
use crate::tools::registry::normalized_allowed_app_cli_actions;
use crate::{AppStore, ChatSessionRecord};

pub const DEFAULT_MAX_DIRECT_APP_CLI_ACTIONS: usize = 48;

#[derive(Debug, Clone, Default)]
pub struct ToolRegistryPlanParams<'a> {
    pub runtime_mode: &'a str,
    pub session_id: Option<&'a str>,
    pub session_metadata: Option<&'a Value>,
    pub active_skills: &'a [String],
    pub allowed_tool_names: Option<&'a [String]>,
    pub task_intent: Option<&'a str>,
    pub max_direct_app_cli_actions: Option<usize>,
    pub mcp_inventory: Option<&'a McpToolInventorySnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeferredActionEntry {
    pub action: String,
    pub namespace: String,
    pub description: String,
    pub mutating: bool,
    pub concurrency_safe: bool,
    pub runtime_modes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ToolRegistryPlan {
    pub runtime_mode: String,
    pub internal_tool_names: Vec<String>,
    pub visible_tools: Vec<ToolDescriptor>,
    pub direct_app_cli_actions: Vec<ActionDescriptor>,
    pub deferred_app_cli_actions: Vec<DeferredActionEntry>,
    pub deferred_action_namespaces: Vec<String>,
    pub direct_mcp_tools: Vec<McpToolInfo>,
    pub deferred_mcp_tools: Vec<McpToolInfo>,
    pub mcp_tool_namespaces: Vec<String>,
    pub allowed_write_targets: Vec<String>,
    pub mcp_inventory_fingerprint: Option<String>,
    pub mcp_exposure_mode: String,
    pub fingerprint: String,
}

impl ToolRegistryPlan {
    pub fn has_direct_app_cli_action(&self, action: &str) -> bool {
        self.direct_app_cli_actions
            .iter()
            .any(|descriptor| descriptor.action == action)
    }

    #[allow(dead_code)]
    pub fn has_deferred_app_cli_action(&self, action: &str) -> bool {
        self.deferred_app_cli_actions
            .iter()
            .any(|descriptor| descriptor.action == action)
    }

    pub fn direct_mcp_tool(&self, name: &str) -> Option<&McpToolInfo> {
        self.direct_mcp_tools
            .iter()
            .find(|tool| tool.callable_name == name)
    }

    pub fn deferred_mcp_tool(&self, name: &str) -> Option<&McpToolInfo> {
        self.deferred_mcp_tools
            .iter()
            .find(|tool| tool.callable_name == name)
    }
}

pub fn build_tool_registry_plan_for_session(
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> ToolRegistryPlan {
    let raw_metadata = session_metadata(store, session_id);
    let effective_metadata = effective_member_runtime_metadata(store, raw_metadata);
    let metadata = effective_metadata.as_ref().or(raw_metadata);
    let internal_tool_names = base_tool_names_for_metadata(runtime_mode, metadata);
    let skill_state =
        build_skill_runtime_state(&store.skills, runtime_mode, metadata, &internal_tool_names);
    let active_skills = skill_state
        .active_skills
        .iter()
        .map(|skill| skill.name.clone())
        .collect::<Vec<_>>();
    let apply_member_tool_policy = should_apply_member_tool_policy(store, metadata);
    let allowed_tool_names = if apply_member_tool_policy {
        &skill_state.allowed_tools
    } else {
        &internal_tool_names
    };
    build_tool_registry_plan(ToolRegistryPlanParams {
        runtime_mode,
        session_id,
        session_metadata: metadata,
        active_skills: &active_skills,
        allowed_tool_names: Some(allowed_tool_names),
        task_intent: metadata
            .and_then(|item| item.get("taskIntent"))
            .and_then(Value::as_str),
        max_direct_app_cli_actions: None,
        mcp_inventory: None,
    })
}

pub fn build_tool_registry_plan_for_session_with_mcp(
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
    mcp_inventory: Option<&McpToolInventorySnapshot>,
) -> ToolRegistryPlan {
    let raw_metadata = session_metadata(store, session_id);
    let effective_metadata = effective_member_runtime_metadata(store, raw_metadata);
    let metadata = effective_metadata.as_ref().or(raw_metadata);
    let internal_tool_names = base_tool_names_for_metadata(runtime_mode, metadata);
    let skill_state =
        build_skill_runtime_state(&store.skills, runtime_mode, metadata, &internal_tool_names);
    let active_skills = skill_state
        .active_skills
        .iter()
        .map(|skill| skill.name.clone())
        .collect::<Vec<_>>();
    let apply_member_tool_policy = should_apply_member_tool_policy(store, metadata);
    let allowed_tool_names = if apply_member_tool_policy {
        &skill_state.allowed_tools
    } else {
        &internal_tool_names
    };
    build_tool_registry_plan(ToolRegistryPlanParams {
        runtime_mode,
        session_id,
        session_metadata: metadata,
        active_skills: &active_skills,
        allowed_tool_names: Some(allowed_tool_names),
        task_intent: metadata
            .and_then(|item| item.get("taskIntent"))
            .and_then(Value::as_str),
        max_direct_app_cli_actions: None,
        mcp_inventory,
    })
}

fn effective_member_runtime_metadata<'a>(
    store: &AppStore,
    metadata: Option<&'a Value>,
) -> Option<Value> {
    let metadata = metadata?;
    let has_member_skill = metadata
        .get("memberSkillRef")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    if !has_member_skill
        || crate::member_skill::member_feature_flag_enabled_for_store(
            store,
            "memberRuntimeOverlay",
            true,
        )
    {
        return None;
    }
    let mut object = metadata.as_object()?.clone();
    crate::member_skill::detach_member_skill_metadata(&mut object);
    Some(Value::Object(object))
}

fn should_apply_member_tool_policy(store: &AppStore, metadata: Option<&Value>) -> bool {
    let has_member_skill = metadata
        .and_then(|value| value.get("memberSkillRef"))
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    if !has_member_skill {
        return true;
    }
    crate::member_skill::member_feature_flag_enabled_for_store(store, "memberToolPolicy", true)
}

#[allow(dead_code)]
pub fn build_tool_registry_plan_for_turn_context(context: &RedboxTurnContext) -> ToolRegistryPlan {
    build_tool_registry_plan(ToolRegistryPlanParams {
        runtime_mode: &context.runtime_mode,
        session_id: context.session_id.as_deref(),
        session_metadata: context.session_metadata.as_ref(),
        active_skills: &context.active_skills,
        allowed_tool_names: Some(&context.allowed_tool_names),
        task_intent: context.task_intent.as_deref(),
        max_direct_app_cli_actions: None,
        mcp_inventory: None,
    })
}

pub fn build_tool_registry_plan(params: ToolRegistryPlanParams<'_>) -> ToolRegistryPlan {
    let runtime_mode = normalize_runtime_mode(params.runtime_mode).to_string();
    let internal_tool_names = params
        .allowed_tool_names
        .map(|items| items.to_vec())
        .unwrap_or_else(|| base_tool_names_for_metadata(&runtime_mode, params.session_metadata));
    let visible_tool_names =
        visible_tool_names_for_internal_tools(&runtime_mode, &internal_tool_names);
    let artifact_authoring_manuscript =
        metadata_is_artifact_authoring_manuscript(params.session_metadata);
    let mut visible_tools = visible_tool_names
        .iter()
        .filter_map(|name| descriptor_by_name(name))
        .collect::<Vec<_>>();
    if artifact_authoring_manuscript {
        visible_tools.retain(|tool| !matches!(tool.name, "Search" | "shell" | "tool_search"));
    }
    let mut app_cli_descriptors = if internal_tool_names.iter().any(|name| name == "workflow") {
        action_descriptors_for_tool("workflow", Some(&runtime_mode), ActionVisibility::Model)
    } else {
        Vec::new()
    };
    if metadata_string(params.session_metadata, "teamEscalation").as_deref() == Some("disabled") {
        app_cli_descriptors.retain(|descriptor| !is_team_escalation_action(descriptor.action));
    }
    let direct_app_cli_actions = select_direct_app_cli_actions(
        &runtime_mode,
        params.session_metadata,
        params.task_intent,
        params
            .max_direct_app_cli_actions
            .or_else(|| max_direct_actions_from_metadata(params.session_metadata))
            .unwrap_or(DEFAULT_MAX_DIRECT_APP_CLI_ACTIONS),
        &app_cli_descriptors,
    );
    let direct_action_names = direct_app_cli_actions
        .iter()
        .map(|descriptor| descriptor.action)
        .collect::<BTreeSet<_>>();
    let has_explicit_action_allowlist =
        !normalized_allowed_app_cli_actions(params.session_metadata).is_empty();
    let deferred_app_cli_actions = if has_explicit_action_allowlist {
        Vec::new()
    } else {
        app_cli_descriptors
            .iter()
            .filter(|descriptor| !direct_action_names.contains(descriptor.action))
            .map(deferred_action_entry)
            .collect::<Vec<_>>()
    };
    let deferred_action_namespaces = deferred_app_cli_actions
        .iter()
        .map(|entry| entry.namespace.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let mcp_exposure = build_mcp_tool_exposure(params.mcp_inventory, params.session_metadata);
    let can_discover_deferred_app_actions = !deferred_app_cli_actions.is_empty()
        && visible_tools.iter().any(|tool| tool.name == "Operate");
    let deferred_discovery_enabled =
        metadata_bool(params.session_metadata, "deferredDiscovery").unwrap_or(true);
    if deferred_discovery_enabled
        && (can_discover_deferred_app_actions || !mcp_exposure.deferred_tools.is_empty())
        && !visible_tools.iter().any(|tool| tool.name == "tool_search")
    {
        if let Some(tool) = descriptor_by_name("tool_search") {
            visible_tools.push(tool);
        }
    }
    let fingerprint = plan_fingerprint(
        &runtime_mode,
        params.session_id,
        params.session_metadata,
        params.active_skills,
        params.task_intent,
        &internal_tool_names,
        &direct_app_cli_actions,
        &deferred_action_namespaces,
        params
            .mcp_inventory
            .map(|snapshot| snapshot.fingerprint.as_str()),
        &mcp_exposure
            .direct_tools
            .iter()
            .map(|tool| tool.callable_name.clone())
            .collect::<Vec<_>>(),
        &mcp_exposure
            .deferred_tools
            .iter()
            .map(|tool| tool.callable_name.clone())
            .collect::<Vec<_>>(),
    );
    ToolRegistryPlan {
        runtime_mode,
        internal_tool_names,
        visible_tools,
        direct_app_cli_actions,
        deferred_app_cli_actions,
        deferred_action_namespaces,
        direct_mcp_tools: mcp_exposure.direct_tools,
        deferred_mcp_tools: mcp_exposure.deferred_tools,
        mcp_tool_namespaces: mcp_exposure.namespaces,
        allowed_write_targets: metadata_string_list(params.session_metadata, "allowedWriteTargets"),
        mcp_inventory_fingerprint: params
            .mcp_inventory
            .map(|snapshot| snapshot.fingerprint.clone()),
        mcp_exposure_mode: mcp_exposure.mode,
        fingerprint,
    }
}

pub fn base_tool_names_for_metadata(runtime_mode: &str, metadata: Option<&Value>) -> Vec<String> {
    let base = tool_names_for_runtime_mode(runtime_mode)
        .iter()
        .map(|item| item.to_string())
        .collect::<Vec<_>>();
    let requested = metadata_string_list(metadata, "allowedTools")
        .into_iter()
        .map(|item| canonical_tool_name(&item).to_string())
        .fold(Vec::<String>::new(), |mut acc, item| {
            if !acc.iter().any(|existing| existing == &item) {
                acc.push(item);
            }
            acc
        });
    if requested.is_empty() {
        return base;
    }
    let filtered = requested
        .into_iter()
        .filter(|item| base.iter().any(|allowed| allowed == item))
        .collect::<Vec<_>>();
    if filtered.is_empty() {
        base
    } else {
        filtered
    }
}

pub fn visible_tool_names_for_internal_tools(
    runtime_mode: &str,
    internal_tool_names: &[String],
) -> Vec<String> {
    let visible_base = visible_tool_names_for_runtime_mode(runtime_mode);
    let mut names = Vec::new();
    for name in visible_base {
        let required_internal = match *name {
            "Read" | "List" | "Search" => "resource",
            "Write" | "Operate" => {
                if internal_tool_names
                    .iter()
                    .any(|item| item == "workflow" || item == "editor")
                {
                    ""
                } else {
                    continue;
                }
            }
            other => other,
        };
        if required_internal.is_empty()
            || internal_tool_names
                .iter()
                .any(|item| item == required_internal || item == *name)
        {
            names.push((*name).to_string());
        }
    }
    names
}

fn select_direct_app_cli_actions(
    runtime_mode: &str,
    metadata: Option<&Value>,
    task_intent: Option<&str>,
    max_direct_actions: usize,
    descriptors: &[ActionDescriptor],
) -> Vec<ActionDescriptor> {
    if descriptors.is_empty() || max_direct_actions == 0 {
        return Vec::new();
    }
    let mut allowed_actions = normalized_allowed_app_cli_actions(metadata);
    if !allowed_actions.is_empty()
        && metadata_is_artifact_authoring_manuscript(metadata)
        && !allowed_actions
            .iter()
            .any(|item| item == "team.guide.create")
    {
        allowed_actions.insert(0, "team.guide.create".to_string());
    }
    if !allowed_actions.is_empty() {
        return descriptors
            .iter()
            .copied()
            .filter(|descriptor| allowed_actions.iter().any(|item| item == descriptor.action))
            .collect();
    }
    let preferred_namespaces = preferred_app_cli_namespaces(runtime_mode, task_intent);
    let explicit_direct_namespaces =
        direct_namespaces_from_metadata(metadata).filter(|items| !items.is_empty());
    let uses_explicit_direct_namespaces = explicit_direct_namespaces.is_some();
    let preferred_namespaces = explicit_direct_namespaces.unwrap_or(preferred_namespaces);
    let pinned_actions = pinned_direct_app_cli_actions(runtime_mode, task_intent);
    let max_direct_actions = if uses_explicit_direct_namespaces {
        max_direct_actions
    } else {
        max_direct_actions
            .max(DEFAULT_SAFE_DIRECT_APP_CLI_ACTIONS.len() + pinned_actions.len())
            .max(if pinned_actions.is_empty() { 0 } else { 26 })
    };
    let mut selected = Vec::<ActionDescriptor>::new();
    if !uses_explicit_direct_namespaces {
        for action in intent_priority_app_cli_actions(task_intent) {
            if !push_direct_app_cli_action(&mut selected, descriptors, action, max_direct_actions) {
                return selected;
            }
        }
        for action in DEFAULT_SAFE_DIRECT_APP_CLI_ACTIONS {
            if !push_direct_app_cli_action(&mut selected, descriptors, action, max_direct_actions) {
                return selected;
            }
        }
    }
    if has_active_skill(metadata, "video-director") {
        for action in [
            "assets.get",
            "assets.search",
            "voice.speech",
            "image.generate",
            "video.generate",
        ] {
            if !push_direct_app_cli_action(&mut selected, descriptors, action, max_direct_actions) {
                return selected;
            }
        }
    }
    for action in pinned_actions {
        if !push_direct_app_cli_action(&mut selected, descriptors, action, max_direct_actions) {
            return selected;
        }
    }
    if has_explicit_asset_refs(metadata) {
        for action in ["assets.get", "assets.search"] {
            if !push_direct_app_cli_action(&mut selected, descriptors, action, max_direct_actions) {
                return selected;
            }
        }
    }
    for namespace in preferred_namespaces {
        for descriptor in descriptors
            .iter()
            .copied()
            .filter(|descriptor| descriptor.namespace == namespace)
        {
            if selected
                .iter()
                .any(|selected| selected.action == descriptor.action)
            {
                continue;
            }
            if selected.len() >= max_direct_actions {
                return selected;
            }
            selected.push(descriptor);
        }
    }
    selected
}

fn intent_priority_app_cli_actions(task_intent: Option<&str>) -> &'static [&'static str] {
    match task_intent
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image" | "image-generation" | "cover" => &["image.generate"],
        "video" | "video-generation" => &["video.generate"],
        "video-analysis" | "video_analyze" | "video-analyze" => &["video.analyze"],
        "voice" | "tts" | "speech" => &["voice.speech"],
        _ => &[],
    }
}

const DEFAULT_SAFE_DIRECT_APP_CLI_ACTIONS: &[&str] = &[
    "web.fetch",
    "session.resources.list",
    "session.resources.get",
    "memory.list",
    "memory.search",
    "memory.recall",
    "memory.diagnostics",
    "redclaw.profile.bundle",
    "redclaw.profile.read",
    "redclaw.task.preview",
    "redclaw.task.list",
    "redclaw.task.stats",
    "manuscripts.list",
    "assets.search",
    "assets.get",
    "assets.categories.list",
    "generation.job.list",
    "generation.job.get",
    "assets.categories.create",
    "assets.create",
    "assets.update",
    "assets.generateCharacterCard",
    "voice.speech",
    "voice.list",
    "voice.get",
    "team.guide.create",
    "team.session.list",
    "team.session.get",
    "team.members.list",
    "team.task.list",
    "approval.request",
    "skills.list",
    "skills.invoke",
    "image.generate",
    "video.generate",
    "video.analyze",
    "media.edit",
    "media.transcribe",
];

fn push_direct_app_cli_action(
    selected: &mut Vec<ActionDescriptor>,
    descriptors: &[ActionDescriptor],
    action: &str,
    max_direct_actions: usize,
) -> bool {
    if selected.len() >= max_direct_actions {
        return false;
    }
    if selected
        .iter()
        .any(|descriptor| descriptor.action == action)
    {
        return true;
    }
    if let Some(descriptor) = descriptors
        .iter()
        .copied()
        .find(|descriptor| descriptor.action == action)
    {
        selected.push(descriptor);
    }
    true
}

fn pinned_direct_app_cli_actions(
    runtime_mode: &str,
    task_intent: Option<&str>,
) -> &'static [&'static str] {
    let runtime_mode = runtime_mode.trim();
    let task_intent = task_intent.unwrap_or("").trim();
    let wants_host_cli = matches!(
        task_intent,
        "cli"
            | "cli-runtime"
            | "cli_runtime"
            | "host-cli"
            | "host_cli"
            | "computer-cli"
            | "computer_cli"
            | "terminal"
            | "shell"
    );
    let media_intent = matches!(task_intent, "image" | "video");
    if !media_intent && runtime_mode == "team" {
        &[
            "web.fetch",
            "video.analyze",
            "media.edit",
            "team.guide.create",
            "team.session.create",
            "team.session.get",
            "team.session.list",
            "team.members.list",
            "team.member.spawn",
            "team.member.match",
            "team.member.rename",
            "team.member.shutdown",
            "team.task.create",
            "team.task.update",
            "team.task.list",
            "team.message.send",
            "team.report.request",
            "team.report.submit",
            "team.artifact.attach",
            "team.blocker.raise",
            "media.transcribe",
            "image.generate",
            "skills.invoke",
            "skills.installFromRepo",
            "skills.uninstall",
            "cli_runtime.execution.get",
            "mcp.list",
            "mcp.discoverLocal",
            "mcp.add",
            "mcp.get",
            "mcp.remove",
            "mcp.listTools",
        ]
    } else if wants_host_cli || (!media_intent && matches!(runtime_mode, "redclaw" | "knowledge")) {
        &[
            "web.fetch",
            "video.analyze",
            "media.edit",
            "team.guide.create",
            "media.transcribe",
            "image.generate",
            "skills.invoke",
            "skills.installFromRepo",
            "skills.uninstall",
            "cli_runtime.execution.get",
            "mcp.list",
            "mcp.discoverLocal",
            "mcp.add",
            "mcp.get",
            "mcp.remove",
            "mcp.listTools",
        ]
    } else {
        &[]
    }
}

fn preferred_app_cli_namespaces(runtime_mode: &str, task_intent: Option<&str>) -> Vec<String> {
    families::default_direct_namespaces(runtime_mode, task_intent)
        .into_iter()
        .map(ToString::to_string)
        .collect()
}

fn direct_namespaces_from_metadata(metadata: Option<&Value>) -> Option<Vec<String>> {
    let families = metadata_string_list(metadata, "directActionFamilies");
    let families = if families.is_empty() {
        metadata_string_list(metadata, "allowedActionFamilies")
    } else {
        families
    };
    if families.is_empty() {
        return None;
    }
    Some(families)
}

fn max_direct_actions_from_metadata(metadata: Option<&Value>) -> Option<usize> {
    metadata
        .and_then(|item| item.get("maxDirectActions"))
        .and_then(Value::as_u64)
        .map(|value| value.clamp(1, 64) as usize)
}

fn deferred_action_entry(descriptor: &ActionDescriptor) -> DeferredActionEntry {
    DeferredActionEntry {
        action: descriptor.action.to_string(),
        namespace: descriptor.namespace.to_string(),
        description: descriptor.description.to_string(),
        mutating: descriptor.mutating,
        concurrency_safe: descriptor.concurrency_safe,
        runtime_modes: descriptor
            .runtime_modes
            .iter()
            .map(|item| item.to_string())
            .collect(),
    }
}

fn is_team_escalation_action(action: &str) -> bool {
    (action.starts_with("team.") && action != "team.guide.create")
        || action.starts_with("redclaw.task.")
}

fn session_metadata<'a>(store: &'a AppStore, session_id: Option<&str>) -> Option<&'a Value> {
    session_id.and_then(|id| {
        store
            .chat_sessions
            .iter()
            .find(|item: &&ChatSessionRecord| item.id == id)
            .and_then(|item| item.metadata.as_ref())
    })
}

fn metadata_string_list(metadata: Option<&Value>, field: &str) -> Vec<String> {
    metadata
        .and_then(|item| item.get(field))
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

fn metadata_string(metadata: Option<&Value>, field: &str) -> Option<String> {
    metadata
        .and_then(|item| item.get(field))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
}

fn metadata_bool(metadata: Option<&Value>, field: &str) -> Option<bool> {
    metadata
        .and_then(|item| item.get(field))
        .and_then(Value::as_bool)
}

fn metadata_is_artifact_authoring_manuscript(metadata: Option<&Value>) -> bool {
    metadata_string(metadata, "executionProfile").as_deref() == Some("artifact-authoring")
        && metadata_string(metadata, "artifactType").as_deref() == Some("manuscript")
}

fn has_explicit_asset_refs(metadata: Option<&Value>) -> bool {
    metadata
        .and_then(|item| item.get("explicitAssetRefs"))
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("assetId")
                    .or_else(|| item.get("id"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty())
            })
        })
}

fn has_active_skill(metadata: Option<&Value>, skill_name: &str) -> bool {
    let wanted = skill_name.trim();
    if wanted.is_empty() {
        return false;
    }
    if metadata_string_list(metadata, "activeSkills")
        .iter()
        .any(|item| item.eq_ignore_ascii_case(wanted))
    {
        return true;
    }
    metadata
        .and_then(|item| item.get("sessionSkillState"))
        .and_then(|item| item.get("active"))
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("skillName")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .is_some_and(|value| value.eq_ignore_ascii_case(wanted))
            })
        })
}

fn normalize_runtime_mode(runtime_mode: &str) -> &str {
    match runtime_mode.trim() {
        "" | "default" | "chat" | "chatroom" => "team",
        "image_generation" => "image-generation",
        other => other,
    }
}

fn plan_fingerprint(
    runtime_mode: &str,
    session_id: Option<&str>,
    metadata: Option<&Value>,
    active_skills: &[String],
    task_intent: Option<&str>,
    internal_tool_names: &[String],
    direct_app_cli_actions: &[ActionDescriptor],
    deferred_action_namespaces: &[String],
    mcp_inventory_fingerprint: Option<&str>,
    direct_mcp_tool_names: &[String],
    deferred_mcp_tool_names: &[String],
) -> String {
    let mut hasher = DefaultHasher::new();
    runtime_mode.hash(&mut hasher);
    session_id.unwrap_or_default().hash(&mut hasher);
    task_intent.unwrap_or_default().hash(&mut hasher);
    canonical_metadata_for_hash(metadata).hash(&mut hasher);
    internal_tool_names.hash(&mut hasher);
    active_skills.hash(&mut hasher);
    for descriptor in direct_app_cli_actions {
        descriptor.action.hash(&mut hasher);
    }
    deferred_action_namespaces.hash(&mut hasher);
    mcp_inventory_fingerprint
        .unwrap_or_default()
        .hash(&mut hasher);
    direct_mcp_tool_names.hash(&mut hasher);
    deferred_mcp_tool_names.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn canonical_metadata_for_hash(metadata: Option<&Value>) -> String {
    let Some(Value::Object(object)) = metadata else {
        return String::new();
    };
    let mut canonical = BTreeMap::<String, String>::new();
    for key in [
        "allowedTools",
        "allowedAppCliActions",
        "allowedOperateActions",
        "allowedWriteTargets",
        "executionProfile",
        "artifactType",
        "writeTarget",
        "requiredSkill",
        "deferredDiscovery",
        "teamEscalation",
        "taskIntent",
        "runtimeMode",
    ] {
        if let Some(value) = object.get(key) {
            canonical.insert(key.to_string(), value.to_string());
        }
    }
    canonical
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join(";")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redclaw_image_intent_prioritizes_image_action() {
        let metadata = json!({ "taskIntent": "image" });
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            session_metadata: Some(&metadata),
            task_intent: Some("image"),
            ..ToolRegistryPlanParams::default()
        });

        assert!(plan.has_direct_app_cli_action("image.generate"));
        assert!(!plan.has_direct_app_cli_action("tools.search"));
        assert!(plan.direct_app_cli_actions.len() <= DEFAULT_MAX_DIRECT_APP_CLI_ACTIONS);
        assert!(plan.visible_tools.iter().any(|tool| tool.name == "Operate"));
        assert!(plan
            .visible_tools
            .iter()
            .any(|tool| tool.name == "tool_search"));
        assert!(plan.has_direct_app_cli_action("memory.add"));
    }

    #[test]
    fn redclaw_default_keeps_skill_invocation_direct() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });

        assert!(plan.has_direct_app_cli_action("skills.invoke"));
        assert!(!plan.has_deferred_app_cli_action("skills.invoke"));
    }

    #[test]
    fn image_generation_runtime_exposes_image_action() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "image-generation",
            ..ToolRegistryPlanParams::default()
        });

        assert!(plan.has_direct_app_cli_action("image.generate"));
        assert!(!plan.has_direct_app_cli_action("tools.search"));
        assert!(plan.visible_tools.iter().any(|tool| tool.name == "Operate"));
        assert!(plan
            .visible_tools
            .iter()
            .any(|tool| tool.name == "tool_search"));
    }

    #[test]
    fn allowed_app_cli_actions_override_default_direct_set() {
        let metadata = json!({
            "allowedTools": ["resource", "workflow"],
            "allowedAppCliActions": [
                "manuscripts.createProject",
                "manuscripts.writeCurrent"
            ]
        });

        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            session_metadata: Some(&metadata),
            ..ToolRegistryPlanParams::default()
        });
        let actions = plan
            .direct_app_cli_actions
            .iter()
            .map(|descriptor| descriptor.action)
            .collect::<Vec<_>>();

        assert_eq!(
            actions,
            vec![
                "manuscripts.createProject",
                "manuscripts.writeCurrent",
                "image.generate"
            ]
        );
        assert!(!plan.has_deferred_app_cli_action("redclaw.task.create"));
        assert!(!plan
            .visible_tools
            .iter()
            .any(|tool| tool.name == "tool_search"));
    }

    #[test]
    fn artifact_authoring_manuscript_keeps_minimal_tool_surface() {
        let metadata = json!({
            "executionProfile": "artifact-authoring",
            "artifactType": "manuscript",
            "allowedTools": ["resource", "workflow"],
            "allowedOperateActions": [
                "skills.invoke",
                "manuscripts.createProject",
                "redclaw.profile.read",
                "redclaw.profile.bundle"
            ],
            "allowedWriteTargets": ["manuscripts://current"],
            "deferredDiscovery": false,
            "teamEscalation": "disabled"
        });

        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            session_metadata: Some(&metadata),
            ..ToolRegistryPlanParams::default()
        });
        let visible = plan
            .visible_tools
            .iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        let actions = plan
            .direct_app_cli_actions
            .iter()
            .map(|descriptor| descriptor.action)
            .collect::<Vec<_>>();

        assert_eq!(visible, vec!["Read", "List", "Write", "Operate"]);
        for action in [
            "team.guide.create",
            "skills.invoke",
            "manuscripts.createProject",
            "redclaw.profile.read",
            "redclaw.profile.bundle",
        ] {
            assert!(actions.contains(&action), "{action} should be direct");
        }
        assert_eq!(actions.len(), 5);
        assert!(!plan.has_direct_app_cli_action("manuscripts.writeCurrent"));
        assert!(!visible.contains(&"tool_search"));
        assert!(!visible.contains(&"shell"));
        assert!(!visible.contains(&"Search"));
        assert!(!plan.has_deferred_app_cli_action("redclaw.task.create"));
        assert!(!plan.has_deferred_app_cli_action("team.session.create"));
    }

    #[test]
    fn explicit_operate_allowlist_does_not_create_deferred_actions() {
        let metadata = json!({
            "activeSkills": ["redclaw-style-definition"],
            "allowedOperateActions": [
                "redclaw.profile.bundle",
                "redclaw.profile.read",
                "redclaw.profile.update",
                "redclaw.profile.completeStyleDefinition"
            ]
        });

        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            session_metadata: Some(&metadata),
            ..ToolRegistryPlanParams::default()
        });

        assert!(plan.has_direct_app_cli_action("redclaw.profile.bundle"));
        assert!(plan.has_direct_app_cli_action("redclaw.profile.read"));
        assert!(plan.has_direct_app_cli_action("redclaw.profile.update"));
        assert!(plan.has_direct_app_cli_action("redclaw.profile.completeStyleDefinition"));
        assert!(!plan.has_direct_app_cli_action("video.analyze"));
        assert!(!plan.has_deferred_app_cli_action("video.analyze"));
        assert!(plan.deferred_app_cli_actions.is_empty());
        assert!(!plan
            .visible_tools
            .iter()
            .any(|tool| tool.name == "tool_search"));
    }

    #[test]
    fn manuscript_editor_keeps_direct_actions_to_bound_write_only() {
        let metadata = json!({
            "allowedTools": ["workflow"],
            "allowedAppCliActions": ["manuscripts.writeCurrent"]
        });

        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "manuscript-editor",
            session_metadata: Some(&metadata),
            ..ToolRegistryPlanParams::default()
        });
        let visible = plan
            .visible_tools
            .iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        let actions = plan
            .direct_app_cli_actions
            .iter()
            .map(|descriptor| descriptor.action)
            .collect::<Vec<_>>();

        assert_eq!(visible, vec!["Write"]);
        assert_eq!(actions, vec!["manuscripts.writeCurrent"]);
    }

    #[test]
    fn allowed_tools_constrain_visible_tools() {
        let metadata = json!({
            "allowedTools": ["resource"]
        });

        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "team",
            session_metadata: Some(&metadata),
            ..ToolRegistryPlanParams::default()
        });
        let names = plan
            .visible_tools
            .iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["Read", "List", "Search"]);
        assert!(plan.direct_app_cli_actions.is_empty());
    }

    #[test]
    fn metadata_can_select_direct_action_families() {
        let metadata = json!({
            "directActionFamilies": ["mcp"],
            "maxDirectActions": 3
        });
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "diagnostics",
            session_metadata: Some(&metadata),
            ..ToolRegistryPlanParams::default()
        });

        assert!(!plan.direct_app_cli_actions.is_empty());
        assert!(plan.direct_app_cli_actions.len() <= 3);
        assert!(plan
            .direct_app_cli_actions
            .iter()
            .all(|descriptor| descriptor.namespace == "mcp"));
    }

    #[test]
    fn redclaw_runtime_pins_core_cli_runtime_actions() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            ..ToolRegistryPlanParams::default()
        });

        assert!(plan.has_direct_app_cli_action("video.analyze"));
        assert!(plan.has_direct_app_cli_action("media.edit"));
        assert!(plan.has_direct_app_cli_action("media.transcribe"));
        assert!(plan.has_direct_app_cli_action("team.guide.create"));
        assert!(plan.has_direct_app_cli_action("web.fetch"));
        assert!(!plan.has_direct_app_cli_action("cli_runtime.inspect"));
        assert!(!plan.has_direct_app_cli_action("cli_runtime.diagnose"));
        assert!(!plan.has_direct_app_cli_action("cli_runtime.discover"));
        assert!(!plan.has_direct_app_cli_action("cli_runtime.install"));
        assert!(!plan.has_direct_app_cli_action("cli_runtime.execute"));
        assert!(plan.has_direct_app_cli_action("cli_runtime.execution.get"));
        assert!(plan.has_direct_app_cli_action("image.generate"));
    }

    #[test]
    fn team_runtime_exposes_coordination_actions_directly() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "team",
            ..ToolRegistryPlanParams::default()
        });

        for action in [
            "team.session.create",
            "team.member.spawn",
            "team.task.create",
            "team.task.update",
            "team.message.send",
            "team.report.request",
            "team.report.submit",
            "team.artifact.attach",
            "team.blocker.raise",
        ] {
            assert!(plan.has_direct_app_cli_action(action), "{action}");
        }
    }

    #[test]
    fn explicit_asset_refs_make_asset_lookup_direct() {
        let metadata = json!({
            "explicitAssetRefs": [{
                "assetId": "subject_1774704234274_53536cc0",
                "name": "Jamba"
            }]
        });
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            session_metadata: Some(&metadata),
            ..ToolRegistryPlanParams::default()
        });

        assert!(plan.has_direct_app_cli_action("assets.get"));
        assert!(plan.has_direct_app_cli_action("assets.search"));
        assert!(!plan.has_deferred_app_cli_action("assets.get"));
        assert!(!plan.has_deferred_app_cli_action("assets.search"));
    }

    #[test]
    fn video_director_skill_makes_generation_actions_direct() {
        let metadata = json!({
            "sessionSkillState": {
                "active": [{
                    "skillName": "video-director",
                    "requestedScope": "session"
                }]
            },
            "activeSkills": ["video-director"]
        });
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            session_metadata: Some(&metadata),
            ..ToolRegistryPlanParams::default()
        });

        for action in [
            "assets.get",
            "assets.search",
            "voice.speech",
            "image.generate",
            "video.generate",
        ] {
            assert!(
                plan.has_direct_app_cli_action(action),
                "{action} should be direct"
            );
        }
    }

    #[test]
    fn team_runtime_pins_web_and_core_cli_runtime_actions() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "team",
            ..ToolRegistryPlanParams::default()
        });

        assert!(plan.has_direct_app_cli_action("video.analyze"));
        assert!(plan.has_direct_app_cli_action("media.edit"));
        assert!(plan.has_direct_app_cli_action("media.transcribe"));
        assert!(plan.has_direct_app_cli_action("team.guide.create"));
        assert!(plan.has_direct_app_cli_action("web.fetch"));
        assert!(!plan.has_direct_app_cli_action("cli_runtime.inspect"));
        assert!(!plan.has_direct_app_cli_action("cli_runtime.diagnose"));
        assert!(!plan.has_direct_app_cli_action("cli_runtime.discover"));
        assert!(!plan.has_direct_app_cli_action("cli_runtime.install"));
        assert!(!plan.has_direct_app_cli_action("cli_runtime.execute"));
        assert!(plan.has_direct_app_cli_action("cli_runtime.execution.get"));
    }

    #[test]
    fn team_runtime_pins_mcp_setup_actions() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "team",
            ..ToolRegistryPlanParams::default()
        });

        assert!(plan.has_direct_app_cli_action("mcp.list"));
        assert!(plan.has_direct_app_cli_action("mcp.discoverLocal"));
        assert!(plan.has_direct_app_cli_action("mcp.add"));
        assert!(plan.has_direct_app_cli_action("mcp.get"));
        assert!(plan.has_direct_app_cli_action("mcp.remove"));
        assert!(plan.has_direct_app_cli_action("mcp.listTools"));
    }

    #[test]
    fn fingerprint_changes_with_routing_metadata() {
        let first_metadata = json!({ "taskIntent": "image" });
        let second_metadata = json!({ "taskIntent": "video" });
        let first = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            session_metadata: Some(&first_metadata),
            task_intent: Some("image"),
            ..ToolRegistryPlanParams::default()
        });
        let second = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "redclaw",
            session_metadata: Some(&second_metadata),
            task_intent: Some("video"),
            ..ToolRegistryPlanParams::default()
        });

        assert_ne!(first.fingerprint, second.fingerprint);
        assert_eq!(first.direct_app_cli_actions[0].action, "image.generate");
        assert_eq!(second.direct_app_cli_actions[0].action, "video.generate");
    }

    #[test]
    fn plan_can_be_built_from_typed_turn_context() {
        let context = RedboxTurnContext {
            runtime_mode: "image-generation".to_string(),
            session_id: Some("session-1".to_string()),
            current_date: "2026-04-25".to_string(),
            workspace_root: None,
            session_metadata: None,
            active_skills: Vec::new(),
            allowed_tool_names: vec![
                "shell".to_string(),
                "resource".to_string(),
                "workflow".to_string(),
            ],
            bound_context: None,
            task_intent: Some("image".to_string()),
            model_capabilities: crate::runtime::ModelCapabilities::default(),
        };
        let plan = build_tool_registry_plan_for_turn_context(&context);

        assert_eq!(plan.runtime_mode, "image-generation");
        assert!(plan.has_direct_app_cli_action("image.generate"));
    }
}
