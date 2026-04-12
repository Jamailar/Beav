use serde_json::Value;

use crate::payload_string;
use crate::runtime::RuntimeSubagentRoleSpec;

pub fn runtime_subagent_role_spec(role_id: &str) -> RuntimeSubagentRoleSpec {
    match role_id {
        "planner" => RuntimeSubagentRoleSpec {
            role_id: "planner".to_string(),
            purpose: "负责拆解目标、确定阶段顺序、把任务转成明确执行步骤。".to_string(),
            handoff_contract: "把任务拆成可执行步骤，并给出下一角色所需最小输入。".to_string(),
            output_schema: "阶段计划、执行建议、关键依赖、保存策略".to_string(),
            system_prompt:
                "你是任务规划者，优先澄清目标、阶段、依赖和落盘动作，不要直接跳到模糊回答。"
                    .to_string(),
        },
        "researcher" => RuntimeSubagentRoleSpec {
            role_id: "researcher".to_string(),
            purpose: "负责检索知识、提取证据、整理素材、形成研究摘要。".to_string(),
            handoff_contract: "输出给写作者或评审时，必须包含证据、结论和不确定项。".to_string(),
            output_schema: "证据摘要、引用来源、结论边界、待验证点".to_string(),
            system_prompt:
                "你是研究代理，优先检索证据、阅读素材、提炼事实，不要在证据不足时强行下结论。"
                    .to_string(),
        },
        "copywriter" => RuntimeSubagentRoleSpec {
            role_id: "copywriter".to_string(),
            purpose: "负责产出标题、正文、发布话术、完整稿件和成品文案。".to_string(),
            handoff_contract: "完成正文后必须准备保存路径或项目归档信息。".to_string(),
            output_schema: "完整稿件、标题包、标签、发布建议".to_string(),
            system_prompt: "你是写作代理，目标是生成可直接交付和落盘的内容，而不是停留在聊天草稿。"
                .to_string(),
        },
        "image-director" => RuntimeSubagentRoleSpec {
            role_id: "image-director".to_string(),
            purpose: "负责封面、配图、海报、图片策略和视觉执行指令。".to_string(),
            handoff_contract: "给执行层的输出必须是可以直接生成或保存的结构化内容。".to_string(),
            output_schema: "封面策略、图片提示词、视觉结构、保存方案".to_string(),
            system_prompt:
                "你是图像策略代理，负责把目标转成可执行的配图/封面方案，并推动真实出图或落盘。"
                    .to_string(),
        },
        "reviewer" => RuntimeSubagentRoleSpec {
            role_id: "reviewer".to_string(),
            purpose: "负责校验结果是否符合需求、是否保存、是否存在幻觉或遗漏。".to_string(),
            handoff_contract: "如果结果不满足交付条件，明确指出缺口并阻止宣称成功。".to_string(),
            output_schema: "评审结论、问题列表、修正建议".to_string(),
            system_prompt:
                "你是质量评审代理，优先检查结果是否满足需求、是否真实落盘、是否存在伪成功。"
                    .to_string(),
        },
        _ => RuntimeSubagentRoleSpec {
            role_id: "ops-coordinator".to_string(),
            purpose: "负责后台任务、自动化、记忆维护和持续执行任务的推进。".to_string(),
            handoff_contract: "输出必须明确包含下一步执行条件与当前状态。".to_string(),
            output_schema: "调度动作、运行状态、恢复策略、维护结论".to_string(),
            system_prompt:
                "你是运行协调代理，负责长任务推进、自动化配置、状态检查、恢复和后台维护。"
                    .to_string(),
        },
    }
}

