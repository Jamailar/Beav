use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpCapabilitySnapshot {
    pub connection_strategy: String,
    pub initialize_response: Option<Value>,
    pub tools_response: Option<Value>,
    pub resources_response: Option<Value>,
    pub resource_templates_response: Option<Value>,
}

impl McpCapabilitySnapshot {
    pub fn from_initialize_response(
        response: Value,
        connection_strategy: impl Into<String>,
    ) -> Self {
        Self {
            connection_strategy: connection_strategy.into(),
            initialize_response: Some(response),
            tools_response: None,
            resources_response: None,
            resource_templates_response: None,
        }
    }

    pub fn server_name(&self) -> Option<&str> {
        self.initialize_response
            .as_ref()
            .and_then(|value| value.pointer("/result/serverInfo/name"))
            .and_then(Value::as_str)
    }

    pub fn protocol_version(&self) -> Option<&str> {
        self.initialize_response
            .as_ref()
            .and_then(|value| value.pointer("/result/protocolVersion"))
            .and_then(Value::as_str)
    }

    pub fn tool_count(&self) -> usize {
        response_item_count(self.tools_response.as_ref(), "/result/tools")
    }

    pub fn resource_count(&self) -> usize {
        response_item_count(self.resources_response.as_ref(), "/result/resources")
    }

    pub fn resource_template_count(&self) -> usize {
        response_item_count(
            self.resource_templates_response.as_ref(),
            "/result/resourceTemplates",
        )
    }

    pub fn cached_response(&self, method: &str) -> Option<Value> {
        match method {
            "initialize" => self.initialize_response.clone(),
            "tools/list" => self.tools_response.clone(),
            "resources/list" => self.resources_response.clone(),
            "resources/templates/list" => self.resource_templates_response.clone(),
            _ => None,
        }
    }

    pub fn apply_method_response(&mut self, method: &str, response: Value) {
        match method {
            "initialize" => self.initialize_response = Some(response),
            "tools/list" => self.tools_response = Some(response),
            "resources/list" => self.resources_response = Some(response),
            "resources/templates/list" => self.resource_templates_response = Some(response),
            _ => {}
        }
    }

    pub fn detail_text(&self, fallback_name: &str) -> String {
        let name = self.server_name().unwrap_or(fallback_name);
        let protocol = self.protocol_version().unwrap_or("unknown");
        format!(
            "initialized {} ({}) · tools {} · resources {} · templates {} · {}",
            name,
            protocol,
            self.tool_count(),
            self.resource_count(),
            self.resource_template_count(),
            self.connection_strategy
        )
    }
}

fn response_item_count(response: Option<&Value>, pointer: &str) -> usize {
    response
        .and_then(|value| value.pointer(pointer))
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn capability_snapshot_tracks_cached_responses() {
        let mut snapshot = McpCapabilitySnapshot::from_initialize_response(
            json!({
                "result": {
                    "protocolVersion": "2024-11-05",
                    "serverInfo": { "name": "Demo" }
                }
            }),
            "persistent",
        );

        snapshot.apply_method_response(
            "tools/list",
            json!({ "result": { "tools": [{ "name": "read" }, { "name": "write" }] } }),
        );
        snapshot.apply_method_response(
            "resources/list",
            json!({ "result": { "resources": [{ "uri": "memo://1" }] } }),
        );

        assert_eq!(snapshot.server_name(), Some("Demo"));
        assert_eq!(snapshot.protocol_version(), Some("2024-11-05"));
        assert_eq!(snapshot.tool_count(), 2);
        assert_eq!(snapshot.resource_count(), 1);
        assert!(snapshot.cached_response("tools/list").is_some());
    }
}
