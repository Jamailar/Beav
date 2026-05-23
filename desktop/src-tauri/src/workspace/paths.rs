use crate::{
    app_brand_display_name, persistence::with_store, slug_from_relative_path, AppState, AppStore,
};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

pub(crate) fn store_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = state
        .store_path
        .parent()
        .ok_or_else(|| format!("{} store root is unavailable", app_brand_display_name()))?
        .to_path_buf();
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(crate) fn preferred_workspace_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join(".redbox")
}

pub(crate) fn legacy_workspace_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".redconvert"))
}

pub(crate) fn legacy_default_workspace_dir() -> Option<PathBuf> {
    legacy_workspace_dir().map(|root| root.join("spaces").join("default"))
}

pub(crate) fn has_legacy_workspace_layout() -> bool {
    legacy_default_workspace_dir().is_some_and(|path| path.exists())
}

#[allow(dead_code)]
pub(crate) fn managed_workspace_dir_candidates(store_path: &Path) -> Vec<PathBuf> {
    let mut items = Vec::new();
    if let Some(root) = store_path.parent() {
        items.push(root.join("spaces").join("default"));
    }
    items
}

pub(crate) fn is_same_path(left: &Path, right: &Path) -> bool {
    let left = left.to_string_lossy().replace('\\', "/");
    let right = right.to_string_lossy().replace('\\', "/");
    left == right
}

pub(crate) fn configured_workspace_dir(settings: &Value) -> Option<PathBuf> {
    settings
        .get("workspace_dir")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub(crate) fn compatible_workspace_base_dir(settings: &Value) -> PathBuf {
    if let Some(configured) = configured_workspace_dir(settings) {
        return configured;
    }
    if let Some(legacy) = legacy_workspace_dir().filter(|_| has_legacy_workspace_layout()) {
        return legacy;
    }
    preferred_workspace_dir()
}

pub(crate) fn is_legacy_workspace_base(path: &Path) -> bool {
    legacy_workspace_dir()
        .as_ref()
        .is_some_and(|legacy| is_same_path(path, legacy))
}

pub(crate) fn workspace_root_from_snapshot(
    settings: &Value,
    active_space_id: &str,
    _store_path: &Path,
) -> Result<PathBuf, String> {
    let base = compatible_workspace_base_dir(settings);
    let root = if is_legacy_workspace_base(&base) {
        if active_space_id == "default" {
            base.join("spaces").join("default")
        } else {
            base.join("spaces").join(active_space_id)
        }
    } else if active_space_id == "default" {
        base
    } else {
        base.join("spaces").join(active_space_id)
    };
    ensure_workspace_dirs(&root)?;
    Ok(root)
}

pub(crate) fn active_space_workspace_root_from_store(
    store: &AppStore,
    active_space_id: &str,
    store_path: &Path,
) -> Result<PathBuf, String> {
    workspace_root_from_snapshot(&store.settings, active_space_id, store_path)
}

pub(crate) fn update_workspace_root_cache(
    state: &State<'_, AppState>,
    settings: &Value,
    active_space_id: &str,
) -> Result<PathBuf, String> {
    let root = workspace_root_from_snapshot(settings, active_space_id, &state.store_path)?;
    let mut cache = state
        .workspace_root_cache
        .lock()
        .map_err(|_| "workspace root cache lock 已损坏".to_string())?;
    *cache = root.clone();
    Ok(root)
}

pub(crate) fn workspace_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let cached_root = state
        .workspace_root_cache
        .lock()
        .map_err(|_| "workspace root cache lock 已损坏".to_string())?
        .clone();
    if !cached_root.as_os_str().is_empty() {
        ensure_workspace_dirs(&cached_root)?;
        return Ok(cached_root);
    }

    let (settings_snapshot, active_space_id) = with_store(state, |store| {
        Ok((store.settings.clone(), store.active_space_id.clone()))
    })?;
    let root = update_workspace_root_cache(state, &settings_snapshot, &active_space_id)?;
    Ok(root)
}

pub(crate) fn ensure_workspace_dirs(root: &Path) -> Result<(), String> {
    for dir in [
        root.join("manuscripts"),
        root.join("knowledge"),
        root.join("media"),
        root.join("cover"),
        root.join("redclaw"),
        root.join("redclaw").join("profile"),
        root.join("memory"),
        root.join("assets"),
        root.join("chatrooms"),
        root.join("remotion-elements"),
    ] {
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn manuscripts_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("manuscripts");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(crate) fn media_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("media");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(crate) fn cover_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("cover");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(crate) fn redclaw_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("redclaw");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(crate) fn knowledge_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("knowledge");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(crate) fn remotion_elements_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("remotion-elements");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(crate) fn advisors_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("advisors");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(crate) fn advisor_dir(
    state: &State<'_, AppState>,
    advisor_id: &str,
) -> Result<PathBuf, String> {
    let root = advisors_root(state)?.join(slug_from_relative_path(advisor_id));
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(crate) fn advisor_knowledge_dir(
    state: &State<'_, AppState>,
    advisor_id: &str,
) -> Result<PathBuf, String> {
    let root = advisor_dir(state, advisor_id)?.join("knowledge");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(crate) fn advisor_avatar_dir(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = advisors_root(state)?.join("avatars");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(crate) fn wechat_drafts_dir(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?
        .join("wechat-official")
        .join("drafts");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(crate) fn subjects_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let workspace = workspace_root(state)?;
    let root = workspace.join("assets");
    let legacy_root = workspace.join("subjects");
    let root_has_catalog = root.join("catalog.json").exists();
    let legacy_has_catalog = legacy_root.join("catalog.json").exists();
    if !root_has_catalog && legacy_has_catalog && root.exists() {
        let is_empty = fs::read_dir(&root)
            .map_err(|error| error.to_string())?
            .next()
            .is_none();
        if is_empty {
            fs::remove_dir(&root).map_err(|error| error.to_string())?;
        }
    }
    if !root.exists() && legacy_root.exists() {
        fs::rename(&legacy_root, &root).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}
