use super::types::AppStore;

pub(crate) fn active_space_id(store: &AppStore) -> String {
    store.active_space_id.clone()
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
