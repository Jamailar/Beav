use crate::runtime::RedclawJobExecutionRecord;

pub fn lease_execution(
    execution: &mut RedclawJobExecutionRecord,
    worker_id: &str,
    worker_mode: &str,
    heartbeat_timeout_ms: i64,
    leased_at: &str,
) {
    execution.status = "leased".to_string();
    execution.worker_id = Some(worker_id.to_string());
    execution.worker_mode = worker_mode.to_string();
    execution.heartbeat_timeout_ms = Some(heartbeat_timeout_ms);
    execution.last_heartbeat_at = Some(leased_at.to_string());
    execution.updated_at = leased_at.to_string();
}
