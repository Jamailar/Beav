use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::cli_runtime::{
    default_environment_path_entries, detect_runtime_inventory, load_host_shell_env,
    merge_execution_env, CliEnvironmentRecord, CliEnvironmentScope,
};
use crate::persistence::{with_store, with_store_mut};
use crate::store::spaces as spaces_store;
use crate::{
    active_space_workspace_root_from_store, is_same_path, now_i64, slug_from_relative_path,
    store_root, AppState, AppStore,
};

const CLI_RUNTIME_DATA_DIR: &str = "cli-runtime";
const CLI_RUNTIME_ENVIRONMENTS_DIR: &str = "environments";

#[derive(Debug, Clone)]
struct EnvironmentSeed {
    id: String,
    scope: CliEnvironmentScope,
    root_path: PathBuf,
    workspace_root: Option<String>,
    metadata: Option<Value>,
}

fn hash_workspace_root(workspace_root: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(workspace_root.to_string_lossy().as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    digest.chars().take(16).collect()
}

fn cli_runtime_root_dir(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = store_root(state)?.join(CLI_RUNTIME_DATA_DIR);
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn environment_root_dir(base_root: &Path) -> PathBuf {
    base_root.join(CLI_RUNTIME_ENVIRONMENTS_DIR)
}

fn build_environment_seed(
    base_root: &Path,
    scope: CliEnvironmentScope,
    workspace_root: Option<&Path>,
    task_id: Option<&str>,
) -> Result<EnvironmentSeed, String> {
    match scope {
        CliEnvironmentScope::AppGlobal => Ok(EnvironmentSeed {
            id: "cli-env-app-global".to_string(),
            scope,
            root_path: environment_root_dir(base_root).join("app-global"),
            workspace_root: None,
            metadata: Some(json!({
                "scopeKey": "app-global",
            })),
        }),
        CliEnvironmentScope::WorkspaceLocal => {
            let workspace_root = workspace_root
                .ok_or_else(|| "workspace-local environment requires workspace_root".to_string())?;
            let workspace_hash = hash_workspace_root(workspace_root);
            Ok(EnvironmentSeed {
                id: format!("cli-env-workspace-{workspace_hash}"),
                scope,
                root_path: environment_root_dir(base_root)
                    .join("workspace")
                    .join(&workspace_hash),
                workspace_root: Some(workspace_root.to_string_lossy().to_string()),
                metadata: Some(json!({
                    "scopeKey": "workspace-local",
                    "workspaceHash": workspace_hash,
                })),
            })
        }
        CliEnvironmentScope::TaskEphemeral => {
            let task_id =
                task_id.ok_or_else(|| "task-ephemeral environment requires task_id".to_string())?;
            let task_slug = slug_from_relative_path(task_id);
            Ok(EnvironmentSeed {
                id: format!("cli-env-task-{task_slug}"),
                scope,
                root_path: environment_root_dir(base_root)
                    .join("ephemeral")
                    .join(&task_slug),
                workspace_root: None,
                metadata: Some(json!({
                    "scopeKey": "task-ephemeral",
                    "taskId": task_id,
                })),
            })
        }
    }
}

fn ensure_environment_layout(root_path: &Path) -> Result<(), String> {
    fs::create_dir_all(root_path.join("bin")).map_err(|error| error.to_string())?;
    fs::create_dir_all(root_path.join("node_modules").join(".bin"))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn find_environment_by_id_in_store(
    environments: &[CliEnvironmentRecord],
    environment_id: &str,
) -> Option<CliEnvironmentRecord> {
    environments
        .iter()
        .find(|item| item.id == environment_id)
        .cloned()
}

fn find_workspace_environment_in_store(
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
                    .is_some_and(|value| is_same_path(Path::new(value), workspace_root))
        })
        .cloned()
}

fn find_task_environment_in_store(
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
                    .and_then(Value::as_str)
                    == Some(task_id)
        })
        .cloned()
}

fn merge_environment_metadata(existing: Option<&Value>, generated: Option<Value>) -> Option<Value> {
    let mut merged = serde_json::Map::<String, Value>::new();

    if let Some(Value::Object(existing_object)) = existing {
        for (key, value) in existing_object {
            merged.insert(key.clone(), value.clone());
        }
    }
    if let Some(Value::Object(generated_object)) = generated {
        for (key, value) in generated_object {
            merged.insert(key, value);
        }
    }

    if merged.is_empty() {
        return existing.cloned();
    }
    Some(Value::Object(merged))
}

