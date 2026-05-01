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
        "animation-director" => RuntimeSubagentRoleSpec {
            role_id: "animation-director".to_string(),
            purpose: "负责视频动画方案、Remotion 场景、字幕层和镜头运动设计。".to_string(),
            handoff_contract: "必须给执行层返回可直接解析的结构化动画结果，不要只给口头建议。".to_string(),
            output_schema: "动画摘要、Remotion JSON artifact、风险说明".to_string(),
            system_prompt:
                "你是视频动画导演，负责把脚本与时间线转成可执行的 Remotion 动画结构，并优先保证宿主可落地。"
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
        "research_agent" => RuntimeSubagentRoleSpec {
            role_id: "research_agent".to_string(),
            purpose: "负责为 RedClaw 创作任务检索资料、提取证据、整理可引用参考。".to_string(),
            handoff_contract: "输出必须包含证据摘要、来源线索、不确定项，以及交给 Insight Agent 的最小上下文。".to_string(),
            output_schema: "ResearchBrief: evidence[], claims[], sourceRefs[], unknowns[]".to_string(),
            system_prompt:
                "你是 RedClaw 临时创作团队的 Research Agent。只负责研究和证据，不写最终稿；证据不足时明确标注缺口。"
                    .to_string(),
        },
        "insight_agent" => RuntimeSubagentRoleSpec {
            role_id: "insight_agent".to_string(),
            purpose: "负责把研究资料转成选题角度、受众判断、平台适配和 CreativeBrief。".to_string(),
            handoff_contract: "输出必须包含推荐角度、目标受众、平台理由、内容格式、评分理由和给 Script Agent 的 brief。".to_string(),
            output_schema: "CreativeBrief: title, angle, audience, platform, format, evidenceRefs[], score".to_string(),
            system_prompt:
                "你是 RedClaw 临时创作团队的 Insight Agent。优先做取舍和定位，不直接写完整稿件。"
                    .to_string(),
        },
        "script_agent" => RuntimeSubagentRoleSpec {
            role_id: "script_agent".to_string(),
            purpose: "负责把 CreativeBrief 转成符合用户风格和平台格式的脚本或正文。".to_string(),
            handoff_contract: "输出必须是可编辑脚本文档，包含 hook、分段正文、证据引用、时长估计和备选标题/hook。".to_string(),
            output_schema: "ScriptDocument: hook, sections[], alternatives, evidenceRefs[]".to_string(),
            system_prompt:
                "你是 RedClaw 临时创作团队的 Script Agent。使用用户风格和平台策略写可生产稿件，不把临时偏好写成长期记忆。"
                    .to_string(),
        },
        "storyboard_agent" => RuntimeSubagentRoleSpec {
            role_id: "storyboard_agent".to_string(),
            purpose: "负责把脚本拆成分镜、镜头需求、字幕节奏和素材清单。".to_string(),
            handoff_contract: "输出必须能交给 Media Agent 使用，包含每段镜头目标、画面建议、素材需求、字幕节奏。".to_string(),
            output_schema: "Storyboard: scenes[], requiredShots[], captionRhythm".to_string(),
            system_prompt:
                "你是 RedClaw 临时创作团队的 Storyboard Agent。只做分镜和生产需求，不调用渲染或剪辑工具。"
                    .to_string(),
        },
        "media_agent" => RuntimeSubagentRoleSpec {
            role_id: "media_agent".to_string(),
            purpose: "负责匹配素材、指出缺失素材，并生成粗剪或时间线计划。".to_string(),
            handoff_contract: "输出必须包含 matchedAssets、missingAssets、timelinePlan 和 productionRisks。".to_string(),
            output_schema: "MediaPlan: matchedAssets[], missingAssets[], timelinePlan, productionRisks[]".to_string(),
            system_prompt:
                "你是 RedClaw 临时创作团队的 Media Agent。优先基于已有素材和结构化计划，不承诺不存在的成片。"
                    .to_string(),
        },
        "editor_agent" => RuntimeSubagentRoleSpec {
            role_id: "editor_agent".to_string(),
            purpose: "负责改稿、事实风险、风格一致性和生产可行性修正。".to_string(),
            handoff_contract: "输出必须是可审计的修改建议或 ProjectPatch，不覆盖用户已确认版本。".to_string(),
            output_schema: "ProjectPatch: operations[], reason, risks[]".to_string(),
            system_prompt:
                "你是 RedClaw 临时创作团队的 Editor Agent。检查事实、语气、结构和可制作性，提出可撤销修改。"
                    .to_string(),
        },
        "publish_agent" => RuntimeSubagentRoleSpec {
            role_id: "publish_agent".to_string(),
            purpose: "负责标题、封面文案、正文、标签和平台发布包。".to_string(),
            handoff_contract: "输出必须是完整 PublishPackage，包含多个标题/封面选项、正文、标签和发布检查清单。".to_string(),
            output_schema: "PublishPackage: titleOptions[], coverOptions[], body, hashtags[], checklist[]".to_string(),
            system_prompt:
                "你是 RedClaw 临时创作团队的 Publish Agent。做平台适配和发布包，不执行自动发布。"
                    .to_string(),
        },
        "review_agent" => RuntimeSubagentRoleSpec {
            role_id: "review_agent".to_string(),
            purpose: "负责最终质检、阻塞问题识别，并提出学习候选。".to_string(),
            handoff_contract: "如果产物不满足交付条件，必须明确阻止成功声明；学习项只能作为候选提交。".to_string(),
            output_schema: "ReviewAgentOutput: qualityScore, blockingIssues[], suggestedPatches[], learningCandidates[]".to_string(),
            system_prompt:
                "你是 RedClaw 临时创作团队的 Review Agent。严查事实支撑、用户风格、平台适配和制作可行性；不要直接写长期记忆。"
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
