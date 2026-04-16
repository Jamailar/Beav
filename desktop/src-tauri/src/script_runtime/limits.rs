use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::script_runtime::rpc::ScriptExecutionLimitOverrides;

pub const SCRIPT_RUNTIME_PROGRAM_VERSION: &str = "lexbox_script_v1";
pub const SCRIPT_RUNTIME_ELIGIBLE_MODES: [&str; 3] = ["knowledge", "diagnostics", "video-editor"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptExecutionLimits {
    pub timeout_ms: u64,
    pub max_stdout_chars: usize,
    pub max_tool_calls: usize,
    pub max_artifacts: usize,
    pub max_artifact_chars: usize,
    pub max_steps: usize,
    pub max_loop_items: usize,
    pub max_fs_read_chars: usize,
    pub max_fs_list_entries: usize,
    pub max_recall_chars: usize,
    pub max_recall_hits: usize,
}

pub fn script_runtime_feature_enabled(settings: &Value) -> bool {
    let _ = settings;
    true
}

pub fn script_runtime_mode_allowed(runtime_mode: &str) -> bool {
    SCRIPT_RUNTIME_ELIGIBLE_MODES
        .iter()
        .any(|item| item == &runtime_mode)
}

pub fn script_runtime_enabled_for_mode(settings: &Value, runtime_mode: &str) -> bool {
    script_runtime_feature_enabled(settings) && script_runtime_mode_allowed(runtime_mode)
}

pub fn allowed_script_tools_for_runtime_mode(runtime_mode: &str) -> Vec<&'static str> {
    match runtime_mode {
        "video-editor" => vec![
            "app.query",
            "fs.list",
            "fs.read",
            "memory.recall",
            "editor.script_read",
            "editor.project_read",
            "editor.remotion_read",
        ],
        "knowledge" | "diagnostics" => vec![
            "app.query",
            "fs.list",
            "fs.read",
            "memory.recall",
            "mcp.list_servers",
            "mcp.list_tools",
            "mcp.list_resources",
            "mcp.list_resource_templates",
        ],
        _ => Vec::new(),
    }
}

pub fn default_limits_for_runtime_mode(runtime_mode: &str) -> ScriptExecutionLimits {
    match runtime_mode {
        "video-editor" => ScriptExecutionLimits {
            timeout_ms: 8_000,
            max_stdout_chars: 4_000,
            max_tool_calls: 12,
            max_artifacts: 4,
            max_artifact_chars: 20_000,
            max_steps: 32,
            max_loop_items: 4,
            max_fs_read_chars: 12_000,
            max_fs_list_entries: 30,
            max_recall_chars: 4_000,
            max_recall_hits: 6,
        },
        "knowledge" => ScriptExecutionLimits {
            timeout_ms: 8_000,
            max_stdout_chars: 5_000,
            max_tool_calls: 16,
            max_artifacts: 4,
            max_artifact_chars: 24_000,
            max_steps: 40,
            max_loop_items: 6,
            max_fs_read_chars: 12_000,
            max_fs_list_entries: 40,
            max_recall_chars: 5_000,
            max_recall_hits: 8,
        },
        _ => ScriptExecutionLimits {
            timeout_ms: 6_000,
            max_stdout_chars: 4_000,
            max_tool_calls: 12,
            max_artifacts: 4,
            max_artifact_chars: 20_000,
            max_steps: 32,
            max_loop_items: 4,
            max_fs_read_chars: 10_000,
            max_fs_list_entries: 30,
            max_recall_chars: 4_000,
            max_recall_hits: 6,
        },
    }
}

pub fn merge_limits(
    mut limits: ScriptExecutionLimits,
    overrides: Option<&ScriptExecutionLimitOverrides>,
) -> ScriptExecutionLimits {
    let Some(overrides) = overrides else {
        return limits;
    };
    if let Some(value) = overrides.timeout_ms {
        limits.timeout_ms = value.clamp(500, 30_000);
    }
    if let Some(value) = overrides.max_stdout_chars {
        limits.max_stdout_chars = value.clamp(200, 20_000);
    }
    if let Some(value) = overrides.max_tool_calls {
        limits.max_tool_calls = value.clamp(1, 64);
    }
    if let Some(value) = overrides.max_artifacts {
        limits.max_artifacts = value.clamp(1, 16);
    }
    if let Some(value) = overrides.max_artifact_chars {
        limits.max_artifact_chars = value.clamp(200, 50_000);
    }
    if let Some(value) = overrides.max_steps {
        limits.max_steps = value.clamp(1, 128);
    }
    if let Some(value) = overrides.max_loop_items {
        limits.max_loop_items = value.clamp(1, 32);
    }
    if let Some(value) = overrides.max_fs_read_chars {
        limits.max_fs_read_chars = value.clamp(200, 40_000);
    }
    if let Some(value) = overrides.max_fs_list_entries {
        limits.max_fs_list_entries = value.clamp(1, 100);
    }
    if let Some(value) = overrides.max_recall_chars {
        limits.max_recall_chars = value.clamp(500, 12_000);
    }
    if let Some(value) = overrides.max_recall_hits {
        limits.max_recall_hits = value.clamp(1, 16);
    }
    limits
}
