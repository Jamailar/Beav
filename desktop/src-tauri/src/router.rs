use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tauri::Emitter;
use uuid::Uuid;
use walkdir::WalkDir;

#[derive(Clone, Serialize, Deserialize)]
struct SpaceRecord {
    id: String,
    name: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct SpacesState {
    active_space_id: String,
    spaces: Vec<SpaceRecord>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct WechatBinding {
    id: String,
    name: String,
    app_id: String,
    created_at: String,
    updated_at: String,
    verified_at: Option<String>,
    is_active: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct FileNode {
    name: String,
    path: String,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<FileNode>>,
}

pub async fn handle_invoke(
    app: &tauri::AppHandle,
    channel: &str,
    payload: Option<Value>,
) -> Result<Value, String> {
    match channel {
        "app:get-version" => Ok(Value::String(app.package_info().version.to_string())),
        "app:check-update" => Ok(json!({
            "success": true,
            "hasUpdate": false,
            "message": "Update checks are not implemented in LexBox yet."
        })),
        "app:open-release-page" => {
            let url = payload
                .as_ref()
                .and_then(|value| value.get("url"))
                .and_then(Value::as_str)
                .unwrap_or("https://github.com/Jamailar/RedBox/releases");
            open_external(url)?;
            Ok(json!({ "success": true }))
        }
        "db:get-settings" => read_json_or_default(&settings_path()?, json!({})),
        "db:save-settings" => {
            let next = payload.unwrap_or_else(|| json!({}));
            write_json(&settings_path()?, &next)?;
            Ok(json!({ "success": true }))
        }
        "debug:get-status" => Ok(json!({ "enabled": false, "logDirectory": data_root()?.join("logs") })),
        "debug:get-recent" => Ok(json!({ "lines": [] })),
        "debug:open-log-dir" => {
            let path = data_root()?.join("logs");
            ensure_dir(&path)?;
            open_path(&path)?;
            Ok(json!({ "success": true, "path": path }))
        }
        "clipboard:read-text" => Ok(Value::String(String::new())),
        "clipboard:write-html" => Ok(json!({ "success": true })),
        "plugin:browser-extension-status" => Ok(json!({
            "success": true,
            "bundled": false,
            "exported": false,
            "exportPath": "",
            "bundledPath": ""
        })),
        "plugin:prepare-browser-extension" => Ok(json!({
            "success": false,
            "error": "Not implemented in LexBox yet."
        })),
        "plugin:open-browser-extension-dir" => Ok(json!({
            "success": false,
            "error": "Not implemented in LexBox yet."
        })),
        "spaces:list" => {
            let state = read_spaces_state()?;
            Ok(json!({
                "spaces": state.spaces,
                "activeSpaceId": state.active_space_id
            }))
        }
        "spaces:create" => {
            let name = value_as_string(payload.as_ref(), None).unwrap_or_else(|| "New Space".to_string());
            let mut state = read_spaces_state()?;
            let record = SpaceRecord {
                id: Uuid::new_v4().to_string(),
                name: if name.trim().is_empty() { "New Space".to_string() } else { name.trim().to_string() },
            };
            ensure_workspace_structure(&record.id)?;
            state.spaces.push(record.clone());
            write_spaces_state(&state)?;
            Ok(json!({ "success": true, "space": record }))
        }
        "spaces:rename" => {
            let id = payload.as_ref().and_then(|value| value.get("id")).and_then(Value::as_str).unwrap_or("").trim().to_string();
            let name = payload.as_ref().and_then(|value| value.get("name")).and_then(Value::as_str).unwrap_or("").trim().to_string();
            let mut state = read_spaces_state()?;
            if let Some(space) = state.spaces.iter_mut().find(|space| space.id == id) {
                if !name.is_empty() {
                    space.name = name;
                    write_spaces_state(&state)?;
                    return Ok(json!({ "success": true, "space": space }));
                }
            }
            Ok(json!({ "success": false, "error": "Space not found or invalid name" }))
        }
        "spaces:switch" => {
            let space_id = value_as_string(payload.as_ref(), None).unwrap_or_default();
            let mut state = read_spaces_state()?;
            if state.spaces.iter().any(|space| space.id == space_id) {
                state.active_space_id = space_id.clone();
                write_spaces_state(&state)?;
                ensure_workspace_structure(&space_id)?;
                let _ = app.emit("space:changed", json!({ "spaceId": space_id }));
                return Ok(json!({ "success": true }));
            }
            Ok(json!({ "success": false, "error": "Space not found" }))
        }
        "indexing:get-stats" => Ok(json!({
            "isIndexing": false,
            "totalQueueLength": 0,
            "activeItems": [],
            "queuedItems": [],
            "processedCount": 0,
            "totalStats": { "vectors": 0, "documents": 0 }
        })),
        "indexing:remove-item" | "indexing:clear-queue" => Ok(json!({ "success": true })),
        "wechat-official:get-status" => {
            let bindings = read_wechat_bindings()?;
            let active = bindings.iter().find(|binding| binding.is_active).cloned();
            Ok(json!({
                "success": true,
                "bindings": bindings,
                "activeBinding": active
            }))
        }
        "wechat-official:bind" => {
            let name = payload.as_ref().and_then(|value| value.get("name")).and_then(Value::as_str).unwrap_or("LexBox Wechat");
            let app_id = payload.as_ref().and_then(|value| value.get("appId")).and_then(Value::as_str).unwrap_or("").trim().to_string();
            if app_id.is_empty() {
                return Ok(json!({ "success": false, "error": "appId is required" }));
            }
            let mut bindings = read_wechat_bindings()?;
            for binding in &mut bindings {
                binding.is_active = false;
            }
            let now = chrono::Utc::now().to_rfc3339();
            let binding = WechatBinding {
                id: Uuid::new_v4().to_string(),
                name: name.trim().to_string(),
                app_id,
                created_at: now.clone(),
                updated_at: now,
                verified_at: None,
                is_active: true,
            };
            bindings.push(binding.clone());
            write_wechat_bindings(&bindings)?;
            Ok(json!({ "success": true, "binding": binding }))
        }
        "wechat-official:unbind" => {
            let binding_id = payload.as_ref().and_then(|value| value.get("bindingId")).and_then(Value::as_str).unwrap_or("").trim().to_string();
            let mut bindings = read_wechat_bindings()?;
            if binding_id.is_empty() {
                bindings.clear();
            } else {
                bindings.retain(|binding| binding.id != binding_id);
            }
            write_wechat_bindings(&bindings)?;
            Ok(json!({ "success": true }))
        }
        "wechat-official:create-draft" => Ok(json!({
            "success": false,
            "error": "Publishing to Wechat Official Account is not implemented in LexBox yet."
        })),
        "manuscripts:list" => {
            let root = manuscripts_root()?;
            ensure_dir(&root)?;
            Ok(serde_json::to_value(list_tree(&root, &root)?).map_err(|error| error.to_string())?)
        }
        "manuscripts:read" => {
            let relative = value_as_string(payload.as_ref(), None).unwrap_or_default();
            let path = resolve_manuscript_path(&relative)?;
            let content = fs::read_to_string(&path).unwrap_or_default();
            Ok(json!({
                "content": content,
                "metadata": {
                    "id": slug_from_relative_path(&relative),
                    "title": title_from_relative_path(&relative)
                }
            }))
        }
        "manuscripts:save" => {
            let file_path = payload.as_ref().and_then(|value| value.get("path")).and_then(Value::as_str).unwrap_or("").trim().to_string();
            let content = payload.as_ref().and_then(|value| value.get("content")).and_then(Value::as_str).unwrap_or("").to_string();
            let path = resolve_manuscript_path(&file_path)?;
            if let Some(parent) = path.parent() {
                ensure_dir(parent)?;
            }
            fs::write(&path, content).map_err(|error| error.to_string())?;
            Ok(json!({ "success": true }))
        }
        "manuscripts:create-folder" => {
            let parent = payload.as_ref().and_then(|value| value.get("parentPath")).and_then(Value::as_str).unwrap_or("").trim().to_string();
            let name = payload.as_ref().and_then(|value| value.get("name")).and_then(Value::as_str).unwrap_or("").trim().to_string();
            let dir = resolve_manuscript_path(&join_relative(&parent, &name))?;
            ensure_dir(&dir)?;
            Ok(json!({ "success": true, "path": normalize_relative_path(&join_relative(&parent, &name)) }))
        }
        "manuscripts:create-file" => {
            let parent = payload.as_ref().and_then(|value| value.get("parentPath")).and_then(Value::as_str).unwrap_or("").trim().to_string();
            let name = payload.as_ref().and_then(|value| value.get("name")).and_then(Value::as_str).unwrap_or("Untitled.md").trim().to_string();
            let content = payload.as_ref().and_then(|value| value.get("content")).and_then(Value::as_str).unwrap_or("").to_string();
            let relative = ensure_markdown_extension(&join_relative(&parent, &name));
            let path = resolve_manuscript_path(&relative)?;
            if let Some(parent_dir) = path.parent() {
                ensure_dir(parent_dir)?;
            }
            fs::write(&path, content).map_err(|error| error.to_string())?;
            Ok(json!({ "success": true, "path": normalize_relative_path(&relative) }))
        }
        "manuscripts:delete" => {
            let relative = value_as_string(payload.as_ref(), None).unwrap_or_default();
            let path = resolve_manuscript_path(&relative)?;
            if path.is_dir() {
                fs::remove_dir_all(&path).map_err(|error| error.to_string())?;
            } else if path.exists() {
                fs::remove_file(&path).map_err(|error| error.to_string())?;
            }
            Ok(json!({ "success": true }))
        }
        "manuscripts:rename" => {
            let old_path = payload.as_ref().and_then(|value| value.get("oldPath")).and_then(Value::as_str).unwrap_or("").trim().to_string();
            let new_name = payload.as_ref().and_then(|value| value.get("newName")).and_then(Value::as_str).unwrap_or("").trim().to_string();
            let source = resolve_manuscript_path(&old_path)?;
            let parent = source.parent().ok_or_else(|| "Invalid manuscript path".to_string())?;
            let target_relative = normalize_relative_path(&join_relative(
                &normalize_relative_path(parent.strip_prefix(manuscripts_root()?).map_err(|error| error.to_string())?.to_string_lossy().as_ref()),
                &new_name,
            ));
            let target = resolve_manuscript_path(&target_relative)?;
            fs::rename(&source, &target).map_err(|error| error.to_string())?;
            Ok(json!({ "success": true, "newPath": target_relative }))
        }
        "manuscripts:move" => {
            let source_path = payload.as_ref().and_then(|value| value.get("sourcePath")).and_then(Value::as_str).unwrap_or("").trim().to_string();
            let target_dir = payload.as_ref().and_then(|value| value.get("targetDir")).and_then(Value::as_str).unwrap_or("").trim().to_string();
            let source = resolve_manuscript_path(&source_path)?;
            let file_name = source.file_name().and_then(|value| value.to_str()).ok_or_else(|| "Invalid manuscript source".to_string())?;
            let target_relative = normalize_relative_path(&join_relative(&target_dir, file_name));
            let target = resolve_manuscript_path(&target_relative)?;
            if let Some(parent) = target.parent() {
                ensure_dir(parent)?;
            }
            fs::rename(&source, &target).map_err(|error| error.to_string())?;
            Ok(json!({ "success": true, "newPath": target_relative }))
        }
        "manuscripts:get-layout" => read_json_or_default(&manuscript_layouts_path()?, json!({})),
        "manuscripts:save-layout" => {
            let layout = payload.unwrap_or_else(|| json!({}));
            write_json(&manuscript_layouts_path()?, &layout)?;
            Ok(json!({ "success": true }))
        }
        "manuscripts:format-wechat" => {
            let title = payload.as_ref().and_then(|value| value.get("title")).and_then(Value::as_str).unwrap_or("").trim();
            let content = payload.as_ref().and_then(|value| value.get("content")).and_then(Value::as_str).unwrap_or("");
            let html = markdown_to_html(title, content);
            Ok(json!({
                "success": true,
                "html": html,
                "plainText": content
            }))
        }
        "chat:getOrCreateFileSession" => {
            let file_path = payload.as_ref().and_then(|value| value.get("filePath")).and_then(Value::as_str).unwrap_or("");
            Ok(json!({
                "id": format!("file-session:{}", slug_from_relative_path(file_path)),
                "title": title_from_relative_path(file_path),
                "updatedAt": chrono::Utc::now().to_rfc3339()
            }))
        }
        "chat:get-sessions" => Ok(json!([])),
        "chat:get-messages" => Ok(json!([])),
        "chat:get-runtime-state" => Ok(json!({ "status": "idle" })),
        "chat:create-session" => {
            let title = value_as_string(payload.as_ref(), None).unwrap_or_else(|| "New Chat".to_string());
            Ok(json!({
                "id": format!("session:{}", Uuid::new_v4()),
                "title": title,
                "updatedAt": chrono::Utc::now().to_rfc3339()
            }))
        }
        "chat:delete-session" | "chat:clear-messages" | "chat:compact-context" => Ok(json!({ "success": true })),
        "chat:get-context-usage" => Ok(json!({
            "messages": 0,
            "estimatedTokens": 0,
            "windowTokens": 0
        })),
        "skills:list" => Ok(json!([])),
        _ => Err(format!("LexBox router has not implemented channel: {channel}")),
    }
}

pub async fn handle_send(
    app: &tauri::AppHandle,
    channel: &str,
    _payload: Option<Value>,
) -> Result<(), String> {
    match channel {
        "chat:send-message" | "chat:cancel" | "chat:confirm-tool" | "ai:start-chat" | "ai:cancel" | "ai:confirm-tool" => {
            let _ = app.emit(
                "chat:error",
                json!({ "message": format!("LexBox has not migrated send channel \"{channel}\" yet.") }),
            );
            Ok(())
        }
        _ => Ok(()),
    }
}

fn data_root() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or_else(|| "Unable to resolve local data directory".to_string())?;
    let root = base.join("LexBox");
    ensure_dir(&root)?;
    Ok(root)
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(data_root()?.join("settings.json"))
}

fn spaces_path() -> Result<PathBuf, String> {
    Ok(data_root()?.join("spaces.json"))
}

fn wechat_bindings_path() -> Result<PathBuf, String> {
    Ok(data_root()?.join("wechat-bindings.json"))
}

fn read_spaces_state() -> Result<SpacesState, String> {
    let path = spaces_path()?;
    if path.exists() {
        return read_json(&path);
    }

    let default = SpacesState {
        active_space_id: "default".to_string(),
        spaces: vec![SpaceRecord {
            id: "default".to_string(),
            name: "Default".to_string(),
        }],
    };
    write_spaces_state(&default)?;
    ensure_workspace_structure("default")?;
    Ok(default)
}

fn write_spaces_state(state: &SpacesState) -> Result<(), String> {
    write_json(&spaces_path()?, &serde_json::to_value(state).map_err(|error| error.to_string())?)
}

fn active_space_id() -> Result<String, String> {
    Ok(read_spaces_state()?.active_space_id)
}

fn workspace_root() -> Result<PathBuf, String> {
    let root = data_root()?.join("spaces").join(active_space_id()?);
    ensure_dir(&root)?;
    Ok(root)
}

fn manuscripts_root() -> Result<PathBuf, String> {
    let path = workspace_root()?.join("manuscripts");
    ensure_dir(&path)?;
    Ok(path)
}

fn manuscript_layouts_path() -> Result<PathBuf, String> {
    Ok(workspace_root()?.join("manuscript-layouts.json"))
}

fn ensure_workspace_structure(space_id: &str) -> Result<(), String> {
    let root = data_root()?.join("spaces").join(space_id);
    let dirs = [
        root.join("manuscripts"),
        root.join("knowledge"),
        root.join("media"),
        root.join("cover"),
        root.join("redclaw"),
        root.join("subjects"),
        root.join("chatrooms"),
    ];
    for dir in dirs {
        ensure_dir(&dir)?;
    }
    Ok(())
}

fn read_wechat_bindings() -> Result<Vec<WechatBinding>, String> {
    let path = wechat_bindings_path()?;
    if !path.exists() {
        write_json(&path, &json!([]))?;
    }
    read_json(&path)
}

fn write_wechat_bindings(bindings: &[WechatBinding]) -> Result<(), String> {
    write_json(&wechat_bindings_path()?, &serde_json::to_value(bindings).map_err(|error| error.to_string())?)
}

fn list_tree(root: &Path, current: &Path) -> Result<Vec<FileNode>, String> {
    let mut entries = fs::read_dir(current)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, io::Error>>()
        .map_err(|error| error.to_string())?;

    entries.sort_by_key(|entry| entry.file_name());

    let mut nodes = Vec::new();
    for entry in entries {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        let relative = normalize_relative_path(
            path.strip_prefix(root)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .as_ref(),
        );
        if path.is_dir() {
            nodes.push(FileNode {
                name: file_name,
                path: relative.clone(),
                is_directory: true,
                children: Some(list_tree(root, &path)?),
            });
        } else if path.is_file() {
            nodes.push(FileNode {
                name: file_name,
                path: relative,
                is_directory: false,
                children: None,
            });
        }
    }
    Ok(nodes)
}

fn resolve_manuscript_path(relative: &str) -> Result<PathBuf, String> {
    let root = manuscripts_root()?;
    let cleaned = normalize_relative_path(relative);
    let joined = if cleaned.is_empty() { root } else { root.join(cleaned) };
    Ok(joined)
}

fn normalize_relative_path(value: &str) -> String {
    value
        .replace('\\', "/")
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect::<Vec<_>>()
        .join("/")
}

fn ensure_markdown_extension(value: &str) -> String {
    if value.ends_with(".md") {
        normalize_relative_path(value)
    } else {
        format!("{}.md", normalize_relative_path(value))
    }
}

fn join_relative(parent: &str, name: &str) -> String {
    let parent = normalize_relative_path(parent);
    let name = normalize_relative_path(name);
    if parent.is_empty() {
        name
    } else if name.is_empty() {
        parent
    } else {
        format!("{parent}/{name}")
    }
}

fn slug_from_relative_path(path: &str) -> String {
    normalize_relative_path(path)
        .replace('/', "-")
        .replace('.', "-")
}

fn title_from_relative_path(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled")
        .to_string()
}

fn markdown_to_html(title: &str, content: &str) -> String {
    let mut html = String::from("<article>");
    if !title.is_empty() {
        html.push_str(&format!("<h1>{}</h1>", escape_html(title)));
    }
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        html.push_str(&format!("<p>{}</p>", escape_html(trimmed)));
    }
    html.push_str("</article>");
    html
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn read_json<T>(path: &Path) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn read_json_or_default(path: &Path, default: Value) -> Result<Value, String> {
    if path.exists() {
        read_json(path)
    } else {
        write_json(path, &default)?;
        Ok(default)
    }
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let content = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())
}

fn value_as_string(payload: Option<&Value>, key: Option<&str>) -> Option<String> {
    match key {
        Some(key) => payload?.get(key)?.as_str().map(str::to_string),
        None => payload?.as_str().map(str::to_string),
    }
}

fn open_external(url: &str) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .arg(url)
            .status()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .status()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    std::process::Command::new("xdg-open")
        .arg(url)
        .status()
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn open_path(path: &Path) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .arg(path)
            .status()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    if cfg!(target_os = "windows") {
        std::process::Command::new("explorer")
            .arg(path)
            .status()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    std::process::Command::new("xdg-open")
        .arg(path)
        .status()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[allow(dead_code)]
fn flatten_workspace_files(root: &Path) -> Result<HashMap<String, PathBuf>, String> {
    let mut files = HashMap::new();
    for entry in WalkDir::new(root) {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_file() {
            let relative = normalize_relative_path(
                path.strip_prefix(root)
                    .map_err(|error| error.to_string())?
                    .to_string_lossy()
                    .as_ref(),
            );
            files.insert(relative, path.to_path_buf());
        }
    }
    Ok(files)
}
