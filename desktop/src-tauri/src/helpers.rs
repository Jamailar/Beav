use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::{ensure_parent_dir, manuscripts_root, payload_string, AppState, FileNode};

pub(crate) fn normalize_relative_path(value: &str) -> String {
    value
        .replace('\\', "/")
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect::<Vec<_>>()
        .join("/")
}

pub(crate) fn ensure_markdown_extension(value: &str) -> String {
    let normalized = normalize_relative_path(value);
    if normalized.ends_with(".md") {
        normalized
    } else if normalized.is_empty() {
        "Untitled.md".to_string()
    } else {
        format!("{normalized}.md")
    }
}

pub(crate) const ARTICLE_DRAFT_EXTENSION: &str = ".redarticle";
pub(crate) const POST_DRAFT_EXTENSION: &str = ".redpost";
pub(crate) const VIDEO_DRAFT_EXTENSION: &str = ".redvideo";
pub(crate) const AUDIO_DRAFT_EXTENSION: &str = ".redaudio";

pub(crate) fn is_manuscript_package_name(file_name: &str) -> bool {
    file_name.ends_with(ARTICLE_DRAFT_EXTENSION)
        || file_name.ends_with(POST_DRAFT_EXTENSION)
        || file_name.ends_with(VIDEO_DRAFT_EXTENSION)
        || file_name.ends_with(AUDIO_DRAFT_EXTENSION)
}

pub(crate) fn get_package_kind_from_file_name(file_name: &str) -> Option<&'static str> {
    if file_name.ends_with(ARTICLE_DRAFT_EXTENSION) {
        Some("article")
    } else if file_name.ends_with(POST_DRAFT_EXTENSION) {
        Some("post")
    } else if file_name.ends_with(VIDEO_DRAFT_EXTENSION) {
        Some("video")
    } else if file_name.ends_with(AUDIO_DRAFT_EXTENSION) {
        Some("audio")
    } else {
        None
    }
}

pub(crate) fn get_draft_type_from_file_name(file_name: &str) -> &'static str {
    match get_package_kind_from_file_name(file_name) {
        Some("article") => "longform",
        Some("post") => "richpost",
        Some("video") => "video",
        Some("audio") => "audio",
        _ => "unknown",
    }
}

pub(crate) fn get_default_package_entry(file_name: &str) -> &'static str {
    match get_package_kind_from_file_name(file_name) {
        Some("video") | Some("audio") => "script.md",
        _ => "content.md",
    }
}

pub(crate) fn ensure_manuscript_file_name(name: &str, fallback_extension: &str) -> String {
    let trimmed = name.trim();
    if trimmed.ends_with(".md")
        || trimmed.ends_with(ARTICLE_DRAFT_EXTENSION)
        || trimmed.ends_with(POST_DRAFT_EXTENSION)
        || trimmed.ends_with(VIDEO_DRAFT_EXTENSION)
        || trimmed.ends_with(AUDIO_DRAFT_EXTENSION)
    {
        trimmed.to_string()
    } else {
        format!("{trimmed}{fallback_extension}")
    }
}

pub(crate) fn package_manifest_path(package_path: &Path) -> PathBuf {
    package_path.join("manifest.json")
}

pub(crate) fn package_entry_path(
    package_path: &Path,
    file_name: &str,
    manifest: Option<&Value>,
) -> PathBuf {
    let entry = manifest
        .and_then(|value| value.get("entry"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| get_default_package_entry(file_name));
    package_path.join(entry)
}

pub(crate) fn package_timeline_path(package_path: &Path) -> PathBuf {
    package_path.join("timeline.otio.json")
}

pub(crate) fn package_assets_path(package_path: &Path) -> PathBuf {
    package_path.join("assets.json")
}

pub(crate) fn package_cover_path(package_path: &Path) -> PathBuf {
    package_path.join("cover.json")
}

pub(crate) fn package_images_path(package_path: &Path) -> PathBuf {
    package_path.join("images.json")
}

pub(crate) fn package_remotion_path(package_path: &Path) -> PathBuf {
    package_path.join("remotion.scene.json")
}

pub(crate) fn package_editor_project_path(package_path: &Path) -> PathBuf {
    package_path.join("editor.project.json")
}

pub(crate) fn package_track_ui_path(package_path: &Path) -> PathBuf {
    package_path.join("track-ui.json")
}

pub(crate) fn package_scene_ui_path(package_path: &Path) -> PathBuf {
    package_path.join("scene-ui.json")
}

pub(crate) fn read_json_value_or(path: &Path, fallback: Value) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .unwrap_or(fallback)
}

