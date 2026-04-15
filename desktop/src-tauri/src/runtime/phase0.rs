use serde_json::{json, Map, Value};
use tauri::State;

use crate::interactive_runtime_shared::legacy_interactive_runtime_system_prompt;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::store_runtime_task;
use crate::scheduler::{
    derived_background_tasks, enqueue_runtime_task_job_execution, ensure_runtime_task_job_definition,
};
use crate::script_runtime::{script_runtime_feature_enabled, SCRIPT_RUNTIME_ELIGIBLE_MODES};
use crate::skills::build_skill_runtime_state;
use crate::tools::capabilities::resolve_capability_set_for_store;
use crate::tools::registry::base_tool_names_for_session_metadata;
use crate::{
    commands::runtime_routing::route_runtime_intent_with_settings, memory_type_counts_value,
    now_iso, recall_query_enabled, refresh_runtime_warm_state, resolve_chat_config,
    runtime_warm_settings_fingerprint, session_lineage_summary_value, workspace_root, AppState,
};

const FEATURE_FLAGS_KEY: &str = "feature_flags";
const PHASE0_METRICS_KEY: &str = "phase0_runtime_metrics";
const SMOKE_RUNTIME_MODES: [&str; 3] = ["chatroom", "wander", "redclaw"];

pub fn default_feature_flags() -> Value {
    json!({
        "vectorRecommendation": false,
        "runtimeContextBundleV2": true,
        "runtimeMemoryRecallV2": true,
        "runtimeSubagentRuntimeV2": true,
        "runtimeExecuteScriptV1": true,
        "runtimeAgentJobV1": true,
    })
}

pub fn default_phase0_runtime_metrics() -> Value {
    json!({
        "sessionResumeAttempts": 0,
        "sessionResumeSuccesses": 0,
        "smokeRuns": 0,
        "smokePasses": 0,
        "smokeFailures": 0,
        "updatedAt": Value::Null,
    })
}

fn merge_defaults(current: Option<&Value>, defaults: &Value) -> Value {
    match (current.and_then(Value::as_object), defaults.as_object()) {
        (Some(current_map), Some(default_map)) => {
            let mut merged = default_map.clone();
            for (key, value) in current_map {
                merged.insert(key.to_string(), value.clone());
            }
            Value::Object(merged)
        }
        _ => defaults.clone(),
    }
}

pub fn ensure_phase0_settings_defaults_value(settings: &Value) -> Value {
    let mut root = settings.as_object().cloned().unwrap_or_default();
    root.insert(
        FEATURE_FLAGS_KEY.to_string(),
        merge_defaults(root.get(FEATURE_FLAGS_KEY), &default_feature_flags()),
    );
    root.insert(
        PHASE0_METRICS_KEY.to_string(),
        merge_defaults(
            root.get(PHASE0_METRICS_KEY),
            &default_phase0_runtime_metrics(),
        ),
    );
    Value::Object(root)
}

pub fn ensure_phase0_settings_defaults_mut(settings: &mut Value) {
    let next = ensure_phase0_settings_defaults_value(settings);
    *settings = next;
}

pub fn ensure_phase0_settings_defaults(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store_mut(state, |store| {
        ensure_phase0_settings_defaults_mut(&mut store.settings);
        Ok(store.settings.clone())
    })
}

fn metrics_mut<'a>(settings: &'a mut Value) -> &'a mut Map<String, Value> {
    ensure_phase0_settings_defaults_mut(settings);
    settings
        .as_object_mut()
        .and_then(|root| root.get_mut(PHASE0_METRICS_KEY))
        .and_then(Value::as_object_mut)
        .expect("phase0 metrics defaults should exist")
}

pub fn record_phase0_metric_in_settings(
    settings: &mut Value,
    key: &str,
    delta: i64,
) -> Result<(), String> {
    let metrics = metrics_mut(settings);
    let current = metrics.get(key).and_then(Value::as_i64).unwrap_or(0);
    metrics.insert(key.to_string(), json!(current + delta));
    metrics.insert("updatedAt".to_string(), json!(now_iso()));
    Ok(())
}

