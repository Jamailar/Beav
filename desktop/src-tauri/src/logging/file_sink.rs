use super::config::LoggingConfig;
use super::event::LogEventRecord;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::{self, JoinHandle};

enum FileSinkCommand {
    Write(LogEventRecord),
    Shutdown,
}

pub struct FileSinkHandle {
    sender: Sender<FileSinkCommand>,
    join: Option<JoinHandle<()>>,
}

impl FileSinkHandle {
    pub fn write(&self, record: LogEventRecord) {
        let _ = self.sender.send(FileSinkCommand::Write(record));
    }
}

impl Drop for FileSinkHandle {
    fn drop(&mut self) {
        let _ = self.sender.send(FileSinkCommand::Shutdown);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

fn ensure_log_dirs(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root.join("logs").join("current")).map_err(|error| error.to_string())?;
    fs::create_dir_all(root.join("logs").join("archive")).map_err(|error| error.to_string())?;
    Ok(())
}

fn current_sink_path(root: &Path, sink_name: &str) -> PathBuf {
    root.join("logs")
        .join("current")
        .join(format!("{sink_name}.ndjson"))
}

fn archive_dir(root: &Path) -> PathBuf {
    root.join("logs").join("archive")
}

fn prune_archives(root: &Path, sink_name: &str, keep: usize) {
    let dir = archive_dir(root);
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let mut matches = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_string_lossy().to_string();
            if name.starts_with(&format!("{sink_name}-")) && name.ends_with(".zst") {
                let modified = entry.metadata().and_then(|value| value.modified()).ok()?;
                Some((modified, path))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    matches.sort_by_key(|(modified, _)| *modified);
    while matches.len() > keep {
        if let Some((_, path)) = matches.first().cloned() {
            let _ = fs::remove_file(path);
            matches.remove(0);
        } else {
            break;
        }
    }
}

fn rotate_if_needed(root: &Path, sink_name: &str, config: &LoggingConfig) -> Result<(), String> {
    let current = current_sink_path(root, sink_name);
    let Ok(metadata) = fs::metadata(&current) else {
        return Ok(());
    };
    let max_bytes = (config.max_file_mb.max(1) * 1024 * 1024) as u64;
    if metadata.len() < max_bytes {
        return Ok(());
    }
    let rotated_plain = archive_dir(root).join(format!("{sink_name}-{}.ndjson", crate::now_ms()));
    fs::rename(&current, &rotated_plain).map_err(|error| error.to_string())?;
    let raw = fs::read(&rotated_plain).map_err(|error| error.to_string())?;
    let compressed = zstd::stream::encode_all(std::io::Cursor::new(raw), 3)
        .map_err(|error| error.to_string())?;
    let compressed_path = rotated_plain.with_extension("ndjson.zst");
    fs::write(&compressed_path, compressed).map_err(|error| error.to_string())?;
    let _ = fs::remove_file(rotated_plain);
    prune_archives(root, sink_name, config.archive_files_per_sink.max(1));
    Ok(())
}

fn write_record(
    root: &Path,
    record: &LogEventRecord,
    config: &LoggingConfig,
) -> Result<(), String> {
    let sink_name = record.source.sink_name();
    rotate_if_needed(root, sink_name, config)?;
    let path = current_sink_path(root, sink_name);
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    let line = serde_json::to_string(record).map_err(|error| error.to_string())?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|error| error.to_string())
}

fn run_worker(root: PathBuf, config: LoggingConfig, receiver: Receiver<FileSinkCommand>) {
    let _ = ensure_log_dirs(&root);
    while let Ok(command) = receiver.recv() {
        match command {
            FileSinkCommand::Write(record) => {
                let _ = write_record(&root, &record, &config);
            }
            FileSinkCommand::Shutdown => break,
        }
    }
}

pub fn spawn_file_sink(root: PathBuf, config: LoggingConfig) -> FileSinkHandle {
    let (sender, receiver) = mpsc::channel::<FileSinkCommand>();
    let join = thread::spawn(move || run_worker(root, config, receiver));
    FileSinkHandle {
        sender,
        join: Some(join),
    }
}
