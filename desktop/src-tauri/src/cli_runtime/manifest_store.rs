use tauri::State;

use crate::cli_runtime::{CliToolManifestRecord, CliToolRecord};
use crate::persistence::{with_store, with_store_mut};
use crate::{AppState, AppStore};

fn upsert_cli_tool_in_store(store: &mut AppStore, record: CliToolRecord) -> CliToolRecord {
    if let Some(existing) = store.cli_tools.iter_mut().find(|item| item.id == record.id) {
        *existing = record.clone();
    } else {
        store.cli_tools.push(record.clone());
    }
    store
        .cli_tools
        .sort_by(|left, right| left.id.cmp(&right.id));
    record
}

fn upsert_cli_manifest_in_store(
    store: &mut AppStore,
    record: CliToolManifestRecord,
) -> CliToolManifestRecord {
    if let Some(existing) = store
        .cli_manifests
        .iter_mut()
        .find(|item| item.id == record.id || item.tool_id == record.tool_id)
    {
        *existing = record.clone();
    } else {
        store.cli_manifests.push(record.clone());
    }
    store
        .cli_manifests
        .sort_by(|left, right| left.tool_id.cmp(&right.tool_id));
    record
}

pub fn upsert_cli_tool_record(
    state: &State<'_, AppState>,
    record: CliToolRecord,
) -> Result<CliToolRecord, String> {
    with_store_mut(state, |store| {
        Ok(upsert_cli_tool_in_store(store, record.clone()))
    })
}

pub fn list_cli_tool_records(state: &State<'_, AppState>) -> Result<Vec<CliToolRecord>, String> {
    with_store(state, |store| Ok(store.cli_tools.clone()))
}

pub fn find_cli_tool_by_id(
    state: &State<'_, AppState>,
    tool_id: &str,
) -> Result<Option<CliToolRecord>, String> {
    with_store(state, |store| {
        Ok(store
            .cli_tools
            .iter()
            .find(|item| item.id == tool_id)
            .cloned())
    })
}

pub fn find_cli_tool_by_command(
    state: &State<'_, AppState>,
    command: &str,
) -> Result<Option<CliToolRecord>, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    with_store(state, |store| {
        Ok(store
            .cli_tools
            .iter()
            .find(|item| item.executable == trimmed || item.name == trimmed)
            .cloned())
    })
}

pub fn upsert_cli_tool_manifest(
    state: &State<'_, AppState>,
    record: CliToolManifestRecord,
) -> Result<CliToolManifestRecord, String> {
    with_store_mut(state, |store| {
        Ok(upsert_cli_manifest_in_store(store, record.clone()))
    })
}

pub fn list_cli_tool_manifests(
    state: &State<'_, AppState>,
) -> Result<Vec<CliToolManifestRecord>, String> {
    with_store(state, |store| Ok(store.cli_manifests.clone()))
}

pub fn find_cli_tool_manifest_by_tool_id(
    state: &State<'_, AppState>,
    tool_id: &str,
) -> Result<Option<CliToolManifestRecord>, String> {
    with_store(state, |store| {
        Ok(store
            .cli_manifests
            .iter()
            .find(|item| item.tool_id == tool_id)
            .cloned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_cli_tool_in_store_replaces_existing_tool() {
        let mut store = crate::persistence::default_store();
        upsert_cli_tool_in_store(
            &mut store,
            CliToolRecord {
                id: "cli-tool-ffmpeg".to_string(),
                name: "ffmpeg".to_string(),
                executable: "ffmpeg".to_string(),
                version: Some("6.0".to_string()),
                ..CliToolRecord::default()
            },
        );
        upsert_cli_tool_in_store(
            &mut store,
            CliToolRecord {
                id: "cli-tool-ffmpeg".to_string(),
                name: "ffmpeg".to_string(),
                executable: "ffmpeg".to_string(),
                version: Some("7.0".to_string()),
                ..CliToolRecord::default()
            },
        );

        assert_eq!(store.cli_tools.len(), 1);
        assert_eq!(store.cli_tools[0].version.as_deref(), Some("7.0"));
    }

    #[test]
    fn upsert_cli_manifest_in_store_replaces_manifest_by_tool_id() {
        let mut store = crate::persistence::default_store();
        upsert_cli_manifest_in_store(
            &mut store,
            CliToolManifestRecord {
                id: "cli-manifest-ffmpeg".to_string(),
                tool_id: "cli-tool-ffmpeg".to_string(),
                tool_name: "ffmpeg".to_string(),
                generated_at: 1,
                ..CliToolManifestRecord::default()
            },
        );
        upsert_cli_manifest_in_store(
            &mut store,
            CliToolManifestRecord {
                id: "cli-manifest-ffmpeg-v2".to_string(),
                tool_id: "cli-tool-ffmpeg".to_string(),
                tool_name: "ffmpeg".to_string(),
                generated_at: 2,
                ..CliToolManifestRecord::default()
            },
        );

        assert_eq!(store.cli_manifests.len(), 1);
        assert_eq!(store.cli_manifests[0].id, "cli-manifest-ffmpeg-v2");
    }
}
