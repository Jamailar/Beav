use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::State;
use url::Url;

use crate::{
    AppState, FileNode, ensure_parent_dir, manuscripts_root, payload_string, write_text_file,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HostRuntimeContext {
    pub os_family: &'static str,
    pub path_style: &'static str,
    pub path_separator: &'static str,
    pub shell_hint: &'static str,
    pub exe_suffix: &'static str,
    pub line_ending: &'static str,
}

pub(crate) fn current_host_runtime_context() -> HostRuntimeContext {
    #[cfg(target_os = "windows")]
    {
        return HostRuntimeContext {
            os_family: "windows",
            path_style: "windows",
            path_separator: "\\",
            shell_hint: "powershell",
            exe_suffix: ".exe",
            line_ending: "crlf",
        };
    }

    #[cfg(target_os = "macos")]
    {
        return HostRuntimeContext {
            os_family: "macos",
            path_style: "posix",
            path_separator: "/",
            shell_hint: "zsh",
            exe_suffix: "",
            line_ending: "lf",
        };
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        HostRuntimeContext {
            os_family: "linux",
            path_style: "posix",
            path_separator: "/",
            shell_hint: "bash",
            exe_suffix: "",
            line_ending: "lf",
        }
    }
}

pub(crate) fn compact_host_runtime_context(context: &HostRuntimeContext) -> String {
    format!(
        "host_os={}; path_style={}; path_separator={}; shell_hint={}; exe_suffix={}; line_ending={}",
        context.os_family,
        context.path_style,
        context.path_separator,
        context.shell_hint,
        if context.exe_suffix.is_empty() {
            "(none)"
        } else {
            context.exe_suffix
        },
        context.line_ending
    )
}

pub(crate) fn app_brand_display_name() -> &'static str {
    match env!("CARGO_PKG_NAME") {
        "thrive" => "Thrive",
        "redbox" => "RedBox",
        _ => "App",
    }
}

pub(crate) fn app_ai_display_name() -> &'static str {
    app_brand_display_name()
}

pub(crate) fn render_host_runtime_context_section(context: &HostRuntimeContext) -> String {
    [
        format!("- Host OS: {}", context.os_family),
        format!("- Path style: {}", context.path_style),
        format!("- Path separator: {}", context.path_separator),
        format!("- Preferred shell syntax hint: {}", context.shell_hint),
        format!(
            "- Executable suffix: {}",
            if context.exe_suffix.is_empty() {
                "(none)"
            } else {
                context.exe_suffix
            }
        ),
        format!("- Default line ending: {}", context.line_ending),
        "- When suggesting manual file paths or shell examples, prefer the host OS format unless a tool contract explicitly requires normalized logical paths.".to_string(),
    ]
    .join("\n")
}

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

pub(crate) fn draft_type_from_package_kind(kind: &str) -> &'static str {
    match kind {
        "post" => "richpost",
        "article" => "longform",
        "video" => "video",
        "audio" => "audio",
        _ => "unknown",
    }
}

pub(crate) fn default_package_entry_for_kind(kind: Option<&str>) -> &'static str {
    match kind {
        Some("video") | Some("audio") => "script.md",
        _ => "content.md",
    }
}

fn normalize_package_entry_name(name: &str) -> Option<String> {
    let normalized = name.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return None;
    }
    Some(normalized)
}

pub(crate) fn is_manuscript_package_path(path: &Path) -> bool {
    path.is_dir() && package_manifest_path(path).is_file()
}

pub(crate) fn get_package_kind_from_manifest(path: &Path) -> Option<String> {
    if !is_manuscript_package_path(path) {
        return None;
    }
    let manifest = read_json_value_or(&package_manifest_path(path), json!({}));
    payload_string(&manifest, "packageKind")
        .or_else(|| payload_string(&manifest, "kind"))
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| matches!(value.as_str(), "post" | "article" | "video" | "audio"))
}

pub(crate) fn read_package_text_entry(package_path: &Path, entry_name: &str) -> Option<String> {
    let entry_name = normalize_package_entry_name(entry_name)?;
    fs::read_to_string(package_path.join(entry_name)).ok()
}

pub(crate) fn read_package_json_entry_or(
    package_path: &Path,
    entry_name: &str,
    fallback: Value,
) -> Value {
    read_package_text_entry(package_path, entry_name)
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .unwrap_or(fallback)
}

