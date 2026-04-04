#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use arboard::Clipboard;
use dirs::config_dir;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpaceRecord {
    id: String,
    name: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SubjectAttribute {
    key: String,
    value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubjectCategory {
    id: String,
    name: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubjectRecord {
    id: String,
    name: String,
    category_id: Option<String>,
    description: Option<String>,
    tags: Vec<String>,
    attributes: Vec<SubjectAttribute>,
    image_paths: Vec<String>,
    voice_path: Option<String>,
    voice_script: Option<String>,
    created_at: String,
    updated_at: String,
    absolute_image_paths: Vec<String>,
    preview_urls: Vec<String>,
    primary_preview_url: Option<String>,
    absolute_voice_path: Option<String>,
    voice_preview_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppStore {
    settings: Value,
    spaces: Vec<SpaceRecord>,
    active_space_id: String,
    subjects: Vec<SubjectRecord>,
    categories: Vec<SubjectCategory>,
}

struct AppState {
    store_path: PathBuf,
    store: Mutex<AppStore>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubjectMediaInput {
    relative_path: Option<String>,
    data_url: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubjectVoiceInput {
    relative_path: Option<String>,
    data_url: Option<String>,
    name: Option<String>,
    script_text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubjectMutationInput {
    id: Option<String>,
    name: String,
    category_id: Option<String>,
    description: Option<String>,
    tags: Option<Vec<String>>,
    attributes: Option<Vec<SubjectAttribute>>,
    images: Option<Vec<SubjectMediaInput>>,
    voice: Option<SubjectVoiceInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubjectCategoryMutationInput {
    id: Option<String>,
    name: String,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn now_iso() -> String {
    now_ms().to_string()
}

fn build_store_path() -> PathBuf {
    let mut base = config_dir().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    base.push("LexBox");
    let _ = fs::create_dir_all(&base);
    base.push("lexbox-state.json");
    base
}

fn default_store() -> AppStore {
    let timestamp = now_iso();
    AppStore {
        settings: json!({}),
        spaces: vec![SpaceRecord {
            id: "default".to_string(),
            name: "默认空间".to_string(),
            created_at: timestamp.clone(),
            updated_at: timestamp,
        }],
        active_space_id: "default".to_string(),
        subjects: Vec::new(),
        categories: Vec::new(),
    }
}

fn load_store(path: &PathBuf) -> AppStore {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return default_store(),
    };
    serde_json::from_str(&content).unwrap_or_else(|_| default_store())
}

fn persist_store(path: &PathBuf, store: &AppStore) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(store).map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, serialized).map_err(|error| error.to_string())
}

fn with_store_mut<T>(
    state: &State<'_, AppState>,
    mutator: impl FnOnce(&mut AppStore) -> Result<T, String>,
) -> Result<T, String> {
    let mut store = state.store.lock().map_err(|_| "状态锁已损坏".to_string())?;
    let result = mutator(&mut store)?;
    persist_store(&state.store_path, &store)?;
    Ok(result)
}

fn with_store<T>(
    state: &State<'_, AppState>,
    reader: impl FnOnce(MutexGuard<'_, AppStore>) -> Result<T, String>,
) -> Result<T, String> {
    let store = state.store.lock().map_err(|_| "状态锁已损坏".to_string())?;
    reader(store)
}

fn normalize_string(value: Option<&Value>) -> Option<String> {
    value.and_then(|value| value.as_str().map(|item| item.trim().to_string())).filter(|item| !item.is_empty())
}

fn payload_field<'a>(payload: &'a Value, key: &str) -> Option<&'a Value> {
    payload.as_object().and_then(|object| object.get(key))
}

fn payload_string(payload: &Value, key: &str) -> Option<String> {
    normalize_string(payload_field(payload, key))
}

fn make_id(prefix: &str) -> String {
    format!("{prefix}-{}", now_ms())
}

fn subject_record_from_input(input: SubjectMutationInput, existing: Option<SubjectRecord>) -> SubjectRecord {
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
                .or_else(|| item.name.clone().map(|name| format!("inline:{index}:{name}")))
                .unwrap_or_else(|| format!("inline:{index}"))
        })
        .collect();
    let preview_urls: Vec<String> = images
        .iter()
        .map(|item| item.data_url.clone().or_else(|| item.relative_path.clone()).unwrap_or_default())
        .collect();
    let voice_preview_url = input.voice.as_ref().and_then(|voice| {
        voice
            .data_url
            .clone()
            .or_else(|| voice.relative_path.clone())
            .filter(|item| !item.is_empty())
    });
    let voice_path = input.voice.as_ref().and_then(|voice| {
        voice
            .relative_path
            .clone()
            .or_else(|| voice.name.clone().map(|name| format!("inline-voice:{name}")))
    });
    let voice_script = input.voice.as_ref().and_then(|voice| voice.script_text.clone());

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

fn default_indexing_stats() -> Value {
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

fn emit_space_changed(app: &AppHandle, active_space_id: &str) {
    let _ = app.emit("space:changed", json!({ "activeSpaceId": active_space_id }));
}

fn handle_subject_category_create(payload: Value, state: &State<'_, AppState>) -> Result<Value, String> {
    let input: SubjectCategoryMutationInput =
        serde_json::from_value(payload).map_err(|error| format!("分类参数无效: {error}"))?;
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Ok(json!({ "success": false, "error": "分类名称不能为空" }));
    }

    with_store_mut(state, |store| {
        let timestamp = now_iso();
        let category = SubjectCategory {
            id: make_id("category"),
            name,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        store.categories.push(category.clone());
        Ok(json!({ "success": true, "category": category }))
    })
}

fn handle_subject_category_update(payload: Value, state: &State<'_, AppState>) -> Result<Value, String> {
    let input: SubjectCategoryMutationInput =
        serde_json::from_value(payload).map_err(|error| format!("分类参数无效: {error}"))?;
    let Some(id) = input.id else {
        return Ok(json!({ "success": false, "error": "缺少分类 id" }));
    };
    let next_name = input.name.trim().to_string();
    if next_name.is_empty() {
        return Ok(json!({ "success": false, "error": "分类名称不能为空" }));
    }

    with_store_mut(state, |store| {
        let Some(category) = store.categories.iter_mut().find(|item| item.id == id) else {
            return Ok(json!({ "success": false, "error": "分类不存在" }));
        };
        category.name = next_name;
        category.updated_at = now_iso();
        Ok(json!({ "success": true, "category": category.clone() }))
    })
}

fn handle_subject_category_delete(payload: Value, state: &State<'_, AppState>) -> Result<Value, String> {
    let Some(id) = payload_string(&payload, "id") else {
        return Ok(json!({ "success": false, "error": "缺少分类 id" }));
    };

    with_store_mut(state, |store| {
        if store.subjects.iter().any(|subject| subject.category_id.as_deref() == Some(id.as_str())) {
            return Ok(json!({ "success": false, "error": "仍有主体使用该分类，无法删除" }));
        }
        let before = store.categories.len();
        store.categories.retain(|item| item.id != id);
        if store.categories.len() == before {
            return Ok(json!({ "success": false, "error": "分类不存在" }));
        }
        Ok(json!({ "success": true }))
    })
}

fn handle_subject_create(payload: Value, state: &State<'_, AppState>) -> Result<Value, String> {
    let input: SubjectMutationInput =
        serde_json::from_value(payload).map_err(|error| format!("主体参数无效: {error}"))?;
    if input.name.trim().is_empty() {
        return Ok(json!({ "success": false, "error": "主体名称不能为空" }));
    }

    with_store_mut(state, |store| {
        let record = subject_record_from_input(input, None);
        store.subjects.push(record.clone());
        Ok(json!({ "success": true, "subject": record }))
    })
}

fn handle_subject_update(payload: Value, state: &State<'_, AppState>) -> Result<Value, String> {
    let input: SubjectMutationInput =
        serde_json::from_value(payload).map_err(|error| format!("主体参数无效: {error}"))?;
    let Some(id) = input.id.clone() else {
        return Ok(json!({ "success": false, "error": "缺少主体 id" }));
    };

    with_store_mut(state, |store| {
        let Some(index) = store.subjects.iter().position(|item| item.id == id) else {
            return Ok(json!({ "success": false, "error": "主体不存在" }));
        };
        let existing = store.subjects.get(index).cloned();
        let record = subject_record_from_input(input, existing);
        store.subjects[index] = record.clone();
        Ok(json!({ "success": true, "subject": record }))
    })
}

fn handle_subject_delete(payload: Value, state: &State<'_, AppState>) -> Result<Value, String> {
    let Some(id) = payload_string(&payload, "id") else {
        return Ok(json!({ "success": false, "error": "缺少主体 id" }));
    };

    with_store_mut(state, |store| {
        let before = store.subjects.len();
        store.subjects.retain(|item| item.id != id);
        if store.subjects.len() == before {
            return Ok(json!({ "success": false, "error": "主体不存在" }));
        }
        Ok(json!({ "success": true }))
    })
}

fn handle_channel(
    app: &AppHandle,
    channel: &str,
    payload: Value,
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    match channel {
        "app:get-version" => Ok(json!(env!("CARGO_PKG_VERSION"))),
        "app:check-update" => Ok(json!({
            "success": true,
            "updateAvailable": false,
            "currentVersion": env!("CARGO_PKG_VERSION")
        })),
        "app:open-release-page" => {
            let url = payload_string(&payload, "url")
                .unwrap_or_else(|| "https://github.com/Jamailar/RedBox/releases".to_string());
            match open::that(url.clone()) {
                Ok(_) => Ok(json!({ "success": true, "url": url })),
                Err(error) => Ok(json!({ "success": false, "error": error.to_string(), "url": url })),
            }
        }
        "db:get-settings" => with_store(state, |store| Ok(store.settings.clone())),
        "db:save-settings" => with_store_mut(state, |store| {
            store.settings = payload;
            Ok(json!({ "success": true }))
        }),
        "spaces:list" => with_store(state, |store| {
            Ok(json!({
                "spaces": store.spaces.clone(),
                "activeSpaceId": store.active_space_id
            }))
        }),
        "spaces:create" => {
            let name = payload
                .as_str()
                .map(|item| item.trim().to_string())
                .or_else(|| payload_string(&payload, "name"))
                .unwrap_or_default();
            if name.is_empty() {
                return Ok(json!({ "success": false, "error": "空间名称不能为空" }));
            }

            let result = with_store_mut(state, |store| {
                let timestamp = now_iso();
                let space = SpaceRecord {
                    id: make_id("space"),
                    name,
                    created_at: timestamp.clone(),
                    updated_at: timestamp,
                };
                store.active_space_id = space.id.clone();
                store.spaces.push(space.clone());
                Ok(json!({ "success": true, "space": space, "activeSpaceId": store.active_space_id }))
            })?;
            if let Some(active_space_id) = result.get("activeSpaceId").and_then(|value| value.as_str()) {
                emit_space_changed(app, active_space_id);
            }
            Ok(result)
        }
        "spaces:rename" => {
            let Some(id) = payload_string(&payload, "id") else {
                return Ok(json!({ "success": false, "error": "缺少空间 id" }));
            };
            let Some(name) = payload_string(&payload, "name") else {
                return Ok(json!({ "success": false, "error": "空间名称不能为空" }));
            };
            with_store_mut(state, |store| {
                let Some(space) = store.spaces.iter_mut().find(|item| item.id == id) else {
                    return Ok(json!({ "success": false, "error": "空间不存在" }));
                };
                space.name = name;
                space.updated_at = now_iso();
                Ok(json!({ "success": true, "space": space.clone() }))
            })
        }
        "spaces:switch" => {
            let next_id = payload.as_str().map(ToString::to_string).or_else(|| payload_string(&payload, "spaceId"));
            let Some(space_id) = next_id else {
                return Ok(json!({ "success": false, "error": "缺少空间 id" }));
            };
            let result = with_store_mut(state, |store| {
                if !store.spaces.iter().any(|item| item.id == space_id) {
                    return Ok(json!({ "success": false, "error": "空间不存在" }));
                }
                store.active_space_id = space_id.clone();
                Ok(json!({ "success": true, "activeSpaceId": store.active_space_id }))
            })?;
            if let Some(active_space_id) = result.get("activeSpaceId").and_then(|value| value.as_str()) {
                emit_space_changed(app, active_space_id);
            }
            Ok(result)
        }
        "clipboard:read-text" => match Clipboard::new().and_then(|mut clipboard| clipboard.get_text()) {
            Ok(text) => Ok(json!(text)),
            Err(error) => Ok(json!({ "success": false, "error": error.to_string() })),
        },
        "clipboard:write-html" => {
            let text = payload_string(&payload, "text")
                .or_else(|| payload_string(&payload, "html"))
                .unwrap_or_default();
            match Clipboard::new().and_then(|mut clipboard| clipboard.set_text(text.clone())) {
                Ok(_) => Ok(json!({ "success": true, "text": text })),
                Err(error) => Ok(json!({ "success": false, "error": error.to_string() })),
            }
        }
        "debug:get-status" => Ok(json!({ "enabled": true, "logDirectory": state.store_path.parent().map(|path| path.display().to_string()).unwrap_or_default() })),
        "debug:get-recent" => Ok(json!({ "lines": ["LexBox Rust host is active."] })),
        "debug:open-log-dir" => Ok(json!({
            "success": true,
            "path": state.store_path.parent().map(|path| path.display().to_string()).unwrap_or_default()
        })),
        "plugin:browser-extension-status" => Ok(json!({ "success": false, "error": "LexBox 尚未迁移浏览器插件桥。" })),
        "plugin:prepare-browser-extension" => Ok(json!({ "success": false, "error": "LexBox 尚未迁移浏览器插件桥。" })),
        "plugin:open-browser-extension-dir" => Ok(json!({ "success": false, "error": "LexBox 尚未迁移浏览器插件桥。" })),
        "indexing:get-stats" => Ok(default_indexing_stats()),
        "indexing:clear-queue" => Ok(json!({ "success": true })),
        "indexing:remove-item" => Ok(json!({ "success": true })),
        "subjects:list" => with_store(state, |store| Ok(json!({ "success": true, "subjects": store.subjects.clone() }))),
        "subjects:get" => {
            let Some(id) = payload_string(&payload, "id") else {
                return Ok(json!({ "success": false, "error": "缺少主体 id" }));
            };
            with_store(state, |store| {
                let subject = store.subjects.iter().find(|item| item.id == id).cloned();
                Ok(json!({ "success": true, "subject": subject }))
            })
        }
        "subjects:create" => handle_subject_create(payload, state),
        "subjects:update" => handle_subject_update(payload, state),
        "subjects:delete" => handle_subject_delete(payload, state),
        "subjects:search" => {
            let query = payload_string(&payload, "query").unwrap_or_default().to_lowercase();
            let category_id = payload_string(&payload, "categoryId");
            with_store(state, |store| {
                let subjects: Vec<SubjectRecord> = store
                    .subjects
                    .iter()
                    .filter(|subject| {
                        let matches_category = match category_id.as_deref() {
                            Some(category) => subject.category_id.as_deref() == Some(category),
                            None => true,
                        };
                        let matches_query = if query.is_empty() {
                            true
                        } else {
                            let haystack = format!(
                                "{}\n{}\n{}",
                                subject.name,
                                subject.description.clone().unwrap_or_default(),
                                subject.tags.join(" ")
                            )
                            .to_lowercase();
                            haystack.contains(&query)
                        };
                        matches_category && matches_query
                    })
                    .cloned()
                    .collect();
                Ok(json!({ "success": true, "subjects": subjects }))
            })
        }
        "subjects:categories:list" => with_store(state, |store| Ok(json!({ "success": true, "categories": store.categories.clone() }))),
        "subjects:categories:create" => handle_subject_category_create(payload, state),
        "subjects:categories:update" => handle_subject_category_update(payload, state),
        "subjects:categories:delete" => handle_subject_category_delete(payload, state),
        "work:list" => Ok(json!([])),
        "work:get" => Ok(Value::Null),
        "work:ready" => Ok(json!([])),
        "work:update" => Ok(json!({ "success": false, "error": "LexBox 尚未迁移 work item 可写支持。" })),
        "redclaw:runner-status" => Ok(json!({
            "running": false,
            "available": false,
            "error": "RedClaw runner 尚未迁移到 Rust 宿主。"
        })),
        "redclaw:runner-run-scheduled-now" => Ok(json!({ "success": false, "error": "RedClaw runner 尚未迁移。" })),
        "redclaw:runner-run-long-cycle-now" => Ok(json!({ "success": false, "error": "RedClaw runner 尚未迁移。" })),
        _ => Ok(json!({
            "success": false,
            "error": format!("Rust host has not implemented channel `{channel}` yet.")
        })),
    }
}

#[tauri::command]
fn ipc_invoke(
    app: AppHandle,
    channel: String,
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    handle_channel(&app, &channel, payload.unwrap_or(Value::Null), &state)
}

#[tauri::command]
fn ipc_send(
    app: AppHandle,
    channel: String,
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let payload = payload.unwrap_or(Value::Null);
    let _ = handle_channel(&app, &channel, payload, &state)?;
    Ok(())
}

fn main() {
    let store_path = build_store_path();
    let store = load_store(&store_path);

    tauri::Builder::default()
        .manage(AppState {
            store_path,
            store: Mutex::new(store),
        })
        .invoke_handler(tauri::generate_handler![ipc_invoke, ipc_send])
        .setup(|app| {
            let _ = app.emit("indexing:status", default_indexing_stats());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run LexBox");
}
