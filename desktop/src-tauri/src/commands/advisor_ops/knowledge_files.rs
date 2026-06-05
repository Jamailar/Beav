use crate::persistence::{with_store, with_store_mut};
use crate::{advisor_knowledge_dir, copy_file_into_dir, now_iso, AppState};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

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
