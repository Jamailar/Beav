use serde_json::Value;

use crate::runtime::{
    runtime_direct_route_record, runtime_route_from_llm_parsed, RuntimeRouteRecord,
    RUNTIME_INTENT_NAMES, RUNTIME_ROLE_IDS,
};
use crate::{
    load_redbox_prompt, parse_json_value_from_text, payload_field, render_redbox_prompt,
    run_model_structured_task_with_settings,
};

fn text_contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn explicit_card_image_route(user_input: &str) -> Option<RuntimeRouteRecord> {
    let normalized = user_input.trim().to_lowercase();
    if normalized.is_empty() {
        return None;
    }
    let card_markers = [
        "演示卡片",
        "小红书演示卡片",
        "图解卡片",
        "文章卡片",
        "图文卡片",
        "知识卡片",
        "电商套图",
        "商品套图",
        "商品详情图",
        "轮播图",
        "组图",
        "多卡配图",
    ];
    if !text_contains_any(&normalized, &card_markers) {
        return None;
    }
    let explicit_project_markers = [
        "保存到工程",
        "绑定工程",
        "写入工程",
        "稿件文件夹",
        "稿件工程",
        "创建工程",
        "保存成工程",
        "入稿件",
    ];
    if text_contains_any(&normalized, &explicit_project_markers) {
        return None;
    }
    Some(RuntimeRouteRecord {
        intent: "image_creation".to_string(),
        secondary_intents: Vec::new(),
        goal: user_input.trim().to_string(),
        deliverables: vec!["成套卡片图".to_string()],
        required_capabilities: vec![
            "planning".to_string(),
            "image-generation".to_string(),
            "artifact-save".to_string(),
        ],
        recommended_role: "image-director".to_string(),
        requires_long_running_task: false,
        requires_multi_agent: false,
        requires_human_approval: false,
        confidence: 0.98,
        reasoning: "explicit-card-image-route".to_string(),
        source: "heuristic".to_string(),
    })
}

pub fn route_runtime_intent_with_settings(
    settings: &Value,
    runtime_mode: &str,
    user_input: &str,
    metadata: Option<&Value>,
) -> RuntimeRouteRecord {
    if let Some(explicit_image_route) = explicit_card_image_route(user_input) {
        return explicit_image_route;
    }
    let fallback = runtime_direct_route_record(runtime_mode, user_input, metadata);
    let Some(system_template) = load_redbox_prompt("runtime/ai/route_intent_system.txt") else {
        return fallback;
    };
    let Some(user_template) = load_redbox_prompt("runtime/ai/route_intent_user.txt") else {
        return fallback;
    };
    let user_prompt = render_redbox_prompt(
        &user_template,
        &[
            ("runtime_mode", runtime_mode.to_string()),
            ("user_input", user_input.to_string()),
            (
                "context_type",
                metadata
                    .and_then(|value| payload_field(value, "contextType"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string(),
            ),
            (
                "context_id",
                metadata
                    .and_then(|value| payload_field(value, "contextId"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string(),
            ),
            (
                "associated_file_path",
                metadata
                    .and_then(|value| payload_field(value, "associatedFilePath"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string(),
            ),
            ("fallback_intent", fallback.intent.clone()),
            ("fallback_role", fallback.recommended_role.clone()),
            ("fallback_reasoning", fallback.reasoning.clone()),
            ("intent_names", RUNTIME_INTENT_NAMES.join(", ")),
            ("role_ids", RUNTIME_ROLE_IDS.join(", ")),
        ],
    );
    let raw = run_model_structured_task_with_settings(
        settings,
        None,
        &system_template,
        &user_prompt,
        true,
    );
    let Ok(content) = raw else {
        return fallback;
    };
    let Some(parsed) = parse_json_value_from_text(&content) else {
        return fallback;
    };
    runtime_route_from_llm_parsed(&fallback, &parsed, user_input).unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_card_image_route_promotes_demo_cards_to_image_creation() {
        let route = explicit_card_image_route("帮我生成小红书演示卡片").expect("route");
        assert_eq!(route.intent, "image_creation");
        assert_eq!(route.recommended_role, "image-director");
    }

    #[test]
    fn explicit_card_image_route_does_not_override_when_project_binding_is_explicit() {
        assert!(explicit_card_image_route("帮我生成小红书演示卡片并写入稿件工程").is_none());
    }
}
