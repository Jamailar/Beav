use super::event::DiagnosticReportRecord;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn report_root(root: &Path) -> PathBuf {
    root.join("diagnostic-reports")
}

pub fn pending_dir(root: &Path) -> PathBuf {
    report_root(root).join("pending")
}

pub fn uploaded_dir(root: &Path) -> PathBuf {
    report_root(root).join("uploaded")
}

pub fn failed_dir(root: &Path) -> PathBuf {
    report_root(root).join("failed")
}

pub fn export_dir(root: &Path) -> PathBuf {
    report_root(root).join("export")
}

pub fn runtime_state_path(root: &Path) -> PathBuf {
    report_root(root).join("runtime-state.json")
}

fn report_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{}.json", crate::slug_from_relative_path(id)))
}

pub fn ensure_report_dirs(root: &Path) -> Result<(), String> {
    fs::create_dir_all(pending_dir(root)).map_err(|error| error.to_string())?;
    fs::create_dir_all(uploaded_dir(root)).map_err(|error| error.to_string())?;
    fs::create_dir_all(failed_dir(root)).map_err(|error| error.to_string())?;
    fs::create_dir_all(export_dir(root)).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn persist_report(
    root: &Path,
    bucket: &str,
    report: &DiagnosticReportRecord,
) -> Result<(), String> {
    ensure_report_dirs(root)?;
    let path = match bucket {
        "uploaded" => report_path(&uploaded_dir(root), &report.id),
        "failed" => report_path(&failed_dir(root), &report.id),
        _ => report_path(&pending_dir(root), &report.id),
    };
    let serialized = serde_json::to_string_pretty(report).map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())
}

fn load_reports_from_dir(dir: &Path) -> Vec<DiagnosticReportRecord> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut items = entries
        .filter_map(Result::ok)
        .filter_map(|entry| fs::read_to_string(entry.path()).ok())
        .filter_map(|raw| serde_json::from_str::<DiagnosticReportRecord>(&raw).ok())
        .collect::<Vec<_>>();
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    items
}

pub fn list_reports(root: &Path, bucket: &str) -> Vec<DiagnosticReportRecord> {
    let dir = match bucket {
        "uploaded" => uploaded_dir(root),
        "failed" => failed_dir(root),
        _ => pending_dir(root),
    };
    load_reports_from_dir(&dir)
}

pub fn load_report(
    root: &Path,
    bucket: &str,
    report_id: &str,
) -> Result<DiagnosticReportRecord, String> {
    let dir = match bucket {
        "uploaded" => uploaded_dir(root),
        "failed" => failed_dir(root),
        _ => pending_dir(root),
    };
    let path = report_path(&dir, report_id);
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

pub fn delete_report(root: &Path, bucket: &str, report_id: &str) -> Result<(), String> {
    let dir = match bucket {
        "uploaded" => uploaded_dir(root),
        "failed" => failed_dir(root),
        _ => pending_dir(root),
    };
    let path = report_path(&dir, report_id);
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn move_report(
    root: &Path,
    from_bucket: &str,
    to_bucket: &str,
    report: &DiagnosticReportRecord,
) -> Result<(), String> {
    delete_report(root, from_bucket, &report.id)?;
    persist_report(root, to_bucket, report)
}

pub fn upload_response_value(report: &DiagnosticReportRecord) -> Value {
    serde_json::to_value(report).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::{
        delete_report, list_reports, load_report, move_report, pending_dir, persist_report,
        uploaded_dir,
    };
    use crate::logging::event::DiagnosticReportRecord;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("valid clock")
            .as_nanos();
        std::env::temp_dir().join(format!("redbox-logging-test-{unique}"))
    }

    fn sample_report(id: &str, created_at: &str) -> DiagnosticReportRecord {
        DiagnosticReportRecord {
            id: id.to_string(),
            trigger: "manual-export".to_string(),
            status: "pending".to_string(),
            created_at: created_at.to_string(),
            updated_at: created_at.to_string(),
            summary: format!("report {id}"),
            include_advanced_context: false,
            last_error: None,
            uploaded_at: None,
            last_attempt_at: None,
            dedupe_key: None,
            bundle_file_name: None,
            metadata: json!({ "source": "test" }),
        }
    }

    #[test]
    fn persist_and_list_reports_sorts_newest_first() {
        let root = test_root();
        let older = sample_report("older", "2026-04-23T09:00:00Z");
        let newer = sample_report("newer", "2026-04-23T10:00:00Z");

        persist_report(&root, "pending", &older).expect("persist older report");
        persist_report(&root, "pending", &newer).expect("persist newer report");

        let reports = list_reports(&root, "pending");
        assert_eq!(reports.len(), 2);
        assert_eq!(reports[0].id, "newer");
        assert_eq!(reports[1].id, "older");

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn move_report_rehomes_between_buckets() {
        let root = test_root();
        let report = sample_report("move-me", "2026-04-23T10:00:00Z");

        persist_report(&root, "pending", &report).expect("persist report");
        move_report(&root, "pending", "uploaded", &report).expect("move report");

        assert!(!pending_dir(&root).join("move-me.json").exists());
        assert!(uploaded_dir(&root).join("move-me.json").exists());
        let loaded = load_report(&root, "uploaded", "move-me").expect("load moved report");
        assert_eq!(loaded.id, "move-me");

        delete_report(&root, "uploaded", "move-me").expect("delete report");
        fs::remove_dir_all(root).ok();
    }
}
