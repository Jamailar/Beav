use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::background_command;

const DEFAULT_MAX_PDF_PAGES: usize = 12;
const DEFAULT_RENDER_DPI: u32 = 144;

pub(super) fn render_pdf_pages(
    path: &Path,
    max_pages: usize,
    render_dpi: u32,
) -> Result<Vec<PathBuf>, String> {
    let pdftoppm =
        command_path("pdftoppm").ok_or_else(|| "pdftoppm is not available".to_string())?;
    let temp_dir = unique_temp_dir("redbox-visual-pdf");
    fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;
    let prefix = temp_dir.join("page");
    let page_limit = max_pages
        .clamp(1, 200)
        .max(DEFAULT_MAX_PDF_PAGES.min(max_pages.max(1)));
    let dpi = render_dpi
        .clamp(72, 300)
        .max(DEFAULT_RENDER_DPI.min(render_dpi.max(72)));
    let status = background_command(pdftoppm)
        .args([
            "-png",
            "-r",
            &dpi.to_string(),
            "-f",
            "1",
            "-l",
            &page_limit.to_string(),
            path.to_string_lossy().as_ref(),
            prefix.to_string_lossy().as_ref(),
        ])
        .status()
        .map_err(|error| error.to_string())?;
    if !status.success() {
        let _ = fs::remove_dir_all(&temp_dir);
        return Ok(Vec::new());
    }
    let mut files = fs::read_dir(&temp_dir)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|entry| entry.extension().and_then(|value| value.to_str()) == Some("png"))
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

pub(super) fn cleanup_rendered_pages(paths: &[PathBuf]) -> Result<(), String> {
    let Some(parent) = paths.first().and_then(|path| path.parent()) else {
        return Ok(());
    };
    fs::remove_dir_all(parent).map_err(|error| error.to_string())
}

fn unique_temp_dir(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(format!("{prefix}-{}", unique_suffix()))
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn command_path(name: &str) -> Option<PathBuf> {
    background_command("sh")
        .arg("-c")
        .arg(format!("command -v {name}"))
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            let path = String::from_utf8(output.stdout).ok()?;
            let trimmed = path.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(PathBuf::from(trimmed))
            }
        })
}
