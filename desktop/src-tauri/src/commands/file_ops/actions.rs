use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::{copy_image_to_clipboard, pick_save_file_native, AppState};

fn show_in_folder_target(path: &Path) -> PathBuf {
    if path.is_file() {
        path.parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| path.to_path_buf())
    } else {
        path.to_path_buf()
    }
}

fn default_save_name(path: &Path, requested_name: Option<String>) -> String {
    requested_name
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            path.file_name()
                .and_then(|value| value.to_str())
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "generated-asset".to_string())
}

fn safe_download_file_name(path: &Path, requested_name: Option<String>) -> String {
    let name = default_save_name(path, requested_name);
    let file_name = Path::new(&name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("generated-asset")
        .trim();
    let sanitized = file_name
        .chars()
        .map(|value| match value {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => value,
        })
        .collect::<String>();
    let trimmed = sanitized.trim_matches('.').trim();
    if trimmed.is_empty() {
        "generated-asset".to_string()
    } else {
        trimmed.to_string()
    }
}

fn unique_download_path(download_dir: &Path, file_name: &str) -> PathBuf {
    let candidate = download_dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("generated-asset");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();

    for index in 1..10_000 {
        let candidate = download_dir.join(format!("{stem} ({index}){extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }

    download_dir.join(format!("{stem}-{}{}", crate::now_ms(), extension))
}

pub(crate) fn show_in_folder(state: &State<'_, AppState>, source: &str) -> Result<Value, String> {
    let path = match super::resolve_file_action_path(state, source) {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "success": false, "error": error })),
    };
    let target = show_in_folder_target(&path);
    open::that(&target).map_err(|error| error.to_string())?;
    Ok(json!({ "success": true }))
}

pub(crate) fn copy_image(state: &State<'_, AppState>, source: &str) -> Result<Value, String> {
    let path = match super::resolve_file_action_path(state, source) {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "success": false, "error": error })),
    };
    copy_image_to_clipboard(&path)?;
    Ok(json!({ "success": true }))
}

pub(crate) fn save_as(
    state: &State<'_, AppState>,
    source: &str,
    requested_name: Option<String>,
) -> Result<Value, String> {
    let path = match super::resolve_file_action_path(state, source) {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "success": false, "error": error })),
    };
    let default_name = default_save_name(&path, requested_name);
    let selected = pick_save_file_native("选择保存位置", &default_name, path.parent())?;
    let Some(target_path) = selected else {
        return Ok(json!({ "success": false, "canceled": true }));
    };
    fs::copy(&path, &target_path).map_err(|error| error.to_string())?;
    Ok(json!({ "success": true, "path": target_path }))
}

pub(crate) fn download_to_downloads(
    state: &State<'_, AppState>,
    source: &str,
    requested_name: Option<String>,
) -> Result<Value, String> {
    let path = match super::resolve_file_action_path(state, source) {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "success": false, "error": error })),
    };
    let download_dir = dirs::download_dir().ok_or_else(|| "无法找到下载文件夹".to_string())?;
    fs::create_dir_all(&download_dir).map_err(|error| error.to_string())?;
    let file_name = safe_download_file_name(&path, requested_name);
    let target_path = unique_download_path(&download_dir, &file_name);
    fs::copy(&path, &target_path).map_err(|error| error.to_string())?;
    Ok(json!({ "success": true, "path": target_path }))
}

#[cfg(test)]
mod tests {
    use super::{
        default_save_name, safe_download_file_name, show_in_folder_target, unique_download_path,
    };
    use std::fs;
    use std::path::{Path, PathBuf};

    fn make_temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "redbox-file-ops-action-{label}-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn show_in_folder_target_uses_parent_for_files() {
        let root = make_temp_dir("show-file");
        let file = root.join("image.png");
        fs::write(&file, b"ok").expect("write file");

        assert_eq!(show_in_folder_target(&file), root);
        let _ = fs::remove_dir_all(file.parent().expect("file parent"));
    }

    #[test]
    fn show_in_folder_target_keeps_directories() {
        let root = make_temp_dir("show-dir");

        assert_eq!(show_in_folder_target(&root), root);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn default_save_name_prefers_non_empty_requested_name() {
        assert_eq!(
            default_save_name(Path::new("/tmp/source.png"), Some("copy.png".to_string())),
            "copy.png"
        );
        assert_eq!(
            default_save_name(Path::new("/tmp/source.png"), Some(" ".to_string())),
            "source.png"
        );
    }

    #[test]
    fn safe_download_file_name_strips_path_segments_and_invalid_chars() {
        assert_eq!(
            safe_download_file_name(
                Path::new("/tmp/source.png"),
                Some("../bad:name?.png".to_string())
            ),
            "bad_name_.png"
        );
    }

    #[test]
    fn unique_download_path_avoids_overwriting_existing_file() {
        let root = make_temp_dir("unique-download");
        fs::write(root.join("image.png"), b"ok").expect("write existing file");

        assert_eq!(
            unique_download_path(&root, "image.png"),
            root.join("image (1).png")
        );
        let _ = fs::remove_dir_all(root);
    }
}
