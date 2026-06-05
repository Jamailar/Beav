use super::types::AppStore;

pub(crate) fn active_space_id(store: &AppStore) -> String {
    store.active_space_id.clone()
}
