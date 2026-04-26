use serde_json::{json, Map, Value};
use std::fs;
use std::path::Path;

use tauri::State;

use crate::persistence::{with_store, with_store_mut};
use crate::skills::{
    merge_requested_skills_into_metadata, refresh_skill_store_catalog, SkillActivationSource,
};
use crate::{
    advisor_knowledge_dir, build_excerpt_around, now_i64, now_iso, slug_from_relative_path,
    workspace_root, AdvisorRecord, AppState, AppStore,
};

const MEMBER_SKILL_REASON: &str = "advisor-member-skill";
const MEMBER_SKILL_SOURCE_VERSION: &str = "member-skill-v1";

#[derive(Debug, Clone)]
pub(crate) struct MemberSkillPublishResult {
    pub skill_name: String,
    pub status: String,
    pub version: String,
    pub package_path: String,
    pub language: String,
    pub refreshed_catalog: bool,
}

pub(crate) fn advisor_member_skill_ref(store: &AppStore, advisor_id: &str) -> Option<String> {
    store
        .advisors
        .iter()
        .find(|item| item.id == advisor_id)
        .and_then(|advisor| advisor.member_skill_ref.clone())
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

pub(crate) fn attach_member_skill_metadata(
    metadata: &mut Map<String, Value>,
    member_skill_ref: &str,
) {
    let skill_name = member_skill_ref.trim();
    if skill_name.is_empty() {
        return;
    }
    metadata.insert(
        "memberSkillRef".to_string(),
        Value::String(skill_name.to_string()),
    );
    let merged = merge_requested_skills_into_metadata(
        Some(&Value::Object(metadata.clone())),
        &[skill_name.to_string()],
        SkillActivationSource::ContextDefault,
        MEMBER_SKILL_REASON,
    );
    if let Value::Object(next_metadata) = merged {
        *metadata = next_metadata;
    }
}

pub(crate) fn publish_member_skill_for_advisor(
    state: &State<'_, AppState>,
    advisor_id: &str,
    source_event: &str,
) -> Result<MemberSkillPublishResult, String> {
    let advisor = with_store(state, |store| {
        store
            .advisors
            .iter()
            .find(|item| item.id == advisor_id)
            .cloned()
            .ok_or_else(|| "成员不存在".to_string())
    })?;
    let skill_name = member_skill_name(&advisor);
    let version = format!("{}-{}", MEMBER_SKILL_SOURCE_VERSION, now_i64());
    let language_profile = detect_advisor_language(state, &advisor);
    let knowledge_evidence = collect_member_skill_knowledge(state, &advisor)?;
    let source_summary = member_source_summary(&advisor, source_event);
    let skill_body = render_member_skill_body(
        &advisor,
        &skill_name,
        &version,
        &language_profile.language,
        &source_summary,
        &knowledge_evidence,
    );

    let workspace = workspace_root(state)?;
    let package_dir = workspace
        .join("skills")
        .join(slug_from_relative_path(&skill_name));
    fs::create_dir_all(package_dir.join("references")).map_err(|error| error.to_string())?;
    fs::write(package_dir.join("SKILL.md"), skill_body).map_err(|error| error.to_string())?;
    fs::write(
        package_dir.join("member.json"),
        serde_json::to_string_pretty(&json!({
            "advisorId": advisor.id,
            "advisorName": advisor.name,
            "sourceEvent": source_event,
            "sourceSummary": source_summary,
            "skillName": skill_name,
            "version": version,
            "language": language_profile.language,
            "languageDetectionStatus": language_profile.status,
            "languageConfidence": language_profile.confidence,
            "knowledgeFileCount": advisor.knowledge_files.len(),
            "youtubeChannel": advisor.youtube_channel,
            "updatedAt": now_iso()
        }))
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        package_dir.join("persona.json"),
        serde_json::to_string_pretty(&json!({
            "name": advisor.name,
            "avatar": advisor.avatar,
            "personality": advisor.personality,
            "systemPrompt": advisor.system_prompt
        }))
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        package_dir.join("retrieval_scope.json"),
        serde_json::to_string_pretty(&json!({
            "advisorId": advisor.id,
            "knowledgeFiles": advisor.knowledge_files,
            "youtubeChannel": advisor.youtube_channel,
            "maxInlineEvidenceChars": 6000,
            "policy": "Prefer advisor-bound knowledge evidence before generic workspace knowledge."
        }))
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        package_dir.join("tool_policy.json"),
        serde_json::to_string_pretty(&json!({
            "allowedTools": ["knowledge_search", "redbox_fs"],
            "blockedBehaviors": [
                "Do not invent source facts that are absent from advisor knowledge.",
                "Do not speak as a generic assistant when the advisor identity is active."
            ]
        }))
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        package_dir.join("references").join("knowledge-evidence.md"),
        render_knowledge_reference(&knowledge_evidence),
    )
    .map_err(|error| error.to_string())?;

    let distilled_at = now_iso();
    with_store_mut(state, |store| {
        if let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id) {
            advisor.member_skill_ref = Some(skill_name.clone());
            advisor.member_skill_status = Some("ready".to_string());
            advisor.member_skill_version = Some(version.clone());
            advisor.member_skill_last_distilled_at = Some(distilled_at.clone());
            advisor.member_skill_last_error = None;
            advisor.detected_knowledge_language = Some(language_profile.language.clone());
            advisor.language_detection_status = Some(language_profile.status.clone());
            advisor.language_confidence = Some(language_profile.confidence);
            advisor.updated_at = now_iso();
        }
        Ok(())
    })?;
    let refreshed_catalog = refresh_skill_store_catalog(state)?;

    Ok(MemberSkillPublishResult {
        skill_name,
        status: "ready".to_string(),
        version,
        package_path: package_dir.display().to_string(),
        language: language_profile.language,
        refreshed_catalog,
    })
}

