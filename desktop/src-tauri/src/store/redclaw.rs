use super::types::AppStore;
use serde_json::{json, Value};

use crate::redclaw_state_value;
use crate::runtime::{
    RedclawJobDefinitionRecord, RedclawJobExecutionRecord, RedclawLongCycleTaskRecord,
    RedclawProjectRecord, RedclawScheduledTaskRecord,
};
use crate::{RedclawStateRecord, WorkItemRecord};

pub(crate) fn state_value(store: &AppStore) -> Value {
    redclaw_state_value(&store.redclaw_state)
}

pub(crate) fn runtime_start_decision(store: &AppStore) -> (bool, bool) {
    let has_tasks = !store.redclaw_state.scheduled_tasks.is_empty()
        || !store.redclaw_state.long_cycle_tasks.is_empty();
    let should_run = store.redclaw_state.enabled
        && (store.redclaw_state.is_ticking || (!store.redclaw_state.is_ticking && has_tasks));
    let should_recover_tick =
        store.redclaw_state.enabled && !store.redclaw_state.is_ticking && has_tasks;
    (should_run, should_recover_tick)
}

pub(crate) fn recover_ticking_if_needed(store: &mut AppStore) {
    if store.redclaw_state.enabled && !store.redclaw_state.is_ticking {
        store.redclaw_state.is_ticking = true;
    }
}

#[derive(Default)]
pub(crate) struct RunnerConfigPatch {
    pub(crate) interval_minutes: Option<i64>,
    pub(crate) max_automation_per_tick: Option<i64>,
    pub(crate) heartbeat_enabled: Option<bool>,
    pub(crate) heartbeat_interval_minutes: Option<i64>,
    pub(crate) heartbeat_suppress_empty_report: Option<bool>,
    pub(crate) heartbeat_report_to_main_session: Option<bool>,
}

pub(crate) fn start_runner(
    store: &mut AppStore,
    now: String,
    default_next_maintenance_at: String,
    patch: RunnerConfigPatch,
) -> Value {
    store.redclaw_state.enabled = true;
    store.redclaw_state.is_ticking = true;
    store.redclaw_state.last_tick_at = Some(now.clone());
    store.redclaw_state.next_tick_at = Some(now);
    if store.redclaw_state.next_maintenance_at.is_none() {
        store.redclaw_state.next_maintenance_at = Some(default_next_maintenance_at);
    }
    apply_runner_config_patch(store, patch);
    state_value(store)
}

pub(crate) fn stop_runner(store: &mut AppStore) -> Value {
    store.redclaw_state.enabled = false;
    store.redclaw_state.is_ticking = false;
    state_value(store)
}

pub(crate) fn mark_runner_tick(store: &mut AppStore, now: String) -> Value {
    store.redclaw_state.last_tick_at = Some(now);
    state_value(store)
}

pub(crate) fn set_next_maintenance_at(store: &mut AppStore, next_maintenance_at: Option<String>) {
    store.redclaw_state.next_maintenance_at = next_maintenance_at;
}

pub(crate) fn replace_hydration_state(
    store: &mut AppStore,
    state: RedclawStateRecord,
    work_items: Vec<WorkItemRecord>,
) {
    store.redclaw_state = state;
    store.work_items = work_items;
}

pub(crate) fn has_work_items(store: &AppStore) -> bool {
    !store.work_items.is_empty()
}

pub(crate) fn needs_workspace_hydration(store: &AppStore) -> bool {
    store.redclaw_state.scheduled_tasks.is_empty()
        && store.redclaw_state.long_cycle_tasks.is_empty()
        && store.work_items.is_empty()
}

pub(crate) fn runner_is_ticking(store: &AppStore) -> bool {
    store.redclaw_state.enabled && store.redclaw_state.is_ticking
}

