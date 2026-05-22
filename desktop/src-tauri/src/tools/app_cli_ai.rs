use super::*;

pub(super) fn handle(
    executor: &AppCliExecutor<'_>,
    tokens: &[String],
    payload: &Value,
) -> Result<Value, String> {
    let Some(action) = tokens.first().map(String::as_str) else {
        return Ok(help_response(Some("ai")));
    };
    let args = parse_cli_args(&tokens[1..])?;
    match action {
        "roles-list" => executor.call_channel("ai:roles:list", json!({})),
        "detect-protocol" => executor.call_channel(
            "ai:detect-protocol",
            json!({
                "baseURL": args
                    .string(&["base-url", "baseURL"])
                    .or_else(|| payload_string(payload, "baseURL"))
                    .unwrap_or_default(),
                "presetId": args
                    .string(&["preset-id", "presetId"])
                    .or_else(|| payload_string(payload, "presetId")),
                "protocol": args
                    .string(&["protocol"])
                    .or_else(|| payload_string(payload, "protocol")),
            }),
        ),
        "test-connection" => executor.call_channel(
            "ai:test-connection",
            json!({
                "baseURL": args
                    .string(&["base-url", "baseURL"])
                    .or_else(|| payload_string(payload, "baseURL"))
                    .unwrap_or_default(),
                "apiKey": args
                    .string(&["api-key", "apiKey"])
                    .or_else(|| payload_string(payload, "apiKey")),
                "presetId": args
                    .string(&["preset-id", "presetId"])
                    .or_else(|| payload_string(payload, "presetId")),
                "protocol": args
                    .string(&["protocol"])
                    .or_else(|| payload_string(payload, "protocol")),
            }),
        ),
        _ => Err(format!("unsupported ai action: {action}")),
    }
}
