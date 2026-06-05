use std::path::{Component, Path, PathBuf};
use tauri::State;

use crate::{cover_root, media_root, resolve_manuscript_path, workspace_root, AppState};

fn is_windows_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

pub(super) fn safe_virtual_relative_path(raw: &str) -> Option<PathBuf> {
    let decoded = urlencoding::decode(raw)
        .map(|value| value.into_owned())
        .unwrap_or_else(|_| raw.to_string());
    if decoded.starts_with("//") || decoded.starts_with("\\\\") {
        return None;
    }
    let normalized = decoded
        .trim_start_matches(|value| value == '/' || value == '\\')
        .replace('\\', "/");
    if normalized.is_empty() {
        return Some(PathBuf::new());
    }
    if is_windows_drive_prefix(&normalized) {
        return None;
    }
    let path = PathBuf::from(normalized);
    for component in path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return None;
        }
    }
    Some(path)
}

fn virtual_path_parts(source: &str) -> Option<(String, String)> {
    let trimmed = source.trim();
    let separator = trimmed.find("://")?;
    let scheme = trimmed[..separator].to_ascii_lowercase();
    let rest = trimmed[(separator + 3)..].to_string();
    Some((scheme, rest))
}

pub(crate) fn resolve_virtual_resource_path(
    state: &State<'_, AppState>,
    source: &str,
) -> Result<Option<PathBuf>, String> {
    let Some((scheme, rest)) = virtual_path_parts(source) else {
        return Ok(None);
    };
    let root = match scheme.as_str() {
        "workspace" => workspace_root(state)?,
        "knowledge" => crate::knowledge_root(state)?,
        "manuscripts" => resolve_manuscript_path(state, "")?,
        "media" => media_root(state)?,
        "cover" => cover_root(state)?,
        "redclaw" => crate::redclaw_root(state)?,
        _ => return Ok(None),
    };
    let relative = safe_virtual_relative_path(&rest).ok_or_else(|| "虚拟路径不安全".to_string())?;
    Ok(Some(root.join(relative)))
}

pub(super) fn resolve_manuscript_package_fallback(
    state: &State<'_, AppState>,
    source: &str,
    resolved_path: &Path,
) -> Option<PathBuf> {
    if resolved_path.exists() {
        return None;
    }
    let (scheme, rest) = virtual_path_parts(source)?;
    if scheme != "workspace" {
        return None;
    }
    let relative = safe_virtual_relative_path(&rest)?;
    let root = resolve_manuscript_path(state, "").ok()?;
    let candidate = root.join(relative);
    candidate.exists().then_some(candidate)
}

pub(super) fn redbox_asset_url_for_path(path: &Path) -> String {
    let path_string = path.to_string_lossy().replace('\\', "/");
    format!("redbox-asset://asset/{}", urlencoding::encode(&path_string))
}

#[cfg(test)]
mod tests {
    use super::safe_virtual_relative_path;
    use std::path::PathBuf;

    #[test]
    fn virtual_preview_paths_decode_and_block_parent_dir() {
        assert_eq!(
            safe_virtual_relative_path("folder/My%20File.md"),
            Some(PathBuf::from("folder/My File.md"))
        );
        assert_eq!(safe_virtual_relative_path("../secret.md"), None);
        assert_eq!(safe_virtual_relative_path("C:/secret.md"), None);
        assert_eq!(safe_virtual_relative_path("//server/share/secret.md"), None);
    }
}