pub(crate) fn mark_scheduler_tick(store: &mut AppStore, now: i64) -> Option<Option<String>> {
    if !runner_is_ticking(store) {
        return None;
    }
    let next_maintenance_at = store.redclaw_state.next_maintenance_at.clone();
    store.redclaw_state.last_tick_at = Some(now.to_string());
    store.redclaw_state.next_tick_at =
        Some((now + store.redclaw_state.interval_minutes * 60_000).to_string());
    Some(next_maintenance_at)
}

pub(crate) fn scheduler_execution_limit(store: &AppStore) -> usize {
    if runner_is_ticking(store) {
        return store.redclaw_state.max_automation_per_tick.max(1) as usize;
    }
    0
}

pub(crate) fn apply_runner_config(store: &mut AppStore, patch: RunnerConfigPatch) -> Value {
    apply_runner_config_patch(store, patch);
    state_value(store)
}

fn apply_runner_config_patch(store: &mut AppStore, patch: RunnerConfigPatch) {
    if let Some(interval) = patch.interval_minutes {
        store.redclaw_state.interval_minutes = interval;
    }
    if let Some(max_auto) = patch.max_automation_per_tick {
        store.redclaw_state.max_automation_per_tick = max_auto;
    }
    if let Some(object) = store.redclaw_state.heartbeat.as_object_mut() {
        if let Some(value) = patch.heartbeat_enabled {
            object.insert("enabled".to_string(), json!(value));
        }
        if let Some(value) = patch.heartbeat_interval_minutes {
            object.insert("intervalMinutes".to_string(), json!(value));
        }
        if let Some(value) = patch.heartbeat_suppress_empty_report {
            object.insert("suppressEmptyReport".to_string(), json!(value));
        }
        if let Some(value) = patch.heartbeat_report_to_main_session {
            object.insert("reportToMainSession".to_string(), json!(value));
        }
    }
}

pub(crate) fn list_projects_sorted(store: &AppStore) -> Vec<RedclawProjectRecord> {
    let mut projects = store.redclaw_state.projects.clone();
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    projects
}

pub(crate) fn project_by_id(store: &AppStore, project_id: &str) -> Option<RedclawProjectRecord> {
    store
        .redclaw_state
        .projects
        .iter()
        .find(|item| item.id == project_id)
        .cloned()
}

pub(crate) fn upsert_project_preserving_created_at(
    store: &mut AppStore,
    mut record: RedclawProjectRecord,
    default_created_at: &str,
) -> RedclawProjectRecord {
    if let Some(existing) = store
        .redclaw_state
        .projects
        .iter_mut()
        .find(|item| item.id == record.id)
    {
        record.created_at = existing
            .created_at
            .clone()
            .or(record.created_at)
            .or_else(|| Some(default_created_at.to_string()));
        *existing = record.clone();
    } else {
        record.created_at = record
            .created_at
            .or_else(|| Some(default_created_at.to_string()));
        store.redclaw_state.projects.push(record.clone());
    }
    store.redclaw_state.current_project_id = Some(record.id.clone());
    record
}

pub(crate) fn append_project_metadata_array_record(
    store: &mut AppStore,
    project_id: &str,
    key: &str,
    record: Value,
    updated_at: &str,
) -> Result<RedclawProjectRecord, String> {
    let project = store
        .redclaw_state
        .projects
        .iter_mut()
        .find(|item| item.id == project_id)
        .ok_or_else(|| "RedClaw project not found".to_string())?;
    let mut metadata = project
        .metadata
        .clone()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let mut records = metadata
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    records.push(record);
    metadata.insert(key.to_string(), Value::Array(records));
    project.metadata = Some(Value::Object(metadata));
    project.updated_at = updated_at.to_string();
    Ok(project.clone())
}

