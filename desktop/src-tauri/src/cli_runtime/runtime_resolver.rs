use std::path::{Path, PathBuf};

use tauri::State;

use crate::cli_runtime::{
    active_workspace_root, create_task_ephemeral_environment, ensure_app_global_environment,
    ensure_workspace_environment, find_cli_environment_by_id, list_cli_environments,
    CliEnvironmentRecord, CliEnvironmentResolution, CliEnvironmentResolveRequest,
    CliEnvironmentScope,
};
use crate::{is_same_path, AppState};

fn normalized_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn select_scope_for_request(request: &CliEnvironmentResolveRequest) -> CliEnvironmentScope {
    if let Some(scope) = request.preferred_scope.clone() {
        return scope;
    }
    if request.isolated && normalized_text(request.task_id.as_deref()).is_some() {
        return CliEnvironmentScope::TaskEphemeral;
    }
    if normalized_text(request.workspace_root.as_deref()).is_some() {
        return CliEnvironmentScope::WorkspaceLocal;
    }
    CliEnvironmentScope::AppGlobal
}

fn find_tool_environment(
    environments: &[CliEnvironmentRecord],
    tool_id: &str,
) -> Option<CliEnvironmentRecord> {
    environments
        .iter()
        .find(|item| {
            item.installed_tool_ids
                .iter()
                .any(|candidate| candidate == tool_id)
        })
        .cloned()
}

fn find_workspace_environment(
    environments: &[CliEnvironmentRecord],
    workspace_root: &Path,
) -> Option<CliEnvironmentRecord> {
    environments
        .iter()
        .find(|item| {
            item.scope == CliEnvironmentScope::WorkspaceLocal
                && item
                    .workspace_root
                    .as_deref()
                    .is_some_and(|candidate| is_same_path(Path::new(candidate), workspace_root))
        })
        .cloned()
}

fn find_task_environment(
    environments: &[CliEnvironmentRecord],
    task_id: &str,
) -> Option<CliEnvironmentRecord> {
    environments
        .iter()
        .find(|item| {
            item.scope == CliEnvironmentScope::TaskEphemeral
                && item
                    .metadata
                    .as_ref()
                    .and_then(|value| value.get("taskId"))
                    .and_then(|value| value.as_str())
                    == Some(task_id)
        })
        .cloned()
}

fn requested_workspace_root(
    state: &State<'_, AppState>,
    request: &CliEnvironmentResolveRequest,
) -> Result<PathBuf, String> {
    if let Some(workspace_root) = normalized_text(request.workspace_root.as_deref()) {
        return Ok(PathBuf::from(workspace_root));
    }
    active_workspace_root(state)
}

pub fn resolve_cli_environment(
    state: &State<'_, AppState>,
    request: &CliEnvironmentResolveRequest,
) -> Result<CliEnvironmentResolution, String> {
    let environments = list_cli_environments(state)?;

    if let Some(environment_id) = normalized_text(request.requested_environment_id.as_deref()) {
        let environment = find_cli_environment_by_id(state, &environment_id)?
            .ok_or_else(|| format!("cli environment not found: {environment_id}"))?;
        return Ok(CliEnvironmentResolution {
            environment,
            reason: format!("explicit environment id: {environment_id}"),
            reused_existing: true,
        });
    }

    if let Some(tool_id) = normalized_text(request.tool_id.as_deref()) {
        if let Some(environment) = find_tool_environment(&environments, &tool_id) {
            return Ok(CliEnvironmentResolution {
                environment,
                reason: format!("reused existing environment for tool: {tool_id}"),
                reused_existing: true,
            });
        }
    }

    match select_scope_for_request(request) {
        CliEnvironmentScope::AppGlobal => {
            let existed = environments
                .iter()
                .any(|item| item.scope == CliEnvironmentScope::AppGlobal);
            let environment = ensure_app_global_environment(state)?;
            Ok(CliEnvironmentResolution {
                environment,
                reason: "defaulted to app-global environment".to_string(),
                reused_existing: existed,
            })
        }
        CliEnvironmentScope::WorkspaceLocal => {
            let workspace_root = requested_workspace_root(state, request)?;
            let existed = find_workspace_environment(&environments, &workspace_root).is_some();
            let environment = ensure_workspace_environment(state, &workspace_root)?;
            Ok(CliEnvironmentResolution {
                environment,
                reason: format!(
                    "resolved workspace-local environment for {}",
                    workspace_root.display()
                ),
                reused_existing: existed,
            })
        }
        CliEnvironmentScope::TaskEphemeral => {
            let task_id = normalized_text(request.task_id.as_deref())
                .ok_or_else(|| "task-ephemeral environment requires taskId".to_string())?;
            let existed = find_task_environment(&environments, &task_id).is_some();
            let environment = create_task_ephemeral_environment(state, &task_id)?;
            Ok(CliEnvironmentResolution {
                environment,
                reason: format!("resolved isolated task environment for {task_id}"),
                reused_existing: existed,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn select_scope_prefers_explicit_scope() {
        let request = CliEnvironmentResolveRequest {
            preferred_scope: Some(CliEnvironmentScope::WorkspaceLocal),
            workspace_root: None,
            task_id: Some("task-1".to_string()),
            isolated: true,
            ..Default::default()
        };
        assert_eq!(
            select_scope_for_request(&request),
            CliEnvironmentScope::WorkspaceLocal
        );
    }

    #[test]
    fn select_scope_uses_task_ephemeral_for_isolated_task() {
        let request = CliEnvironmentResolveRequest {
            task_id: Some("task-1".to_string()),
            isolated: true,
            ..Default::default()
        };
        assert_eq!(
            select_scope_for_request(&request),
            CliEnvironmentScope::TaskEphemeral
        );
    }

    #[test]
    fn find_tool_environment_reuses_installed_tool_host() {
        let environments = vec![
            CliEnvironmentRecord {
                id: "cli-env-app-global".to_string(),
                scope: CliEnvironmentScope::AppGlobal,
                root_path: "/tmp/app".to_string(),
                workspace_root: None,
                path_entries: Vec::new(),
                runtimes: Default::default(),
                installed_tool_ids: vec!["node".to_string(), "ffmpeg".to_string()],
                created_at: 0,
                updated_at: 0,
                metadata: None,
            },
            CliEnvironmentRecord {
                id: "cli-env-workspace-abcd".to_string(),
                scope: CliEnvironmentScope::WorkspaceLocal,
                root_path: "/tmp/workspace".to_string(),
                workspace_root: Some("/tmp/project".to_string()),
                path_entries: Vec::new(),
                runtimes: Default::default(),
                installed_tool_ids: vec!["wrangler".to_string()],
                created_at: 0,
                updated_at: 0,
                metadata: None,
            },
        ];

        let matched = find_tool_environment(&environments, "wrangler")
            .expect("wrangler environment should exist");
        assert_eq!(matched.id, "cli-env-workspace-abcd");
    }

    #[test]
    fn find_task_environment_matches_metadata_task_id() {
        let environments = vec![CliEnvironmentRecord {
            id: "cli-env-task-task-7".to_string(),
            scope: CliEnvironmentScope::TaskEphemeral,
            root_path: "/tmp/task-7".to_string(),
            workspace_root: None,
            path_entries: Vec::new(),
            runtimes: Default::default(),
            installed_tool_ids: Vec::new(),
            created_at: 0,
            updated_at: 0,
            metadata: Some(json!({ "taskId": "task-7" })),
        }];

        let matched =
            find_task_environment(&environments, "task-7").expect("task environment should exist");
        assert_eq!(matched.id, "cli-env-task-task-7");
    }
}