pub fn build_runtime_task_artifact_content(
    task_id: &str,
    route: &Value,
    goal: &str,
    orchestration: Option<&Value>,
) -> Result<String, String> {
    let intent = payload_string(route, "intent").unwrap_or_else(|| "direct_answer".to_string());
    let orchestration_outputs = orchestration_outputs(orchestration);
    let summary_lines = orchestration_summary_lines(&orchestration_outputs);
    let mut content = String::new();

    match intent.as_str() {
        "manuscript_creation" | "discussion" | "direct_answer" | "advisor_persona" => {
            content.push_str(&format!("# {}\n\n", goal.trim()));
            if !summary_lines.is_empty() {
                content.push_str("## Execution Summary\n\n");
                content.push_str(&summary_lines.join("\n"));
                content.push_str("\n\n");
            }
            for item in &orchestration_outputs {
                if let Some(role_id) = payload_string(item, "roleId") {
                    content.push_str(&format!("## {}\n\n", role_id));
                    if let Some(artifact) = payload_string(item, "artifact") {
                        if !artifact.trim().is_empty() {
                            content.push_str(&artifact);
                            content.push_str("\n\n");
                            continue;
                        }
                    }
                    content.push_str(&payload_string(item, "summary").unwrap_or_default());
                    content.push_str("\n\n");
                }
            }
        }
        "image_creation" | "cover_generation" => {
            content.push_str(&format!("# Visual Task {}\n\n", task_id));
            content.push_str(&format!("Goal: {}\n\n", goal));
            content.push_str("## Visual Plan\n\n");
            if summary_lines.is_empty() {
                content.push_str("- No visual plan generated.\n");
            } else {
                content.push_str(&summary_lines.join("\n"));
                content.push('\n');
            }
        }
        _ => {
            content.push_str(&format!("# Runtime Task {}\n\n", task_id));
            content.push_str(&format!("Intent: {}\n\n", intent));
            content.push_str(&format!("Goal: {}\n\n", goal));
            if !summary_lines.is_empty() {
                content.push_str("## Summary\n\n");
                content.push_str(&summary_lines.join("\n"));
                content.push_str("\n\n");
            }
        }
    }

    if let Some(orchestration) = orchestration {
        content.push_str("## Orchestration JSON\n\n```json\n");
        content.push_str(
            &serde_json::to_string_pretty(orchestration).map_err(|error| error.to_string())?,
        );
        content.push_str("\n```\n");
    }

    Ok(content)
}

pub fn reviewer_rejected(orchestration: Option<&Value>) -> bool {
    orchestration
        .and_then(|value| value.get("outputs"))
        .and_then(|value| value.as_array())
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("roleId").and_then(|value| value.as_str()) == Some("reviewer")
            })
        })
        .map(|review| {
            let approved = review
                .get("approved")
                .and_then(|value| value.as_bool())
                .unwrap_or(true);
            let issue_count = review
                .get("issues")
                .and_then(|value| value.as_array())
                .map(|items| items.len())
                .unwrap_or(0);
            !approved || issue_count > 0
        })
        .unwrap_or(false)
}

pub fn build_repair_goal(goal: &str, repair: &Value) -> String {
    format!(
        "{}\n\nRepair instructions:\n{}",
        goal,
        payload_string(repair, "summary").unwrap_or_else(|| repair.to_string())
    )
}

fn orchestration_outputs(orchestration: Option<&Value>) -> Vec<Value> {
    orchestration
        .and_then(|value| value.get("outputs"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn orchestration_summary_lines(outputs: &[Value]) -> Vec<String> {
    outputs
        .iter()
        .filter_map(|item| {
            Some(format!(
                "- {}: {}",
                payload_string(item, "roleId")?,
                payload_string(item, "summary").unwrap_or_default()
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reviewer_rejected_returns_false_without_reviewer_output() {
        assert!(!reviewer_rejected(Some(&json!({
            "outputs": [{"roleId": "planner", "summary": "ok"}]
        }))));
    }

    #[test]
    fn reviewer_rejected_returns_true_for_disapproval_or_issues() {
        assert!(reviewer_rejected(Some(&json!({
            "outputs": [{"roleId": "reviewer", "approved": false, "issues": []}]
        }))));
        assert!(reviewer_rejected(Some(&json!({
            "outputs": [{"roleId": "reviewer", "approved": true, "issues": [{}]}]
        }))));
    }

    #[test]
    fn build_repair_goal_prefers_summary_field() {
        let goal = build_repair_goal("Write draft", &json!({"summary": "Fix missing citations"}));
        assert!(goal.contains("Write draft"));
        assert!(goal.contains("Fix missing citations"));
    }
}
