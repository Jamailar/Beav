use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::persistence::with_store;
use crate::runtime::{runtime_approval_snapshot, RuntimeWarmEntry, SessionToolResultRecord};
use crate::{cli_runtime, media_runtime, now_i64, payload_string, AppState};

const DIAGNOSTIC_HISTORY_LIMIT: usize = 100;
const RECENT_PREVIEW_LIMIT: usize = 12;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AdvisorPersonaMetric {
    pub advisor_id: String,
    pub session_advisor_name: Option<String>,
    pub knowledge_language: Option<String>,
    pub elapsed_ms: i64,
    pub search_elapsed_ms: Option<i64>,
    pub search_hit_count: i64,
    pub advisor_knowledge_hit_count: i64,
    pub manuscript_hit_count: i64,
    pub knowledge_file_count: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AdvisorKnowledgeIngestMetric {
    pub advisor_id: String,
    pub imported_file_count: i64,
    pub total_knowledge_file_count: i64,
    pub elapsed_ms: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RuntimeQueryMetric {
    pub session_id: String,
    pub runtime_mode: String,
    pub advisor_id: Option<String>,
    pub prompt_chars: i64,
    pub active_skill_count: i64,
    pub response_chars: i64,
    pub elapsed_ms: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SkillInvocationMetric {
    pub session_id: Option<String>,
    pub runtime_mode: String,
    pub skill_name: String,
    pub activation_scope: String,
    pub persisted_to_session: bool,
    pub active_skill_count: i64,
    pub elapsed_ms: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Default)]
pub struct DiagnosticsState {
    pub advisor_persona_runs: Vec<AdvisorPersonaMetric>,
    pub advisor_knowledge_ingests: Vec<AdvisorKnowledgeIngestMetric>,
    pub runtime_queries: Vec<RuntimeQueryMetric>,
    pub skill_invocations: Vec<SkillInvocationMetric>,
}

fn count_values<I>(values: I) -> HashMap<String, i64>
where
    I: IntoIterator<Item = String>,
{
    let mut counts = HashMap::<String, i64>::new();
    for value in values {
        *counts.entry(value).or_insert(0) += 1;
    }
    counts
}

fn push_bounded<T>(items: &mut Vec<T>, item: T) {
    items.insert(0, item);
    if items.len() > DIAGNOSTIC_HISTORY_LIMIT {
        items.truncate(DIAGNOSTIC_HISTORY_LIMIT);
    }
}

fn average_from_iter<I>(values: I) -> f64
where
    I: IntoIterator<Item = i64>,
{
    let mut total = 0_f64;
    let mut count = 0_f64;
    for value in values {
        total += value as f64;
        count += 1.0;
    }
    if count <= 0.0 {
        0.0
    } else {
        total / count
    }
}

fn session_advisor_id_from_metadata(metadata: Option<&Value>) -> Option<String> {
    let metadata = metadata?;
    payload_string(metadata, "advisorId").or_else(|| {
        let context_type = payload_string(metadata, "contextType");
        if context_type.as_deref() == Some("advisor-discussion") {
            payload_string(metadata, "contextId")
        } else {
            None
        }
    })
}

pub fn record_advisor_persona_metric(
    state: &State<'_, AppState>,
    metric: AdvisorPersonaMetric,
) -> Result<(), String> {
    let mut diagnostics = state
        .diagnostics
        .lock()
        .map_err(|_| "diagnostics lock 已损坏".to_string())?;
    push_bounded(&mut diagnostics.advisor_persona_runs, metric);
    Ok(())
}

pub fn record_advisor_knowledge_ingest_metric(
    state: &State<'_, AppState>,
    metric: AdvisorKnowledgeIngestMetric,
) -> Result<(), String> {
    let mut diagnostics = state
        .diagnostics
        .lock()
        .map_err(|_| "diagnostics lock 已损坏".to_string())?;
    push_bounded(&mut diagnostics.advisor_knowledge_ingests, metric);
    Ok(())
}

pub fn record_runtime_query_metric(
    state: &State<'_, AppState>,
    metric: RuntimeQueryMetric,
) -> Result<(), String> {
    let mut diagnostics = state
        .diagnostics
        .lock()
        .map_err(|_| "diagnostics lock 已损坏".to_string())?;
    push_bounded(&mut diagnostics.runtime_queries, metric);
    Ok(())
}

pub fn record_skill_invocation_metric(
    state: &State<'_, AppState>,
    metric: SkillInvocationMetric,
) -> Result<(), String> {
    let mut diagnostics = state
        .diagnostics
        .lock()
        .map_err(|_| "diagnostics lock 已损坏".to_string())?;
    push_bounded(&mut diagnostics.skill_invocations, metric);
    Ok(())
}

fn build_runtime_warm_summary(entries: Vec<RuntimeWarmEntry>, last_warmed_at: i64) -> Value {
    let mut rows = entries
        .into_iter()
        .map(|entry| {
            json!({
                "mode": entry.mode,
                "warmedAt": entry.warmed_at,
                "systemPromptChars": entry.system_prompt.chars().count() as i64,
                "longTermContextChars": entry.long_term_context.as_ref().map(|value| value.chars().count() as i64).unwrap_or(0),
                "hasModelConfig": entry.model_config.is_some(),
                "contextBundle": entry.context_bundle,
            })
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        left.get("mode")
            .and_then(Value::as_str)
            .cmp(&right.get("mode").and_then(Value::as_str))
    });
    json!({
        "lastWarmedAt": last_warmed_at,
        "entries": rows,
    })
}

fn build_persona_summary(
    metrics: &[AdvisorPersonaMetric],
    advisor_names: &HashMap<String, String>,
) -> Value {
    let mut grouped: HashMap<String, Vec<&AdvisorPersonaMetric>> = HashMap::new();
    for metric in metrics {
        grouped
            .entry(metric.advisor_id.clone())
            .or_default()
            .push(metric);
    }
    let mut by_advisor = grouped
        .into_iter()
        .map(|(advisor_id, rows)| {
            let advisor_name = advisor_names
                .get(&advisor_id)
                .cloned()
                .unwrap_or_else(|| advisor_id.clone());
            json!({
                "advisorId": advisor_id,
                "advisorName": advisor_name,
                "count": rows.len() as i64,
                "avgElapsedMs": average_from_iter(rows.iter().map(|item| item.elapsed_ms)),
                "avgSearchElapsedMs": average_from_iter(rows.iter().filter_map(|item| item.search_elapsed_ms)),
                "avgKnowledgeFiles": average_from_iter(rows.iter().map(|item| item.knowledge_file_count)),
                "avgSearchHits": average_from_iter(rows.iter().map(|item| item.search_hit_count)),
                "avgAdvisorKnowledgeHits": average_from_iter(rows.iter().map(|item| item.advisor_knowledge_hit_count)),
                "avgManuscriptHits": average_from_iter(rows.iter().map(|item| item.manuscript_hit_count)),
                "lastAt": rows.first().map(|item| item.created_at).unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    by_advisor.sort_by(|left, right| {
        right
            .get("lastAt")
            .and_then(Value::as_i64)
            .cmp(&left.get("lastAt").and_then(Value::as_i64))
    });

    json!({
        "count": metrics.len() as i64,
        "avgElapsedMs": average_from_iter(metrics.iter().map(|item| item.elapsed_ms)),
        "avgSearchElapsedMs": average_from_iter(metrics.iter().filter_map(|item| item.search_elapsed_ms)),
        "avgKnowledgeFiles": average_from_iter(metrics.iter().map(|item| item.knowledge_file_count)),
        "avgSearchHits": average_from_iter(metrics.iter().map(|item| item.search_hit_count)),
        "avgAdvisorKnowledgeHits": average_from_iter(metrics.iter().map(|item| item.advisor_knowledge_hit_count)),
        "avgManuscriptHits": average_from_iter(metrics.iter().map(|item| item.manuscript_hit_count)),
        "byAdvisor": by_advisor,
        "recent": metrics.iter().take(RECENT_PREVIEW_LIMIT).map(|item| json!(item)).collect::<Vec<_>>(),
    })
}

fn build_knowledge_ingest_summary(
    metrics: &[AdvisorKnowledgeIngestMetric],
    advisor_names: &HashMap<String, String>,
) -> Value {
    let mut grouped: HashMap<String, Vec<&AdvisorKnowledgeIngestMetric>> = HashMap::new();
    for metric in metrics {
        grouped
            .entry(metric.advisor_id.clone())
            .or_default()
            .push(metric);
    }
    let mut by_advisor = grouped
        .into_iter()
        .map(|(advisor_id, rows)| {
            let advisor_name = advisor_names
                .get(&advisor_id)
                .cloned()
                .unwrap_or_else(|| advisor_id.clone());
            json!({
                "advisorId": advisor_id,
                "advisorName": advisor_name,
                "count": rows.len() as i64,
                "avgElapsedMs": average_from_iter(rows.iter().map(|item| item.elapsed_ms)),
                "avgImportedFiles": average_from_iter(rows.iter().map(|item| item.imported_file_count)),
                "avgTotalKnowledgeFiles": average_from_iter(rows.iter().map(|item| item.total_knowledge_file_count)),
                "lastAt": rows.first().map(|item| item.created_at).unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    by_advisor.sort_by(|left, right| {
        right
            .get("lastAt")
            .and_then(Value::as_i64)
            .cmp(&left.get("lastAt").and_then(Value::as_i64))
    });

    json!({
        "count": metrics.len() as i64,
        "avgElapsedMs": average_from_iter(metrics.iter().map(|item| item.elapsed_ms)),
        "avgImportedFiles": average_from_iter(metrics.iter().map(|item| item.imported_file_count)),
        "avgTotalKnowledgeFiles": average_from_iter(metrics.iter().map(|item| item.total_knowledge_file_count)),
        "byAdvisor": by_advisor,
        "recent": metrics.iter().take(RECENT_PREVIEW_LIMIT).map(|item| json!(item)).collect::<Vec<_>>(),
    })
}

fn build_redclaw_task_summary(
    definitions: &[crate::RedclawJobDefinitionRecord],
    executions: &[crate::RedclawJobExecutionRecord],
) -> Value {
    let draft_count = definitions
        .iter()
        .filter(|item| item.requires_confirmation)
        .count();
    let active_count = definitions
        .iter()
        .filter(|item| !item.requires_confirmation && item.enabled)
        .count();
    let paused_count = definitions
        .iter()
        .filter(|item| !item.requires_confirmation && !item.enabled)
        .count();
    let recent_executions = executions
        .iter()
        .filter(|item| item.archived_at.is_none())
        .take(12)
        .map(|item| {
            json!({
                "executionId": item.id,
                "runId": item.run_id,
                "definitionId": item.definition_id,
                "status": item.status,
                "scheduledForAt": item.scheduled_for_at,
                "attemptNo": item.attempt_no,
                "retryBucket": item.retry_bucket,
                "trigger": item.trigger,
                "lastHeartbeatAt": item.last_heartbeat_at,
                "lastError": item.last_error,
                "checkpoints": item.checkpoints,
                "updatedAt": item.updated_at,
            })
        })
        .collect::<Vec<_>>();

    json!({
        "definitions": {
            "total": definitions.len(),
            "drafts": draft_count,
            "active": active_count,
            "paused": paused_count,
        },
        "executions": {
            "total": executions.len(),
            "running": executions.iter().filter(|item| matches!(item.status.as_str(), "queued" | "leased" | "running" | "retrying")).count(),
            "failed": executions.iter().filter(|item| matches!(item.status.as_str(), "failed" | "dead_lettered")).count(),
            "succeeded": executions.iter().filter(|item| matches!(item.status.as_str(), "succeeded" | "completed")).count(),
            "recent": recent_executions,
        }
    })
}

fn build_runtime_query_summary(
    metrics: &[RuntimeQueryMetric],
    advisor_names: &HashMap<String, String>,
) -> Value {
    let mut by_advisor_map: HashMap<String, Vec<&RuntimeQueryMetric>> = HashMap::new();
    let mut by_mode_map: HashMap<String, Vec<&RuntimeQueryMetric>> = HashMap::new();
    for metric in metrics {
        if let Some(advisor_id) = metric.advisor_id.clone() {
            by_advisor_map.entry(advisor_id).or_default().push(metric);
        }
        by_mode_map
            .entry(metric.runtime_mode.clone())
            .or_default()
            .push(metric);
    }
    let mut by_advisor = by_advisor_map
        .into_iter()
        .map(|(advisor_id, rows)| {
            let advisor_name = advisor_names
                .get(&advisor_id)
                .cloned()
                .unwrap_or_else(|| advisor_id.clone());
            json!({
                "advisorId": advisor_id,
                "advisorName": advisor_name,
                "count": rows.len() as i64,
                "avgElapsedMs": average_from_iter(rows.iter().map(|item| item.elapsed_ms)),
                "avgPromptChars": average_from_iter(rows.iter().map(|item| item.prompt_chars)),
                "avgActiveSkillCount": average_from_iter(rows.iter().map(|item| item.active_skill_count)),
                "avgResponseChars": average_from_iter(rows.iter().map(|item| item.response_chars)),
                "lastAt": rows.first().map(|item| item.created_at).unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    by_advisor.sort_by(|left, right| {
        right
            .get("lastAt")
            .and_then(Value::as_i64)
            .cmp(&left.get("lastAt").and_then(Value::as_i64))
    });

    let mut by_mode = by_mode_map
        .into_iter()
        .map(|(runtime_mode, rows)| {
            json!({
                "runtimeMode": runtime_mode,
                "count": rows.len() as i64,
                "avgElapsedMs": average_from_iter(rows.iter().map(|item| item.elapsed_ms)),
                "avgPromptChars": average_from_iter(rows.iter().map(|item| item.prompt_chars)),
                "avgActiveSkillCount": average_from_iter(rows.iter().map(|item| item.active_skill_count)),
            })
        })
        .collect::<Vec<_>>();
    by_mode.sort_by(|left, right| {
        right
            .get("count")
            .and_then(Value::as_i64)
            .cmp(&left.get("count").and_then(Value::as_i64))
    });

    json!({
        "count": metrics.len() as i64,
        "avgElapsedMs": average_from_iter(metrics.iter().map(|item| item.elapsed_ms)),
        "avgPromptChars": average_from_iter(metrics.iter().map(|item| item.prompt_chars)),
        "avgActiveSkillCount": average_from_iter(metrics.iter().map(|item| item.active_skill_count)),
        "avgResponseChars": average_from_iter(metrics.iter().map(|item| item.response_chars)),
        "byAdvisor": by_advisor,
        "byMode": by_mode,
        "recent": metrics.iter().take(RECENT_PREVIEW_LIMIT).map(|item| json!(item)).collect::<Vec<_>>(),
    })
}

fn build_skill_invocation_summary(metrics: &[SkillInvocationMetric]) -> Value {
    let mut by_skill_map: HashMap<String, Vec<&SkillInvocationMetric>> = HashMap::new();
    for metric in metrics {
        by_skill_map
            .entry(metric.skill_name.clone())
            .or_default()
            .push(metric);
    }
    let mut by_skill = by_skill_map
        .into_iter()
        .map(|(skill_name, rows)| {
            let persisted_count = rows
                .iter()
                .filter(|item| item.persisted_to_session)
                .count() as i64;
            json!({
                "skillName": skill_name,
                "count": rows.len() as i64,
                "persistedCount": persisted_count,
                "avgElapsedMs": average_from_iter(rows.iter().map(|item| item.elapsed_ms)),
                "avgActiveSkillCount": average_from_iter(rows.iter().map(|item| item.active_skill_count)),
                "lastRuntimeMode": rows.first().map(|item| item.runtime_mode.clone()).unwrap_or_default(),
                "lastAt": rows.first().map(|item| item.created_at).unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    by_skill.sort_by(|left, right| {
        right
            .get("lastAt")
            .and_then(Value::as_i64)
            .cmp(&left.get("lastAt").and_then(Value::as_i64))
    });

    json!({
        "count": metrics.len() as i64,
        "avgElapsedMs": average_from_iter(metrics.iter().map(|item| item.elapsed_ms)),
        "avgActiveSkillCount": average_from_iter(metrics.iter().map(|item| item.active_skill_count)),
        "bySkill": by_skill,
        "recent": metrics.iter().take(RECENT_PREVIEW_LIMIT).map(|item| json!(item)).collect::<Vec<_>>(),
    })
}

fn build_tool_call_summary(
    recent_results: &[SessionToolResultRecord],
    advisor_names: &HashMap<String, String>,
    session_advisors: &HashMap<String, String>,
) -> Value {
    let total = recent_results.len() as i64;
    let successes = recent_results.iter().filter(|item| item.success).count() as i64;
    let success_rate = if total <= 0 {
        0.0
    } else {
        successes as f64 / total as f64
    };

    let mut by_tool_map: HashMap<String, Vec<&SessionToolResultRecord>> = HashMap::new();
    let mut by_advisor_map: HashMap<String, Vec<&SessionToolResultRecord>> = HashMap::new();
    for item in recent_results {
        by_tool_map
            .entry(item.tool_name.clone())
            .or_default()
            .push(item);
        if let Some(advisor_id) = session_advisors.get(&item.session_id) {
            by_advisor_map
                .entry(advisor_id.clone())
                .or_default()
                .push(item);
        }
    }

    let mut by_tool = by_tool_map
        .into_iter()
        .map(|(tool_name, rows)| {
            let tool_total = rows.len() as i64;
            let tool_successes = rows.iter().filter(|item| item.success).count() as i64;
            json!({
                "toolName": tool_name,
                "count": tool_total,
                "successRate": if tool_total <= 0 { 0.0 } else { tool_successes as f64 / tool_total as f64 },
                "lastAt": rows.first().map(|item| item.created_at).unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    by_tool.sort_by(|left, right| {
        right
            .get("lastAt")
            .and_then(Value::as_i64)
            .cmp(&left.get("lastAt").and_then(Value::as_i64))
    });

    let mut by_advisor = by_advisor_map
        .into_iter()
        .map(|(advisor_id, rows)| {
            let advisor_total = rows.len() as i64;
            let advisor_successes = rows.iter().filter(|item| item.success).count() as i64;
            let advisor_name = advisor_names
                .get(&advisor_id)
                .cloned()
                .unwrap_or_else(|| advisor_id.clone());
            json!({
                "advisorId": advisor_id,
                "advisorName": advisor_name,
                "count": advisor_total,
                "successRate": if advisor_total <= 0 { 0.0 } else { advisor_successes as f64 / advisor_total as f64 },
                "lastAt": rows.first().map(|item| item.created_at).unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    by_advisor.sort_by(|left, right| {
        right
            .get("lastAt")
            .and_then(Value::as_i64)
            .cmp(&left.get("lastAt").and_then(Value::as_i64))
    });

    let recent = recent_results
        .iter()
        .take(RECENT_PREVIEW_LIMIT)
        .map(|item| {
            let advisor_id = session_advisors.get(&item.session_id).cloned();
            json!({
                "sessionId": item.session_id,
                "advisorId": advisor_id,
                "advisorName": advisor_id.as_ref().and_then(|id| advisor_names.get(id)).cloned(),
                "toolName": item.tool_name,
                "success": item.success,
                "summaryText": item.summary_text,
                "createdAt": item.created_at,
            })
        })
        .collect::<Vec<_>>();

    json!({
        "count": total,
        "successCount": successes,
        "successRate": success_rate,
        "byAdvisor": by_advisor,
        "byTool": by_tool,
        "recent": recent,
    })
}

pub fn build_runtime_diagnostics_summary(state: &State<'_, AppState>) -> Result<Value, String> {
    let (advisor_names, session_advisors, recent_tool_results, redclaw_task_summary) =
        with_store(state, |store| {
            let advisor_names = store
                .advisors
                .iter()
                .map(|advisor| (advisor.id.clone(), advisor.name.clone()))
                .collect::<HashMap<_, _>>();
            let session_advisors = store
                .chat_sessions
                .iter()
                .filter_map(|session| {
                    session_advisor_id_from_metadata(session.metadata.as_ref())
                        .map(|advisor_id| (session.id.clone(), advisor_id))
                })
                .collect::<HashMap<_, _>>();
            let mut tool_results = store.session_tool_results.clone();
            tool_results.sort_by(|left, right| right.created_at.cmp(&left.created_at));
            tool_results.truncate(DIAGNOSTIC_HISTORY_LIMIT);
            let redclaw_task_summary = build_redclaw_task_summary(
                &store.redclaw_job_definitions,
                &store.redclaw_job_executions,
            );
            Ok((
                advisor_names,
                session_advisors,
                tool_results,
                redclaw_task_summary,
            ))
        })?;

    let diagnostics = state
        .diagnostics
        .lock()
        .map_err(|_| "diagnostics lock 已损坏".to_string())?
        .clone();
    let (runtime_warm_entries, runtime_warm_last_warmed_at) = {
        let runtime_warm = state
            .runtime_warm
            .lock()
            .map_err(|_| "runtime warm lock 已损坏".to_string())?;
        (
            runtime_warm.entries.values().cloned().collect::<Vec<_>>(),
            runtime_warm.last_warmed_at,
        )
    };
    let approvals = runtime_approval_snapshot(state)?;

    Ok(json!({
        "generatedAt": now_i64(),
        "runtimeWarm": build_runtime_warm_summary(runtime_warm_entries, runtime_warm_last_warmed_at),
        "approvals": approvals,
        "phase0": {
            "backgroundWorkers": build_background_worker_summary(state),
            "personaGeneration": build_persona_summary(&diagnostics.advisor_persona_runs, &advisor_names),
            "knowledgeIngest": build_knowledge_ingest_summary(&diagnostics.advisor_knowledge_ingests, &advisor_names),
            "runtimeQueries": build_runtime_query_summary(&diagnostics.runtime_queries, &advisor_names),
            "skillInvocations": build_skill_invocation_summary(&diagnostics.skill_invocations),
            "toolCalls": build_tool_call_summary(&recent_tool_results, &advisor_names, &session_advisors),
            "redclawTasks": redclaw_task_summary,
        }
    }))
}

pub fn build_background_worker_summary(state: &State<'_, AppState>) -> Value {
    let media_runtime_running = state
        .media_generation_runtime
        .lock()
        .map(|runtime| runtime.is_some())
        .unwrap_or(false);
    let redclaw_runtime_running = state
        .redclaw_runtime
        .lock()
        .map(|runtime| runtime.is_some())
        .unwrap_or(false);
    let assistant_runtime = state
        .assistant_runtime
        .lock()
        .map(|runtime| {
            runtime.as_ref().map(|item| {
                json!({
                    "running": true,
                    "host": item.host.clone(),
                    "port": item.port,
                })
            })
        })
        .ok()
        .flatten()
        .unwrap_or_else(|| json!({ "running": false }));
    let assistant_sidecar_running = state
        .assistant_sidecar
        .lock()
        .map(|runtime| runtime.is_some())
        .unwrap_or(false);
    let knowledge_index = state
        .knowledge_index_state
        .lock()
        .map(|runtime| {
            json!({
                "isBuilding": runtime.is_building,
                "pendingRebuild": runtime.pending_rebuild,
                "pendingCount": runtime.pending_count,
                "failedCount": runtime.failed_count,
                "watchedRootCount": runtime.watched_roots.len(),
            })
        })
        .unwrap_or_else(|_| json!({ "error": "knowledge index state lock is poisoned" }));
    let store_persist = json!({
        "scheduled": state.store_persist_scheduled.load(std::sync::atomic::Ordering::SeqCst),
        "version": state.store_persist_version.load(std::sync::atomic::Ordering::SeqCst),
    });
    let media_pressure = media_runtime::media_runtime_pressure_snapshot(state)
        .unwrap_or_else(|error| json!({ "error": error }));
    let active_cli_processes = cli_runtime::active_background_execution_count().unwrap_or(0);

    let store_summary = with_store(state, |store| {
        let redclaw_execution_status = count_values(
            store
                .redclaw_job_executions
                .iter()
                .map(|item| item.status.clone()),
        );
        let redclaw_definition_status =
            count_values(store.redclaw_job_definitions.iter().map(|item| {
                if item.enabled {
                    "enabled".to_string()
                } else {
                    "disabled".to_string()
                }
            }));
        let cli_status = count_values(store.cli_executions.iter().map(|item| {
            serde_json::to_value(&item.status)
                .ok()
                .and_then(|value| value.as_str().map(ToString::to_string))
                .unwrap_or_else(|| format!("{:?}", item.status))
        }));
        Ok(json!({
            "redclaw": {
                "definitionsByStatus": redclaw_definition_status,
                "executionsByStatus": redclaw_execution_status,
                "runtimeRunning": redclaw_runtime_running,
            },
            "cliRuntime": {
                "activeProcesses": active_cli_processes,
                "executionsByStatus": cli_status,
            }
        }))
    })
    .unwrap_or_else(|error| json!({ "error": error }));

    json!({
        "generatedAt": now_i64(),
        "dedicatedWorkers": {
            "logSink": { "running": true },
            "knowledgeWatcher": {
                "running": true,
                "state": knowledge_index,
            },
            "assistantListener": assistant_runtime,
            "assistantSidecar": { "running": assistant_sidecar_running },
        },
        "coordinators": {
            "mediaRuntime": {
                "running": media_runtime_running,
                "pressure": media_pressure,
            },
            "redclawRuntime": {
                "running": redclaw_runtime_running,
            },
            "storePersist": store_persist,
            "officialCacheRefresh": {
                "inflight": state.official_cache_refresh_inflight.load(std::sync::atomic::Ordering::SeqCst),
            }
        },
        "domains": store_summary,
        "notes": [
            "phase0 snapshot is observational only",
            "counts may include completed historical records from durable stores"
        ]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::RuntimeContextBundleSummary;

    #[test]
    fn runtime_warm_summary_keeps_context_bundle_metrics() {
        let summary = build_runtime_warm_summary(
            vec![RuntimeWarmEntry {
                mode: "redclaw".to_string(),
                system_prompt: "system prompt".to_string(),
                model_config: Some(json!({ "model": "gpt" })),
                long_term_context: Some("long-term".to_string()),
                context_bundle: RuntimeContextBundleSummary {
                    runtime_mode: "redclaw".to_string(),
                    tool_count: 4,
                    active_skill_count: 2,
                    project_context_chars: 18,
                    host_context_chars: 22,
                    advisor_context_chars: 11,
                    memory_chars: 30,
                    subjects_chars: 14,
                    prompt_prefix_chars: 10,
                    prompt_suffix_chars: 8,
                    final_prompt_chars: 128,
                },
                warmed_at: 123,
            }],
            456,
        );

        assert_eq!(
            summary.get("lastWarmedAt").and_then(Value::as_i64),
            Some(456)
        );
        assert_eq!(
            summary
                .pointer("/entries/0/contextBundle/toolCount")
                .and_then(Value::as_i64),
            Some(4)
        );
        assert_eq!(
            summary
                .pointer("/entries/0/contextBundle/finalPromptChars")
                .and_then(Value::as_i64),
            Some(128)
        );
        assert_eq!(
            summary
                .pointer("/entries/0/hasModelConfig")
                .and_then(Value::as_bool),
            Some(true)
        );
    }
}
