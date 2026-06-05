use super::types::{AppStore, SpaceRecord};

pub(crate) fn list_spaces_snapshot(store: &AppStore) -> (Vec<SpaceRecord>, String) {
    (store.spaces.clone(), active_space_id(store))
}

pub(crate) fn active_space_id(store: &AppStore) -> String {
    store.active_space_id.clone()
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
