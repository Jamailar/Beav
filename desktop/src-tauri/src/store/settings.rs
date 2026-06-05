use super::types::AppStore;
use serde_json::Value;

pub(crate) fn settings_snapshot(store: &AppStore) -> Value {
    store.settings.clone()
}

pub(crate) fn replace_settings(store: &mut AppStore, settings: Value) {
    store.settings = settings;
}

pub(crate) fn update_settings(store: &mut AppStore, updater: impl FnOnce(&mut Value)) -> Value {
    updater(&mut store.settings);
    settings_snapshot(store)
}
