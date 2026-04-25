use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::hash::{DefaultHasher, Hash, Hasher};

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

pub const DEFAULT_MAX_DIRECT_APP_CLI_ACTIONS: usize = 14;

#[derive(Debug, Clone, Default)]
pub struct ToolRegistryPlanParams<'a> {
    pub runtime_mode: &'a str,
    pub session_id: Option<&'a str>,
    pub session_metadata: Option<&'a Value>,
    pub active_skills: &'a [String],
    pub allowed_tool_names: Option<&'a [String]>,
    pub task_intent: Option<&'a str>,
    pub max_direct_app_cli_actions: Option<usize>,
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
    pub fingerprint: String,
}

impl ToolRegistryPlan {
    pub fn has_direct_app_cli_action(&self, action: &str) -> bool {
        self.direct_app_cli_actions
            .iter()
            .any(|descriptor| descriptor.action == action)
    }

    pub fn has_deferred_app_cli_action(&self, action: &str) -> bool {
        self.deferred_app_cli_actions
            .iter()
            .any(|descriptor| descriptor.action == action)
    }
}

pub fn build_tool_registry_plan_for_session(
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> ToolRegistryPlan {
    let metadata = session_metadata(store, session_id);
    let internal_tool_names = base_tool_names_for_metadata(runtime_mode, metadata);
    let skill_state =
        build_skill_runtime_state(&store.skills, runtime_mode, metadata, &internal_tool_names);
    let active_skills = skill_state
        .active_skills
        .iter()
        .map(|skill| skill.name.clone())
        .collect::<Vec<_>>();
    build_tool_registry_plan(ToolRegistryPlanParams {
        runtime_mode,
        session_id,
        session_metadata: metadata,
        active_skills: &active_skills,
        allowed_tool_names: Some(&skill_state.allowed_tools),
        task_intent: metadata
            .and_then(|item| item.get("taskIntent"))
            .and_then(Value::as_str),
        max_direct_app_cli_actions: None,
    })
}

pub fn build_tool_registry_plan_for_turn_context(context: &RedboxTurnContext) -> ToolRegistryPlan {
    build_tool_registry_plan(ToolRegistryPlanParams {
        runtime_mode: &context.runtime_mode,
        session_id: context.session_id.as_deref(),
        session_metadata: context.session_metadata.as_ref(),
        active_skills: &context.active_skills,
        allowed_tool_names: Some(&context.allowed_tool_names),
        task_intent: context.task_intent.as_deref(),
        max_direct_app_cli_actions: None,
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
    let visible_tools = visible_tool_names
        .iter()
        .filter_map(|name| descriptor_by_name(name))
        .collect::<Vec<_>>();
    let app_cli_descriptors = if internal_tool_names.iter().any(|name| name == "app_cli") {
        action_descriptors_for_tool("app_cli", Some(&runtime_mode), ActionVisibility::Model)
    } else {
        Vec::new()
    };
    let direct_app_cli_actions = select_direct_app_cli_actions(
        &runtime_mode,
        params.session_metadata,
        params.task_intent,
        params
            .max_direct_app_cli_actions
            .unwrap_or(DEFAULT_MAX_DIRECT_APP_CLI_ACTIONS),
        &app_cli_descriptors,
    );
    let direct_action_names = direct_app_cli_actions
        .iter()
        .map(|descriptor| descriptor.action)
        .collect::<BTreeSet<_>>();
    let deferred_app_cli_actions = app_cli_descriptors
        .iter()
        .filter(|descriptor| !direct_action_names.contains(descriptor.action))
        .map(deferred_action_entry)
        .collect::<Vec<_>>();
    let deferred_action_namespaces = deferred_app_cli_actions
        .iter()
        .map(|entry| entry.namespace.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let fingerprint = plan_fingerprint(
        &runtime_mode,
        params.session_id,
        params.session_metadata,
        params.active_skills,
        params.task_intent,
        &internal_tool_names,
        &direct_app_cli_actions,
        &deferred_action_namespaces,
    );
    ToolRegistryPlan {
        runtime_mode,
        internal_tool_names,
        visible_tools,
        direct_app_cli_actions,
        deferred_app_cli_actions,
        deferred_action_namespaces,
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
            "Read" | "List" | "Search" => "redbox_fs",
            "Write" | "Redbox" => {
                if internal_tool_names
                    .iter()
                    .any(|item| item == "app_cli" || item == "redbox_editor")
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
    let allowed_actions = normalized_allowed_app_cli_actions(metadata);
    if !allowed_actions.is_empty() {
        return descriptors
            .iter()
            .copied()
            .filter(|descriptor| allowed_actions.iter().any(|item| item == descriptor.action))
            .collect();
    }
    let preferred_namespaces = preferred_app_cli_namespaces(runtime_mode, task_intent);
    let mut selected = Vec::<ActionDescriptor>::new();
    for namespace in preferred_namespaces {
        for descriptor in descriptors
            .iter()
            .copied()
            .filter(|descriptor| descriptor.namespace == namespace)
        {
            if selected.len() >= max_direct_actions {
                return selected;
            }
            selected.push(descriptor);
        }
    }
    selected
}

fn preferred_app_cli_namespaces(
    runtime_mode: &str,
    task_intent: Option<&str>,
) -> Vec<&'static str> {
    families::default_direct_namespaces(runtime_mode, task_intent)
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

fn normalize_runtime_mode(runtime_mode: &str) -> &str {
    match runtime_mode.trim() {
        "" | "default" | "chat" => "chatroom",
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
        assert!(plan.has_direct_app_cli_action("tools.search"));
        assert!(plan.direct_app_cli_actions.len() <= DEFAULT_MAX_DIRECT_APP_CLI_ACTIONS);
        assert!(plan.visible_tools.iter().any(|tool| tool.name == "Redbox"));
        assert!(plan.has_deferred_app_cli_action("memory.add"));
    }

    #[test]
    fn image_generation_runtime_exposes_image_action() {
        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "image-generation",
            ..ToolRegistryPlanParams::default()
        });

        assert!(plan.has_direct_app_cli_action("image.generate"));
        assert!(plan.has_direct_app_cli_action("tools.search"));
        assert!(plan.visible_tools.iter().any(|tool| tool.name == "Redbox"));
    }

    #[test]
    fn allowed_app_cli_actions_override_default_direct_set() {
        let metadata = json!({
            "allowedTools": ["redbox_fs", "app_cli"],
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
        assert!(plan.has_deferred_app_cli_action("redclaw.task.create"));
    }

    #[test]
    fn allowed_tools_constrain_visible_tools() {
        let metadata = json!({
            "allowedTools": ["redbox_fs"]
        });

        let plan = build_tool_registry_plan(ToolRegistryPlanParams {
            runtime_mode: "chatroom",
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
                "bash".to_string(),
                "redbox_fs".to_string(),
                "app_cli".to_string(),
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
