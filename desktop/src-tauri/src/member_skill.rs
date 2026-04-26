use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

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
    pub candidate: bool,
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
    let artifacts = build_member_skill_artifacts(
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
    let should_promote = should_promote_member_skill_immediately(&advisor, &package_dir);
    if should_promote {
        write_member_skill_package(&package_dir, &artifacts)?;
        write_member_skill_package(&package_dir.join("versions").join(&version), &artifacts)?;
    } else {
        write_member_skill_package(
            &package_dir.join("distillation_candidates").join(&version),
            &artifacts,
        )?;
    }

    let distilled_at = now_iso();
    with_store_mut(state, |store| {
        if let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id) {
            if should_promote {
                advisor.member_skill_ref = Some(skill_name.clone());
                advisor.member_skill_status = Some("ready".to_string());
                advisor.member_skill_version = Some(version.clone());
                advisor.member_skill_last_distilled_at = Some(distilled_at.clone());
                advisor.member_skill_last_error = None;
                advisor.member_skill_candidate_version = None;
                advisor.member_skill_candidate_path = None;
                advisor.member_skill_candidate_created_at = None;
                advisor.member_skill_candidate_source_event = None;
            } else {
                advisor.member_skill_status = Some("ready".to_string());
                advisor.member_skill_last_error = None;
                advisor.member_skill_candidate_version = Some(version.clone());
                advisor.member_skill_candidate_path = Some(
                    package_dir
                        .join("distillation_candidates")
                        .join(&version)
                        .display()
                        .to_string(),
                );
                advisor.member_skill_candidate_created_at = Some(distilled_at.clone());
                advisor.member_skill_candidate_source_event = Some(source_event.to_string());
            }
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
        candidate: !should_promote,
    })
}

pub(crate) fn promote_member_skill_candidate(
    state: &State<'_, AppState>,
    advisor_id: &str,
    candidate_version: Option<&str>,
) -> Result<MemberSkillPublishResult, String> {
    let advisor = with_store(state, |store| {
        store
            .advisors
            .iter()
            .find(|item| item.id == advisor_id)
            .cloned()
            .ok_or_else(|| "成员不存在".to_string())
    })?;
    let skill_name = advisor
        .member_skill_ref
        .clone()
        .filter(|item| !item.trim().is_empty())
        .unwrap_or_else(|| member_skill_name(&advisor));
    let version = candidate_version
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .or(advisor.member_skill_candidate_version.clone())
        .ok_or_else(|| "没有可发布的成员技能候选版本".to_string())?;
    let package_dir = workspace_root(state)?
        .join("skills")
        .join(slug_from_relative_path(&skill_name));
    let candidate_dir = package_dir.join("distillation_candidates").join(&version);
    if !candidate_dir.join("SKILL.md").is_file() {
        return Err(format!("成员技能候选不存在：{}", candidate_dir.display()));
    }
    copy_member_skill_dir(&candidate_dir, &package_dir)?;
    copy_member_skill_dir(&candidate_dir, &package_dir.join("versions").join(&version))?;
    let promoted_at = now_iso();
    with_store_mut(state, |store| {
        if let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id) {
            advisor.member_skill_ref = Some(skill_name.clone());
            advisor.member_skill_status = Some("ready".to_string());
            advisor.member_skill_version = Some(version.clone());
            advisor.member_skill_last_distilled_at = Some(promoted_at.clone());
            advisor.member_skill_last_error = None;
            advisor.member_skill_candidate_version = None;
            advisor.member_skill_candidate_path = None;
            advisor.member_skill_candidate_created_at = None;
            advisor.member_skill_candidate_source_event = None;
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
        language: advisor
            .detected_knowledge_language
            .or(advisor.knowledge_language)
            .unwrap_or_else(|| "中文".to_string()),
        refreshed_catalog,
        candidate: false,
    })
}

