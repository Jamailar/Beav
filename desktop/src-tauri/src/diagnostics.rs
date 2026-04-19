use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::persistence::with_store;
use crate::runtime::{RuntimeWarmEntry, SessionToolResultRecord};
use crate::{now_i64, payload_string, AppState};

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
    let (advisor_names, session_advisors, recent_tool_results) = with_store(state, |store| {
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
        Ok((advisor_names, session_advisors, tool_results))
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

    Ok(json!({
        "generatedAt": now_i64(),
        "runtimeWarm": build_runtime_warm_summary(runtime_warm_entries, runtime_warm_last_warmed_at),
        "phase0": {
            "personaGeneration": build_persona_summary(&diagnostics.advisor_persona_runs, &advisor_names),
            "knowledgeIngest": build_knowledge_ingest_summary(&diagnostics.advisor_knowledge_ingests, &advisor_names),
            "runtimeQueries": build_runtime_query_summary(&diagnostics.runtime_queries, &advisor_names),
            "skillInvocations": build_skill_invocation_summary(&diagnostics.skill_invocations),
            "toolCalls": build_tool_call_summary(&recent_tool_results, &advisor_names, &session_advisors),
        }
    }))
}
