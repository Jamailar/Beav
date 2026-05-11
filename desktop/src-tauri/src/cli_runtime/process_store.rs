use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::json;
use tauri::State;

use crate::cli_runtime::{
    CliExecutionRecord, CliExecutionSnapshot, CliVerificationRecord,
    find_cli_escalation_by_execution_id,
};
use crate::persistence::{with_store, with_store_mut};
use crate::{AppState, AppStore, store_root};

const CLI_RUNTIME_ROOT_DIR: &str = "cli-runtime";
const CLI_RUNTIME_LOGS_DIR: &str = "logs";

fn cli_runtime_root_from_store_root(store_root: &Path) -> Result<PathBuf, String> {
    let root = store_root.join(CLI_RUNTIME_ROOT_DIR);
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub fn cli_runtime_root_dir(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    cli_runtime_root_from_store_root(&store_root(state)?)
}

fn cli_runtime_logs_dir_from_root(runtime_root: &Path) -> Result<PathBuf, String> {
    let dir = runtime_root.join(CLI_RUNTIME_LOGS_DIR);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

pub fn cli_runtime_logs_dir(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let runtime_root = cli_runtime_root_dir(state)?;
    cli_runtime_logs_dir_from_root(&runtime_root)
}

pub fn execution_log_paths_from_root(
    runtime_root: &Path,
    execution_id: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let logs_dir = cli_runtime_logs_dir_from_root(runtime_root)?;
    Ok((
        logs_dir.join(format!("{execution_id}.stdout.log")),
        logs_dir.join(format!("{execution_id}.stderr.log")),
    ))
}

pub fn execution_log_paths(
    state: &State<'_, AppState>,
    execution_id: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let runtime_root = cli_runtime_root_dir(state)?;
    execution_log_paths_from_root(&runtime_root, execution_id)
}

pub fn write_execution_logs(
    stdout_path: &Path,
    stderr_path: &Path,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<(), String> {
    initialize_execution_logs(stdout_path, stderr_path)?;
    append_execution_log_chunk(stdout_path, stdout)?;
    append_execution_log_chunk(stderr_path, stderr)?;
    Ok(())
}

pub fn initialize_execution_logs(stdout_path: &Path, stderr_path: &Path) -> Result<(), String> {
    if let Some(parent) = stdout_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if let Some(parent) = stderr_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(stdout_path)
        .map_err(|error| error.to_string())?;
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(stderr_path)
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn append_execution_log_chunk(path: &Path, chunk: &[u8]) -> Result<(), String> {
    if chunk.is_empty() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(chunk).map_err(|error| error.to_string())
}

pub fn read_log_tail_from_path(path: &Path, max_chars: usize) -> Result<String, String> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error.to_string()),
    };
    if max_chars == 0 {
        return Ok(String::new());
    }
    let total_chars = content.chars().count();
    if total_chars <= max_chars {
        return Ok(content);
    }
    Ok(content
        .chars()
        .skip(total_chars.saturating_sub(max_chars))
        .collect())
}

fn upsert_execution_record_in_store(
    store: &mut AppStore,
    record: CliExecutionRecord,
) -> CliExecutionRecord {
    if let Some(existing) = store
        .cli_executions
        .iter_mut()
        .find(|item| item.id == record.id)
    {
        *existing = record.clone();
    } else {
        store.cli_executions.push(record.clone());
    }
    store
        .cli_executions
        .sort_by(|left, right| left.id.cmp(&right.id));
    record
}

pub fn upsert_cli_execution_record(
    state: &State<'_, AppState>,
    record: CliExecutionRecord,
) -> Result<CliExecutionRecord, String> {
    with_store_mut(state, |store| {
        Ok(upsert_execution_record_in_store(store, record.clone()))
    })
}

pub fn list_cli_executions(state: &State<'_, AppState>) -> Result<Vec<CliExecutionRecord>, String> {
    with_store(state, |store| Ok(store.cli_executions.clone()))
}

pub fn replace_cli_verification_records(
    state: &State<'_, AppState>,
    records: Vec<CliVerificationRecord>,
) -> Result<Vec<CliVerificationRecord>, String> {
    if records.is_empty() {
        return Ok(Vec::new());
    }
    let execution_id = records[0].execution_id.clone();
    with_store_mut(state, |store| {
        store
            .cli_verifications
            .retain(|item| item.execution_id != execution_id);
        store.cli_verifications.extend(records.clone());
        store
            .cli_verifications
            .sort_by(|left, right| left.created_at.cmp(&right.created_at));
        Ok(records)
    })
}

pub fn list_cli_verifications_for_execution(
    state: &State<'_, AppState>,
    execution_id: &str,
) -> Result<Vec<CliVerificationRecord>, String> {
    with_store(state, |store| {
        let mut records = store
            .cli_verifications
            .iter()
            .filter(|item| item.execution_id == execution_id)
            .cloned()
            .collect::<Vec<_>>();
        records.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        Ok(records)
    })
}

pub fn find_cli_execution_by_id(
    state: &State<'_, AppState>,
    execution_id: &str,
) -> Result<Option<CliExecutionRecord>, String> {
    with_store(state, |store| {
        Ok(store
            .cli_executions
            .iter()
            .find(|item| item.id == execution_id)
            .cloned())
    })
}

pub fn load_cli_execution_snapshot(
    state: &State<'_, AppState>,
    execution_id: &str,
    max_chars: usize,
) -> Result<Option<CliExecutionSnapshot>, String> {
    let Some(execution) = find_cli_execution_by_id(state, execution_id)? else {
        return Ok(None);
    };
    let stdout_tail = execution
        .stdout_path
        .as_deref()
        .map(Path::new)
        .map(|path| read_log_tail_from_path(path, max_chars))
        .transpose()?
        .unwrap_or_default();
    let stderr_tail = execution
        .stderr_path
        .as_deref()
        .map(Path::new)
        .map(|path| read_log_tail_from_path(path, max_chars))
        .transpose()?
        .unwrap_or_default();
    Ok(Some(CliExecutionSnapshot {
        execution,
        stdout_tail,
        stderr_tail,
        verifications: list_cli_verifications_for_execution(state, execution_id)?,
        escalation: find_cli_escalation_by_execution_id(state, execution_id)?,
    }))
}

pub fn execution_log_metadata(stdout_path: &Path, stderr_path: &Path) -> serde_json::Value {
    json!({
        "stdoutPath": stdout_path.to_string_lossy().to_string(),
        "stderrPath": stderr_path.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execution_log_paths_from_root_uses_cli_runtime_logs_directory() {
        let store_root = Path::new("/tmp/redbox-state");
        let runtime_root =
            cli_runtime_root_from_store_root(store_root).expect("runtime root should build");
        let (stdout_path, stderr_path) =
            execution_log_paths_from_root(&runtime_root, "cli-exec-1").expect("paths should build");
        assert!(stdout_path.to_string_lossy().contains("cli-runtime/logs"));
        assert!(
            stdout_path
                .to_string_lossy()
                .ends_with("cli-exec-1.stdout.log")
        );
        assert!(
            stderr_path
                .to_string_lossy()
                .ends_with("cli-exec-1.stderr.log")
        );
    }

    #[test]
    fn read_log_tail_from_path_returns_last_chars_only() {
        let temp_root = std::env::temp_dir().join(format!("redbox-cli-tail-{}", crate::now_i64()));
        fs::create_dir_all(&temp_root).expect("temp dir should exist");
        let path = temp_root.join("stdout.log");
        fs::write(&path, "0123456789abcdef").expect("log should write");
        let tail = read_log_tail_from_path(&path, 6).expect("tail should read");
        assert_eq!(tail, "abcdef");
        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn append_execution_log_chunk_appends_without_truncating() {
        let temp_root =
            std::env::temp_dir().join(format!("redbox-cli-append-{}", crate::now_i64()));
        fs::create_dir_all(&temp_root).expect("temp dir should exist");
        let stdout_path = temp_root.join("stdout.log");
        let stderr_path = temp_root.join("stderr.log");
        initialize_execution_logs(&stdout_path, &stderr_path).expect("logs should initialize");
        append_execution_log_chunk(&stdout_path, b"hello ").expect("first chunk should append");
        append_execution_log_chunk(&stdout_path, b"world").expect("second chunk should append");
        let content = fs::read_to_string(&stdout_path).expect("stdout log should read");
        assert_eq!(content, "hello world");
        let _ = fs::remove_dir_all(&temp_root);
    }
}