#[cfg(test)]
pub(crate) fn write_post_package_files(
    package_path: &Path,
    manifest: &Value,
    content: &str,
    bindings: &Value,
) -> Result<(), String> {
    fs::create_dir_all(package_path).map_err(|error| error.to_string())?;
    write_json_value(&package_manifest_path(package_path), manifest)?;
    write_package_text_entry(package_path, "content.md", content)?;
    write_package_json_entry(package_path, "bindings.json", bindings)
}

pub(crate) fn write_package_text_entry(
    package_path: &Path,
    entry_name: &str,
    content: &str,
) -> Result<(), String> {
    let entry_name = normalize_package_entry_name(entry_name)
        .ok_or_else(|| "Invalid package entry".to_string())?;
    write_text_file(&package_path.join(entry_name), content)
}

pub(crate) fn write_package_json_entry(
    package_path: &Path,
    entry_name: &str,
    value: &Value,
) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    write_package_text_entry(package_path, entry_name, &content)
}

pub(crate) fn package_manifest_path(package_path: &Path) -> PathBuf {
    package_path.join("manifest.json")
}

pub(crate) fn package_entry_path(
    package_path: &Path,
    _file_name: &str,
    manifest: Option<&Value>,
) -> PathBuf {
    let entry = manifest
        .and_then(|value| value.get("entry"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            default_package_entry_for_kind(get_package_kind_from_manifest(package_path).as_deref())
        });
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

pub(crate) fn package_remotion_input_props_path(package_path: &Path) -> PathBuf {
    package_path.join("remotion.input-props.json")
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

pub(crate) fn package_layout_html_path(package_path: &Path) -> PathBuf {
    package_path.join("layout.html")
}

pub(crate) fn package_content_map_path(package_path: &Path) -> PathBuf {
    package_path.join("content-map.json")
}

pub(crate) fn package_layout_tokens_path(package_path: &Path) -> PathBuf {
    package_path.join("layout.tokens.json")
}

pub(crate) fn package_richpost_page_plan_path(package_path: &Path) -> PathBuf {
    package_path.join("richpost-page-plan.json")
}

pub(crate) fn package_workspace_root_path(package_path: &Path) -> PathBuf {
    let start = if package_path.is_dir() {
        package_path
    } else {
        package_path.parent().unwrap_or(package_path)
    };
    for ancestor in start.ancestors() {
        if ancestor
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value == "manuscripts")
            .unwrap_or(false)
        {
            return ancestor.parent().unwrap_or(ancestor).to_path_buf();
        }
    }
    start.parent().unwrap_or(start).to_path_buf()
}

pub(crate) fn legacy_package_richpost_themes_path(package_path: &Path) -> PathBuf {
    package_path.join("richpost-themes.json")
}

pub(crate) fn legacy_package_richpost_theme_store_dir(package_path: &Path) -> PathBuf {
    package_path.join("themes")
}

pub(crate) fn legacy_package_richpost_theme_template_path(package_path: &Path) -> PathBuf {
    legacy_package_richpost_theme_store_dir(package_path).join("richpost-theme-template.md")
}

pub(crate) fn workspace_richpost_theme_store_dir(package_path: &Path) -> PathBuf {
    package_workspace_root_path(package_path).join("themes")
}

pub(crate) fn workspace_richpost_themes_path(package_path: &Path) -> PathBuf {
    workspace_richpost_theme_store_dir(package_path).join("richpost-themes.json")
}

pub(crate) fn package_richpost_theme_store_dir(package_path: &Path) -> PathBuf {
    workspace_richpost_theme_store_dir(package_path)
}

pub(crate) fn package_richpost_themes_path(package_path: &Path) -> PathBuf {
    package_richpost_theme_store_dir(package_path).join("index.json")
}

pub(crate) fn package_richpost_theme_template_path(package_path: &Path) -> PathBuf {
    package_richpost_theme_store_dir(package_path).join("richpost-theme-template.md")
}

pub(crate) fn package_richpost_theme_root_dir(package_path: &Path, theme_id: &str) -> PathBuf {
    package_richpost_theme_store_dir(package_path).join(theme_id)
}

pub(crate) fn package_richpost_theme_config_file_name(theme_id: &str) -> String {
    format!("{theme_id}.json")
}

pub(crate) fn package_richpost_theme_config_path(package_path: &Path, theme_id: &str) -> PathBuf {
    package_richpost_theme_root_dir(package_path, theme_id)
        .join(package_richpost_theme_config_file_name(theme_id))
}

pub(crate) fn package_richpost_theme_tokens_path(package_path: &Path, theme_id: &str) -> PathBuf {
    package_richpost_theme_root_dir(package_path, theme_id).join("layout.tokens.json")
}

pub(crate) fn package_richpost_theme_masters_dir(package_path: &Path, theme_id: &str) -> PathBuf {
    package_richpost_theme_root_dir(package_path, theme_id).join("masters")
}

pub(crate) fn package_richpost_theme_master_path(
    package_path: &Path,
    theme_id: &str,
    master_name: &str,
) -> PathBuf {
    package_richpost_theme_masters_dir(package_path, theme_id)
        .join(format!("{master_name}.master.html"))
}

pub(crate) fn package_richpost_theme_assets_dir(package_path: &Path, theme_id: &str) -> PathBuf {
    package_richpost_theme_root_dir(package_path, theme_id).join("assets")
}

pub(crate) fn package_richpost_masters_dir(package_path: &Path) -> PathBuf {
    package_path.join("masters")
}

pub(crate) fn package_richpost_master_path(package_path: &Path, master_name: &str) -> PathBuf {
    package_richpost_masters_dir(package_path).join(format!("{master_name}.master.html"))
}

pub(crate) fn package_richpost_pages_dir(package_path: &Path) -> PathBuf {
    package_path.join("pages")
}

pub(crate) fn package_richpost_preview_dir(package_path: &Path) -> PathBuf {
    package_path.join("previews")
}

pub(crate) fn package_richpost_page_html_path(package_path: &Path, page_id: &str) -> PathBuf {
    package_richpost_pages_dir(package_path).join(format!("{page_id}.html"))
}

pub(crate) fn package_richpost_card_preview_image_path(package_path: &Path) -> PathBuf {
    package_richpost_preview_dir(package_path).join("card-first-page.png")
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

pub(crate) fn redbox_project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn bundled_resource_roots_for_install_root(install_root: &Path) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut roots = Vec::new();
    let mut push = |path: PathBuf| {
        let key = path.to_string_lossy().to_string();
        if seen.insert(key) {
            roots.push(path);
        }
    };

    push(install_root.to_path_buf());
    push(install_root.join("resources"));
    push(install_root.join("_up_"));
    push(install_root.join("_up_").join("resources"));
    if install_root
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| name == "MacOS")
    {
        if let Some(contents_root) = install_root.parent() {
            let resource_root = contents_root.join("Resources");
            push(resource_root.clone());
            push(resource_root.join("_up_"));
            push(resource_root.join("resources"));
            push(resource_root.join("_up_").join("resources"));
        }
    }

    roots
}