pub(crate) fn write_json_value(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent_dir(path)?;
    fs::write(
        path,
        serde_json::to_string_pretty(value).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn parse_json_value_from_text(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Some(value);
    }
    if let Some(start) = trimmed.find("```") {
        let fenced = &trimmed[start + 3..];
        let fenced = fenced
            .strip_prefix("json")
            .or_else(|| fenced.strip_prefix("JSON"))
            .unwrap_or(fenced)
            .trim_start_matches('\n');
        if let Some(end) = fenced.find("```") {
            let candidate = fenced[..end].trim();
            if let Ok(value) = serde_json::from_str::<Value>(candidate) {
                return Some(value);
            }
        }
    }
    let first = trimmed.find('{')?;
    let last = trimmed.rfind('}')?;
    if last <= first {
        return None;
    }
    serde_json::from_str::<Value>(&trimmed[first..=last]).ok()
}

pub(crate) fn lexbox_project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

pub(crate) fn redbox_prompt_library_root() -> PathBuf {
    lexbox_project_root().join("prompts").join("library")
}

pub(crate) fn load_redbox_prompt(relative_path: &str) -> Option<String> {
    let full_path = redbox_prompt_library_root().join(relative_path);
    fs::read_to_string(full_path)
        .ok()
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty())
}

pub(crate) fn load_redbox_prompt_or_embedded(relative_path: &str, embedded: &str) -> String {
    load_redbox_prompt(relative_path).unwrap_or_else(|| embedded.trim().to_string())
}

pub(crate) fn render_redbox_prompt(template: &str, vars: &[(&str, String)]) -> String {
    let mut rendered = template.to_string();
    for (key, value) in vars {
        rendered = rendered.replace(&format!("{{{{{key}}}}}"), value);
        rendered = rendered.replace(&format!("{{{key}}}"), value);
    }
    rendered
}

pub(crate) fn join_relative(parent: &str, name: &str) -> String {
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

pub(crate) fn slug_from_relative_path(path: &str) -> String {
    let normalized = normalize_relative_path(path);
    if normalized.is_empty() {
        "root".to_string()
    } else {
        normalized.replace('/', "-").replace('.', "-")
    }
}

pub(crate) fn title_from_relative_path(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled")
        .to_string()
}

fn parse_optional_i64_from_value(value: Option<&Value>) -> Option<i64> {
    value.and_then(|item| {
        item.as_i64()
            .or_else(|| item.as_str().and_then(|raw| raw.trim().parse::<i64>().ok()))
    })
}

fn markdown_summary(content: &str, max_chars: usize) -> String {
    let plain = String::from(content)
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace("\0", "")
        .replace("```", " ")
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty() && !line.starts_with("---"))
        .map(|line| line.trim_start_matches('#').trim())
        .collect::<Vec<_>>()
        .join(" ");
    let chars = plain.chars().collect::<Vec<_>>();
    if chars.len() <= max_chars {
        plain
    } else {
        chars.into_iter().take(max_chars).collect::<String>()
    }
}

fn parse_markdown_frontmatter(content: &str) -> Option<Value> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---\n") && !trimmed.starts_with("---\r\n") {
        return None;
    }
    let mut lines = trimmed.lines();
    let first = lines.next()?;
    if first.trim() != "---" {
        return None;
    }
    let mut object = serde_json::Map::new();
    for line in lines {
        let normalized = line.trim();
        if normalized == "---" {
            break;
        }
        let Some((key, raw_value)) = normalized.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let raw_value = raw_value.trim();
        let value = if (raw_value.starts_with('"') && raw_value.ends_with('"'))
            || (raw_value.starts_with('{') && raw_value.ends_with('}'))
            || (raw_value.starts_with('[') && raw_value.ends_with(']'))
        {
            serde_json::from_str::<Value>(raw_value)
                .unwrap_or_else(|_| Value::String(raw_value.trim_matches('"').to_string()))
        } else if let Ok(number) = raw_value.parse::<i64>() {
            json!(number)
        } else {
            json!(raw_value)
        };
        object.insert(key.to_string(), value);
    }
    Some(Value::Object(object))
}

fn file_node_from_package(path: &Path, file_name: &str, relative: String) -> FileNode {
    let manifest = read_json_value_or(&package_manifest_path(path), json!({}));
    let entry_path = package_entry_path(path, file_name, Some(&manifest));
    let entry_content = read_text_prefix(&entry_path, 8 * 1024);
    let title =
        payload_string(&manifest, "title").unwrap_or_else(|| title_from_relative_path(file_name));
    let draft_type = payload_string(&manifest, "draftType")
        .unwrap_or_else(|| get_draft_type_from_file_name(file_name).to_string());
    let updated_at = parse_optional_i64_from_value(
        manifest
            .get("updatedAt")
            .or_else(|| manifest.get("updated_at")),
    )
    .or_else(|| {
        fs::metadata(path)
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
    });
    let status = payload_string(&manifest, "status");
    let summary = if entry_content.trim().is_empty() {
        None
    } else {
        Some(markdown_summary(&entry_content, 72))
    };
    FileNode {
        name: file_name.to_string(),
        path: relative,
        is_directory: false,
        children: None,
        status,
        title: Some(title),
        draft_type: Some(draft_type),
        updated_at,
        summary,
    }
}

