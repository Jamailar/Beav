use crate::tools::registry::descriptor_by_name_for_runtime_mode;

pub fn ensure_tool_allowed_for_runtime_mode(
    runtime_mode: &str,
    tool_name: &str,
) -> Result<(), String> {
    if descriptor_by_name_for_runtime_mode(runtime_mode, tool_name).is_some() {
        return Ok(());
    }
    Err(format!(
        "tool `{}` is not allowed in runtime mode `{}`",
        tool_name, runtime_mode
    ))
}

pub fn output_budget_for_tool(runtime_mode: &str, tool_name: &str) -> usize {
    descriptor_by_name_for_runtime_mode(runtime_mode, tool_name)
        .map(|item| item.output_budget_chars)
        .unwrap_or(8_000)
}

pub fn apply_output_budget(runtime_mode: &str, tool_name: &str, content: &str) -> (String, bool) {
    let budget = output_budget_for_tool(runtime_mode, tool_name);
    let count = content.chars().count();
    if count <= budget {
        return (content.to_string(), false);
    }
    let mut truncated = content.chars().take(budget).collect::<String>();
    truncated.push_str("\n\n[truncated by ToolResultBudget]");
    (truncated, true)
}
