use super::types::{AppStore, SpaceRecord};

pub(crate) fn create_space(
    store: &mut AppStore,
    id: String,
    name: String,
    timestamp: &str,
) -> Result<SpaceRecord, String> {
    if name.trim().is_empty() {
        return Err("空间名称不能为空".to_string());
    }
    if space_exists(store, &id) {
        return Err("空间已存在".to_string());
    }
    let space = SpaceRecord {
        id,
        name,
        created_at: timestamp.to_string(),
        updated_at: timestamp.to_string(),
    };
    store.spaces.push(space.clone());
    store.active_space_id = space.id.clone();
    Ok(space)
}

pub(crate) fn list_spaces_snapshot(store: &AppStore) -> (Vec<SpaceRecord>, String) {
    (store.spaces.clone(), active_space_id(store))
}

pub(crate) fn active_space_id(store: &AppStore) -> String {
    store.active_space_id.clone()
}

pub(crate) fn set_active_space_id_unchecked(store: &mut AppStore, space_id: &str) -> String {
    store.active_space_id = space_id.to_string();
    active_space_id(store)
}

pub(crate) fn space_count(store: &AppStore) -> usize {
    store.spaces.len()
}

pub(crate) fn space_exists(store: &AppStore, space_id: &str) -> bool {
    store.spaces.iter().any(|item| item.id == space_id)
}

pub(crate) fn is_active_space(store: &AppStore, space_id: &str) -> bool {
    store.active_space_id == space_id
}

pub(crate) fn active_workspace_snapshot(store: &AppStore) -> (String, String) {
    let id = active_space_id(store);
    let name = store
        .spaces
        .iter()
        .find(|space| space.id == id)
        .map(|space| space.name.clone())
        .unwrap_or_else(|| id.clone());
    (id, name)
}

pub(crate) fn replace_spaces(store: &mut AppStore, spaces: Vec<SpaceRecord>) {
    store.spaces = spaces;
}

pub(crate) fn normalize_active_space_id(store: &mut AppStore, fallback_space_id: &str) -> String {
    let current_space_id = active_space_id(store);
    if current_space_id.trim().is_empty() || !space_exists(store, &current_space_id) {
        store.active_space_id = fallback_space_id.to_string();
    }
    active_space_id(store)
}

pub(crate) fn rename_space(
    store: &mut AppStore,
    space_id: &str,
    name: String,
    updated_at: &str,
) -> Result<(SpaceRecord, String, bool), String> {
    let active_space_id = active_space_id(store);
    let renamed_active_space = active_space_id == space_id;
    let Some(space) = store.spaces.iter_mut().find(|item| item.id == space_id) else {
        return Err("空间不存在".to_string());
    };
    space.name = name;
    space.updated_at = updated_at.to_string();
    Ok((space.clone(), active_space_id, renamed_active_space))
}

pub(crate) fn delete_space(
    store: &mut AppStore,
    space_id: &str,
    fallback_active_space_id: &str,
) -> Result<(String, bool), String> {
    let Some(index) = store.spaces.iter().position(|item| item.id == space_id) else {
        return Err("空间不存在".to_string());
    };
    let deleted_active_space = is_active_space(store, space_id);
    store.spaces.remove(index);
    if deleted_active_space {
        store.active_space_id = fallback_active_space_id.to_string();
    }
    Ok((active_space_id(store), deleted_active_space))
}

pub(crate) fn switch_active_space(store: &mut AppStore, space_id: &str) -> Result<String, String> {
    if !space_exists(store, space_id) {
        return Err("空间不存在".to_string());
    }
    store.active_space_id = space_id.to_string();
    Ok(active_space_id(store))
}