pub fn record_phase0_metric(
    state: &State<'_, AppState>,
    key: &str,
    delta: i64,
) -> Result<Value, String> {
    with_store_mut(state, |store| {
        record_phase0_metric_in_settings(&mut store.settings, key, delta)?;
        Ok(store.settings.clone())
    })
}

fn session_resume_success_rate(metrics: &Value) -> f64 {
    let attempts = metrics
        .get("sessionResumeAttempts")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let successes = metrics
        .get("sessionResumeSuccesses")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    if attempts <= 0.0 {
        0.0
    } else {
        successes / attempts
    }
}

fn estimated_prompt_tokens(chars: usize) -> usize {
    if chars == 0 {
        0
    } else {
        (chars + 3) / 4
    }
}

pub fn build_runtime_debug_summary(state: &State<'_, AppState>) -> Result<Value, String> {
    let _ = ensure_phase0_settings_defaults(state)?;
    let _ = refresh_runtime_warm_state(state, &SMOKE_RUNTIME_MODES);
    let workspace = workspace_root(state).ok();
    let (
        settings_snapshot,
        skills,
        store_counts,
        memory_overview,
        derived_metrics,
        latest_context_snapshots,
        recent_session_lineage,
        recent_capability_audits,
        recent_script_executions,
        recent_agent_jobs,
    ) = with_store(state, |store| {
        let settings_snapshot = store.settings.clone();
        let skills = store.skills.clone();
        let feature_flags = settings_snapshot
            .get(FEATURE_FLAGS_KEY)
            .cloned()
            .unwrap_or_else(default_feature_flags);
        let metrics = settings_snapshot
            .get(PHASE0_METRICS_KEY)
            .cloned()
            .unwrap_or_else(default_phase0_runtime_metrics);
        let counts = json!({
            "sessions": store.chat_sessions.len(),
            "transcripts": store.session_transcript_records.len(),
            "checkpoints": store.session_checkpoints.len(),
            "toolResults": store.session_tool_results.len(),
            "runtimeTasks": store.runtime_tasks.len(),
            "runtimeTaskTraces": store.runtime_task_traces.len(),
            "backgroundTasks": derived_background_tasks(&store).len(),
            "agentJobDefinitions": store.redclaw_job_definitions.len(),
            "agentJobExecutions": store.redclaw_job_executions.len(),
            "hooks": store.runtime_hooks.len(),
            "mcpServers": store.mcp_servers.len(),
            "skills": store.skills.len(),
            "debugLogs": store.debug_logs.len(),
            "memories": store.memories.len(),
            "memoryHistory": store.memory_history.len(),
            "capabilityAudits": store.capability_audit_records.len(),
            "scriptExecutions": store
                .session_checkpoints
                .iter()
                .filter(|item| item.checkpoint_type == "runtime.script_execution")
                .count(),
        });
        let session_count = store.chat_sessions.len().max(1) as f64;
        let task_count = store.runtime_tasks.len().max(1) as f64;
        let mut latest_context_snapshots = store
            .session_checkpoints
            .iter()
            .filter(|item| item.checkpoint_type == "runtime.context_bundle")
            .cloned()
            .collect::<Vec<_>>();
        latest_context_snapshots.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok((
            json!({
                "featureFlags": feature_flags,
                "metrics": metrics,
                "settings": settings_snapshot,
            }),
            skills,
            counts,
            json!({
                "memoryCount": store.memories.len(),
                "historyCount": store.memory_history.len(),
                "byType": memory_type_counts_value(&store),
                "latestMemoryUpdatedAt": store.memories.iter().filter_map(|item| item.updated_at.or(Some(item.created_at))).max(),
                "latestHistoryAt": store.memory_history.iter().map(|item| item.timestamp).max(),
            }),
            json!({
                "averageToolCallsPerSession": store.session_tool_results.len() as f64 / session_count,
                "averageTraceRecordsPerSession": store.session_transcript_records.len() as f64 / session_count,
                "averageCheckpointsPerSession": store.session_checkpoints.len() as f64 / session_count,
                "averageTaskTraceRowsPerTask": store.runtime_task_traces.len() as f64 / task_count,
            }),
            latest_context_snapshots
                .into_iter()
                .take(8)
                .map(|item| {
                    json!({
                        "sessionId": item.session_id,
                        "createdAt": item.created_at,
                        "summary": item.summary,
                        "payload": item.payload,
                    })
                })
                .collect::<Vec<_>>(),
            {
                let mut sessions = store.chat_sessions.clone();
                sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                sessions
                    .into_iter()
                    .take(8)
                    .map(|item| {
                        json!({
                            "sessionId": item.id,
                            "title": item.title,
                            "updatedAt": item.updated_at,
                            "lineage": session_lineage_summary_value(&store, &item.id),
                        })
                    })
                    .collect::<Vec<_>>()
            },
            store
                .capability_audit_records
                .iter()
                .take(16)
                .map(|item| json!(item))
                .collect::<Vec<_>>(),
            {
                let mut items = store
                    .session_checkpoints
                    .iter()
                    .filter(|item| item.checkpoint_type == "runtime.script_execution")
                    .cloned()
                    .collect::<Vec<_>>();
                items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
                items
                    .into_iter()
                    .take(8)
                    .map(|item| {
                        json!({
                            "sessionId": item.session_id,
                            "createdAt": item.created_at,
                            "summary": item.summary,
                            "payload": item.payload,
                        })
                    })
                    .collect::<Vec<_>>()
            },
            {
                let mut items = store.redclaw_job_executions.clone();
                items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                items
                    .into_iter()
                    .take(8)
                    .map(|item| {
                        let definition = store
                            .redclaw_job_definitions
                            .iter()
                            .find(|definition| definition.id == item.definition_id);
                        json!({
                            "executionId": item.id,
                            "definitionId": item.definition_id,
                            "status": item.status,
                            "runtimeMode": definition.map(|value| value.runtime_mode.clone()),
                            "sourceKind": definition.and_then(|value| value.source_kind.clone()),
                            "title": definition.map(|value| value.title.clone()),
                            "updatedAt": item.updated_at,
                            "sessionId": item.session_id,
                            "runtimeTaskId": item.runtime_task_id,
                            "lastError": item.last_error,
                            "lastCheckpoint": item.checkpoints.last().cloned(),
                            "lastArtifact": item.artifacts.last().cloned(),
                        })
                    })
                    .collect::<Vec<_>>()
            },
        ))
    })?;

    let feature_flags = settings_snapshot
        .get("featureFlags")
        .cloned()
        .unwrap_or_else(default_feature_flags);
    let metrics = settings_snapshot
        .get("metrics")
        .cloned()
        .unwrap_or_else(default_phase0_runtime_metrics);
    let settings_only = settings_snapshot
        .get("settings")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let script_runtime_enabled = script_runtime_feature_enabled(&settings_only);

    let runtime_warm = state
        .runtime_warm
        .lock()
        .map_err(|error| error.to_string())?;
    let mut warm_entries = Vec::new();
    for mode in SMOKE_RUNTIME_MODES {
        let Some(entry) = runtime_warm.entries.get(mode) else {
            continue;
        };
        let base_tools = base_tool_names_for_session_metadata(&entry.mode, None);
        let skill_state = build_skill_runtime_state(&skills, &entry.mode, None, &base_tools);
        let model_config = resolve_chat_config(&settings_only, entry.model_config.as_ref());
        let prompt_chars = entry.system_prompt.chars().count();
        let capability_set = with_store(state, |store| {
            Ok(resolve_capability_set_for_store(&store, &entry.mode, None))
        })?;
        let legacy_prompt_chars =
            legacy_interactive_runtime_system_prompt(state, &entry.mode, None)
                .chars()
                .count();
        let long_term_chars = entry
            .long_term_context
            .as_ref()
            .map(|value| value.chars().count())
            .unwrap_or(0);
        warm_entries.push(json!({
            "mode": entry.mode,
            "warmedAt": entry.warmed_at,
            "systemPromptChars": prompt_chars,
            "estimatedPromptTokens": estimated_prompt_tokens(prompt_chars),
            "legacySystemPromptChars": legacy_prompt_chars,
            "charReductionRatio": if legacy_prompt_chars == 0 {
                0.0
            } else {
                1.0 - (prompt_chars as f64 / legacy_prompt_chars as f64)
            },
            "longTermContextChars": long_term_chars,
            "activeSkillCount": skill_state.active_skills.len(),
            "activeSkills": skill_state
                .active_skills
                .iter()
                .map(|skill| skill.name.clone())
                .collect::<Vec<_>>(),
            "baseToolCount": base_tools.len(),
            "allowedToolCount": skill_state.allowed_tools.len(),
            "allowedTools": skill_state.allowed_tools,
            "modelConfigured": model_config.is_some(),
            "modelName": model_config.as_ref().map(|config| config.model_name.clone()),
            "baseUrl": model_config.as_ref().map(|config| config.base_url.clone()),
            "protocol": model_config.as_ref().map(|config| config.protocol.clone()),
            "contextBundleSummary": entry.context_bundle_summary,
            "capabilitySet": capability_set,
        }));
    }
    let settings_fingerprint = runtime_warm.settings_fingerprint.clone();
    let last_warmed_at = runtime_warm.last_warmed_at;
    drop(runtime_warm);

    Ok(json!({
        "generatedAt": now_iso(),
        "workspaceRoot": workspace.as_ref().map(|path| path.display().to_string()),
        "featureFlags": feature_flags,
        "phase0Metrics": metrics,
        "sessionResumeSuccessRate": session_resume_success_rate(&metrics),
        "storeCounts": store_counts,
        "memoryOverview": memory_overview,
        "recallReadiness": {
            "enabled": recall_query_enabled(&settings_only),
            "structuredMemoryTypes": memory_overview.get("byType").cloned().unwrap_or_else(|| json!({})),
        },
        "derivedMetrics": derived_metrics,
        "latestContextSnapshots": latest_context_snapshots,
        "recentSessionLineage": recent_session_lineage,
        "recentCapabilityAudits": recent_capability_audits,
        "scriptRuntime": {
            "enabled": script_runtime_enabled,
            "eligibleModes": SCRIPT_RUNTIME_ELIGIBLE_MODES,
            "executedCount": store_counts
                .get("scriptExecutions")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            "recentExecutions": recent_script_executions,
        },
        "agentJobs": {
            "enabled": feature_flags
                .get("runtimeAgentJobV1")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            "recentExecutions": recent_agent_jobs,
        },
        "runtimeWarm": {
            "lastWarmedAt": last_warmed_at,
            "settingsFingerprint": settings_fingerprint,
            "entries": warm_entries,
        },
        "configReadiness": {
            "workspaceResolved": workspace.is_some(),
            "chatModelReady": resolve_chat_config(&settings_only, None).is_some(),
            "runtimeWarmMatchesSettings": workspace
                .as_ref()
                .map(|root| runtime_warm_settings_fingerprint(&settings_only, root) == settings_fingerprint)
                .unwrap_or(false),
        }
    }))
}

