use crate::runtime::RedclawJobExecutionRecord;

pub fn mark_dead_lettered(
    execution: &mut RedclawJobExecutionRecord,
    error: Option<String>,
    now: &str,
) {
    execution.status = "dead_lettered".to_string();
    execution.completed_at = Some(now.to_string());
    execution.dead_lettered_at = Some(now.to_string());
    execution.last_error = error.or_else(|| execution.last_error.clone());
    execution.updated_at = now.to_string();
}
