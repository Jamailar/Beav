use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::AppStore;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBackendDescriptor {
    pub id: String,
    pub label: String,
    pub source_kind: String,
    pub backend: String,
    pub status: String,
    pub capabilities: Vec<String>,
    pub desired_current_config: Value,
}

pub fn list_agent_backends(_store: &AppStore) -> Vec<AgentBackendDescriptor> {
    vec![AgentBackendDescriptor {
        id: "internal-runtime".to_string(),
        label: "RedBox Internal Runtime".to_string(),
        source_kind: "internal_runtime".to_string(),
        backend: "redbox-runtime".to_string(),
        status: "available".to_string(),
        capabilities: vec![
            "runtime_tasks".to_string(),
            "team_tools".to_string(),
            "mailbox".to_string(),
        ],
        desired_current_config: json!({
            "desired": {},
            "current": {},
            "reassertOnWake": true
        }),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_backend_registry_is_internal_only() {
        let backends = list_agent_backends(&AppStore::default());
        assert_eq!(backends.len(), 1);
        assert_eq!(backends[0].source_kind, "internal_runtime");
        assert_eq!(backends[0].backend, "redbox-runtime");
    }
}
