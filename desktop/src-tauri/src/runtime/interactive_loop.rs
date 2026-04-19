use serde::Serialize;
use serde_json::{Map, Value};

const MAX_IDENTICAL_TOOL_ROUNDS: usize = 1;
const FORCED_TOOLLESS_TURN_MESSAGE: &str =
    "你已经重复执行了同样的工具调用且结果没有推进。不要继续调用工具。基于已有结果直接给出最终答复；如果仍有缺口，请明确指出缺口。";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveToolOutcomeDigest {
    pub name: String,
    pub arguments: Value,
    pub success: bool,
    pub summary: String,
}

impl InteractiveToolOutcomeDigest {
    pub fn new(name: String, arguments: Value, success: bool, summary: String) -> Self {
        Self {
            name,
            arguments: canonicalize_value(&arguments),
            success,
            summary,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct InteractiveLoopGuard {
    last_tool_round_signature: Option<String>,
    identical_tool_rounds: usize,
    pending_toolless_turn_message: Option<String>,
}

impl InteractiveLoopGuard {
    pub fn has_pending_toolless_turn(&self) -> bool {
        self.pending_toolless_turn_message.is_some()
    }

    pub fn take_toolless_turn_message(&mut self) -> Option<String> {
        self.pending_toolless_turn_message.take()
    }

    pub fn observe_tool_round(
        &mut self,
        outcomes: &[InteractiveToolOutcomeDigest],
    ) -> Option<String> {
        if outcomes.is_empty() {
            self.last_tool_round_signature = None;
            self.identical_tool_rounds = 0;
            return None;
        }

        let signature = tool_round_signature(outcomes);
        if self.last_tool_round_signature.as_deref() == Some(signature.as_str()) {
            self.identical_tool_rounds = self.identical_tool_rounds.saturating_add(1);
        } else {
            self.identical_tool_rounds = 0;
        }
        self.last_tool_round_signature = Some(signature);

        if self.identical_tool_rounds >= MAX_IDENTICAL_TOOL_ROUNDS {
            let instruction = FORCED_TOOLLESS_TURN_MESSAGE.to_string();
            self.pending_toolless_turn_message = Some(instruction.clone());
            return Some(instruction);
        }

        None
    }
}

fn tool_round_signature(outcomes: &[InteractiveToolOutcomeDigest]) -> String {
    serde_json::to_string(outcomes).unwrap_or_else(|_| "[]".to_string())
}

fn canonicalize_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize_value).collect()),
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            let mut normalized = Map::new();
            for (key, item) in entries {
                normalized.insert(key.clone(), canonicalize_value(item));
            }
            Value::Object(normalized)
        }
        _ => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn identical_tool_rounds_trigger_forced_toolless_turn() {
        let mut guard = InteractiveLoopGuard::default();
        let digest = vec![InteractiveToolOutcomeDigest::new(
            "bash".to_string(),
            json!({ "b": 2, "a": 1 }),
            true,
            "ok".to_string(),
        )];

        assert!(guard.observe_tool_round(&digest).is_none());
        let instruction = guard.observe_tool_round(&digest).unwrap();
        assert!(instruction.contains("不要继续调用工具"));
        assert!(guard.has_pending_toolless_turn());
        assert_eq!(
            guard.take_toolless_turn_message().as_deref(),
            Some(instruction.as_str())
        );
        assert!(!guard.has_pending_toolless_turn());
    }

    #[test]
    fn canonicalize_value_stabilizes_object_key_order() {
        let left = vec![InteractiveToolOutcomeDigest::new(
            "app_cli".to_string(),
            json!({ "payload": { "z": 1, "a": 2 } }),
            true,
            "saved".to_string(),
        )];
        let right = vec![InteractiveToolOutcomeDigest::new(
            "app_cli".to_string(),
            json!({ "payload": { "a": 2, "z": 1 } }),
            true,
            "saved".to_string(),
        )];

        assert_eq!(tool_round_signature(&left), tool_round_signature(&right));
    }
}