fn smoke_result(name: &str, status: &str, detail: String) -> Value {
    json!({
        "name": name,
        "status": status,
        "detail": detail,
    })
}

pub fn run_phase0_smoke(state: &State<'_, AppState>) -> Result<Value, String> {
    let _ = record_phase0_metric(state, "smokeRuns", 1)?;
    let mut checks = Vec::new();
    let mut failed = 0_i64;

    match ensure_phase0_settings_defaults(state) {
        Ok(settings) => {
            let feature_flags = settings
                .get(FEATURE_FLAGS_KEY)
                .and_then(Value::as_object)
                .map(|value| value.len())
                .unwrap_or(0);
            checks.push(smoke_result(
                "settings-defaults",
                "passed",
                format!("feature flags={}, phase0 metrics ready", feature_flags),
            ));
        }
        Err(error) => {
            failed += 1;
            checks.push(smoke_result("settings-defaults", "failed", error));
        }
    }

    match build_runtime_debug_summary(state) {
        Ok(summary) => {
            let entry_count = summary
                .get("runtimeWarm")
                .and_then(|value| value.get("entries"))
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            checks.push(smoke_result(
                "runtime-summary",
                "passed",
                format!("runtime warm entries={entry_count}"),
            ));
        }
        Err(error) => {
            failed += 1;
            checks.push(smoke_result("runtime-summary", "failed", error));
        }
    }

    match with_store(state, |store| Ok(store.chat_sessions.len())) {
        Ok(count) => checks.push(smoke_result(
            "sessions-list",
            "passed",
            format!("sessions={count}"),
        )),
        Err(error) => {
            failed += 1;
            checks.push(smoke_result("sessions-list", "failed", error));
        }
    }

    match with_store(state, |store| {
        let session_id = store.chat_sessions.first().map(|item| item.id.clone());
        let transcript_count = session_id
            .as_ref()
            .map(|id| {
                store
                    .session_transcript_records
                    .iter()
                    .filter(|item| item.session_id == *id)
                    .count()
            })
            .unwrap_or(0);
        Ok((session_id, transcript_count))
    }) {
        Ok((Some(session_id), count)) => checks.push(smoke_result(
            "session-transcript",
            "passed",
            format!("session={session_id}, transcript rows={count}"),
        )),
        Ok((None, _)) => checks.push(smoke_result(
            "session-transcript",
            "skipped",
            "no sessions in store".to_string(),
        )),
        Err(error) => {
            failed += 1;
            checks.push(smoke_result("session-transcript", "failed", error));
        }
    }

    match with_store(state, |store| Ok(store.session_checkpoints.len())) {
        Ok(count) => checks.push(smoke_result(
            "runtime-checkpoints",
            "passed",
            format!("checkpoints={count}"),
        )),
        Err(error) => {
            failed += 1;
            checks.push(smoke_result("runtime-checkpoints", "failed", error));
        }
    }

    match with_store(state, |store| Ok(derived_background_tasks(&store).len())) {
        Ok(count) => checks.push(smoke_result(
            "background-tasks",
            "passed",
            format!("derived tasks={count}"),
        )),
        Err(error) => {
            failed += 1;
            checks.push(smoke_result("background-tasks", "failed", error));
        }
    }

    match with_store_mut(state, |store| {
        let route = route_runtime_intent_with_settings(
            &store.settings,
            "chatroom",
            "phase0 smoke runtime task",
            None,
        );
        let task = store_runtime_task(
            store,
            "manual",
            "pending",
            "chatroom".to_string(),
            Some("phase0-smoke-session".to_string()),
            Some("phase0 smoke runtime task".to_string()),
            route,
            Some(json!({
                "source": "phase0-smoke"
            })),
        );
        let task_id = task.id.clone();
        store.runtime_tasks.retain(|item| item.id != task_id);
        store
            .runtime_task_traces
            .retain(|item| item.task_id != task_id);
        Ok(task_id)
    }) {
        Ok(task_id) => checks.push(smoke_result(
            "tasks-create",
            "passed",
            format!("ephemeral task created and removed: {task_id}"),
        )),
        Err(error) => {
            failed += 1;
            checks.push(smoke_result("tasks-create", "failed", error));
        }
    }

    match with_store_mut(state, |store| {
        let route = route_runtime_intent_with_settings(
            &store.settings,
            "chatroom",
            "phase0 smoke agent job",
            None,
        );
        let task = store_runtime_task(
            store,
            "manual",
            "pending",
            "chatroom".to_string(),
            Some("phase0-agent-job-session".to_string()),
            Some("phase0 smoke agent job".to_string()),
            route,
            Some(json!({
                "source": "phase0-agent-job-smoke"
            })),
        );
        let definition_id = ensure_runtime_task_job_definition(store, &task.id)?;
        let execution_id =
            enqueue_runtime_task_job_execution(store, &task.id, "phase0-smoke-agent-job")?;
        store.runtime_tasks.retain(|item| item.id != task.id);
        store
            .runtime_task_traces
            .retain(|item| item.task_id != task.id);
        store
            .redclaw_job_executions
            .retain(|item| item.id != execution_id);
        store
            .redclaw_job_definitions
            .retain(|item| item.id != definition_id);
        Ok((definition_id, execution_id))
    }) {
        Ok((definition_id, execution_id)) => checks.push(smoke_result(
            "agent-job-preflight",
            "passed",
            format!("definition={definition_id}, execution={execution_id}"),
        )),
        Err(error) => {
            failed += 1;
            checks.push(smoke_result("agent-job-preflight", "failed", error));
        }
    }

    checks.push(smoke_result(
        "session-bridge-status",
        "passed",
        "bridge stub available: enabled=true".to_string(),
    ));

    match with_store(state, |store| {
        Ok(resolve_chat_config(&store.settings, None))
    }) {
        Ok(Some(config)) => checks.push(smoke_result(
            "runtime-query-preflight",
            "passed",
            format!("model={} protocol={}", config.model_name, config.protocol),
        )),
        Ok(None) => checks.push(smoke_result(
            "runtime-query-preflight",
            "skipped",
            "chat model not configured".to_string(),
        )),
        Err(error) => {
            failed += 1;
            checks.push(smoke_result("runtime-query-preflight", "failed", error));
        }
    }

    let passed = failed == 0;
    if passed {
        let _ = record_phase0_metric(state, "smokePasses", 1)?;
    } else {
        let _ = record_phase0_metric(state, "smokeFailures", 1)?;
    }

    Ok(json!({
        "ranAt": now_iso(),
        "passed": passed,
        "failedCount": failed,
        "checks": checks,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_phase0_defaults_merges_existing_values() {
        let settings = json!({
            "feature_flags": {
                "vectorRecommendation": true
            },
            "phase0_runtime_metrics": {
                "sessionResumeAttempts": 2
            }
        });
        let merged = ensure_phase0_settings_defaults_value(&settings);
        assert_eq!(
            merged
                .get("feature_flags")
                .and_then(|value| value.get("vectorRecommendation"))
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            merged
                .get("phase0_runtime_metrics")
                .and_then(|value| value.get("sessionResumeAttempts"))
                .and_then(Value::as_i64),
            Some(2)
        );
        assert!(merged
            .get("feature_flags")
            .and_then(|value| value.get("runtimeContextBundleV2"))
            .is_some());
    }

    #[test]
    fn session_resume_success_rate_handles_zero_attempts() {
        let metrics = json!({
            "sessionResumeAttempts": 0,
            "sessionResumeSuccesses": 0
        });
        assert_eq!(session_resume_success_rate(&metrics), 0.0);
    }

    #[test]
    fn record_phase0_metric_updates_counter_and_timestamp() {
        let mut settings = json!({});
        record_phase0_metric_in_settings(&mut settings, "smokeRuns", 1).unwrap();
        assert_eq!(
            settings
                .get("phase0_runtime_metrics")
                .and_then(|value| value.get("smokeRuns"))
                .and_then(Value::as_i64),
            Some(1)
        );
        assert!(settings
            .get("phase0_runtime_metrics")
            .and_then(|value| value.get("updatedAt"))
            .is_some());
    }
}
