use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::AppState;

fn sanitize_zip_entry_name(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    let file_name = Path::new(trimmed)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(trimmed);
    let sanitized = file_name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>()
        .trim_matches('.')
        .trim()
        .to_string();
    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn unique_zip_entry_name(base_name: &str, used_names: &mut HashSet<String>) -> String {
    if used_names.insert(base_name.to_string()) {
        return base_name.to_string();
    }
    let path = Path::new(base_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    for index in 2.. {
        let candidate = if extension.is_empty() {
            format!("{stem}-{index}")
        } else {
            format!("{stem}-{index}.{extension}")
        };
        if used_names.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!()
}

fn ensure_zip_extension(path: PathBuf) -> PathBuf {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("zip"))
        .unwrap_or(false)
    {
        path
    } else {
        path.with_extension("zip")
    }
}

pub(crate) fn write_zip_archive(
    state: &State<'_, AppState>,
    files: &[Value],
    target_path: PathBuf,
) -> Result<Value, String> {
    let target_path = ensure_zip_extension(target_path);
    let file = fs::File::create(&target_path).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut used_names = HashSet::new();
    let mut written = 0usize;
    for (index, item) in files.iter().enumerate() {
        let source = item
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let path = match super::resolve_file_action_path(state, source) {
            Ok(path) => path,
            Err(error) => return Ok(json!({ "success": false, "error": error, "source": source })),
        };
        if !path.is_file() {
            return Ok(json!({ "success": false, "error": "只能下载文件", "source": source }));
        }
        let fallback_name = format!("image-{}.png", index + 1);
        let requested_name = item
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .or_else(|| path.file_name().and_then(|value| value.to_str()))
            .unwrap_or(&fallback_name);
        let entry_name = unique_zip_entry_name(
            &sanitize_zip_entry_name(requested_name, &fallback_name),
            &mut used_names,
        );
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        zip.start_file(entry_name, options)
            .map_err(|error| error.to_string())?;
        zip.write_all(&bytes).map_err(|error| error.to_string())?;
        written += 1;
    }
    zip.finish().map_err(|error| error.to_string())?;
    Ok(json!({ "success": true, "path": target_path, "count": written }))
}

#[cfg(test)]
mod tests {
    use super::{ensure_zip_extension, sanitize_zip_entry_name, unique_zip_entry_name};
    use std::collections::HashSet;
    use std::path::PathBuf;

    #[test]
    fn zip_entry_name_is_sanitized() {
        assert_eq!(
            sanitize_zip_entry_name("../bad:name?.png", "fallback.png"),
            "bad_name_.png"
        );
        assert_eq!(
            sanitize_zip_entry_name("...", "fallback.png"),
            "fallback.png"
        );
    }

    #[test]
    fn zip_entry_names_are_unique() {
        let mut used_names = HashSet::new();
        assert_eq!(
            unique_zip_entry_name("image.png", &mut used_names),
            "image.png"
        );
        assert_eq!(
            unique_zip_entry_name("image.png", &mut used_names),
            "image-2.png"
        );
    }

    #[test]
    fn zip_extension_is_applied_when_missing() {
        assert_eq!(
            ensure_zip_extension(PathBuf::from("/tmp/assets")),
            PathBuf::from("/tmp/assets.zip")
        );
        assert_eq!(
            ensure_zip_extension(PathBuf::from("/tmp/assets.ZIP")),
            PathBuf::from("/tmp/assets.ZIP")
        );
    }
}
