use super::*;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

struct ArchiveEntry {
    source: PathBuf,
    entry_name: String,
}

pub(super) fn handle_download_channel(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "manuscripts:download" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(payload, "filePath")
                .or_else(|| payload_string(payload, "path"))
                .unwrap_or_default();
            if file_path.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "缺少稿件路径" }));
            }
            download_manuscript_to_downloads(state, &file_path)
        })()),
        _ => None,
    }
}

fn download_manuscript_to_downloads(
    state: &State<'_, AppState>,
    file_path: &str,
) -> Result<Value, String> {
    let source_path = resolve_manuscript_path(state, file_path)?;
    if !source_path.exists() {
        return Ok(json!({ "success": false, "error": "稿件文件不存在" }));
    }

    let resolved = resolve_download_source(&source_path)?;
    match resolved.format.as_str() {
        "html" => download_html_file(&resolved.entry_path),
        "markdown" => download_markdown_archive(state, file_path, &resolved),
        _ => Ok(json!({ "success": false, "error": "当前稿件格式不支持下载" })),
    }
}

struct ResolvedDownloadSource {
    root_path: PathBuf,
    entry_path: PathBuf,
    format: String,
    archive_stem: String,
    markdown_entry_name: String,
}

fn resolve_download_source(source_path: &Path) -> Result<ResolvedDownloadSource, String> {
    if is_manuscript_package_path(source_path) {
        let file_name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("manuscript");
        let manifest = read_json_value_or(&package_manifest_path(source_path), json!({}));
        let entry_path = package_entry_path(source_path, file_name, Some(&manifest));
        return Ok(ResolvedDownloadSource {
            root_path: source_path.to_path_buf(),
            entry_path,
            format: "markdown".to_string(),
            archive_stem: safe_file_stem(file_name),
            markdown_entry_name: safe_file_name(&format!("{}.md", safe_file_stem(file_name))),
        });
    }

    let file_name = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("manuscript.md");
    let format = manuscript_content_format_from_name(file_name).to_string();
    Ok(ResolvedDownloadSource {
        root_path: source_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(".")),
        entry_path: source_path.to_path_buf(),
        format,
        archive_stem: safe_file_stem(
            source_path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("manuscript"),
        ),
        markdown_entry_name: safe_file_name(file_name),
    })
}

fn download_html_file(source_path: &Path) -> Result<Value, String> {
    if !source_path.is_file() {
        return Ok(json!({ "success": false, "error": "HTML 文件不存在" }));
    }
    let download_dir = downloads_dir()?;
    let file_name = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .map(safe_file_name)
        .unwrap_or_else(|| "manuscript.html".to_string());
    let target_path = unique_download_path(&download_dir, &ensure_extension(&file_name, "html"));
    fs::copy(source_path, &target_path).map_err(|error| error.to_string())?;
    Ok(json!({
        "success": true,
        "format": "html",
        "path": target_path.display().to_string(),
    }))
}

fn download_markdown_archive(
    state: &State<'_, AppState>,
    file_path: &str,
    resolved: &ResolvedDownloadSource,
) -> Result<Value, String> {
    if !resolved.entry_path.is_file() {
        return Ok(json!({ "success": false, "error": "Markdown 文件不存在" }));
    }
    let markdown = fs::read_to_string(&resolved.entry_path).unwrap_or_default();
    let mut entries = Vec::new();
    entries.push(ArchiveEntry {
        source: resolved.entry_path.clone(),
        entry_name: resolved.markdown_entry_name.clone(),
    });

    entries.extend(markdown_image_entries(&markdown, &resolved.root_path));
    entries.extend(bound_image_entries(state, file_path)?);

    let download_dir = downloads_dir()?;
    let archive_name = format!("{}.zip", safe_file_stem(&resolved.archive_stem));
    let target_path = unique_download_path(&download_dir, &archive_name);
    let image_count = write_archive(&entries, &target_path)?;

    Ok(json!({
        "success": true,
        "format": "zip",
        "path": target_path.display().to_string(),
        "imageCount": image_count,
    }))
}