pub(crate) fn mark_member_skill_failed(
    state: &State<'_, AppState>,
    advisor_id: &str,
    error: &str,
) -> Result<(), String> {
    with_store_mut(state, |store| {
        if let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id) {
            advisor.member_skill_status = Some("failed".to_string());
            advisor.member_skill_last_error = Some(error.to_string());
            advisor.updated_at = now_iso();
        }
        Ok(())
    })
}

pub(crate) fn remove_member_skill_package(
    state: &State<'_, AppState>,
    skill_name: Option<String>,
) -> Result<(), String> {
    let Some(skill_name) = skill_name.map(|item| item.trim().to_string()) else {
        return Ok(());
    };
    if skill_name.is_empty() {
        return Ok(());
    }
    let package_dir = workspace_root(state)?
        .join("skills")
        .join(slug_from_relative_path(&skill_name));
    if package_dir.exists() {
        fs::remove_dir_all(&package_dir).map_err(|error| error.to_string())?;
    }
    let _ = refresh_skill_store_catalog(state);
    Ok(())
}

pub(crate) fn member_skill_result_value(result: &MemberSkillPublishResult) -> Value {
    json!({
        "skillName": result.skill_name,
        "status": result.status,
        "version": result.version,
        "packagePath": result.package_path,
        "language": result.language,
        "refreshedCatalog": result.refreshed_catalog
    })
}

fn member_skill_name(advisor: &AdvisorRecord) -> String {
    format!("member-{}", slug_from_relative_path(&advisor.id))
}

fn member_source_summary(advisor: &AdvisorRecord, source_event: &str) -> String {
    let mut parts = Vec::new();
    parts.push(format!("sourceEvent={source_event}"));
    if advisor.youtube_channel.is_some() {
        parts.push("sourceKind=youtube-channel".to_string());
    } else if !advisor.knowledge_files.is_empty() {
        parts.push("sourceKind=files".to_string());
    } else {
        parts.push("sourceKind=manual-profile".to_string());
    }
    parts.push(format!("knowledgeFiles={}", advisor.knowledge_files.len()));
    parts.join("; ")
}

#[derive(Debug, Clone)]
struct LanguageProfile {
    language: String,
    status: String,
    confidence: f64,
}

fn detect_advisor_language(
    state: &State<'_, AppState>,
    advisor: &AdvisorRecord,
) -> LanguageProfile {
    if let Some(language) = advisor
        .knowledge_language
        .as_ref()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
    {
        return LanguageProfile {
            language,
            status: "user-specified".to_string(),
            confidence: 1.0,
        };
    }

    let mut sample = format!(
        "{}\n{}\n{}",
        advisor.name, advisor.personality, advisor.system_prompt
    );
    if let Ok(knowledge_dir) = advisor_knowledge_dir(state, &advisor.id) {
        for file_name in advisor.knowledge_files.iter().take(3) {
            sample.push('\n');
            sample.push_str(&read_member_skill_sample(
                &knowledge_dir.join(file_name),
                1200,
            ));
        }
    }
    let chinese_chars = sample
        .chars()
        .filter(|ch| ('\u{4e00}'..='\u{9fff}').contains(ch))
        .count();
    let latin_chars = sample.chars().filter(|ch| ch.is_ascii_alphabetic()).count();
    let total = chinese_chars + latin_chars;
    if total == 0 {
        return LanguageProfile {
            language: "中文".to_string(),
            status: "fallback".to_string(),
            confidence: 0.35,
        };
    }
    let chinese_ratio = chinese_chars as f64 / total as f64;
    if chinese_ratio >= 0.25 {
        LanguageProfile {
            language: "中文".to_string(),
            status: "auto-detected".to_string(),
            confidence: round_confidence(chinese_ratio),
        }
    } else {
        LanguageProfile {
            language: "English".to_string(),
            status: "auto-detected".to_string(),
            confidence: round_confidence(1.0 - chinese_ratio),
        }
    }
}

