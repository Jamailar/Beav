use super::*;

pub fn sanitize_runtime_history_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter_map(sanitize_runtime_history_message)
        .collect()
}

pub(super) fn runtime_history_message_from_chat_record(item: ChatMessageRecord) -> Value {
    let mut message = json!({
        "role": item.role,
        "content": item.content
    });
    if let Some(metadata) = item.metadata {
        if let Some(object) = message.as_object_mut() {
            object.insert("metadata".to_string(), metadata);
        }
    }
    message
}

fn sanitize_runtime_history_message(message: &Value) -> Option<Value> {
    if crate::skills::is_skill_instruction_message(message) {
        return None;
    }
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match role {
        "tool" => None,
        "assistant" => {
            let content = message
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if content.is_empty() {
                None
            } else {
                Some(json!({
                    "role": "assistant",
                    "content": content
                }))
            }
        }
        "user" => {
            let content = message
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if content.is_empty() || is_internal_runtime_history_user_message(&content) {
                None
            } else {
                let content =
                    append_runtime_history_reference_context(content, message.get("metadata"));
                Some(json!({
                    "role": "user",
                    "content": content
                }))
            }
        }
        _ => None,
    }
}

fn append_runtime_history_reference_context(
    mut content: String,
    metadata: Option<&Value>,
) -> String {
    let reference_context = runtime_history_asset_reference_context(metadata);
    if !reference_context.is_empty() {
        content.push_str("\n\n");
        content.push_str(&reference_context);
    }
    content
}

fn runtime_history_asset_reference_context(metadata: Option<&Value>) -> String {
    let Some(items) = metadata
        .and_then(|item| item.get("explicitAssetRefs"))
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
    else {
        return String::new();
    };
    let mut lines = vec![
        "Referenced assets from this user message:".to_string(),
        "- These are resolved asset-library selections originally made with `@`.".to_string(),
    ];
    let mut rendered_count = 0usize;
    for item in items.iter().take(12) {
        let asset_id = item
            .get("assetId")
            .or_else(|| item.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(asset_id) = asset_id else {
            continue;
        };
        let name = item
            .get("name")
            .or_else(|| item.get("title"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("未命名资产");
        rendered_count += 1;
        lines.push(format!(
            "{}. name: {}; id: {}",
            rendered_count, name, asset_id
        ));
    }
    if rendered_count == 0 {
        String::new()
    } else {
        lines.join("\n")
    }
}

pub(super) fn is_internal_runtime_history_user_message(content: &str) -> bool {
    crate::skills::is_skill_instruction_content(content)
        || crate::skills::is_available_skills_instruction_content(content)
        || content
        == "你已经用完本次会话允许的工具轮次预算。不要继续调用工具；基于已有上下文和工具结果直接完成最终答复，如果仍有缺口，请明确指出缺口。"
        || content.starts_with("系统状态更新：")
        || content.starts_with("当前写稿工程已创建并绑定为 `")
        || content.starts_with("你刚才发送了空的 `workflow` 调用")
        || content.starts_with("当前任务是执行型创作任务")
        || content.starts_with("当前任务还没有完成这些必需动作：")
        || content.starts_with("你正在处理一个图片生成后台进度回传。")
        || content.starts_with("你正在处理一个图片生成后台回传任务。")
        || content.starts_with("你正在处理一个视频生成后台进度回传。")
        || content.starts_with("你正在处理一个视频生成后台回传任务。")
        || content.starts_with("你正在处理一个音频生成后台进度回传。")
        || content.starts_with("你正在处理一个音频生成后台回传任务。")
}

pub(super) fn is_internal_runtime_bundle_message(message: &Value) -> bool {
    crate::skills::is_skill_instruction_message(message)
        || (message.get("role").and_then(Value::as_str) == Some("user")
            && message
                .get("content")
                .and_then(Value::as_str)
                .map(str::trim)
                .map(is_internal_runtime_history_user_message)
                .unwrap_or(false))
}

pub(super) fn build_session_context_summary(messages: &[ChatMessageRecord]) -> String {
    let total_count = messages.len();
    let user_count = messages.iter().filter(|item| item.role == "user").count();
    let assistant_count = messages
        .iter()
        .filter(|item| item.role == "assistant")
        .count();
    let first_user = messages
        .iter()
        .find(|item| item.role == "user")
        .map(|item| snippet(&item.content, 180));
    let last_user = messages
        .iter()
        .rev()
        .find(|item| item.role == "user")
        .map(|item| snippet(&item.content, 220));
    let last_assistant = messages
        .iter()
        .rev()
        .find(|item| item.role == "assistant")
        .map(|item| snippet(&item.content, 220));

    let mut lines = vec![format!(
        "Archived {total_count} messages ({user_count} user / {assistant_count} assistant) from this session."
    )];
    if let Some(value) = first_user {
        lines.push(format!("Conversation started with: {value}"));
    }
    if let Some(value) = last_user {
        lines.push(format!("Latest archived user intent: {value}"));
    }
    if let Some(value) = last_assistant {
        lines.push(format!("Latest archived assistant reply: {value}"));
    }
    let summary = lines.join("\n");
    snippet(&summary, SESSION_CONTEXT_SUMMARY_MAX_CHARS)
}

pub(super) fn session_bundle_summary_from_messages(messages: &[Value]) -> String {
    messages
        .iter()
        .find(|item| {
            item.get("role").and_then(Value::as_str) == Some("user")
                && !is_internal_runtime_bundle_message(item)
        })
        .and_then(|item| item.get("content").and_then(Value::as_str))
        .map(|item| snippet(item, 80))
        .unwrap_or_default()
}

pub(super) fn snippet(value: &str, limit: usize) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= limit {
        return text;
    }
    let mut truncated: String = text.chars().take(limit.saturating_sub(1)).collect();
    truncated.push('…');
    truncated
}

pub(super) fn estimate_tokens_from_chars(chars: i64) -> i64 {
    ((chars.max(0) as f64) / 4.0).ceil() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_followup_bridge_prompts_are_internal_history_messages() {
        assert!(is_internal_runtime_history_user_message(
            "系统状态更新：以下技能已选择供当前轮使用：high-retention-video-script。本次工具结果已返回 skillContextPack。"
        ));
        assert!(is_internal_runtime_history_user_message(
            "你正在处理一个图片生成后台进度回传。不要提到后台任务、session bridge、系统提示或内部轮询。"
        ));
        assert!(is_internal_runtime_history_user_message(
            "你正在处理一个视频生成后台回传任务。不要提到后台任务、session bridge、系统提示或内部轮询。"
        ));
        assert!(!is_internal_runtime_history_user_message(
            "图片已生成完成。\n\n![图片](<file:///tmp/redbox-image.png>)"
        ));
    }
}