fn markdown_image_entries(markdown: &str, base_dir: &Path) -> Vec<ArchiveEntry> {
    let mut entries = Vec::new();
    if let Ok(markdown_image_re) = regex::Regex::new(r#"!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)"#) {
        for captures in markdown_image_re.captures_iter(markdown) {
            if let Some(raw) = captures.get(1).map(|value| value.as_str()) {
                if let Some(entry) = local_image_reference_entry(raw, base_dir) {
                    entries.push(entry);
                }
            }
        }
    }
    if let Ok(html_image_re) = regex::Regex::new(r#"(?is)<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']"#)
    {
        for captures in html_image_re.captures_iter(markdown) {
            if let Some(raw) = captures.get(1).map(|value| value.as_str()) {
                if let Some(entry) = local_image_reference_entry(raw, base_dir) {
                    entries.push(entry);
                }
            }
        }
    }
    entries
}

fn local_image_reference_entry(raw: &str, base_dir: &Path) -> Option<ArchiveEntry> {
    let trimmed = raw.trim().trim_matches('<').trim_matches('>');
    if trimmed.is_empty()
        || trimmed.starts_with('#')
        || trimmed.starts_with("data:")
        || trimmed.starts_with("blob:")
        || trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
    {
        return None;
    }
    let without_fragment = trimmed
        .split('#')
        .next()
        .unwrap_or(trimmed)
        .split('?')
        .next()
        .unwrap_or(trimmed)
        .trim();
    if without_fragment.is_empty() {
        return None;
    }
    let decoded = urlencoding::decode(without_fragment)
        .ok()
        .map(|value| value.into_owned())
        .unwrap_or_else(|| without_fragment.to_string());
    let source = if decoded.starts_with("file://") {
        url::Url::parse(&decoded).ok()?.to_file_path().ok()?
    } else {
        let path = PathBuf::from(&decoded);
        if path.is_absolute() {
            path
        } else {
            base_dir.join(path)
        }
    };
    if !source.is_file() || !is_image_path(&source) {
        return None;
    }
    let entry_name = if PathBuf::from(&decoded).is_relative() && !decoded.starts_with("file://") {
        sanitize_archive_path(&decoded, "images/image")
    } else {
        let fallback = source
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| format!("images/{value}"))
            .unwrap_or_else(|| "images/image".to_string());
        sanitize_archive_path(&fallback, "images/image")
    };
    Some(ArchiveEntry { source, entry_name })
}

fn bound_image_entries(
    state: &State<'_, AppState>,
    file_path: &str,
) -> Result<Vec<ArchiveEntry>, String> {
    let normalized_file_path = normalize_relative_path(file_path);
    let media_root_path = media_root(state)?;
    let assets = with_store(state, |store| {
        Ok(media_store::list_assets(&store)
            .into_iter()
            .filter(|asset| {
                asset
                    .bound_manuscript_path
                    .as_deref()
                    .map(normalize_relative_path)
                    .as_deref()
                    == Some(normalized_file_path.as_str())
            })
            .collect::<Vec<_>>())
    })?;

    Ok(assets
        .into_iter()
        .filter(asset_is_image)
        .filter_map(|asset| {
            let source = asset_file_path(&asset, &media_root_path)?;
            let file_name = source
                .file_name()
                .and_then(|value| value.to_str())
                .map(safe_file_name)
                .unwrap_or_else(|| format!("{}.png", safe_file_stem(&asset.id)));
            Some(ArchiveEntry {
                source,
                entry_name: format!("assets/{file_name}"),
            })
        })
        .collect())
}

fn asset_file_path(asset: &MediaAssetRecord, media_root_path: &Path) -> Option<PathBuf> {
    if let Some(path) = asset
        .absolute_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Some(path);
    }
    if let Some(path) = asset
        .relative_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| media_root_path.join(value))
        .filter(|path| path.is_file())
    {
        return Some(path);
    }
    asset
        .preview_url
        .as_deref()
        .map(str::trim)
        .filter(|value| value.starts_with("file://"))
        .and_then(|value| url::Url::parse(value).ok())
        .and_then(|url| url.to_file_path().ok())
        .filter(|path| path.is_file())
}

fn asset_is_image(asset: &MediaAssetRecord) -> bool {
    asset
        .mime_type
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("image/"))
        || asset
            .absolute_path
            .as_deref()
            .map(Path::new)
            .is_some_and(is_image_path)
        || asset
            .relative_path
            .as_deref()
            .map(Path::new)
            .is_some_and(is_image_path)
}

fn is_image_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "heic")
    )
}

