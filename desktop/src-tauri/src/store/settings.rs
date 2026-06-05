use super::types::AppStore;
use serde_json::Value;

pub(crate) fn settings_snapshot(store: &AppStore) -> Value {
    store.settings.clone()
}
