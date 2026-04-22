use tauri::State;

use super::recall::build_memory_recall_summary;
use super::types::MemoryPromptSection;
use crate::{truncate_chars, AppState};

pub(crate) fn build_memory_prompt_section(
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
    limit: usize,
) -> Option<MemoryPromptSection> {
    let summary = build_memory_recall_summary(state, runtime_mode, session_id, limit).ok()?;
    if summary.items.is_empty() {
        return None;
    }
    let rendered = format!(
        "Long-term memory recall:\n{}",
        truncate_chars(&summary.rendered_summary, 1200)
    );
    Some(MemoryPromptSection {
        title: "memory_summary_section".to_string(),
        summary: rendered.clone(),
        total_active: summary.total_active,
        matched_count: summary.matched_count,
        rendered_chars: rendered.chars().count(),
    })
}
