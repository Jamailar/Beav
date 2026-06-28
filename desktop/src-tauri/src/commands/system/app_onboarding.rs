use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::{app_brand_display_name, now_iso, payload_field, AppState};

const APP_ONBOARDING_RECEIPT_FILE: &str = "app-onboarding-receipt.json";

fn receipt_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = state
        .store_path
        .parent()
        .ok_or_else(|| format!("{} store root is unavailable", app_brand_display_name()))?;
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    Ok(root.join(APP_ONBOARDING_RECEIPT_FILE))
}

fn read_receipt(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn receipt_seen(receipt: &Value) -> bool {
    receipt
        .get("seen")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn write_receipt(path: &Path, source: &str) -> Result<Value, String> {
    let seen_at = now_iso();
    let receipt = json!({
        "kind": "app-onboarding-receipt",
        "version": 1,
        "seen": true,
        "seenAt": seen_at,
        "source": source,
    });
    let raw = serde_json::to_string_pretty(&receipt).map_err(|error| error.to_string())?;
    fs::write(path, raw).map_err(|error| error.to_string())?;
    Ok(receipt)
}

fn status_from_receipt(path: &Path, receipt: Option<Value>, migrated: bool) -> Value {
    let seen = receipt.as_ref().map(receipt_seen).unwrap_or(false);
    json!({
        "success": true,
        "seen": seen,
        "seenAt": receipt
            .as_ref()
            .and_then(|value| value.get("seenAt"))
            .and_then(Value::as_str)
            .unwrap_or(""),
        "migrated": migrated,
        "path": path.display().to_string(),
    })
}

pub(super) fn get_status(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let path = receipt_path(state)?;
    let mut receipt = read_receipt(&path);
    let mut migrated = false;
    let legacy_seen = payload_field(payload, "legacySeen")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if !receipt.as_ref().map(receipt_seen).unwrap_or(false) && legacy_seen {
        receipt = Some(write_receipt(&path, "renderer-local-storage-migration")?);
        migrated = true;
    }

    Ok(status_from_receipt(&path, receipt, migrated))
}

pub(super) fn mark_seen(state: &State<'_, AppState>) -> Result<Value, String> {
    let path = receipt_path(state)?;
    let receipt = if let Some(receipt) = read_receipt(&path).filter(receipt_seen) {
        receipt
    } else {
        write_receipt(&path, "app-onboarding-completed")?
    };
    Ok(status_from_receipt(&path, Some(receipt), false))
}