fn write_archive(entries: &[ArchiveEntry], target_path: &Path) -> Result<usize, String> {
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let file = fs::File::create(target_path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipWriter::new(file);
    let options =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut used_entries = HashSet::new();
    let mut image_count = 0usize;

    for (index, entry) in entries.iter().enumerate() {
        if !entry.source.is_file() {
            continue;
        }
        let fallback = if index == 0 {
            "manuscript.md".to_string()
        } else {
            format!("images/image-{index}")
        };
        let entry_name = unique_archive_entry_name(
            &sanitize_archive_path(&entry.entry_name, &fallback),
            &mut used_entries,
        );
        let bytes = fs::read(&entry.source).map_err(|error| error.to_string())?;
        archive
            .start_file(&entry_name, options)
            .map_err(|error| error.to_string())?;
        archive
            .write_all(&bytes)
            .map_err(|error| error.to_string())?;
        if index > 0 {
            image_count += 1;
        }
    }
    archive.finish().map_err(|error| error.to_string())?;
    Ok(image_count)
}

fn downloads_dir() -> Result<PathBuf, String> {
    let download_dir = dirs::download_dir().ok_or_else(|| "无法找到下载文件夹".to_string())?;
    fs::create_dir_all(&download_dir).map_err(|error| error.to_string())?;
    Ok(download_dir)
}

fn unique_download_path(download_dir: &Path, file_name: &str) -> PathBuf {
    let candidate = download_dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("manuscript");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    for index in 1..10_000 {
        let candidate = download_dir.join(format!("{stem} ({index}){extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    download_dir.join(format!("{stem}-{}{}", now_ms(), extension))
}

fn sanitize_archive_path(value: &str, fallback: &str) -> String {
    let segments = value
        .replace('\\', "/")
        .split('/')
        .filter(|segment| !segment.trim().is_empty() && *segment != "." && *segment != "..")
        .map(safe_file_name)
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.is_empty() {
        fallback.to_string()
    } else {
        segments.join("/")
    }
}

fn unique_archive_entry_name(base_name: &str, used_names: &mut HashSet<String>) -> String {
    if used_names.insert(base_name.to_string()) {
        return base_name.to_string();
    }
    let path = Path::new(base_name);
    let parent = path
        .parent()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty());
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("file");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    for index in 2.. {
        let file_name = format!("{stem}-{index}{extension}");
        let candidate = parent
            .map(|value| format!("{value}/{file_name}"))
            .unwrap_or(file_name);
        if used_names.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!()
}

fn safe_file_stem(value: &str) -> String {
    let name = Path::new(value)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(value);
    let sanitized = safe_file_name(name);
    if sanitized.is_empty() {
        "manuscript".to_string()
    } else {
        sanitized
    }
}

fn safe_file_name(value: &str) -> String {
    let name = Path::new(value)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(value)
        .trim();
    let sanitized = name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>();
    let trimmed = sanitized.trim_matches('.').trim();
    if trimmed.is_empty() {
        "manuscript".to_string()
    } else {
        trimmed.to_string()
    }
}

fn ensure_extension(file_name: &str, extension: &str) -> String {
    if Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case(extension))
        .unwrap_or(false)
    {
        file_name.to_string()
    } else {
        format!(
            "{}.{extension}",
            Path::new(file_name)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(file_name)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{sanitize_archive_path, unique_archive_entry_name, unique_download_path};
    use std::collections::HashSet;
    use std::fs;

    #[test]
    fn archive_path_strips_traversal_segments() {
        assert_eq!(
            sanitize_archive_path("../images/../cover:1.png", "fallback.png"),
            "images/cover_1.png"
        );
    }

    #[test]
    fn archive_entry_names_are_unique_inside_directories() {
        let mut used = HashSet::new();
        assert_eq!(
            unique_archive_entry_name("assets/image.png", &mut used),
            "assets/image.png"
        );
        assert_eq!(
            unique_archive_entry_name("assets/image.png", &mut used),
            "assets/image-2.png"
        );
    }

    #[test]
    fn download_path_avoids_overwriting_existing_file() {
        let root = std::env::temp_dir().join(format!(
            "redbox-manuscript-download-test-{}",
            crate::now_ms()
        ));
        fs::create_dir_all(&root).expect("create temp root");
        fs::write(root.join("draft.zip"), b"old").expect("write existing");
        assert_eq!(
            unique_download_path(&root, "draft.zip"),
            root.join("draft (1).zip")
        );
        let _ = fs::remove_dir_all(root);
    }
}
