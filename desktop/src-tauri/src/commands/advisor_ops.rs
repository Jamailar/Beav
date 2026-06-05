use crate::persistence::{ensure_store_hydrated_for_advisors, with_store, with_store_mut};
use crate::*;
use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, Emitter, State};

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

use crud::handle_crud_channel;
use knowledge_files::{collect_advisor_knowledge_files, import_advisor_knowledge_files};
use member_skills::{handle_member_skill_channel, publish_member_skill_if_enabled};
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
            "advisors:pick-knowledge-files" => {
                let selected = pick_files_native("选择要导入该成员知识库的文件", false, true)?;
                let files = selected
                    .into_iter()
                    .map(|path| {
                        json!({
                            "path": path,
                            "name": path.file_name().and_then(|value| value.to_str()).unwrap_or_default()
                        })
                    })
                    .collect::<Vec<_>>();
                Ok(json!({ "success": true, "files": files }))
            }
            "advisors:pick-knowledge-folder" => {
                let selected = pick_files_native("选择要导入该成员知识库的文件夹", true, false)?;
                let files = collect_advisor_knowledge_files(&selected)?
                    .into_iter()
                    .map(|path| {
                        json!({
                            "path": path,
                            "name": path.file_name().and_then(|value| value.to_str()).unwrap_or_default()
                        })
                    })
                    .collect::<Vec<_>>();
                Ok(json!({ "success": true, "files": files }))
            }
            "advisors:upload-knowledge" => {
                let started_at = now_ms();
                let advisor_id = payload_string(payload, "advisorId")
                    .or_else(|| payload_value_as_string(payload))
                    .unwrap_or_default();
                let selected = payload_field(payload, "filePaths")
                    .and_then(|value| value.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.as_str())
                            .map(std::path::PathBuf::from)
                            .collect::<Vec<_>>()
                    })
                    .map(Ok)
                    .unwrap_or_else(|| {
                        pick_files_native("选择要导入该成员知识库的文件", false, true)
                    })?;
                let imported = import_advisor_knowledge_files(state, &advisor_id, &selected)?;
                let imported_file_count = imported
                    .get("files")
                    .and_then(Value::as_array)
                    .map(|items| items.len() as i64)
                    .unwrap_or_default();
                let total_knowledge_file_count = with_store(state, |store| {
                    Ok(store
                        .advisors
                        .iter()
                        .find(|item| item.id == advisor_id)
                        .map(|item| item.knowledge_files.len() as i64)
                        .unwrap_or_default())
                })?;
                let _ = record_advisor_knowledge_ingest_metric(
                    state,
                    AdvisorKnowledgeIngestMetric {
                        advisor_id: advisor_id.clone(),
                        imported_file_count,
                        total_knowledge_file_count,
                        elapsed_ms: now_ms().saturating_sub(started_at) as i64,
                        created_at: now_i64(),
                    },
                );
                log_timing_event(
                    state,
                    "advisor",
                    &format!("advisors:upload-knowledge:{advisor_id}"),
                    "advisors:upload-knowledge",
                    started_at,
                    Some(format!(
                        "importedFiles={} totalKnowledgeFiles={}",
                        imported_file_count, total_knowledge_file_count
                    )),
                );
                let member_skill =
                    publish_member_skill_if_enabled(state, &advisor_id, "advisor-knowledge-import");
                let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
                knowledge_index::jobs::schedule_rebuild(app, "advisor-knowledge-import");
                let mut imported = imported;
                if let Some(object) = imported.as_object_mut() {
                    object.insert(
                        "memberSkill".to_string(),
                        member_skill.unwrap_or_else(|| Value::Null),
                    );
                }
                Ok(imported)
            }
            "advisors:delete-knowledge" => {
                let advisor_id = payload_string(payload, "advisorId").unwrap_or_default();
                let file_name = payload_string(payload, "fileName").unwrap_or_default();
                let result = with_store_mut(state, |store| {
                    let Some(advisor) =
                        store.advisors.iter_mut().find(|item| item.id == advisor_id)
                    else {
                        return Ok(json!({ "success": false, "error": "成员不存在" }));
                    };
                    advisor.knowledge_files.retain(|item| item != &file_name);
                    advisor.updated_at = now_iso();
                    Ok(json!({ "success": true }))
                })?;
                let path = advisor_knowledge_dir(state, &advisor_id)?.join(&file_name);
                let _ = fs::remove_file(path);
                let _ =
                    publish_member_skill_if_enabled(state, &advisor_id, "advisor-knowledge-delete");
                let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
                knowledge_index::jobs::schedule_rebuild(app, "advisor-knowledge-delete");
                Ok(result)
            }
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
            "advisors:select-avatar" => {
                let selected = pick_files_native("选择成员头像图片", false, false)?;
                let Some(path) = selected.into_iter().next() else {
                    return Ok(Value::Null);
                };
                let target_dir = advisor_avatar_dir(state)?;
                let (_, copied) = copy_file_into_dir(&path, &target_dir)?;
                Ok(json!(file_url_for_path(&copied)))
            }
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