pub(crate) fn discard_member_skill_candidate(
    state: &State<'_, AppState>,
    advisor_id: &str,
) -> Result<(), String> {
    let candidate_path = with_store(state, |store| {
        store
            .advisors
            .iter()
            .find(|item| item.id == advisor_id)
            .map(|item| item.member_skill_candidate_path.clone())
            .ok_or_else(|| "成员不存在".to_string())
    })?;
    if let Some(path) = candidate_path {
        let path = PathBuf::from(path);
        if path.exists() {
            fs::remove_dir_all(path).map_err(|error| error.to_string())?;
        }
    }
    with_store_mut(state, |store| {
        if let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id) {
            advisor.member_skill_candidate_version = None;
            advisor.member_skill_candidate_path = None;
            advisor.member_skill_candidate_created_at = None;
            advisor.member_skill_candidate_source_event = None;
            advisor.updated_at = now_iso();
        }
        Ok(())
    })
}

pub(crate) fn rollback_member_skill_version(
    state: &State<'_, AppState>,
    advisor_id: &str,
    version: &str,
) -> Result<MemberSkillPublishResult, String> {
    let advisor = with_store(state, |store| {
        store
            .advisors
            .iter()
            .find(|item| item.id == advisor_id)
            .cloned()
            .ok_or_else(|| "成员不存在".to_string())
    })?;
    let skill_name = advisor
        .member_skill_ref
        .clone()
        .filter(|item| !item.trim().is_empty())
        .unwrap_or_else(|| member_skill_name(&advisor));
    let version = version.trim();
    if version.is_empty() {
        return Err("缺少要回滚的成员技能版本".to_string());
    }
    let package_dir = workspace_root(state)?
        .join("skills")
        .join(slug_from_relative_path(&skill_name));
    let version_dir = package_dir.join("versions").join(version);
    if !version_dir.join("SKILL.md").is_file() {
        return Err(format!("成员技能历史版本不存在：{}", version_dir.display()));
    }
    copy_member_skill_dir(&version_dir, &package_dir)?;
    let rolled_back_at = now_iso();
    with_store_mut(state, |store| {
        if let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id) {
            advisor.member_skill_ref = Some(skill_name.clone());
            advisor.member_skill_status = Some("ready".to_string());
            advisor.member_skill_version = Some(version.to_string());
            advisor.member_skill_last_distilled_at = Some(rolled_back_at.clone());
            advisor.member_skill_last_error = None;
            advisor.updated_at = now_iso();
        }
        Ok(())
    })?;
    let refreshed_catalog = refresh_skill_store_catalog(state)?;
    Ok(MemberSkillPublishResult {
        skill_name,
        status: "ready".to_string(),
        version: version.to_string(),
        package_path: package_dir.display().to_string(),
        language: advisor
            .detected_knowledge_language
            .or(advisor.knowledge_language)
            .unwrap_or_else(|| "中文".to_string()),
        refreshed_catalog,
        candidate: false,
    })
}

pub(crate) fn inspect_member_skill_versions(
    state: &State<'_, AppState>,
    advisor_id: &str,
) -> Result<Value, String> {
    let advisor = with_store(state, |store| {
        store
            .advisors
            .iter()
            .find(|item| item.id == advisor_id)
            .cloned()
            .ok_or_else(|| "成员不存在".to_string())
    })?;
    let skill_name = advisor
        .member_skill_ref
        .clone()
        .filter(|item| !item.trim().is_empty())
        .unwrap_or_else(|| member_skill_name(&advisor));
    let package_dir = workspace_root(state)?
        .join("skills")
        .join(slug_from_relative_path(&skill_name));
    let current_skill = read_member_skill_version_summary(
        &package_dir,
        advisor.member_skill_version.as_deref(),
        advisor.member_skill_last_distilled_at.as_deref(),
    );
    let candidate_dir = advisor
        .member_skill_candidate_version
        .as_ref()
        .map(|version| package_dir.join("distillation_candidates").join(version));
    let candidate_skill = match (
        advisor.member_skill_candidate_version.as_deref(),
        candidate_dir.as_deref(),
    ) {
        (Some(version), Some(path)) if path.join("SKILL.md").is_file() => {
            let mut value = read_member_skill_version_summary(
                path,
                Some(version),
                advisor.member_skill_candidate_created_at.as_deref(),
            );
            if let Some(object) = value.as_object_mut() {
                object.insert(
                    "sourceEvent".to_string(),
                    Value::String(
                        advisor
                            .member_skill_candidate_source_event
                            .clone()
                            .unwrap_or_else(|| "knowledge-update".to_string()),
                    ),
                );
                object.insert(
                    "diff".to_string(),
                    diff_member_skill_dirs(&package_dir, path),
                );
            }
            Some(value)
        }
        _ => None,
    };
    let mut versions = list_member_skill_versions(&package_dir.join("versions"))?;
    versions.sort_by(|left, right| {
        let left_version = left
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let right_version = right
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default();
        right_version.cmp(left_version)
    });
    Ok(json!({
        "success": true,
        "skillName": skill_name,
        "packagePath": package_dir.display().to_string(),
        "current": current_skill,
        "candidate": candidate_skill,
        "versions": versions
    }))
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
        "refreshedCatalog": result.refreshed_catalog,
        "candidate": result.candidate
    })
}

