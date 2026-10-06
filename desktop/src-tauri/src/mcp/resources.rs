use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::McpServerRecord;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpCapabilitySnapshot {
    pub connection_strategy: String,
    pub initialize_response: Option<Value>,
    pub tools_response: Option<Value>,
    pub resources_response: Option<Value>,
    pub resource_templates_response: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceInfo {
    pub server_id: String,
    pub server_name: String,
    pub uri: String,
    pub name: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceTemplateInfo {
    pub server_id: String,
    pub server_name: String,
    pub uri_template: String,
    pub name: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub mime_type: Option<String>,
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

pub fn resources_from_response(server: &McpServerRecord, response: &Value) -> Vec<McpResourceInfo> {
    response
        .pointer("/result/resources")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(McpResourceInfo {
                        server_id: server.id.clone(),
                        server_name: server.name.clone(),
                        uri: item.get("uri").and_then(Value::as_str)?.to_string(),
                        name: optional_string(item, "name"),
                        title: optional_string(item, "title"),
                        description: optional_string(item, "description"),
                        mime_type: item
                            .get("mimeType")
                            .or_else(|| item.get("mime_type"))
                            .and_then(Value::as_str)
                            .map(ToString::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn resource_templates_from_response(
    server: &McpServerRecord,
    response: &Value,
) -> Vec<McpResourceTemplateInfo> {
    response
        .pointer("/result/resourceTemplates")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(McpResourceTemplateInfo {
                        server_id: server.id.clone(),
                        server_name: server.name.clone(),
                        uri_template: item
                            .get("uriTemplate")
                            .or_else(|| item.get("uri_template"))
                            .and_then(Value::as_str)?
                            .to_string(),
                        name: optional_string(item, "name"),
                        title: optional_string(item, "title"),
                        description: optional_string(item, "description"),
                        mime_type: item
                            .get("mimeType")
                            .or_else(|| item.get("mime_type"))
                            .and_then(Value::as_str)
                            .map(ToString::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn optional_string(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
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

    #[test]
    fn parses_resources_and_templates_from_mcp_responses() {
        let server = McpServerRecord {
            id: "demo".to_string(),
            name: "Demo".to_string(),
            enabled: true,
            transport: "stdio".to_string(),
            command: None,
            args: None,
            env: None,
            cwd: None,
            url: None,
            oauth: None,
        };
        let resources = resources_from_response(
            &server,
            &json!({
                "result": {
                    "resources": [{ "uri": "memo://1", "name": "Memo", "mimeType": "text/plain" }]
                }
            }),
        );
        let templates = resource_templates_from_response(
            &server,
            &json!({
                "result": {
                    "resourceTemplates": [{ "uriTemplate": "memo://{id}", "name": "Memo" }]
                }
            }),
        );
        assert_eq!(resources[0].uri, "memo://1");
        assert_eq!(templates[0].uri_template, "memo://{id}");
    }
}
