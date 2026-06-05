use crate::persistence::{ensure_store_hydrated_for_advisors, with_store};
use crate::AppState;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

#[path = "advisor_ops/avatar.rs"]
mod avatar;
#[path = "advisor_ops/crud.rs"]
mod crud;
#[path = "advisor_ops/knowledge_files.rs"]
mod knowledge_files;
#[path = "advisor_ops/member_skills.rs"]
mod member_skills;
#[path = "advisor_ops/persona.rs"]
mod persona;
#[path = "advisor_ops/prompt_ops.rs"]
mod prompt_ops;
#[path = "advisor_ops/templates.rs"]
mod templates;
#[path = "advisor_ops/videos.rs"]
mod videos;
#[path = "advisor_ops/youtube.rs"]
mod youtube;

use avatar::handle_avatar_channel;
use crud::handle_crud_channel;
use knowledge_files::handle_knowledge_channel;
use member_skills::handle_member_skill_channel;
use persona::handle_persona_channel;
use prompt_ops::handle_prompt_channel;
pub(crate) use templates::advisors_list_templates_value;
use youtube::handle_youtube_channel;

pub(crate) fn advisors_list_value(state: &State<'_, AppState>) -> Result<Value, String> {
    let _ = ensure_store_hydrated_for_advisors(state);
    with_store(state, |store| {
        let mut advisors = store.advisors.clone();
        advisors.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(json!(advisors))
    })
}

#[tauri::command]
pub async fn advisors_list(state: State<'_, AppState>) -> Result<Value, String> {
    advisors_list_value(&state)
}

#[tauri::command]
pub async fn advisors_list_templates() -> Result<Value, String> {
    advisors_list_templates_value()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advisors_list_templates_loads_bundled_member_templates() {
        let templates = advisors_list_templates_value()
            .expect("advisor templates should load")
            .as_array()
            .cloned()
            .expect("advisor templates should be an array");
        let template_ids = templates
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .collect::<std::collections::BTreeSet<_>>();

        assert_eq!(templates.len(), 14);
        assert!(template_ids.contains("agency-xiaohongshu-specialist"));
        assert!(template_ids.contains("agency-product-manager"));
        assert!(template_ids.contains("content-strategist"));
        assert!(template_ids.contains("growth-analyst"));
    }
}

pub fn handle_advisor_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "advisors:list"
            | "advisors:list-templates"
            | "advisors:create"
            | "advisors:update"
            | "advisors:delete"
            | "advisors:pick-knowledge-files"
            | "advisors:pick-knowledge-folder"
            | "advisors:upload-knowledge"
            | "advisors:delete-knowledge"
            | "advisors:optimize-prompt"
            | "advisors:optimize-prompt-deep"
            | "advisors:generate-persona"
            | "advisors:inspect-member-skill"
            | "advisors:promote-member-skill-candidate"
            | "advisors:discard-member-skill-candidate"
            | "advisors:rollback-member-skill-version"
            | "members:enqueue-distillation"
            | "members:distill-skill"
            | "members:list-distillation-candidates"
            | "members:preview-distillation"
            | "members:approve-distillation"
            | "members:publish-skill-version"
            | "members:rollback-skill-version"
            | "members:compile-skill-package"
            | "members:evaluate-skill"
            | "advisors:select-avatar"
            | "advisors:youtube-runner-status"
            | "advisors:fetch-youtube-info"
            | "advisors:download-youtube-subtitles"
            | "advisors:get-videos"
            | "advisors:refresh-videos"
            | "advisors:download-video"
            | "advisors:retry-failed"
            | "advisors:update-youtube-settings"
            | "advisors:youtube-runner-run-now"
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "advisors:list" => advisors_list_value(state),
            "advisors:list-templates" => advisors_list_templates_value(),
            "advisors:create" | "advisors:update" | "advisors:delete" => {
                handle_crud_channel(app, state, channel, payload)
                    .unwrap_or_else(|| Err("成员 CRUD 动作未注册".to_string()))
            }
            "advisors:pick-knowledge-files"
            | "advisors:pick-knowledge-folder"
            | "advisors:upload-knowledge"
            | "advisors:delete-knowledge" => handle_knowledge_channel(app, state, channel, payload)
                .unwrap_or_else(|| Err("成员知识库动作未注册".to_string())),
            "advisors:promote-member-skill-candidate"
            | "members:enqueue-distillation"
            | "members:distill-skill"
            | "members:approve-distillation"
            | "members:publish-skill-version"
            | "advisors:discard-member-skill-candidate"
            | "advisors:inspect-member-skill"
            | "members:list-distillation-candidates"
            | "members:preview-distillation"
            | "advisors:rollback-member-skill-version"
            | "members:rollback-skill-version"
            | "members:compile-skill-package"
            | "members:evaluate-skill" => handle_member_skill_channel(app, state, channel, payload)
                .unwrap_or_else(|| Err("成员技能动作未注册".to_string())),
            "advisors:optimize-prompt" | "advisors:optimize-prompt-deep" => {
                handle_prompt_channel(state, channel, payload)
                    .unwrap_or_else(|| Err("成员提示词动作未注册".to_string()))
            }
            "advisors:generate-persona" => handle_persona_channel(state, channel, payload)
                .unwrap_or_else(|| Err("成员角色生成动作未注册".to_string())),
            "advisors:select-avatar" => handle_avatar_channel(state, channel)
                .unwrap_or_else(|| Err("成员头像动作未注册".to_string())),
            "advisors:youtube-runner-status"
            | "advisors:fetch-youtube-info"
            | "advisors:download-youtube-subtitles"
            | "advisors:get-videos"
            | "advisors:refresh-videos"
            | "advisors:download-video"
            | "advisors:retry-failed"
            | "advisors:update-youtube-settings"
            | "advisors:youtube-runner-run-now" => {
                handle_youtube_channel(app, state, channel, payload)
                    .unwrap_or_else(|| Err("YouTube 动作未注册".to_string()))
            }
            _ => unreachable!(),
        }
    })())
}
