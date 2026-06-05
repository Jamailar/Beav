use crate::persistence::with_store;
use crate::store::settings as settings_store;
use crate::{
    app_brand_display_name, collect_advisor_knowledge_evidence,
    collect_related_manuscript_evidence, load_advisor_existing_context, load_redbox_prompt,
    load_skill_bundle_sections, log_timing_event, normalize_optional_string,
    parse_json_value_from_text, payload_field, payload_string, record_advisor_persona_metric,
    render_named_corpus, render_redbox_prompt, run_model_structured_task_with_settings,
    run_model_text_task_with_settings, search_web_with_settings, AdvisorPersonaMetric, AppState,
};
use serde_json::{json, Value};
use tauri::State;

pub(super) fn handle_persona_channel(
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    Some(match channel {
        "advisors:generate-persona" => generate_persona_value(state, payload),
        _ => return None,
    })
}

fn generate_persona_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let started_at = crate::now_ms();
    let settings_snapshot =
        with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    let advisor_id = payload_string(payload, "advisorId").unwrap_or_default();
    let channel_name =
        payload_string(payload, "channelName").unwrap_or_else(|| "YouTube 频道".to_string());
    let channel_description = payload_string(payload, "channelDescription").unwrap_or_default();
    let video_titles = payload_field(payload, "videoTitles")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .collect::<Vec<_>>()
                .join(" / ")
        })
        .unwrap_or_default();
    let knowledge_language =
        payload_string(payload, "knowledgeLanguage").unwrap_or_else(|| "中文".to_string());
    let subject_names = vec![channel_name.clone()];
    let existing_context = with_store(state, |store| {
        Ok(load_advisor_existing_context(&store, &advisor_id))
    })?;
    let advisor_knowledge = collect_advisor_knowledge_evidence(state, &advisor_id)?;
    let manuscript_evidence = collect_related_manuscript_evidence(state, &subject_names)?;
    let search_started_at = crate::now_ms();
    let search_results = search_web_with_settings(
        &settings_snapshot,
        &format!("{channel_name} YouTube 博主 创作者 频道定位 内容风格"),
        6,
    )
    .unwrap_or_default();
    let search_elapsed_ms = crate::now_ms().saturating_sub(search_started_at) as i64;
    let (skill_name, skill_body, skill_references, skill_scripts) =
        load_skill_bundle_sections(state, "agent-persona-creator");
    let search_summary = if search_results.is_empty() {
        "(无外部搜索结果)".to_string()
    } else {
        search_results
            .iter()
            .enumerate()
            .map(|(index, item)| {
                format!(
                    "Result {}\nTitle: {}\nURL: {}\nSnippet: {}",
                    index + 1,
                    item.get("title")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                    item.get("url")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                    item.get("snippet")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    let research_system_prompt =
        load_redbox_prompt("runtime/advisors/generate_persona_research_system.txt")
            .map(|template| {
                render_redbox_prompt(
                    &template,
                    &[
                        ("skill_name", skill_name.clone()),
                        ("skill_body", skill_body.clone()),
                        ("skill_references", skill_references.clone()),
                        ("skill_scripts", skill_scripts.clone()),
                    ],
                )
            })
            .unwrap_or_else(|| {
                format!(
                    "你是 {} 内部的智囊团角色研究代理，负责做角色研究并输出严格 JSON。",
                    app_brand_display_name()
                )
            });
    let research_user_template =
        load_redbox_prompt("runtime/advisors/generate_persona_research_user.txt")
            .unwrap_or_else(|| "请根据证据做角色研究并输出严格 JSON。".to_string());
    let research_user_prompt = render_redbox_prompt(
        &research_user_template,
        &[
            ("channel_name", channel_name.clone()),
            ("knowledge_language", knowledge_language.clone()),
            (
                "channel_description",
                if channel_description.trim().is_empty() {
                    "(无频道描述)".to_string()
                } else {
                    channel_description.clone()
                },
            ),
            (
                "video_titles",
                if video_titles.trim().is_empty() {
                    "(无视频标题)".to_string()
                } else {
                    video_titles
                        .split(" / ")
                        .enumerate()
                        .map(|(index, title)| format!("{}. {}", index + 1, title))
                        .collect::<Vec<_>>()
                        .join("\n")
                },
            ),
            ("search_summary", search_summary.clone()),
            ("existing_context", existing_context),
            (
                "advisor_knowledge_corpus",
                render_named_corpus(
                    "Knowledge Evidence",
                    &advisor_knowledge,
                    "(无 advisor 知识文件)",
                ),
            ),
            (
                "manuscript_corpus",
                render_named_corpus(
                    "Manuscript Evidence",
                    &manuscript_evidence,
                    "(无关联稿件命中)",
                ),
            ),
        ],
    );
    let research_raw = run_model_structured_task_with_settings(
        &settings_snapshot,
        None,
        &research_system_prompt,
        &research_user_prompt,
        true,
    )
    .or_else(|_| {
        run_model_text_task_with_settings(
            &settings_snapshot,
            None,
            &format!(
                "请为一个基于 YouTube 频道创建的智囊团成员生成研究 JSON。频道名：{}，频道简介：{}，视频标题：{}",
                channel_name, channel_description, video_titles
            ),
        )
    })?;
    let research = parse_json_value_from_text(&research_raw).unwrap_or_else(|| json!({}));
    let final_system_prompt =
        load_redbox_prompt("runtime/advisors/generate_persona_final_system.txt")
            .map(|template| {
                render_redbox_prompt(
                    &template,
                    &[
                        ("skill_name", skill_name),
                        ("skill_body", skill_body),
                        ("skill_references", skill_references),
                        ("skill_scripts", skill_scripts),
                    ],
                )
            })
            .unwrap_or_else(|| {
                format!(
                    "你是 {} 内部的智囊团角色文档生成代理，只输出最终 Markdown 文档。",
                    app_brand_display_name()
                )
            });
    let final_user_template =
        load_redbox_prompt("runtime/advisors/generate_persona_final_user.txt")
            .unwrap_or_else(|| "请根据研究结果输出最终智囊团角色文档。".to_string());
    let final_user_prompt = render_redbox_prompt(
        &final_user_template,
        &[
            ("channel_name", channel_name.clone()),
            ("knowledge_language", knowledge_language),
            (
                "research_json",
                serde_json::to_string_pretty(&research).unwrap_or_else(|_| "{}".to_string()),
            ),
            ("search_summary", search_summary),
            (
                "advisor_knowledge_corpus",
                render_named_corpus(
                    "Knowledge Evidence",
                    &advisor_knowledge,
                    "(无 advisor 知识文件)",
                ),
            ),
            (
                "manuscript_corpus",
                render_named_corpus(
                    "Manuscript Evidence",
                    &manuscript_evidence,
                    "(无关联稿件命中)",
                ),
            ),
        ],
    );
    let final_markdown = run_model_structured_task_with_settings(
        &settings_snapshot,
        None,
        &final_system_prompt,
        &final_user_prompt,
        false,
    )
    .or_else(|_| run_model_text_task_with_settings(&settings_snapshot, None, &final_user_prompt))?;
    let prompt = research
        .get("prompt")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            research
                .get("description")
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| final_markdown.clone());
    let personality = research
        .get("personality")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            research
                .get("personality_summary")
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| format!("模仿 {} 的内容风格与表达方式", channel_name));
    let knowledge_file_count = with_store(state, |store| {
        Ok(store
            .advisors
            .iter()
            .find(|item| item.id == advisor_id)
            .map(|item| item.knowledge_files.len() as i64)
            .unwrap_or_default())
    })?;
    let advisor_name = with_store(state, |store| {
        Ok(store
            .advisors
            .iter()
            .find(|item| item.id == advisor_id)
            .map(|item| item.name.clone()))
    })?;
    let _ = record_advisor_persona_metric(
        state,
        AdvisorPersonaMetric {
            advisor_id: advisor_id.clone(),
            session_advisor_name: advisor_name,
            knowledge_language: normalize_optional_string(Some(
                payload_string(payload, "knowledgeLanguage").unwrap_or_else(|| "中文".to_string()),
            )),
            elapsed_ms: crate::now_ms().saturating_sub(started_at) as i64,
            search_elapsed_ms: Some(search_elapsed_ms),
            search_hit_count: search_results.len() as i64,
            advisor_knowledge_hit_count: advisor_knowledge.len() as i64,
            manuscript_hit_count: manuscript_evidence.len() as i64,
            knowledge_file_count,
            created_at: crate::now_i64(),
        },
    );
    log_timing_event(
        state,
        "advisor",
        &format!("advisors:generate-persona:{advisor_id}"),
        "advisors:generate-persona",
        started_at,
        Some(format!(
            "searchHits={} advisorKnowledgeHits={} manuscriptHits={} searchElapsedMs={}",
            search_results.len(),
            advisor_knowledge.len(),
            manuscript_evidence.len(),
            search_elapsed_ms
        )),
    );
    Ok(json!({
        "success": true,
        "prompt": final_markdown,
        "personality": personality,
        "research": research,
        "systemPrompt": prompt
    }))
}
