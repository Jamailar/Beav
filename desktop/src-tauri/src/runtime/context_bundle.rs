use serde::{Deserialize, Serialize};

const DEFAULT_RUNTIME_CONTEXT_TOKEN_BUDGET: i64 = 32_000;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct RuntimeContextBundleSummary {
    pub runtime_mode: String,
    pub tool_count: i64,
    pub active_skill_count: i64,
    pub project_context_chars: i64,
    pub host_context_chars: i64,
    pub advisor_context_chars: i64,
    pub memory_chars: i64,
    pub subjects_chars: i64,
    pub prompt_prefix_chars: i64,
    pub prompt_suffix_chars: i64,
    pub final_prompt_chars: i64,
    pub final_prompt_rendered_chars: i64,
    pub final_prompt_hash: String,
    pub estimated_final_prompt_tokens: i64,
    pub token_budget: i64,
    pub token_budget_exceeded: bool,
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeContextBundle {
    pub system_prompt: String,
    pub summary: RuntimeContextBundleSummary,
}

impl RuntimeContextBundle {
    pub fn new(system_prompt: String, summary: RuntimeContextBundleSummary) -> Self {
        Self {
            system_prompt,
            summary,
        }
    }
}

pub fn build_runtime_context_bundle_summary(
    runtime_mode: &str,
    available_tools: &str,
    active_skill_count: usize,
    project_context: &str,
    host_runtime_context: &str,
    advisor_context: &str,
    memory_section: Option<&str>,
    subjects_section: &str,
    prompt_prefix: &str,
    prompt_suffix: &str,
    final_prompt: &str,
) -> RuntimeContextBundleSummary {
    let token_budget = DEFAULT_RUNTIME_CONTEXT_TOKEN_BUDGET;
    let final_prompt_fragment = crate::runtime::ContextFragment::developer_from_source(
        "final_prompt",
        runtime_mode,
        final_prompt,
        token_budget,
    );
    let estimated_final_prompt_tokens = final_prompt_fragment.estimated_tokens;
    RuntimeContextBundleSummary {
        runtime_mode: runtime_mode.to_string(),
        tool_count: available_tools
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count() as i64,
        active_skill_count: active_skill_count as i64,
        project_context_chars: project_context.chars().count() as i64,
        host_context_chars: host_runtime_context.chars().count() as i64,
        advisor_context_chars: advisor_context.chars().count() as i64,
        memory_chars: memory_section.unwrap_or_default().chars().count() as i64,
        subjects_chars: subjects_section.chars().count() as i64,
        prompt_prefix_chars: prompt_prefix.chars().count() as i64,
        prompt_suffix_chars: prompt_suffix.chars().count() as i64,
        final_prompt_chars: final_prompt.chars().count() as i64,
        final_prompt_rendered_chars: final_prompt_fragment.rendered_chars,
        final_prompt_hash: final_prompt_fragment.body_hash,
        estimated_final_prompt_tokens,
        token_budget,
        token_budget_exceeded: final_prompt_fragment.truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_bundle_summary_tracks_tool_skill_and_prompt_sizes() {
        let summary = build_runtime_context_bundle_summary(
            "redclaw",
            "tool-a\n\ntool-b\n",
            3,
            "project context",
            "host context",
            "advisor context",
            Some("memory summary"),
            "subjects summary",
            "prefix",
            "suffix",
            "full prompt body",
        );

        assert_eq!(summary.runtime_mode, "redclaw");
        assert_eq!(summary.tool_count, 2);
        assert_eq!(summary.active_skill_count, 3);
        assert!(summary.final_prompt_chars >= 16);
        assert!(summary.final_prompt_rendered_chars >= 16);
        assert_eq!(summary.final_prompt_hash.len(), 16);
        assert!(summary.estimated_final_prompt_tokens > 0);
        assert!(!summary.token_budget_exceeded);
        assert!(summary.memory_chars > 0);
    }
}