pub(crate) fn append_project_metadata_record_and_artifact(
    store: &mut AppStore,
    project_id: &str,
    metadata_key: &str,
    metadata_record: Value,
    artifact: Value,
    updated_at: &str,
) -> Result<RedclawProjectRecord, String> {
    let project = store
        .redclaw_state
        .projects
        .iter_mut()
        .find(|item| item.id == project_id)
        .ok_or_else(|| "RedClaw project not found".to_string())?;
    let mut metadata = project
        .metadata
        .clone()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let mut records = metadata
        .get(metadata_key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    records.push(metadata_record);
    metadata.insert(metadata_key.to_string(), Value::Array(records));
    project.artifacts.push(artifact);
    project.metadata = Some(Value::Object(metadata));
    project.updated_at = updated_at.to_string();
    Ok(project.clone())
}

pub(crate) fn update_project_section_draft(
    store: &mut AppStore,
    project_id: &str,
    section_id: &str,
    content: String,
    updated_at: &str,
) -> Result<RedclawProjectRecord, String> {
    let project = store
        .redclaw_state
        .projects
        .iter_mut()
        .find(|item| item.id == project_id)
        .ok_or_else(|| "RedClaw project not found".to_string())?;
    let mut metadata = project
        .metadata
        .clone()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let mut drafts = metadata
        .get("sectionDrafts")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    drafts.insert(
        section_id.to_string(),
        json!({
            "content": content,
            "updatedAt": updated_at,
            "source": "user_edit"
        }),
    );
    metadata.insert("sectionDrafts".to_string(), Value::Object(drafts));
    project.metadata = Some(Value::Object(metadata));
    project.updated_at = updated_at.to_string();
    Ok(project.clone())
}

pub(crate) fn update_learning_candidate_status(
    store: &mut AppStore,
    project_id: &str,
    candidate_id: &str,
    status: &str,
    updated_at: &str,
) -> Result<(RedclawProjectRecord, Value), String> {
    let project = store
        .redclaw_state
        .projects
        .iter_mut()
        .find(|item| item.id == project_id)
        .ok_or_else(|| "RedClaw project not found".to_string())?;
    let candidate = project
        .learning_candidates
        .iter_mut()
        .find(|item| item.get("id").and_then(Value::as_str).map(str::trim) == Some(candidate_id))
        .ok_or_else(|| "learning candidate not found".to_string())?;
    if let Some(object) = candidate.as_object_mut() {
        object.insert("status".to_string(), json!(status));
        object.insert("updatedAt".to_string(), json!(updated_at));
    }
    let candidate_snapshot = candidate.clone();
    project.updated_at = updated_at.to_string();
    Ok((project.clone(), candidate_snapshot))
}

pub(crate) fn list_scheduled_tasks(store: &AppStore) -> Vec<RedclawScheduledTaskRecord> {
    store.redclaw_state.scheduled_tasks.clone()
}

pub(crate) fn list_long_cycle_tasks(store: &AppStore) -> Vec<RedclawLongCycleTaskRecord> {
    store.redclaw_state.long_cycle_tasks.clone()
}

pub(crate) fn scheduled_task_by_id(
    store: &AppStore,
    task_id: &str,
) -> Option<RedclawScheduledTaskRecord> {
    store
        .redclaw_state
        .scheduled_tasks
        .iter()
        .find(|item| item.id == task_id)
        .cloned()
}

pub(crate) fn long_cycle_task_by_id(
    store: &AppStore,
    task_id: &str,
) -> Option<RedclawLongCycleTaskRecord> {
    store
        .redclaw_state
        .long_cycle_tasks
        .iter()
        .find(|item| item.id == task_id)
        .cloned()
}

pub(crate) fn push_scheduled_task(store: &mut AppStore, task: RedclawScheduledTaskRecord) {
    store.redclaw_state.scheduled_tasks.push(task);
}

pub(crate) fn push_long_cycle_task(store: &mut AppStore, task: RedclawLongCycleTaskRecord) {
    store.redclaw_state.long_cycle_tasks.push(task);
}

pub(crate) fn scheduled_task_for_definition(
    store: &AppStore,
    definition: &RedclawJobDefinitionRecord,
) -> Option<RedclawScheduledTaskRecord> {
    store
        .redclaw_state
        .scheduled_tasks
        .iter()
        .find(|item| definition.source_task_id.as_deref() == Some(item.id.as_str()))
        .cloned()
}

pub(crate) fn long_cycle_task_for_definition(
    store: &AppStore,
    definition: &RedclawJobDefinitionRecord,
) -> Option<RedclawLongCycleTaskRecord> {
    store
        .redclaw_state
        .long_cycle_tasks
        .iter()
        .find(|item| definition.source_task_id.as_deref() == Some(item.id.as_str()))
        .cloned()
}

pub(crate) fn update_scheduled_task_for_definition<F>(
    store: &mut AppStore,
    definition: &RedclawJobDefinitionRecord,
    update: F,
) -> Result<RedclawScheduledTaskRecord, String>
where
    F: FnOnce(&mut RedclawScheduledTaskRecord),
{
    let task = store
        .redclaw_state
        .scheduled_tasks
        .iter_mut()
        .find(|item| definition.source_task_id.as_deref() == Some(item.id.as_str()))
        .ok_or_else(|| "定时任务源记录不存在".to_string())?;
    update(task);
    Ok(task.clone())
}

pub(crate) fn update_long_cycle_task_for_definition<F>(
    store: &mut AppStore,
    definition: &RedclawJobDefinitionRecord,
    update: F,
) -> Result<RedclawLongCycleTaskRecord, String>
where
    F: FnOnce(&mut RedclawLongCycleTaskRecord),
{
    let task = store
        .redclaw_state
        .long_cycle_tasks
        .iter_mut()
        .find(|item| definition.source_task_id.as_deref() == Some(item.id.as_str()))
        .ok_or_else(|| "长周期任务源记录不存在".to_string())?;
    update(task);
    Ok(task.clone())
}

pub(crate) fn remove_scheduled_task(store: &mut AppStore, task_id: &str) {
    store
        .redclaw_state
        .scheduled_tasks
        .retain(|item| item.id != task_id);
}

pub(crate) fn set_scheduled_task_enabled(
    store: &mut AppStore,
    task_id: &str,
    enabled: bool,
    updated_at: &str,
) -> bool {
    store
        .redclaw_state
        .scheduled_tasks
        .iter_mut()
        .find(|item| item.id == task_id)
        .map(|task| {
            task.enabled = enabled;
            if enabled {
                task.last_error = None;
            }
            task.updated_at = updated_at.to_string();
        })
        .is_some()
}

pub(crate) fn remove_long_cycle_task(store: &mut AppStore, task_id: &str) {
    store
        .redclaw_state
        .long_cycle_tasks
        .retain(|item| item.id != task_id);
}

pub(crate) fn set_long_cycle_task_enabled(
    store: &mut AppStore,
    task_id: &str,
    enabled: bool,
    updated_at: &str,
) -> bool {
    store
        .redclaw_state
        .long_cycle_tasks
        .iter_mut()
        .find(|item| item.id == task_id)
        .map(|task| {
            task.enabled = enabled;
            task.status = if enabled {
                "running".to_string()
            } else {
                "paused".to_string()
            };
            if enabled {
                task.last_error = None;
            }
            task.updated_at = updated_at.to_string();
        })
        .is_some()
}

pub(crate) fn remove_source_task_for_definition(
    store: &mut AppStore,
    definition: &RedclawJobDefinitionRecord,
) {
    match definition.source_kind.as_deref() {
        Some("scheduled") => {
            if let Some(source_task_id) = definition.source_task_id.as_deref() {
                remove_scheduled_task(store, source_task_id);
            }
        }
        Some("long_cycle") => {
            if let Some(source_task_id) = definition.source_task_id.as_deref() {
                remove_long_cycle_task(store, source_task_id);
            }
        }
        _ => {
            remove_job_definition(store, &definition.id);
        }
    }
}

pub(crate) fn pause_source_task_for_definition(
    store: &mut AppStore,
    definition: &RedclawJobDefinitionRecord,
    reason: &str,
    updated_at: &str,
) {
    match definition.source_kind.as_deref() {
        Some("scheduled") => {
            if let Some(task) = store
                .redclaw_state
                .scheduled_tasks
                .iter_mut()
                .find(|item| definition.source_task_id.as_deref() == Some(item.id.as_str()))
            {
                task.enabled = false;
                task.last_error = Some(reason.to_string());
                task.updated_at = updated_at.to_string();
            }
        }
        Some("long_cycle") => {
            if let Some(task) = store
                .redclaw_state
                .long_cycle_tasks
                .iter_mut()
                .find(|item| definition.source_task_id.as_deref() == Some(item.id.as_str()))
            {
                task.enabled = false;
                task.status = "paused".to_string();
                task.last_error = Some(reason.to_string());
                task.updated_at = updated_at.to_string();
            }
        }
        _ => {}
    }
}

pub(crate) fn update_source_task_next_run(
    store: &mut AppStore,
    source_kind: Option<&str>,
    source_task_id: Option<&str>,
    next_run_at: Option<String>,
    updated_at: &str,
) {
    match source_kind {
        Some("scheduled") => {
            if let Some(task) = store
                .redclaw_state
                .scheduled_tasks
                .iter_mut()
                .find(|item| Some(item.id.as_str()) == source_task_id)
            {
                task.next_run_at = next_run_at;
                task.updated_at = updated_at.to_string();
            }
        }
        Some("long_cycle") => {
            if let Some(task) = store
                .redclaw_state
                .long_cycle_tasks
                .iter_mut()
                .find(|item| Some(item.id.as_str()) == source_task_id)
            {
                task.next_run_at = next_run_at;
                task.updated_at = updated_at.to_string();
            }
        }
        _ => {}
    }
}

pub(crate) fn activate_job_definition_cooldown(
    store: &mut AppStore,
    definition_id: &str,
    source_kind: Option<&str>,
    source_task_id: Option<&str>,
    error: &str,
    now_iso: &str,
    consecutive_failures: usize,
) {
    if let Some(definition) = store
        .redclaw_job_definitions
        .iter_mut()
        .find(|item| item.id == definition_id)
    {
        definition.enabled = false;
        definition.updated_at = now_iso.to_string();
        if let Some(object) = definition.payload.as_object_mut() {
            object.insert(
                "cooldown".to_string(),
                json!({
                    "state": "active",
                    "activatedAt": now_iso,
                    "consecutiveFailures": consecutive_failures,
                    "reason": error,
                }),
            );
        }
    }

    match source_kind {
        Some("scheduled") => {
            if let Some(task) = store
                .redclaw_state
                .scheduled_tasks
                .iter_mut()
                .find(|item| Some(item.id.as_str()) == source_task_id)
            {
                task.enabled = false;
                task.last_error = Some(error.to_string());
                task.updated_at = now_iso.to_string();
            }
        }
        Some("long_cycle") => {
            if let Some(task) = store
                .redclaw_state
                .long_cycle_tasks
                .iter_mut()
                .find(|item| Some(item.id.as_str()) == source_task_id)
            {
                task.enabled = false;
                task.status = "paused".to_string();
                task.last_error = Some(error.to_string());
                task.updated_at = now_iso.to_string();
            }
        }
        _ => {}
    }
}

pub(crate) fn mark_source_task_succeeded(
    store: &mut AppStore,
    source_kind: Option<&str>,
    source_task_id: Option<&str>,
    now_iso: &str,
) {
    match source_kind {
        Some("scheduled") => {
            if let Some(task) = store
                .redclaw_state
                .scheduled_tasks
                .iter_mut()
                .find(|item| Some(item.id.as_str()) == source_task_id)
            {
                task.last_run_at = Some(now_iso.to_string());
                task.last_result = Some("success".to_string());
                task.last_error = None;
                task.updated_at = now_iso.to_string();
                if task.mode == "once" {
                    task.enabled = false;
                    task.next_run_at = None;
                }
            }
        }
        Some("long_cycle") => {
            if let Some(task) = store
                .redclaw_state
                .long_cycle_tasks
                .iter_mut()
                .find(|item| Some(item.id.as_str()) == source_task_id)
            {
                task.completed_rounds += 1;
                task.last_run_at = Some(now_iso.to_string());
                task.last_result = Some("success".to_string());
                task.last_error = None;
                task.updated_at = now_iso.to_string();
                task.status = if task.completed_rounds >= task.total_rounds {
                    task.enabled = false;
                    task.next_run_at = None;
                    "completed".to_string()
                } else {
                    "running".to_string()
                };
            }
        }
        _ => {}
    }
}

pub(crate) fn mark_source_task_failed(
    store: &mut AppStore,
    source_kind: Option<&str>,
    source_task_id: Option<&str>,
    error: &str,
    now_iso: &str,
) {
    match source_kind {
        Some("scheduled") => {
            if let Some(task) = store
                .redclaw_state
                .scheduled_tasks
                .iter_mut()
                .find(|item| Some(item.id.as_str()) == source_task_id)
            {
                task.last_error = Some(error.to_string());
                task.last_result = Some("failed".to_string());
                task.updated_at = now_iso.to_string();
            }
        }
        Some("long_cycle") => {
            if let Some(task) = store
                .redclaw_state
                .long_cycle_tasks
                .iter_mut()
                .find(|item| Some(item.id.as_str()) == source_task_id)
            {
                task.last_error = Some(error.to_string());
                task.last_result = Some("failed".to_string());
                task.status = "failed".to_string();
                task.updated_at = now_iso.to_string();
            }
        }
        _ => {}
    }
}

pub(crate) fn cancel_scheduled_task(
    store: &mut AppStore,
    task_id: &str,
    reason: &str,
    now_iso: &str,
) -> Option<String> {
    store
        .redclaw_state
        .scheduled_tasks
        .iter_mut()
        .find(|item| item.id == task_id)
        .map(|task| {
            task.enabled = false;
            task.last_error = Some(reason.to_string());
            task.updated_at = now_iso.to_string();
            task.id.clone()
        })
}

pub(crate) fn cancel_long_cycle_task(
    store: &mut AppStore,
    task_id: &str,
    reason: &str,
    now_iso: &str,
) -> Option<String> {
    store
        .redclaw_state
        .long_cycle_tasks
        .iter_mut()
        .find(|item| item.id == task_id)
        .map(|task| {
            task.enabled = false;
            task.status = "cancelled".to_string();
            task.last_error = Some(reason.to_string());
            task.updated_at = now_iso.to_string();
            task.id.clone()
        })
}

pub(crate) fn job_definition_sync_snapshot(
    store: &AppStore,
) -> (
    Vec<RedclawJobDefinitionRecord>,
    Vec<RedclawScheduledTaskRecord>,
    Vec<RedclawLongCycleTaskRecord>,
) {
    (
        list_job_definitions(store),
        list_scheduled_tasks(store),
        list_long_cycle_tasks(store),
    )
}

pub(crate) fn list_job_definitions(store: &AppStore) -> Vec<RedclawJobDefinitionRecord> {
    store.redclaw_job_definitions.clone()
}

pub(crate) fn job_definition_by_id(
    store: &AppStore,
    job_definition_id: &str,
) -> Option<RedclawJobDefinitionRecord> {
    store
        .redclaw_job_definitions
        .iter()
        .find(|item| item.id == job_definition_id)
        .cloned()
}

pub(crate) fn job_definition_id_by_source(
    store: &AppStore,
    source_kind: &str,
    source_task_id: &str,
) -> Option<String> {
    store
        .redclaw_job_definitions
        .iter()
        .find(|item| {
            item.source_kind.as_deref() == Some(source_kind)
                && item.source_task_id.as_deref() == Some(source_task_id)
        })
        .map(|item| item.id.clone())
}

pub(crate) fn job_definition_id_by_id_or_source_task(
    store: &AppStore,
    task_id: &str,
) -> Option<String> {
    store
        .redclaw_job_definitions
        .iter()
        .find(|item| item.id == task_id || item.source_task_id.as_deref() == Some(task_id))
        .map(|item| item.id.clone())
}

pub(crate) fn find_confirmable_job_definition(
    store: &AppStore,
    owner_scope: &str,
    definition_fingerprint: &str,
) -> Option<RedclawJobDefinitionRecord> {
    store
        .redclaw_job_definitions
        .iter()
        .find(|item| {
            item.requires_confirmation
                && item.owner_scope.as_deref() == Some(owner_scope)
                && item.definition_fingerprint.as_deref() == Some(definition_fingerprint)
        })
        .cloned()
}

pub(crate) fn push_job_definition(store: &mut AppStore, definition: RedclawJobDefinitionRecord) {
    store.redclaw_job_definitions.push(definition);
}

pub(crate) fn replace_job_definitions(
    store: &mut AppStore,
    definitions: Vec<RedclawJobDefinitionRecord>,
) {
    store.redclaw_job_definitions = definitions;
}

pub(crate) fn remove_job_definition(store: &mut AppStore, job_definition_id: &str) {
    store
        .redclaw_job_definitions
        .retain(|item| item.id != job_definition_id);
}

pub(crate) fn update_job_definition<R>(
    store: &mut AppStore,
    job_definition_id: &str,
    update: impl FnOnce(&mut RedclawJobDefinitionRecord) -> R,
) -> Option<R> {
    store
        .redclaw_job_definitions
        .iter_mut()
        .find(|item| item.id == job_definition_id)
        .map(update)
}

pub(crate) fn update_job_definition_by_source<R>(
    store: &mut AppStore,
    source_kind: &str,
    source_task_id: &str,
    update: impl FnOnce(&mut RedclawJobDefinitionRecord) -> R,
) -> Option<R> {
    store
        .redclaw_job_definitions
        .iter_mut()
        .find(|item| {
            item.source_kind.as_deref() == Some(source_kind)
                && item.source_task_id.as_deref() == Some(source_task_id)
        })
        .map(update)
}

pub(crate) fn list_job_executions(store: &AppStore) -> Vec<RedclawJobExecutionRecord> {
    store.redclaw_job_executions.clone()
}

pub(crate) fn job_execution_count(store: &AppStore) -> usize {
    store.redclaw_job_executions.len()
}

pub(crate) fn job_execution_id_exists(store: &AppStore, execution_id: &str) -> bool {
    store
        .redclaw_job_executions
        .iter()
        .any(|item| item.id == execution_id)
}

pub(crate) fn active_job_execution_exists(store: &AppStore, definition_id: &str) -> bool {
    store.redclaw_job_executions.iter().any(|item| {
        item.definition_id == definition_id
            && matches!(
                item.status.as_str(),
                "queued" | "leased" | "running" | "retrying"
            )
    })
}

pub(crate) fn duplicate_job_execution_anchor_id(
    store: &AppStore,
    definition_id: &str,
    scheduled_for_at: &str,
) -> Option<String> {
    store
        .redclaw_job_executions
        .iter()
        .find(|item| {
            item.archived_at.is_none()
                && item.definition_id == definition_id
                && item.scheduled_for_at.as_deref() == Some(scheduled_for_at)
        })
        .map(|item| item.id.clone())
}

pub(crate) fn latest_job_execution_id_for_definition(
    store: &AppStore,
    definition_id: &str,
) -> Option<String> {
    store
        .redclaw_job_executions
        .iter()
        .filter(|item| item.definition_id == definition_id)
        .max_by(|left, right| left.updated_at.cmp(&right.updated_at))
        .map(|item| item.id.clone())
}

pub(crate) fn job_execution_id_by_task_or_definition(
    store: &AppStore,
    task_id: &str,
) -> Option<String> {
    store
        .redclaw_job_executions
        .iter()
        .find(|item| item.id == task_id || item.definition_id == task_id)
        .map(|item| item.id.clone())
}

pub(crate) fn job_execution_definition_id_by_task_or_definition(
    store: &AppStore,
    task_id: &str,
) -> Option<String> {
    store
        .redclaw_job_executions
        .iter()
        .find(|item| item.id == task_id || item.definition_id == task_id)
        .map(|item| item.definition_id.clone())
}

pub(crate) fn job_execution_status_by_id(store: &AppStore, execution_id: &str) -> Option<String> {
    store
        .redclaw_job_executions
        .iter()
        .find(|item| item.id == execution_id)
        .map(|item| item.status.clone())
}

#[cfg(test)]
pub(crate) fn job_execution_is_archived(store: &AppStore, execution_id: &str) -> bool {
    store
        .redclaw_job_executions
        .iter()
        .find(|item| item.id == execution_id)
        .and_then(|item| item.archived_at.as_deref())
        .is_some()
}

pub(crate) fn consecutive_job_failure_count(store: &AppStore, definition_id: &str) -> usize {
    let mut executions = store
        .redclaw_job_executions
        .iter()
        .filter(|item| item.definition_id == definition_id && item.archived_at.is_none())
        .collect::<Vec<_>>();
    executions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    let mut consecutive = 0;
    for execution in executions {
        match execution.status.as_str() {
            "failed" | "dead_lettered" => consecutive += 1,
            "succeeded" | "completed" | "cancelled" => break,
            _ => {}
        }
    }
    consecutive
}

pub(crate) fn push_job_execution(store: &mut AppStore, execution: RedclawJobExecutionRecord) {
    store.redclaw_job_executions.push(execution);
}

pub(crate) fn update_job_execution<R>(
    store: &mut AppStore,
    execution_id: &str,
    update: impl FnOnce(&mut RedclawJobExecutionRecord) -> R,
) -> Option<R> {
    store
        .redclaw_job_executions
        .iter_mut()
        .find(|item| item.id == execution_id)
        .map(update)
}

pub(crate) fn for_each_job_execution_mut(
    store: &mut AppStore,
    mut update: impl FnMut(&mut RedclawJobExecutionRecord),
) {
    for execution in store.redclaw_job_executions.iter_mut() {
        update(execution);
    }
}

pub(crate) fn claim_job_execution(
    store: &mut AppStore,
    preferred_execution_id: Option<&str>,
    mut retry_ready: impl FnMut(Option<&str>) -> bool,
    mut claim: impl FnMut(&mut RedclawJobExecutionRecord) -> Result<(), String>,
) -> Result<Option<RedclawJobExecutionRecord>, String> {
    let candidate_index = if let Some(execution_id) = preferred_execution_id {
        store.redclaw_job_executions.iter().position(|item| {
            item.id == execution_id
                && matches!(item.status.as_str(), "queued" | "retrying" | "cancelled")
                && retry_ready(item.retry_not_before_at.as_deref())
        })
    } else {
        store.redclaw_job_executions.iter().position(|item| {
            item.status == "queued" && retry_ready(item.retry_not_before_at.as_deref())
        })
    };
    let Some(index) = candidate_index else {
        return Ok(None);
    };

    let definition_id = store.redclaw_job_executions[index].definition_id.clone();
    if preferred_execution_id.is_none()
        && store.redclaw_job_executions.iter().any(|item| {
            item.definition_id == definition_id
                && matches!(item.status.as_str(), "leased" | "running")
        })
    {
        return Ok(None);
    }

    claim(&mut store.redclaw_job_executions[index])?;
    Ok(Some(store.redclaw_job_executions[index].clone()))
}

pub(crate) fn archive_job_execution(
    store: &mut AppStore,
    task_id: &str,
    now_iso: &str,
    is_active_status: impl Fn(&str) -> bool,
) -> Result<String, String> {
    let execution = store
        .redclaw_job_executions
        .iter_mut()
        .find(|item| {
            item.id == task_id
                || item.definition_id == task_id
                || item
                    .input_snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.get("sourceTaskId"))
                    .and_then(Value::as_str)
                    == Some(task_id)
        })
        .ok_or_else(|| "任务执行实例不存在".to_string())?;
    if is_active_status(&execution.status) {
        return Err("运行中的执行实例不能归档".to_string());
    }
    execution.archived_at = Some(now_iso.to_string());
    execution.updated_at = now_iso.to_string();
    Ok(execution.id.clone())
}