fn upsert_environment_record(
    store: &mut AppStore,
    record: CliEnvironmentRecord,
) -> CliEnvironmentRecord {
    if let Some(existing) = store
        .cli_environments
        .iter_mut()
        .find(|item| item.id == record.id)
    {
        *existing = record.clone();
    } else {
        store.cli_environments.push(record.clone());
    }
    store
        .cli_environments
        .sort_by(|left, right| left.id.cmp(&right.id));
    record
}

pub fn upsert_cli_environment_record(
    state: &State<'_, AppState>,
    record: CliEnvironmentRecord,
) -> Result<CliEnvironmentRecord, String> {
    with_store_mut(state, |store| {
        Ok(upsert_environment_record(store, record.clone()))
    })
}

pub fn add_installed_tool_to_environment(
    state: &State<'_, AppState>,
    environment_id: &str,
    tool_id: &str,
) -> Result<Option<CliEnvironmentRecord>, String> {
    let normalized_tool_id = tool_id.trim();
    if normalized_tool_id.is_empty() {
        return Ok(None);
    }
    with_store_mut(state, |store| {
        let Some(existing) = store
            .cli_environments
            .iter_mut()
            .find(|item| item.id == environment_id)
        else {
            return Ok(None);
        };
        if !existing
            .installed_tool_ids
            .iter()
            .any(|item| item == normalized_tool_id)
        {
            existing
                .installed_tool_ids
                .push(normalized_tool_id.to_string());
            existing.installed_tool_ids.sort();
        }
        existing.updated_at = now_i64();
        Ok(Some(existing.clone()))
    })
}

fn ensure_environment_record(
    state: &State<'_, AppState>,
    scope: CliEnvironmentScope,
    workspace_root: Option<&Path>,
    task_id: Option<&str>,
) -> Result<CliEnvironmentRecord, String> {
    let runtime_root = cli_runtime_root_dir(state)?;
    let existing = with_store(state, |store| {
        let record = match scope {
            CliEnvironmentScope::AppGlobal => {
                find_environment_by_id_in_store(&store.cli_environments, "cli-env-app-global")
            }
            CliEnvironmentScope::WorkspaceLocal => workspace_root.and_then(|root| {
                find_workspace_environment_in_store(&store.cli_environments, root)
            }),
            CliEnvironmentScope::TaskEphemeral => task_id
                .and_then(|value| find_task_environment_in_store(&store.cli_environments, value)),
        };
        Ok(record)
    })?;

    let seed = build_environment_seed(&runtime_root, scope, workspace_root, task_id)?;
    ensure_environment_layout(&seed.root_path)?;

    let host_env = load_host_shell_env()
        .unwrap_or_else(|_| std::env::vars().collect::<std::collections::BTreeMap<_, _>>());
    let created_at = existing
        .as_ref()
        .map(|item| item.created_at)
        .unwrap_or_else(now_i64);
    let path_entries = default_environment_path_entries(&seed.root_path);

    let provisional = CliEnvironmentRecord {
        id: seed.id.clone(),
        scope: seed.scope.clone(),
        root_path: seed.root_path.to_string_lossy().to_string(),
        workspace_root: seed.workspace_root.clone(),
        path_entries,
        runtimes: Default::default(),
        installed_tool_ids: existing
            .as_ref()
            .map(|item| item.installed_tool_ids.clone())
            .unwrap_or_default(),
        created_at,
        updated_at: now_i64(),
        metadata: merge_environment_metadata(
            existing.as_ref().and_then(|item| item.metadata.as_ref()),
            seed.metadata,
        ),
    };
    let merged_env = merge_execution_env(&host_env, &provisional, None);
    let record = CliEnvironmentRecord {
        runtimes: detect_runtime_inventory(&merged_env),
        ..provisional
    };

    with_store_mut(state, |store| {
        Ok(upsert_environment_record(store, record.clone()))
    })
}

pub fn list_cli_environments(
    state: &State<'_, AppState>,
) -> Result<Vec<CliEnvironmentRecord>, String> {
    with_store(state, |store| Ok(store.cli_environments.clone()))
}

pub fn find_cli_environment_by_id(
    state: &State<'_, AppState>,
    environment_id: &str,
) -> Result<Option<CliEnvironmentRecord>, String> {
    with_store(state, |store| {
        Ok(find_environment_by_id_in_store(
            &store.cli_environments,
            environment_id,
        ))
    })
}

