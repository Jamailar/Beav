mod artifacts;
mod audit;
mod auth;
mod errors;
mod guide;
mod http;
mod manifest;
mod runs;
mod sessions;
mod types;

use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) use audit::project_runtime_event_to_acp_audit;
pub(crate) use auth::{
    acp_gateway_public_value, apply_acp_gateway_config, create_acp_client, revoke_acp_client,
};
pub(crate) use http::{handle_acp_gateway_http_request, is_acp_gateway_path};
pub(crate) use runs::repair_acp_runs_after_load;

static ACP_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

pub(crate) fn make_acp_id(prefix: &str) -> String {
    let counter = ACP_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{counter}", crate::now_i64())
}

pub(crate) fn normalize_acp_path(path: &str) -> String {
    let without_query = path.split_once('?').map(|(head, _)| head).unwrap_or(path);
    let clean = without_query
        .split_once('#')
        .map(|(head, _)| head)
        .unwrap_or(without_query)
        .trim();
    let with_leading = if clean.starts_with('/') {
        clean.to_string()
    } else {
        format!("/{clean}")
    };
    if with_leading.len() > 1 {
        with_leading.trim_end_matches('/').to_string()
    } else {
        with_leading
    }
}
