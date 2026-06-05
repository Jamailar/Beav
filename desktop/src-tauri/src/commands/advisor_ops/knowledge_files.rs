use super::member_skills::publish_member_skill_if_enabled;
use crate::persistence::{with_store, with_store_mut};
use crate::{
    advisor_knowledge_dir, copy_file_into_dir, knowledge_index, log_timing_event, now_i64, now_iso,
    now_ms, payload_field, payload_string, payload_value_as_string, pick_files_native,
    record_advisor_knowledge_ingest_metric, AdvisorKnowledgeIngestMetric, AppState,
};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

pub(super) fn handle_knowledge_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    Some(match channel {
        "advisors:pick-knowledge-files" => pick_knowledge_files_value(),
        "advisors:pick-knowledge-folder" => pick_knowledge_folder_value(),
        "advisors:upload-knowledge" => upload_knowledge_value(app, state, payload),
        "advisors:delete-knowledge" => delete_knowledge_value(app, state, payload),
        _ => return None,
    })
}

fn pick_knowledge_files_value() -> Result<Value, String> {
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

fn pick_knowledge_folder_value() -> Result<Value, String> {
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

fn upload_knowledge_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
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
                .map(PathBuf::from)
                .collect::<Vec<_>>()
        })
        .map(Ok)
        .unwrap_or_else(|| pick_files_native("选择要导入该成员知识库的文件", false, true))?;
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

fn delete_knowledge_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let advisor_id = payload_string(payload, "advisorId").unwrap_or_default();
    let file_name = payload_string(payload, "fileName").unwrap_or_default();
    let result = with_store_mut(state, |store| {
        let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id) else {
            return Ok(json!({ "success": false, "error": "成员不存在" }));
        };
        advisor.knowledge_files.retain(|item| item != &file_name);
        advisor.updated_at = now_iso();
        Ok(json!({ "success": true }))
    })?;
    let path = advisor_knowledge_dir(state, &advisor_id)?.join(&file_name);
    let _ = fs::remove_file(path);
    let _ = publish_member_skill_if_enabled(state, &advisor_id, "advisor-knowledge-delete");
    let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
    knowledge_index::jobs::schedule_rebuild(app, "advisor-knowledge-delete");
    Ok(result)
}

pub(super) fn import_advisor_knowledge_files(
    state: &State<'_, AppState>,
    advisor_id: &str,
    selected: &[PathBuf],
) -> Result<Value, String> {
    if selected.is_empty() {
        return Ok(json!({ "success": false, "error": "未选择文件" }));
    }

    let target_dir = advisor_knowledge_dir(state, advisor_id)?;
    let advisor_exists = with_store(state, |store| {
        Ok(store.advisors.iter().any(|item| item.id == advisor_id))
    })?;
    if !advisor_exists {
        return Ok(json!({ "success": false, "error": "成员不存在" }));
    }

    let selected_files = collect_advisor_knowledge_files(selected)?;
    if selected_files.is_empty() {
        return Ok(json!({ "success": false, "error": "未找到可导入的文件" }));
    }

    let mut imported_files = Vec::new();
    for file in selected_files {
        let (relative_name, _) = copy_file_into_dir(&file, &target_dir)?;
        imported_files.push(relative_name);
    }

    with_store_mut(state, |store| {
        let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id) else {
            return Ok(json!({ "success": false, "error": "成员不存在" }));
        };

        for relative_name in &imported_files {
            if !advisor.knowledge_files.contains(&relative_name) {
                advisor.knowledge_files.push(relative_name.clone());
            }
        }
        advisor.updated_at = now_iso();
        Ok(json!({ "success": true, "files": imported_files }))
    })
}

pub(super) fn collect_advisor_knowledge_files(
    selected: &[PathBuf],
) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    for path in selected {
        collect_advisor_knowledge_files_from_path(path, &mut files)?;
    }
    files.sort();
    files.dedup();
    Ok(files)
}

fn collect_advisor_knowledge_files_from_path(
    path: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if path.is_file() {
        files.push(path.to_path_buf());
        return Ok(());
    }
    if path.is_dir() {
        let mut entries = fs::read_dir(path)
            .map_err(|error| format!("读取文件夹失败 {}: {error}", path.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        entries.sort_by_key(|entry| entry.path());
        for entry in entries {
            collect_advisor_knowledge_files_from_path(&entry.path(), files)?;
        }
    }
    Ok(())
}