pub fn active_workspace_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    with_store(state, |store| {
        let active_space_id = spaces_store::active_space_id(&store);
        active_space_workspace_root_from_store(&store, &active_space_id, &state.store_path)
    })
}

pub fn ensure_app_global_environment(
    state: &State<'_, AppState>,
) -> Result<CliEnvironmentRecord, String> {
    ensure_environment_record(state, CliEnvironmentScope::AppGlobal, None, None)
}

pub fn ensure_workspace_environment(
    state: &State<'_, AppState>,
    workspace_root: &Path,
) -> Result<CliEnvironmentRecord, String> {
    ensure_environment_record(
        state,
        CliEnvironmentScope::WorkspaceLocal,
        Some(workspace_root),
        None,
    )
}

pub fn ensure_workspace_environment_for_active_space(
    state: &State<'_, AppState>,
) -> Result<CliEnvironmentRecord, String> {
    let workspace_root = active_workspace_root(state)?;
    ensure_workspace_environment(state, &workspace_root)
}

pub fn create_task_ephemeral_environment(
    state: &State<'_, AppState>,
    task_id: &str,
) -> Result<CliEnvironmentRecord, String> {
    ensure_environment_record(
        state,
        CliEnvironmentScope::TaskEphemeral,
        None,
        Some(task_id),
    )
}

pub fn delete_environment(state: &State<'_, AppState>, environment_id: &str) -> Result<(), String> {
    let existing = find_cli_environment_by_id(state, environment_id)?;
    let Some(existing) = existing else {
        return Ok(());
    };

    let root_path = PathBuf::from(&existing.root_path);
    if root_path.exists() {
        fs::remove_dir_all(&root_path).map_err(|error| error.to_string())?;
    }

    with_store_mut(state, |store| {
        store
            .cli_environments
            .retain(|item| item.id != environment_id);
        Ok(())
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_environment_seed_for_workspace_uses_hashed_root() {
        let seed = build_environment_seed(
            Path::new("/tmp/redbox"),
            CliEnvironmentScope::WorkspaceLocal,
            Some(Path::new("/tmp/workspaces/demo")),
            None,
        )
        .expect("workspace seed should build");
        assert!(seed.id.starts_with("cli-env-workspace-"));
        assert!(seed.root_path.to_string_lossy().contains("/workspace/"));
        assert_eq!(seed.workspace_root.as_deref(), Some("/tmp/workspaces/demo"));
    }

    #[test]
    fn build_environment_seed_for_task_keeps_task_id_in_metadata() {
        let seed = build_environment_seed(
            Path::new("/tmp/redbox"),
            CliEnvironmentScope::TaskEphemeral,
            None,
            Some("task-123"),
        )
        .expect("task seed should build");
        assert_eq!(seed.id, "cli-env-task-task-123");
        assert_eq!(
            seed.metadata
                .as_ref()
                .and_then(|value| value.get("taskId"))
                .and_then(Value::as_str),
            Some("task-123")
        );
    }

    #[test]
    fn upsert_environment_record_replaces_existing_record_without_duplication() {
        let mut store = crate::persistence::default_store();
        let first = CliEnvironmentRecord {
            id: "cli-env-app-global".to_string(),
            scope: CliEnvironmentScope::AppGlobal,
            root_path: "/tmp/app".to_string(),
            workspace_root: None,
            path_entries: vec!["/tmp/app/bin".to_string()],
            runtimes: Default::default(),
            installed_tool_ids: vec!["ffmpeg".to_string()],
            created_at: 1,
            updated_at: 1,
            metadata: None,
        };
        upsert_environment_record(&mut store, first);
        let refreshed = CliEnvironmentRecord {
            id: "cli-env-app-global".to_string(),
            scope: CliEnvironmentScope::AppGlobal,
            root_path: "/tmp/app".to_string(),
            workspace_root: None,
            path_entries: vec!["/tmp/app/bin".to_string()],
            runtimes: Default::default(),
            installed_tool_ids: vec!["ffmpeg".to_string(), "node".to_string()],
            created_at: 1,
            updated_at: 2,
            metadata: Some(json!({ "scopeKey": "app-global" })),
        };
        upsert_environment_record(&mut store, refreshed);

        assert_eq!(store.cli_environments.len(), 1);
        assert_eq!(store.cli_environments[0].created_at, 1);
        assert_eq!(store.cli_environments[0].updated_at, 2);
        assert_eq!(store.cli_environments[0].installed_tool_ids.len(), 2);
    }
}
