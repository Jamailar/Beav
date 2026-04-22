use std::fs;
use std::hash::{DefaultHasher, Hasher};
use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone)]
pub(crate) struct FileFingerprint {
    pub size_bytes: i64,
    pub mtime_ms: i64,
    pub content_hash: String,
}

pub(crate) fn fingerprint_file(path: &Path) -> Result<FileFingerprint, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let size_bytes = i64::try_from(metadata.len()).unwrap_or(i64::MAX);
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|mtime| mtime.duration_since(UNIX_EPOCH).ok())
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0);
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = DefaultHasher::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.write(&buffer[..read]);
    }
    Ok(FileFingerprint {
        size_bytes,
        mtime_ms,
        content_hash: format!("{:016x}", hasher.finish()),
    })
}