fn read_member_skill_version_summary(
    path: &Path,
    fallback_version: Option<&str>,
    fallback_updated_at: Option<&str>,
) -> Value {
    let manifest = read_member_skill_manifest(path);
    let skill_body = fs::read_to_string(path.join("SKILL.md")).unwrap_or_default();
    json!({
        "version": manifest
            .get("version")
            .and_then(Value::as_str)
            .or(fallback_version),
        "updatedAt": manifest
            .get("updatedAt")
            .and_then(Value::as_str)
            .or(fallback_updated_at),
        "path": path.display().to_string(),
        "skillPreview": truncate_member_skill_preview(&skill_body, 1800)
    })
}

fn read_member_skill_manifest(path: &Path) -> Value {
    fs::read_to_string(path.join("member.json"))
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .unwrap_or_else(|| json!({}))
}

fn list_member_skill_versions(path: &Path) -> Result<Vec<Value>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut versions = Vec::new();
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let version_path = entry.path();
        if !version_path.is_dir() || !version_path.join("SKILL.md").is_file() {
            continue;
        }
        let version = entry
            .file_name()
            .to_str()
            .map(ToString::to_string)
            .unwrap_or_default();
        versions.push(read_member_skill_version_summary(
            &version_path,
            Some(&version),
            None,
        ));
    }
    Ok(versions)
}

fn diff_member_skill_dirs(current_dir: &Path, candidate_dir: &Path) -> Value {
    let current = fs::read_to_string(current_dir.join("SKILL.md")).unwrap_or_default();
    let candidate = fs::read_to_string(candidate_dir.join("SKILL.md")).unwrap_or_default();
    let current_lines = diff_candidate_lines(&current);
    let candidate_lines = diff_candidate_lines(&candidate);
    let added = candidate_lines
        .iter()
        .filter(|line| !current_lines.contains(line))
        .take(12)
        .cloned()
        .collect::<Vec<_>>();
    let removed = current_lines
        .iter()
        .filter(|line| !candidate_lines.contains(line))
        .take(12)
        .cloned()
        .collect::<Vec<_>>();
    json!({
        "added": added,
        "removed": removed,
        "addedCount": candidate_lines.iter().filter(|line| !current_lines.contains(line)).count(),
        "removedCount": current_lines.iter().filter(|line| !candidate_lines.contains(line)).count()
    })
}

fn diff_candidate_lines(value: &str) -> Vec<String> {
    value
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
}

fn truncate_member_skill_preview(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect::<String>()
}

fn should_promote_member_skill_immediately(advisor: &AdvisorRecord, package_dir: &Path) -> bool {
    let Some(skill_ref) = advisor
        .member_skill_ref
        .as_ref()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
    else {
        return true;
    };
    if advisor.member_skill_status.as_deref() != Some("ready") {
        return true;
    }
    if !package_dir.join("SKILL.md").is_file() {
        return true;
    }
    if current_member_skill_source_kind(package_dir).as_deref() == Some("manual-profile")
        && !advisor.knowledge_files.is_empty()
    {
        return true;
    }
    skill_ref != member_skill_name(advisor)
}

