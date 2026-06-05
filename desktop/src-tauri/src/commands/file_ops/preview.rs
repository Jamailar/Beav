use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

#[path = "preview_paths.rs"]
mod preview_paths;
#[path = "preview_types.rs"]
mod preview_types;

use crate::{
    is_manuscript_package_path, package_entry_path, package_manifest_path,
    strip_markdown_frontmatter, AppState,
};
pub(crate) use preview_paths::resolve_virtual_resource_path;
use preview_paths::{redbox_asset_url_for_path, resolve_manuscript_package_fallback};
use preview_types::{
    extension_for_path, file_name_for_path, mime_type_for_extension, preview_kind_for_extension,
};

const PREVIEW_TEXT_MAX_BYTES: u64 = 512 * 1024;

fn read_preview_text(path: &Path, kind: &str) -> Option<String> {
    if kind != "text" && kind != "html" && kind != "manuscript" {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > PREVIEW_TEXT_MAX_BYTES {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    let extension = extension_for_path(path);
    if matches!(extension.as_deref(), Some("md" | "markdown")) {
        Some(strip_markdown_frontmatter(&content))
    } else {
        Some(content)
    }
}

fn read_package_manifest(package_path: &Path) -> Option<Value> {
    let manifest_path = package_manifest_path(package_path);
    fs::read_to_string(manifest_path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
}

fn resolve_package_preview_entry(path: &Path) -> Option<PathBuf> {
    if !is_manuscript_package_path(path) {
        return None;
    }
    let file_name = file_name_for_path(path)?;
    let manifest = read_package_manifest(path);
    let manifest_entry_path = package_entry_path(path, &file_name, manifest.as_ref());
    if manifest_entry_path.is_file() {
        return Some(manifest_entry_path);
    }
    let default_entry_path = path.join("content.md");
    if default_entry_path.is_file() {
        Some(default_entry_path)
    } else {
        None
    }
}

fn preview_title_for_path(
    trimmed_source: &str,
    original_path: &Path,
    preview_path: &Path,
) -> String {
    let preview_name =
        file_name_for_path(preview_path).unwrap_or_else(|| trimmed_source.to_string());
    if original_path != preview_path && is_manuscript_package_path(original_path) {
        if let Some(package_name) = file_name_for_path(original_path) {
            return format!("{package_name} / {preview_name}");
        }
    }
    preview_name
}

pub(crate) fn resolve_preview_target(
    state: &State<'_, AppState>,
    source: &str,
) -> Result<Value, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("路径为空".to_string());
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let extension = extension_for_path(Path::new(trimmed));
        let kind = preview_kind_for_extension(extension.as_deref(), false);
        return Ok(json!({
            "success": true,
            "isLocal": false,
            "exists": true,
            "isDirectory": false,
            "absolutePath": null,
            "localPathCandidate": null,
            "resolvedUrl": trimmed,
            "title": trimmed,
            "extension": extension,
            "kind": kind,
            "mimeType": mime_type_for_extension(extension.as_deref()),
            "sizeBytes": null,
            "previewText": null,
        }));
    }

    let resolved = match resolve_virtual_resource_path(state, trimmed)? {
        Some(path) => Some(path),
        None => super::resolve_local_path_with_encoded_fallback(trimmed),
    };
    let resolved_path = resolved.ok_or_else(|| "无效路径".to_string())?;
    let original_path = resolve_manuscript_package_fallback(state, trimmed, &resolved_path)
        .unwrap_or(resolved_path);
    let package_preview_entry = resolve_package_preview_entry(&original_path);
    let path = package_preview_entry
        .clone()
        .unwrap_or_else(|| original_path.clone());
    let exists = path.exists();
    let is_directory = path.is_dir();
    let metadata = if exists {
        fs::metadata(&path).ok()
    } else {
        None
    };
    let extension = extension_for_path(&path);
    let mut kind = preview_kind_for_extension(extension.as_deref(), true);
    if package_preview_entry.is_some() {
        kind = "manuscript";
    }
    let title = if let Some(entry_path) = package_preview_entry.as_ref() {
        file_name_for_path(&original_path)
            .map(|package_name| {
                format!(
                    "{package_name} / {}",
                    entry_path
                        .strip_prefix(&original_path)
                        .ok()
                        .and_then(|value| value.to_str())
                        .unwrap_or("content.md")
                )
            })
            .unwrap_or_else(|| preview_title_for_path(trimmed, &original_path, &path))
    } else {
        preview_title_for_path(trimmed, &original_path, &path)
    };
    let preview_text = if exists && !is_directory {
        read_preview_text(&path, kind)
    } else {
        None
    };
    let resolved_url = if exists && !is_directory {
        redbox_asset_url_for_path(&path)
    } else {
        String::new()
    };

    Ok(json!({
        "success": true,
        "isLocal": true,
        "exists": exists,
        "isDirectory": is_directory,
        "absolutePath": path,
        "localPathCandidate": path,
        "resolvedUrl": resolved_url,
        "title": title,
        "extension": extension,
        "kind": kind,
        "mimeType": mime_type_for_extension(extension.as_deref()),
        "sizeBytes": metadata.map(|value| value.len()),
        "previewText": preview_text,
    }))
}

#[cfg(test)]
mod tests {
    use super::{read_preview_text, resolve_package_preview_entry};
    use std::fs;
    use std::path::PathBuf;

    fn make_temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "redbox-file-preview-{label}-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn markdown_preview_text_strips_frontmatter() {
        let root = make_temp_dir("frontmatter");
        let target = root.join("content.md");
        fs::write(
            &target,
            "---\ntitle: Hidden\nplatform: xiaohongshu\n---\n\n# Visible body\n正文",
        )
        .expect("write markdown file");

        let preview = read_preview_text(&target, "text").expect("read markdown preview");

        assert_eq!(preview, "# Visible body\n正文");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn package_preview_uses_default_content_markdown() {
        let root = make_temp_dir("package-default");
        let package = root.join("demo");
        fs::create_dir_all(&package).expect("create manuscript package");
        fs::write(
            package.join("manifest.json"),
            r#"{"packageKind":"post","entry":"content.md"}"#,
        )
        .expect("write manifest");
        let entry = package.join("content.md");
        fs::write(&entry, "# Demo").expect("write package entry");

        let resolved = resolve_package_preview_entry(&package);

        assert_eq!(resolved, Some(entry));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn package_preview_respects_manifest_entry() {
        let root = make_temp_dir("package-manifest");
        let package = root.join("demo");
        let notes_dir = package.join("notes");
        fs::create_dir_all(&notes_dir).expect("create notes dir");
        fs::write(
            package.join("manifest.json"),
            r#"{"entry":"notes/main.md"}"#,
        )
        .expect("write manifest");
        let entry = notes_dir.join("main.md");
        fs::write(&entry, "# Manifest entry").expect("write manifest entry");
        fs::write(package.join("content.md"), "# Default entry").expect("write default entry");

        let resolved = resolve_package_preview_entry(&package);

        assert_eq!(resolved, Some(entry));
        let _ = fs::remove_dir_all(root);
    }
}