pub(crate) fn redbox_bundled_resource_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(install_root) = current_exe.parent() {
            roots.extend(bundled_resource_roots_for_install_root(install_root));
        }
    }
    roots
}

pub(crate) fn redbox_builtin_skill_roots() -> Vec<PathBuf> {
    let mut roots = redbox_bundled_resource_roots()
        .into_iter()
        .map(|root| root.join("builtin-skills"))
        .filter(|root| root.exists() && root.is_dir())
        .collect::<Vec<_>>();
    let source_root = redbox_project_root().join("builtin-skills");
    if source_root.exists()
        && source_root.is_dir()
        && !roots.iter().any(|root| root == &source_root)
    {
        roots.push(source_root);
    }
    if roots.is_empty() {
        roots.push(redbox_project_root().join("builtin-skills"));
    }
    roots
}

pub(crate) fn redbox_builtin_skills_root() -> PathBuf {
    redbox_builtin_skill_roots()
        .into_iter()
        .next()
        .unwrap_or_else(|| redbox_project_root().join("builtin-skills"))
}

pub(crate) fn redbox_prompt_library_roots() -> Vec<PathBuf> {
    let source_root = redbox_project_root().join("prompts").join("library");
    let source_root_exists = source_root.exists() && source_root.is_dir();
    let mut roots = Vec::new();
    let mut seen = HashSet::new();
    let push = |roots: &mut Vec<PathBuf>, seen: &mut HashSet<String>, path: PathBuf| {
        let key = path.to_string_lossy().to_string();
        if seen.insert(key) {
            roots.push(path);
        }
    };

    for root in redbox_bundled_resource_roots() {
        let bundled_library_root = root.join("library");
        if bundled_library_root.exists() && bundled_library_root.is_dir() {
            push(&mut roots, &mut seen, bundled_library_root);
        }
        let bundled_nested_library_root = root.join("prompts").join("library");
        if bundled_nested_library_root.exists() && bundled_nested_library_root.is_dir() {
            push(&mut roots, &mut seen, bundled_nested_library_root);
        }
    }

    if source_root_exists {
        push(&mut roots, &mut seen, source_root.clone());
    }

    if roots.is_empty() {
        push(&mut roots, &mut seen, source_root);
    }

    roots
}