fn current_member_skill_source_kind(package_dir: &Path) -> Option<String> {
    let member_json = fs::read_to_string(package_dir.join("member.json")).ok()?;
    let parsed: Value = serde_json::from_str(&member_json).ok()?;
    let summary = parsed.get("sourceSummary").and_then(Value::as_str)?;
    summary.split(';').find_map(|part| {
        part.trim()
            .strip_prefix("sourceKind=")
            .map(ToString::to_string)
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

#[derive(Debug, Clone)]
struct MemberSkillArtifacts {
    skill_body: String,
    member_json: String,
    persona_json: String,
    retrieval_scope_json: String,
    tool_policy_json: String,
    workflow_json: String,
    heuristics_jsonl: String,
    knowledge_reference: String,
    example_readme: String,
    script_readme: String,
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

fn build_member_skill_artifacts(
    advisor: &AdvisorRecord,
    skill_name: &str,
    version: &str,
    language: &str,
    source_summary: &str,
    evidence: &[(String, String)],
) -> MemberSkillArtifacts {
    let updated_at = now_iso();
    MemberSkillArtifacts {
        skill_body: render_member_skill_body(
            advisor,
            skill_name,
            version,
            language,
            source_summary,
            evidence,
        ),
        member_json: serde_json::to_string_pretty(&json!({
            "advisorId": advisor.id,
            "advisorName": advisor.name,
            "sourceSummary": source_summary,
            "skillName": skill_name,
            "version": version,
            "language": language,
            "knowledgeFileCount": advisor.knowledge_files.len(),
            "youtubeChannel": advisor.youtube_channel,
            "updatedAt": updated_at
        }))
        .unwrap_or_else(|_| "{}".to_string()),
        persona_json: serde_json::to_string_pretty(&json!({
            "name": advisor.name,
            "avatar": advisor.avatar,
            "personality": advisor.personality,
            "systemPrompt": advisor.system_prompt,
            "preferredLanguage": language
        }))
        .unwrap_or_else(|_| "{}".to_string()),
        retrieval_scope_json: serde_json::to_string_pretty(&json!({
            "advisorId": advisor.id,
            "knowledgeFiles": advisor.knowledge_files,
            "youtubeChannel": advisor.youtube_channel,
            "languagePriority": [language, "中文", "English"],
            "maxInlineEvidenceChars": 6000,
            "policy": "Prefer advisor-bound knowledge evidence before generic workspace knowledge.",
            "toolCallHint": {
                "tool": "redbox_fs",
                "scope": "knowledge",
                "advisorId": advisor.id
            }
        }))
        .unwrap_or_else(|_| "{}".to_string()),
        tool_policy_json: serde_json::to_string_pretty(&json!({
            "allowedTools": ["redbox_fs"],
            "allowedKnowledgeActions": ["list", "search", "read"],
            "approval": {
                "readOnlyKnowledge": "auto",
                "workspaceWrite": "require_approval",
                "externalNetwork": "require_approval"
            },
            "blockedBehaviors": [
                "Do not invent source facts that are absent from advisor knowledge.",
                "Do not speak as a generic assistant when the advisor identity is active.",
                "Do not act as another member unless the runtime explicitly changes memberSkillRef."
            ]
        }))
        .unwrap_or_else(|_| "{}".to_string()),
        workflow_json: serde_json::to_string_pretty(&json!({
            "defaultAnswerFlow": [
                "Identify the user's concrete request.",
                "Search advisor-bound knowledge when the answer depends on source facts.",
                "Answer in the member's voice with concise evidence and next actions.",
                "State uncertainty only when source coverage changes the recommendation."
            ],
            "discussionFlow": [
                "Stay within this member's role.",
                "Respond to the previous speaker's point.",
                "Add a distinct angle instead of repeating the room consensus."
            ]
        }))
        .unwrap_or_else(|_| "{}".to_string()),
        heuristics_jsonl: render_heuristics_jsonl(advisor, language),
        knowledge_reference: render_knowledge_reference(evidence),
        example_readme: format!(
            "# Examples\n\nUse this folder for reviewed sample replies from {}. Runtime generation does not require examples to exist.\n",
            advisor.name
        ),
        script_readme: "# Scripts\n\nOptional local helper scripts for this member skill package.\n"
            .to_string(),
    }
}

fn write_member_skill_package(path: &Path, artifacts: &MemberSkillArtifacts) -> Result<(), String> {
    fs::create_dir_all(path.join("references")).map_err(|error| error.to_string())?;
    fs::create_dir_all(path.join("examples")).map_err(|error| error.to_string())?;
    fs::create_dir_all(path.join("scripts")).map_err(|error| error.to_string())?;
    fs::write(path.join("SKILL.md"), &artifacts.skill_body).map_err(|error| error.to_string())?;
    fs::write(path.join("member.json"), &artifacts.member_json)
        .map_err(|error| error.to_string())?;
    fs::write(path.join("persona.json"), &artifacts.persona_json)
        .map_err(|error| error.to_string())?;
    fs::write(
        path.join("retrieval_scope.json"),
        &artifacts.retrieval_scope_json,
    )
    .map_err(|error| error.to_string())?;
    fs::write(path.join("tool_policy.json"), &artifacts.tool_policy_json)
        .map_err(|error| error.to_string())?;
    fs::write(path.join("workflow.json"), &artifacts.workflow_json)
        .map_err(|error| error.to_string())?;
    fs::write(path.join("heuristics.jsonl"), &artifacts.heuristics_jsonl)
        .map_err(|error| error.to_string())?;
    fs::write(
        path.join("references").join("knowledge-evidence.md"),
        &artifacts.knowledge_reference,
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        path.join("examples").join("README.md"),
        &artifacts.example_readme,
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        path.join("scripts").join("README.md"),
        &artifacts.script_readme,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn copy_member_skill_dir(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        for file_name in [
            "SKILL.md",
            "member.json",
            "persona.json",
            "retrieval_scope.json",
            "tool_policy.json",
            "workflow.json",
            "heuristics.jsonl",
        ] {
            let _ = fs::remove_file(target.join(file_name));
        }
        let _ = fs::remove_dir_all(target.join("references"));
        let _ = fs::remove_dir_all(target.join("examples"));
        let _ = fs::remove_dir_all(target.join("scripts"));
    }
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for file_name in [
        "SKILL.md",
        "member.json",
        "persona.json",
        "retrieval_scope.json",
        "tool_policy.json",
        "workflow.json",
        "heuristics.jsonl",
    ] {
        fs::copy(source.join(file_name), target.join(file_name))
            .map_err(|error| error.to_string())?;
    }
    copy_member_skill_subdir(source, target, "references")?;
    copy_member_skill_subdir(source, target, "examples")?;
    copy_member_skill_subdir(source, target, "scripts")?;
    Ok(())
}

fn copy_member_skill_subdir(source: &Path, target: &Path, name: &str) -> Result<(), String> {
    let source_dir = source.join(name);
    let target_dir = target.join(name);
    fs::create_dir_all(&target_dir).map_err(|error| error.to_string())?;
    let Ok(entries) = fs::read_dir(source_dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            fs::copy(&path, target_dir.join(entry.file_name()))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn render_heuristics_jsonl(advisor: &AdvisorRecord, language: &str) -> String {
    [
        json!({
            "kind": "identity",
            "rule": format!("Answer as {}, preserving the member role and voice.", advisor.name)
        }),
        json!({
            "kind": "retrieval",
            "rule": "Search advisor-bound knowledge before making factual claims from imported files or videos."
        }),
        json!({
            "kind": "language",
            "rule": format!("Use {} unless the user explicitly requests another language.", language)
        }),
    ]
    .into_iter()
    .map(|value| serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string()))
    .collect::<Vec<_>>()
    .join("\n")
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
