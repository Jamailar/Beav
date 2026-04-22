use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

use crate::{
    make_id, now_iso, payload_string, workspace_root, AppState, SubjectMutationInput, SubjectRecord,
};

pub(crate) fn collect_json_files(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth == 0 || !root.exists() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_json_files(&path, depth - 1, out);
        } else if path
            .extension()
            .and_then(|value| value.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("json"))
            .unwrap_or(false)
        {
            out.push(path);
        }
    }
}

pub(crate) fn read_weixin_sidecar_state(state_dir: &Path) -> Option<Value> {
    let mut files = Vec::new();
    collect_json_files(state_dir, 4, &mut files);
    files.sort();
    for path in files {
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        let account_id = payload_string(&value, "accountId")
            .or_else(|| payload_string(&value, "account_id"))
            .or_else(|| payload_string(&value, "botId"))
            .or_else(|| payload_string(&value, "uin"));
        let user_id = payload_string(&value, "userId")
            .or_else(|| payload_string(&value, "user_id"))
            .or_else(|| payload_string(&value, "wxid"));
        let token = payload_string(&value, "token")
            .or_else(|| payload_string(&value, "botToken"))
            .or_else(|| payload_string(&value, "accessToken"));
        let connected = value
            .get("connected")
            .and_then(|item| item.as_bool())
            .unwrap_or(false)
            || account_id.is_some()
            || token.is_some();
        if connected {
            return Some(json!({
                "connected": true,
                "accountId": account_id,
                "userId": user_id,
                "token": token,
                "sourcePath": path.display().to_string()
            }));
        }
    }
    None
}

pub(crate) fn read_text_file_or_empty(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

pub(crate) fn manuscript_layouts_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(workspace_root(state)?.join("manuscript-layouts.json"))
}

pub(crate) fn default_indexing_stats() -> Value {
    json!({
        "isIndexing": false,
        "totalQueueLength": 0,
        "activeItems": [],
        "queuedItems": [],
        "processedCount": 0,
        "totalStats": {
            "vectors": 0,
            "documents": 0
        }
    })
}

pub(crate) fn emit_space_changed(app: &AppHandle, active_space_id: &str) {
    let _ = app.emit(
        "space:changed",
        json!({ "spaceId": active_space_id, "activeSpaceId": active_space_id }),
    );
}

pub(crate) fn subject_record_from_input(
    input: SubjectMutationInput,
    existing: Option<SubjectRecord>,
) -> SubjectRecord {
    let created_at = existing
        .as_ref()
        .map(|item| item.created_at.clone())
        .unwrap_or_else(now_iso);
    let images = input.images.unwrap_or_default();
    let image_paths: Vec<String> = images
        .iter()
        .enumerate()
        .map(|(index, item)| {
            item.relative_path
                .clone()
                .or_else(|| {
                    item.name
                        .clone()
                        .map(|name| format!("inline:{index}:{name}"))
                })
                .unwrap_or_else(|| format!("inline:{index}"))
        })
        .collect();
    let preview_urls: Vec<String> = images
        .iter()
        .map(|item| {
            item.data_url
                .clone()
                .or_else(|| item.relative_path.clone())
                .unwrap_or_default()
        })
        .collect();
    let voice_preview_url = input.voice.as_ref().and_then(|voice| {
        voice
            .data_url
            .clone()
            .or_else(|| voice.relative_path.clone())
            .filter(|item| !item.is_empty())
    });
    let voice_path = input.voice.as_ref().and_then(|voice| {
        voice.relative_path.clone().or_else(|| {
            voice
                .name
                .clone()
                .map(|name| format!("inline-voice:{name}"))
        })
    });
    let voice_script = input
        .voice
        .as_ref()
        .and_then(|voice| voice.script_text.clone());

    SubjectRecord {
        id: input.id.unwrap_or_else(|| make_id("subject")),
        name: input.name,
        category_id: input.category_id.filter(|item| !item.is_empty()),
        description: input.description.filter(|item| !item.trim().is_empty()),
        tags: input.tags.unwrap_or_default(),
        attributes: input.attributes.unwrap_or_default(),
        image_paths: image_paths.clone(),
        voice_path: voice_path.clone(),
        voice_script,
        created_at,
        updated_at: now_iso(),
        absolute_image_paths: image_paths.clone(),
        preview_urls: preview_urls.clone(),
        primary_preview_url: preview_urls.first().cloned(),
        absolute_voice_path: voice_path,
        voice_preview_url,
    }
}
