use crate::payload_field;
use serde_json::Value;

const MAX_IMAGE_BATCH_ITEMS: usize = 6;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct PlannedImageGenerationItem {
    pub title: Option<String>,
    pub prompt: String,
}

fn planned_image_string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn build_planned_image_generation_prompt(item: &Value) -> Option<String> {
    if let Some(compiled_prompt) = planned_image_string_field(item, &["compiledPrompt"]) {
        return Some(compiled_prompt);
    }

    let visual_prompt =
        planned_image_string_field(item, &["prompt", "visual", "description", "picture"])?;
    let visible_copy = planned_image_string_field(
        item,
        &[
            "copy",
            "visibleText",
            "visible_text",
            "text",
            "textContent",
            "onscreenText",
        ],
    );
    let mut prompt_parts = Vec::new();

    if let Some(copy) = visible_copy {
        prompt_parts.push(format!(
            "Visible text to render exactly, and no other planning labels: {copy}"
        ));
    } else {
        prompt_parts.push(
            "Do not render planning labels, page numbers, card numbers, storyboard labels, table headers, framework names, or internal reasoning text as visible image text."
                .to_string(),
        );
    }
    prompt_parts.push(format!("Visual brief: {visual_prompt}"));
    prompt_parts.push(
        "Treat imagePlanItems.title/name/label, sequenceGoal, page order, and planning table labels as internal metadata only. Do not place them in the image. Do not render words like 第1页, 第2页, 卡片1, 冲突页, 反转页, 方法页, 行动页, thinking_process, direction_frame, framework, storyboard, prompt, or layout unless they are explicitly included in the visible text above."
            .to_string(),
    );

    Some(prompt_parts.join("\n"))
}

pub(super) fn extract_planned_image_generation_items(
    payload: &Value,
) -> Vec<PlannedImageGenerationItem> {
    payload_field(payload, "imagePlanItems")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(MAX_IMAGE_BATCH_ITEMS)
                .filter(|item| item.is_object())
                .filter_map(|item| {
                    let prompt = build_planned_image_generation_prompt(item)?;
                    Some(PlannedImageGenerationItem {
                        title: planned_image_string_field(item, &["title", "name", "label"]),
                        prompt,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub(super) fn build_generated_image_title(
    batch_title: Option<&str>,
    item_title: Option<&str>,
    prompt: &str,
    index: usize,
    total: usize,
) -> Option<String> {
    if let Some(item_title) = item_title.map(str::trim).filter(|value| !value.is_empty()) {
        return Some(item_title.to_string());
    }
    if let Some(batch_title) = batch_title.map(str::trim).filter(|value| !value.is_empty()) {
        return Some(if total > 1 {
            format!("{batch_title} {}", index + 1)
        } else {
            batch_title.to_string()
        });
    }
    let excerpt = prompt.trim().chars().take(24).collect::<String>();
    if excerpt.is_empty() {
        None
    } else {
        Some(excerpt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_planned_image_generation_items_prefers_compiled_prompt() {
        let items = extract_planned_image_generation_items(&json!({
            "imagePlanItems": [
                {
                    "title": "封面",
                    "prompt": "原始描述",
                    "compiledPrompt": "最终执行提示词"
                },
                {
                    "label": "第二张",
                    "description": "细节补图"
                }
            ]
        }));

        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title.as_deref(), Some("封面"));
        assert_eq!(items[0].prompt, "最终执行提示词");
        assert_eq!(items[1].title.as_deref(), Some("第二张"));
        assert!(items[1].prompt.contains("Visual brief: 细节补图"));
        assert!(items[1].prompt.contains("planning labels"));
    }

    #[test]
    fn extract_planned_image_generation_items_compiles_visible_copy_without_title() {
        let items = extract_planned_image_generation_items(&json!({
            "imagePlanItems": [
                {
                    "title": "第2页冲突",
                    "copy": "你不是缺方法，是缺反馈回路\n做产品→没反馈→再加功能→继续没人看",
                    "prompt": "冲突模型卡片，中心为循环箭头图示"
                }
            ]
        }));

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title.as_deref(), Some("第2页冲突"));
        assert!(items[0].prompt.contains("你不是缺方法，是缺反馈回路"));
        assert!(items[0].prompt.contains("Visual brief: 冲突模型卡片"));
        assert!(!items[0]
            .prompt
            .contains("Visible text to render exactly, and no other planning labels: 第2页冲突"));
        assert!(items[0]
            .prompt
            .contains("Treat imagePlanItems.title/name/label"));
    }

    #[test]
    fn extract_planned_image_generation_items_keeps_six_entries() {
        let items = extract_planned_image_generation_items(&json!({
            "imagePlanItems": [
                { "title": "1", "prompt": "p1" },
                { "title": "2", "prompt": "p2" },
                { "title": "3", "prompt": "p3" },
                { "title": "4", "prompt": "p4" },
                { "title": "5", "prompt": "p5" },
                { "title": "6", "prompt": "p6" }
            ]
        }));

        assert_eq!(items.len(), 6);
        assert_eq!(items[5].title.as_deref(), Some("6"));
        assert!(items[5].prompt.contains("Visual brief: p6"));
    }

    #[test]
    fn build_generated_image_title_prefers_item_title_then_batch_title() {
        assert_eq!(
            build_generated_image_title(
                Some("春日咖啡海报"),
                Some("第 2 张 细节页"),
                "咖啡杯特写",
                1,
                3,
            ),
            Some("第 2 张 细节页".to_string())
        );
        assert_eq!(
            build_generated_image_title(Some("春日咖啡海报"), None, "咖啡杯特写", 1, 3),
            Some("春日咖啡海报 2".to_string())
        );
    }
}