fn round_confidence(value: f64) -> f64 {
    (value.clamp(0.0, 1.0) * 100.0).round() / 100.0
}

fn collect_member_skill_knowledge(
    state: &State<'_, AppState>,
    advisor: &AdvisorRecord,
) -> Result<Vec<(String, String)>, String> {
    let knowledge_dir = advisor_knowledge_dir(state, &advisor.id)?;
    let mut items = Vec::new();
    for file_name in advisor.knowledge_files.iter().take(8) {
        let path = knowledge_dir.join(file_name);
        let sample = read_member_skill_sample(&path, 2400);
        if sample.trim().is_empty() {
            continue;
        }
        items.push((file_name.clone(), build_excerpt_around(&sample, 1800)));
    }
    Ok(items)
}

fn read_member_skill_sample(path: &Path, max_chars: usize) -> String {
    let content = fs::read_to_string(path).unwrap_or_default();
    content.chars().take(max_chars).collect::<String>()
}

fn render_member_skill_body(
    advisor: &AdvisorRecord,
    skill_name: &str,
    version: &str,
    language: &str,
    source_summary: &str,
    evidence: &[(String, String)],
) -> String {
    let evidence_list = if evidence.is_empty() {
        "- 当前没有可内联的知识片段；回答时优先遵循成员设定，事实性内容需要明确不确定性。"
            .to_string()
    } else {
        evidence
            .iter()
            .take(6)
            .map(|(file, excerpt)| {
                format!(
                    "- `{}`: {}",
                    file,
                    excerpt
                        .replace('\n', " ")
                        .chars()
                        .take(700)
                        .collect::<String>()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let personality = non_empty_or(&advisor.personality, "保持该成员在团队中的专业视角。");
    let system_prompt = non_empty_or(
        &advisor.system_prompt,
        "以该成员身份回答，优先结合绑定知识库，不确定时明确说明。",
    );

    format!(
        r#"---
name: {skill_name}
description: 正鹅成员「{advisor_name}」的蒸馏技能。激活后必须按该成员身份、语气、知识边界和证据偏好发言。
allowedRuntimeModes: [chatroom, advisor-discussion, wander, redclaw]
allowedTools: [knowledge_search, redbox_fs]
autoActivate: false
activationScope: session
hookMode: inline
contextNote: 自动成员蒸馏技能，随成员会话 metadata 激活。
---
# {advisor_name} Member Skill

## Identity
- Member id: `{advisor_id}`
- Display name: {advisor_name}
- Avatar: {avatar}
- Distilled version: `{version}`
- Source: {source_summary}
- Preferred language: {language}

## Speaking Contract
- Always answer as {advisor_name}, not as a generic assistant.
- Keep the member's viewpoint, priorities, vocabulary, and decision style stable across turns.
- When the user asks the team to discuss, speak from this member's role and do not collapse into other members' roles.
- If source evidence is incomplete, state the uncertainty briefly and continue with a bounded recommendation.

## Persona
{personality}

## System Prompt
{system_prompt}

## Knowledge Use
- Prefer this member's advisor-bound knowledge files and YouTube subtitles before generic workspace facts.
- Treat the evidence snippets below as orientation, not as the full corpus.
- For factual claims from files or videos, cite the file or video title when available.

## Distilled Evidence
{evidence_list}

## Output Style
- Use {language} unless the user explicitly requests another language.
- Give concrete recommendations, tradeoffs, and next actions.
- Avoid disclaimers that dilute the member voice; only mention uncertainty when it changes the recommendation.
"#,
        skill_name = skill_name,
        advisor_name = advisor.name,
        advisor_id = advisor.id,
        avatar = advisor.avatar,
        version = version,
        source_summary = source_summary,
        language = language,
        personality = personality,
        system_prompt = system_prompt,
        evidence_list = evidence_list
    )
}

fn render_knowledge_reference(evidence: &[(String, String)]) -> String {
    if evidence.is_empty() {
        return "# Knowledge Evidence\n\nNo advisor knowledge files were available during this distillation.\n"
            .to_string();
    }
    let mut output = String::from("# Knowledge Evidence\n");
    for (file, excerpt) in evidence {
        output.push_str("\n## ");
        output.push_str(file);
        output.push_str("\n\n");
        output.push_str(excerpt);
        output.push('\n');
    }
    output
}

fn non_empty_or<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.trim().is_empty() {
        fallback
    } else {
        value
    }
}