fn file_node_from_markdown(path: &Path, file_name: &str, relative: String) -> FileNode {
    let content = read_text_prefix(path, 8 * 1024);
    let frontmatter = parse_markdown_frontmatter(&content).unwrap_or_else(|| json!({}));
    let title = payload_string(&frontmatter, "title")
        .unwrap_or_else(|| title_from_relative_path(file_name));
    let draft_type = payload_string(&frontmatter, "draftType")
        .or_else(|| payload_string(&frontmatter, "draft_type"))
        .unwrap_or_else(|| get_draft_type_from_file_name(file_name).to_string());
    let status = payload_string(&frontmatter, "status");
    let updated_at = parse_optional_i64_from_value(
        frontmatter
            .get("updatedAt")
            .or_else(|| frontmatter.get("updated_at")),
    )
    .or_else(|| {
        fs::metadata(path)
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
    });
    let summary = if content.trim().is_empty() {
        None
    } else {
        Some(markdown_summary(&content, 72))
    };
    FileNode {
        name: file_name.to_string(),
        path: relative,
        is_directory: false,
        children: None,
        status,
        title: Some(title),
        draft_type: Some(draft_type),
        updated_at,
        summary,
    }
}

pub(crate) fn resolve_manuscript_path(
    state: &State<'_, AppState>,
    relative: &str,
) -> Result<PathBuf, String> {
    let root = manuscripts_root(state)?;
    let cleaned = normalize_relative_path(relative);
    Ok(if cleaned.is_empty() {
        root
    } else {
        root.join(cleaned)
    })
}

const MANUSCRIPTS_TREE_MAX_DEPTH: usize = 12;

fn read_text_prefix(path: &Path, max_bytes: u64) -> String {
    let Ok(file) = fs::File::open(path) else {
        return String::new();
    };
    let mut reader = file.take(max_bytes);
    let mut buffer = Vec::new();
    if reader.read_to_end(&mut buffer).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buffer).into_owned()
}

fn list_tree_internal(
    root: &Path,
    current: &Path,
    depth: usize,
) -> Result<Vec<FileNode>, String> {
    if depth > MANUSCRIPTS_TREE_MAX_DEPTH {
        return Ok(Vec::new());
    }

    let Ok(entries_iter) = fs::read_dir(current) else {
        return Ok(Vec::new());
    };
    let mut entries = entries_iter.flatten().collect::<Vec<_>>();

    entries.sort_by_key(|entry| entry.file_name());

    let mut nodes = Vec::new();
    for entry in entries {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let Ok(stripped_path) = path.strip_prefix(root) else {
            continue;
        };
        let relative = normalize_relative_path(stripped_path.to_string_lossy().as_ref());

        if file_type.is_dir() && is_manuscript_package_name(&file_name) {
            nodes.push(file_node_from_package(&path, &file_name, relative));
        } else if file_type.is_dir() {
            let updated_at = fs::metadata(&path)
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64);
            nodes.push(FileNode {
                name: file_name,
                path: relative,
                is_directory: true,
                children: Some(list_tree_internal(root, &path, depth + 1)?),
                status: None,
                title: None,
                draft_type: None,
                updated_at,
                summary: None,
            });
        } else if file_type.is_file() {
            if file_name.ends_with(".md") {
                nodes.push(file_node_from_markdown(&path, &file_name, relative));
            } else {
                nodes.push(FileNode {
                    name: file_name,
                    path: relative,
                    is_directory: false,
                    children: None,
                    status: None,
                    title: None,
                    draft_type: None,
                    updated_at: fs::metadata(&path)
                        .ok()
                        .and_then(|meta| meta.modified().ok())
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|duration| duration.as_millis() as i64),
                    summary: None,
                });
            }
        }
    }

    Ok(nodes)
}

pub(crate) fn list_tree(root: &Path, current: &Path) -> Result<Vec<FileNode>, String> {
    list_tree_internal(root, current, 0)
}

pub(crate) fn markdown_to_html(title: &str, content: &str) -> String {
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

pub(crate) fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub(crate) fn file_url_for_path(path: &Path) -> String {
    format!("file://{}", path.display())
}
