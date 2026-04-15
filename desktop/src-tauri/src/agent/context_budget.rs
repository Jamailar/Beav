use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContextTruncationStrategy {
    Head,
    Tail,
    Middle,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSectionBudget {
    pub max_chars: usize,
    pub strategy: ContextTruncationStrategy,
}

pub fn budget_for_section(section_id: &str) -> ContextSectionBudget {
    match section_id {
        "identity_section" => ContextSectionBudget {
            max_chars: 2_000,
            strategy: ContextTruncationStrategy::Head,
        },
        "workspace_rules_section" => ContextSectionBudget {
            max_chars: 3_000,
            strategy: ContextTruncationStrategy::Head,
        },
        "runtime_mode_section" => ContextSectionBudget {
            max_chars: 1_500,
            strategy: ContextTruncationStrategy::Head,
        },
        "skill_overlay_section" => ContextSectionBudget {
            max_chars: 3_000,
            strategy: ContextTruncationStrategy::Head,
        },
        "memory_summary_section" => ContextSectionBudget {
            max_chars: 2_000,
            strategy: ContextTruncationStrategy::Head,
        },
        "profile_docs_section" => ContextSectionBudget {
            max_chars: 6_000,
            strategy: ContextTruncationStrategy::Middle,
        },
        "tool_contract_section" => ContextSectionBudget {
            max_chars: 2_000,
            strategy: ContextTruncationStrategy::Head,
        },
        "ephemeral_turn_section" => ContextSectionBudget {
            max_chars: 2_500,
            strategy: ContextTruncationStrategy::Head,
        },
        _ => ContextSectionBudget {
            max_chars: 1_500,
            strategy: ContextTruncationStrategy::Head,
        },
    }
}

fn take_chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

pub fn apply_section_budget(
    text: &str,
    max_chars: usize,
    strategy: ContextTruncationStrategy,
) -> (String, bool, usize, usize) {
    let raw_chars = text.chars().count();
    if raw_chars <= max_chars {
        return (text.to_string(), false, raw_chars, raw_chars);
    }

    let truncated = match strategy {
        ContextTruncationStrategy::Head => take_chars(text, max_chars),
        ContextTruncationStrategy::Tail => {
            let chars = text.chars().collect::<Vec<_>>();
            chars[chars.len().saturating_sub(max_chars)..]
                .iter()
                .collect::<String>()
        }
        ContextTruncationStrategy::Middle => {
            let head = max_chars / 2;
            let tail = max_chars.saturating_sub(head).saturating_sub(9);
            let chars = text.chars().collect::<Vec<_>>();
            let start = chars.iter().take(head).collect::<String>();
            let end = chars[chars.len().saturating_sub(tail)..]
                .iter()
                .collect::<String>();
            format!("{start}\n\n[...]\n\n{end}")
        }
    };
    let final_chars = truncated.chars().count();
    (truncated, true, raw_chars, final_chars)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_section_budget_preserves_short_text() {
        let (text, truncated, raw, final_chars) =
            apply_section_budget("hello", 10, ContextTruncationStrategy::Head);
        assert_eq!(text, "hello");
        assert!(!truncated);
        assert_eq!(raw, 5);
        assert_eq!(final_chars, 5);
    }

    #[test]
    fn apply_section_budget_truncates_middle_text() {
        let text = "abcdefghijklmnopqrstuvwxyz";
        let (truncated, did_truncate, raw, final_chars) =
            apply_section_budget(text, 12, ContextTruncationStrategy::Middle);
        assert!(did_truncate);
        assert_eq!(raw, 26);
        assert!(final_chars <= 17);
        assert!(truncated.contains("[...]"));
    }
}