pub(crate) fn load_redbox_prompt(relative_path: &str) -> Option<String> {
    for root in redbox_prompt_library_roots() {
        let full_path = root.join(relative_path);
        let content = fs::read_to_string(full_path)
            .ok()
            .map(|content| content.trim().to_string())
            .filter(|content| !content.is_empty());
        if content.is_some() {
            return content;
        }
    }
    None
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

pub(crate) fn storage_safe_file_stem(value: &str) -> String {
    let raw = slug_from_relative_path(value);
    let mut sanitized = String::with_capacity(raw.len());
    let mut previous_was_dash = false;
    for ch in raw.chars() {
        let invalid =
            matches!(ch, '<' | '>' | ':' | '"' | '\\' | '|' | '?' | '*') || ch.is_control();
        let next = if invalid { '-' } else { ch };
        if next == '-' {
            if previous_was_dash {
                continue;
            }
            previous_was_dash = true;
        } else {
            previous_was_dash = false;
        }
        sanitized.push(next);
    }
    let trimmed = sanitized
        .trim_matches(|ch: char| ch == '-' || ch == ' ' || ch == '.')
        .to_string();
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let normalized = if trimmed.is_empty() {
        "root".to_string()
    } else if reserved
        .iter()
        .any(|reserved_name| trimmed.eq_ignore_ascii_case(reserved_name))
    {
        format!("item-{trimmed}")
    } else {
        trimmed
    };
    normalized.chars().take(120).collect()
}

#[cfg(test)]
mod storage_path_tests {
    use super::storage_safe_file_stem;

    #[test]
    fn storage_safe_file_stem_strips_windows_reserved_filename_chars() {
        assert_eq!(
            storage_safe_file_stem("context-session:wechat-article:foo/bar?.md"),
            "context-session-wechat-article-foo-bar-md"
        );
    }

    #[test]
    fn storage_safe_file_stem_avoids_windows_device_names() {
        assert_eq!(storage_safe_file_stem("CON"), "item-CON");
        assert_eq!(storage_safe_file_stem("lpt1"), "item-lpt1");
    }

    #[test]
    fn storage_safe_file_stem_caps_long_components() {
        let stem = storage_safe_file_stem(&"a".repeat(300));
        assert_eq!(stem.len(), 120);
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

pub(crate) fn markdown_summary(content: &str, max_chars: usize) -> String {
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

pub(crate) fn split_markdown_frontmatter(content: &str) -> Option<(String, String)> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---\n") && !trimmed.starts_with("---\r\n") {
        return None;
    }
    let normalized = content.replace("\r\n", "\n");
    if !normalized.starts_with("---\n") {
        return None;
    }
    let mut lines = normalized.lines();
    let first = lines.next()?;
    if first.trim() != "---" {
        return None;
    }
    let mut raw_lines = Vec::<String>::new();
    let mut body_start_line = None;
    for (index, line) in normalized.lines().enumerate().skip(1) {
        let trimmed = line.trim();
        if trimmed == "---" || trimmed == "..." {
            body_start_line = Some(index + 1);
            break;
        }
        raw_lines.push(line.to_string());
    }
    let body_start_line = body_start_line?;
    let all_lines = normalized.lines().collect::<Vec<_>>();
    let block = all_lines[..body_start_line].join("\n");
    let body = all_lines[body_start_line..]
        .join("\n")
        .trim_start_matches('\n')
        .to_string();
    Some((block, body))
}

pub(crate) fn strip_markdown_frontmatter(content: &str) -> String {
    split_markdown_frontmatter(content)
        .map(|(_, body)| body)
        .unwrap_or_else(|| content.replace("\r\n", "\n"))
}

pub(crate) fn extract_markdown_frontmatter_block(content: &str) -> Option<String> {
    split_markdown_frontmatter(content).map(|(block, _)| block)
}

pub(crate) fn compose_markdown_with_frontmatter(body: &str, block: Option<&str>) -> String {
    let normalized_body = body.replace("\r\n", "\n");
    let Some(frontmatter_block) = block.map(|value| value.replace("\r\n", "\n")) else {
        return normalized_body;
    };
    let normalized_block = frontmatter_block.trim_end_matches('\n');
    let next_body = normalized_body.trim_start_matches('\n');
    if next_body.is_empty() {
        format!("{normalized_block}\n")
    } else {
        format!("{normalized_block}\n\n{next_body}")
    }
}

pub(crate) fn parse_markdown_frontmatter(content: &str) -> Option<Value> {
    let (block, _) = split_markdown_frontmatter(content)?;
    let mut object = serde_json::Map::new();
    for line in block.lines().skip(1) {
        let normalized = line.trim();
        if normalized == "---" || normalized == "..." {
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
    let draft_type = payload_string(&manifest, "draftType").unwrap_or_else(|| {
        get_package_kind_from_manifest(path)
            .as_deref()
            .map(|kind| match kind {
                "post" => "richpost",
                "article" => "longform",
                "video" => "video",
                "audio" => "audio",
                _ => "unknown",
            })
            .unwrap_or("unknown")
            .to_string()
    });
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
        richpost_preview_file: None,
        richpost_preview_file_url: None,
        richpost_preview_updated_at: None,
        richpost_preview_page_file: None,
        richpost_preview_page_file_url: None,
        richpost_preview_page_updated_at: None,
    }
}

fn file_node_from_markdown(path: &Path, file_name: &str, relative: String) -> FileNode {
    let content = read_text_prefix(path, 8 * 1024);
    let frontmatter = parse_markdown_frontmatter(&content).unwrap_or_else(|| json!({}));
    let title = payload_string(&frontmatter, "title")
        .unwrap_or_else(|| title_from_relative_path(file_name));
    let draft_type = payload_string(&frontmatter, "draftType")
        .or_else(|| payload_string(&frontmatter, "draft_type"))
        .unwrap_or_else(|| "unknown".to_string());
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
        richpost_preview_file: None,
        richpost_preview_file_url: None,
        richpost_preview_updated_at: None,
        richpost_preview_page_file: None,
        richpost_preview_page_file_url: None,
        richpost_preview_page_updated_at: None,
    }
}

pub(crate) fn resolve_manuscript_path(
    state: &State<'_, AppState>,
    relative: &str,
) -> Result<PathBuf, String> {
    let root = manuscripts_root(state)?;
    let direct_path = PathBuf::from(relative);
    if direct_path.is_absolute() {
        if direct_path.starts_with(&root) {
            return Ok(direct_path);
        }
        return Err("Path is outside manuscripts root".to_string());
    }
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

fn list_tree_internal(root: &Path, current: &Path, depth: usize) -> Result<Vec<FileNode>, String> {
    if depth > MANUSCRIPTS_TREE_MAX_DEPTH {
        return Ok(Vec::new());
    }
    if current != root {
        if let Ok(relative) = current.strip_prefix(root) {
            let mut cursor = root.to_path_buf();
            let inside_package = relative.components().any(|component| {
                cursor.push(component.as_os_str());
                is_manuscript_package_path(&cursor)
            });
            if inside_package {
                return Ok(Vec::new());
            }
        }
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
        if file_name.starts_with('.') {
            continue;
        }
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

        if file_type.is_dir() && is_manuscript_package_path(&path) {
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
                richpost_preview_file: None,
                richpost_preview_file_url: None,
                richpost_preview_updated_at: None,
                richpost_preview_page_file: None,
                richpost_preview_page_file_url: None,
                richpost_preview_page_updated_at: None,
            });
        } else if file_type.is_file() {
            if file_name.ends_with(".md") {
                nodes.push(file_node_from_markdown(&path, &file_name, relative));
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
    Url::from_file_path(path)
        .map(|url| url.into())
        .unwrap_or_else(|_| {
            let raw = path.to_string_lossy().trim().replace('\\', "/");
            if raw.len() >= 2 && raw.as_bytes().get(1).copied() == Some(b':') {
                let synthetic_posix = format!("/{}", raw.trim_start_matches('/'));
                return Url::from_file_path(Path::new(&synthetic_posix))
                    .map(|url| url.into())
                    .unwrap_or_else(|_| format!("file:///{}", raw));
            }
            if raw.starts_with("//") {
                return Url::parse(&format!("file:{raw}"))
                    .map(|url| url.into())
                    .unwrap_or_else(|_| format!("file:{raw}"));
            }
            format!("file://{}", raw)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_resource_roots_for_install_root_covers_tauri_nsis_layout() {
        let roots = bundled_resource_roots_for_install_root(Path::new("/tmp/RedBox"));
        assert_eq!(
            roots,
            vec![
                PathBuf::from("/tmp/RedBox"),
                PathBuf::from("/tmp/RedBox/resources"),
                PathBuf::from("/tmp/RedBox/_up_"),
                PathBuf::from("/tmp/RedBox/_up_/resources"),
            ]
        );
    }

    #[test]
    fn bundled_resource_roots_for_install_root_covers_tauri_macos_app_layout() {
        let roots = bundled_resource_roots_for_install_root(Path::new(
            "/Applications/RedBox.app/Contents/MacOS",
        ));
        assert!(roots.contains(&PathBuf::from(
            "/Applications/RedBox.app/Contents/Resources"
        )));
        assert!(roots.contains(&PathBuf::from(
            "/Applications/RedBox.app/Contents/Resources/_up_"
        )));
    }

    #[test]
    fn redbox_builtin_skills_root_points_to_a_skill_directory_in_dev() {
        let root = redbox_builtin_skills_root();
        assert!(root.join("writing-style").join("SKILL.md").exists());
    }

    #[test]
    fn redbox_prompt_library_root_points_to_a_prompt_directory_in_dev() {
        assert!(redbox_prompt_library_roots().into_iter().any(|root| {
            root.join("runtime")
                .join("advisors")
                .join("templates")
                .exists()
        }));
    }

    #[test]
    fn current_host_runtime_context_fields_are_consistent() {
        let context = current_host_runtime_context();
        assert!(!context.os_family.is_empty());
        assert!(!context.path_style.is_empty());
        assert!(!context.path_separator.is_empty());
        assert!(!context.shell_hint.is_empty());
        assert!(!context.line_ending.is_empty());

        #[cfg(target_os = "windows")]
        {
            assert_eq!(context.os_family, "windows");
            assert_eq!(context.path_style, "windows");
            assert_eq!(context.path_separator, "\\");
            assert_eq!(context.shell_hint, "powershell");
            assert_eq!(context.exe_suffix, ".exe");
            assert_eq!(context.line_ending, "crlf");
        }

        #[cfg(target_os = "macos")]
        {
            assert_eq!(context.os_family, "macos");
            assert_eq!(context.path_style, "posix");
            assert_eq!(context.path_separator, "/");
            assert_eq!(context.shell_hint, "zsh");
            assert_eq!(context.exe_suffix, "");
            assert_eq!(context.line_ending, "lf");
        }

        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        {
            assert_eq!(context.os_family, "linux");
            assert_eq!(context.path_style, "posix");
            assert_eq!(context.path_separator, "/");
            assert_eq!(context.shell_hint, "bash");
            assert_eq!(context.exe_suffix, "");
            assert_eq!(context.line_ending, "lf");
        }
    }

    #[test]
    fn file_url_for_path_normalizes_windows_drive_paths() {
        let url = file_url_for_path(Path::new(r#"C:\Users\Jam\My Images\demo 1.png"#));
        assert_eq!(url, "file:///C:/Users/Jam/My%20Images/demo%201.png");
    }

    #[test]
    fn file_url_for_path_encodes_unicode_windows_user_paths() {
        let url = file_url_for_path(Path::new(r#"C:\Users\张三\RedBox\图片 1.png"#));
        assert_eq!(
            url,
            "file:///C:/Users/%E5%BC%A0%E4%B8%89/RedBox/%E5%9B%BE%E7%89%87%201.png"
        );
    }

    #[test]
    fn render_host_runtime_context_section_contains_key_fields() {
        let section = render_host_runtime_context_section(&HostRuntimeContext {
            os_family: "windows",
            path_style: "windows",
            path_separator: "\\",
            shell_hint: "powershell",
            exe_suffix: ".exe",
            line_ending: "crlf",
        });
        assert!(section.contains("Host OS: windows"));
        assert!(section.contains("Path style: windows"));
        assert!(section.contains("Preferred shell syntax hint: powershell"));
        assert!(section.contains("Default line ending: crlf"));
    }

    #[test]
    fn storage_safe_file_stem_strips_windows_reserved_filename_chars() {
        assert_eq!(
            storage_safe_file_stem("context-session:wechat-article:foo/bar?.md"),
            "context-session-wechat-article-foo-bar-md"
        );
    }

    #[test]
    fn list_tree_treats_package_directory_as_single_manuscript_node() {
        let root = std::env::temp_dir().join(format!("redbox-list-tree-{}", crate::now_ms()));
        let package_root = root.join("demo");
        fs::create_dir_all(package_root.join("pages")).expect("package pages dir");
        fs::write(
            package_root.join("manifest.json"),
            r#"{"title":"Demo","packageKind":"post","draftType":"richpost","entry":"content.md"}"#,
        )
        .expect("manifest should be written");
        fs::write(package_root.join("content.md"), "# Demo\n\nBody")
            .expect("content should be written");
        fs::write(
            package_root.join("pages").join("page-001.html"),
            "<html></html>",
        )
        .expect("page should be written");

        let nodes = list_tree(&root, &root).expect("tree should load");
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].name, "demo");
        assert_eq!(nodes[0].draft_type.as_deref(), Some("richpost"));
        assert!(!nodes[0].is_directory);
        assert!(nodes[0].children.is_none());

        let package_children =
            list_tree_internal(&root, &package_root, 1).expect("package children");
        assert!(package_children.is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn package_entry_helpers_read_and_write_directory_entries() {
        let root = std::env::temp_dir().join(format!("redbox-package-entry-{}", crate::now_ms()));
        fs::create_dir_all(&root).expect("root should exist");
        let package_path = root.join("demo");
        write_post_package_files(
            &package_path,
            &json!({
                "schemaVersion": 1,
                "packageKind": "post",
                "draftType": "richpost",
                "title": "Package Demo",
                "entry": "content.md"
            }),
            "# Package Demo\n\nBody",
            &json!({
                "media": [],
                "targets": [],
                "publishedPosts": [],
                "sources": [],
                "inspirations": []
            }),
        )
        .expect("package files should be written");

        let nodes = list_tree(&root, &root).expect("tree should load");
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].name, "demo");
        assert_eq!(nodes[0].title.as_deref(), Some("Package Demo"));
        assert_eq!(nodes[0].draft_type.as_deref(), Some("richpost"));
        assert!(!nodes[0].is_directory);
        assert!(
            nodes[0]
                .summary
                .as_deref()
                .unwrap_or("")
                .contains("Package Demo")
        );
        write_package_text_entry(&package_path, "variants/xiaohongshu.md", "平台版本")
            .expect("variant should be written");
        assert_eq!(
            read_package_text_entry(&package_path, "variants/xiaohongshu.md").as_deref(),
            Some("平台版本")
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_tree_ignores_hidden_and_non_markdown_files() {
        let root =
            std::env::temp_dir().join(format!("redbox-list-tree-filter-{}", crate::now_ms()));
        fs::create_dir_all(&root).expect("root should exist");
        fs::write(root.join(".DS_Store"), "ignored").expect("hidden file should be written");
        fs::write(root.join("notes.txt"), "ignored").expect("txt file should be written");
        fs::write(root.join("draft.md"), "# Draft").expect("markdown should be written");

        let nodes = list_tree(&root, &root).expect("tree should load");
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].name, "draft.md");

        let _ = fs::remove_dir_all(&root);
    }
}
