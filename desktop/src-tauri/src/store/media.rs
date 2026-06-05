use super::types::{AppStore, MediaAssetRecord};

pub(crate) fn list_assets(store: &AppStore) -> Vec<MediaAssetRecord> {
    store.media_assets.clone()
}

pub(crate) fn count_assets(store: &AppStore) -> usize {
    store.media_assets.len()
}

pub(crate) fn push_asset(store: &mut AppStore, asset: MediaAssetRecord) {
    store.media_assets.push(asset);
}

pub(crate) fn list_recent_assets(store: &AppStore, limit: usize) -> Vec<MediaAssetRecord> {
    let mut assets = list_assets(store);
    assets.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    assets.truncate(limit);
    assets
}
