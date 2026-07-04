use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use calamine::{open_workbook_auto, Data, Reader};

const OFFICE_PREVIEW_TIMEOUT_SECONDS: u64 = 45;

const PPTX_FALLBACK_WIDTH_PX: f64 = 960.0;
const DEFAULT_PPTX_WIDTH_EMU: f64 = 12_192_000.0;
const DEFAULT_PPTX_HEIGHT_EMU: f64 = 6_858_000.0;
const SPREADSHEET_PREVIEW_MAX_ROWS: usize = 240;
const SPREADSHEET_PREVIEW_MAX_COLUMNS: usize = 64;

pub(super) fn office_preview_file_for_path(path: &Path) -> Result<Option<PathBuf>, String> {
    if !is_convertible_office_path(path) {
        return Ok(None);
    }
    let source_meta = fs::metadata(path).map_err(|error| error.to_string())?;
    if !source_meta.is_file() {
        return Ok(None);
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if native_html_fallback_first(extension.as_str()) {
        if let Some(fallback) = fallback_preview_for_path(path, &source_meta)? {
            return Ok(Some(fallback));
        }
    }
    let cached_pdf = cached_preview_path(path, &source_meta, "pdf")?;
    if cached_pdf.is_file() {
        return Ok(Some(cached_pdf));
    }
    if let Some(pdf) = office_preview_pdf_for_path(path, &source_meta)? {
        return Ok(Some(pdf));
    }
    fallback_preview_for_path(path, &source_meta)
}

fn native_html_fallback_first(extension: &str) -> bool {
    matches!(
        extension,
        "pptx" | "pptm" | "xls" | "xlsx" | "xlsm" | "xlsb" | "ods"
    )
}

fn office_preview_pdf_for_path(
    path: &Path,
    source_meta: &fs::Metadata,
) -> Result<Option<PathBuf>, String> {
    let Some(converter) = find_soffice() else {
        return Ok(None);
    };

    let cache_path = cached_preview_path(path, source_meta, "pdf")?;
    if cache_path.is_file() {
        return Ok(Some(cache_path));
    }
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let work_dir = unique_temp_dir("redbox-office-preview");
    let output_dir = work_dir.join("out");
    let profile_dir = work_dir.join("profile");
    fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;
    fs::create_dir_all(&profile_dir).map_err(|error| error.to_string())?;

    let profile_uri = file_uri_for_directory(&profile_dir);
    let mut child = crate::background_command(converter)
        .arg("--headless")
        .arg("--nologo")
        .arg("--nofirststartwizard")
        .arg("--nolockcheck")
        .arg(format!("-env:UserInstallation={profile_uri}"))
        .arg("--convert-to")
        .arg("pdf")
        .arg("--outdir")
        .arg(&output_dir)
        .arg(path)
        .spawn()
        .map_err(|error| format!("启动 Office 预览转换失败: {error}"))?;

    let started_at = Instant::now();
    loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => {
                if !status.success() {
                    let _ = fs::remove_dir_all(&work_dir);
                    return Ok(None);
                }
                break;
            }
            None if started_at.elapsed() > Duration::from_secs(OFFICE_PREVIEW_TIMEOUT_SECONDS) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_dir_all(&work_dir);
                return Ok(None);
            }
            None => thread::sleep(Duration::from_millis(120)),
        }
    }

    let converted = converted_pdf_path(path, &output_dir).or_else(|| first_pdf_in_dir(&output_dir));
    let Some(converted) = converted else {
        let _ = fs::remove_dir_all(&work_dir);
        return Ok(None);
    };
    fs::rename(&converted, &cache_path)
        .or_else(|_| fs::copy(&converted, &cache_path).map(|_| ()))
        .map_err(|error| error.to_string())?;
    let _ = fs::remove_dir_all(&work_dir);
    Ok(Some(cache_path))
}

fn fallback_preview_for_path(
    path: &Path,
    source_meta: &fs::Metadata,
) -> Result<Option<PathBuf>, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "pptx" | "pptm" => pptx_preview_html_for_path(path, source_meta),
        "xls" | "xlsx" | "xlsm" | "xlsb" | "ods" => {
            spreadsheet_preview_html_for_path(path, source_meta)
        }
        _ => Ok(None),
    }
}

fn is_convertible_office_path(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase());
    matches!(
        extension.as_deref(),
        Some(
            "doc"
                | "docx"
                | "docm"
                | "odt"
                | "ppt"
                | "pptx"
                | "pptm"
                | "odp"
                | "xls"
                | "xlsx"
                | "xlsm"
                | "xlsb"
                | "ods"
        )
    )
}

fn find_soffice() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("REDBOX_SOFFICE_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Some(path);
    }
    command_path("soffice")
        .or_else(|| command_path("libreoffice"))
        .or_else(|| {
            let mac_path = PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice");
            mac_path.is_file().then_some(mac_path)
        })
}

fn command_path(name: &str) -> Option<PathBuf> {
    crate::background_command("sh")
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

fn cached_preview_path(
    path: &Path,
    source_meta: &fs::Metadata,
    extension: &str,
) -> Result<PathBuf, String> {
    let modified_ms = source_meta
        .modified()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    source_meta.len().hash(&mut hasher);
    modified_ms.hash(&mut hasher);
    let hash = hasher.finish();
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(safe_cache_stem)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "office-preview".to_string());
    Ok(std::env::temp_dir()
        .join("redbox-office-preview-cache")
        .join(format!("{stem}-{hash:016x}.{extension}")))
}

fn converted_pdf_path(source: &Path, output_dir: &Path) -> Option<PathBuf> {
    let stem = source.file_stem()?.to_str()?;
    let candidate = output_dir.join(format!("{stem}.pdf"));
    candidate.is_file().then_some(candidate)
}

fn first_pdf_in_dir(output_dir: &Path) -> Option<PathBuf> {
    fs::read_dir(output_dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
        })
}

fn safe_cache_stem(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(80)
        .collect()
}

fn file_uri_for_directory(path: &Path) -> String {
    url::Url::from_directory_path(path)
        .map(|url| url.to_string())
        .unwrap_or_else(|_| {
            let normalized = path.to_string_lossy().replace('\\', "/");
            let encoded = normalized
                .split('/')
                .map(urlencoding::encode)
                .collect::<Vec<_>>()
                .join("/");
            format!("file://{encoded}/")
        })
}

#[derive(Debug, Clone)]
struct PptxShapePreview {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    text: String,
    image_data_url: Option<String>,
    fill: Option<String>,
    font_size: Option<f64>,
}

#[derive(Debug, Clone)]
struct PptxSlidePreview {
    shapes: Vec<PptxShapePreview>,
}

#[derive(Debug, Clone)]
struct SpreadsheetSheetPreview {
    name: String,
    columns: usize,
    rows: Vec<Vec<String>>,
    omitted_rows: usize,
    omitted_columns: usize,
}

fn spreadsheet_preview_html_for_path(
    path: &Path,
    source_meta: &fs::Metadata,
) -> Result<Option<PathBuf>, String> {
    let cache_path = cached_preview_path(path, source_meta, "html")?;
    if cache_path.is_file() {
        return Ok(Some(cache_path));
    }

    let mut workbook = match open_workbook_auto(path) {
        Ok(workbook) => workbook,
        Err(_) => return Ok(None),
    };
    let mut sheets = Vec::<SpreadsheetSheetPreview>::new();
    for sheet_name in workbook.sheet_names().to_vec() {
        let range = match workbook.worksheet_range(&sheet_name) {
            Ok(range) => range,
            Err(_) => continue,
        };
        if range.is_empty() {
            continue;
        }
        if let Some(sheet) = spreadsheet_sheet_preview(&sheet_name, &range) {
            sheets.push(sheet);
        }
    }
    if sheets.is_empty() {
        return Ok(None);
    }

    let title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Spreadsheet Preview");
    let html = render_spreadsheet_preview_html(title, &sheets);
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&cache_path, html).map_err(|error| error.to_string())?;
    Ok(Some(cache_path))
}

fn spreadsheet_sheet_preview(
    name: &str,
    range: &calamine::Range<Data>,
) -> Option<SpreadsheetSheetPreview> {
    let row_values = range
        .rows()
        .map(|row| {
            row.iter()
                .map(spreadsheet_data_to_string)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let mut first_row = None::<usize>;
    let mut last_row = 0usize;
    let mut last_column = 0usize;
    for (row_index, row) in row_values.iter().enumerate() {
        for (column_index, cell) in row.iter().enumerate() {
            if cell.trim().is_empty() {
                continue;
            }
            first_row.get_or_insert(row_index);
            last_row = row_index;
            last_column = last_column.max(column_index);
        }
    }
    let first_row = first_row?;
    let used_rows = last_row.saturating_sub(first_row) + 1;
    let used_columns = last_column + 1;
    let visible_rows = used_rows.min(SPREADSHEET_PREVIEW_MAX_ROWS);
    let visible_columns = used_columns.min(SPREADSHEET_PREVIEW_MAX_COLUMNS);
    let rows = row_values
        .iter()
        .skip(first_row)
        .take(visible_rows)
        .map(|row| {
            (0..visible_columns)
                .map(|column| row.get(column).cloned().unwrap_or_default())
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    Some(SpreadsheetSheetPreview {
        name: name.to_string(),
        columns: visible_columns,
        rows,
        omitted_rows: used_rows.saturating_sub(visible_rows),
        omitted_columns: used_columns.saturating_sub(visible_columns),
    })
}

fn render_spreadsheet_preview_html(title: &str, sheets: &[SpreadsheetSheetPreview]) -> String {
    let mut body = String::new();
    body.push_str("<main class=\"workbook\">");
    body.push_str(&format!("<h1>{}</h1>", escape_html_text(title)));
    for sheet in sheets {
        body.push_str("<section class=\"sheet\">");
        body.push_str(&format!(
            "<div class=\"sheet-title\"><h2>{}</h2><span>{} 行</span></div>",
            escape_html_text(&sheet.name),
            sheet.rows.len()
        ));
        body.push_str("<div class=\"table-wrap\"><table><thead><tr>");
        for column in 0..sheet.columns {
            body.push_str(&format!("<th>{}</th>", spreadsheet_column_label(column)));
        }
        body.push_str("</tr></thead><tbody>");
        for row in &sheet.rows {
            body.push_str("<tr>");
            for cell in row {
                body.push_str(&format!(
                    "<td>{}</td>",
                    escape_html_text(cell).replace('\n', "<br />")
                ));
            }
            body.push_str("</tr>");
        }
        body.push_str("</tbody></table></div>");
        if sheet.omitted_rows > 0 || sheet.omitted_columns > 0 {
            body.push_str(&format!(
                "<p class=\"note\">已截断 {} 行、{} 列</p>",
                sheet.omitted_rows, sheet.omitted_columns
            ));
        }
        body.push_str("</section>");
    }
    body.push_str("</main>");
    format!(
        r#"<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>{}</title>
<style>
html,body{{margin:0;min-height:100%;background:#f3efe7;color:#2f2724;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}}
body{{box-sizing:border-box;padding:28px;}}
.workbook{{max-width:1280px;margin:0 auto;}}
h1{{margin:0 0 18px;font-size:24px;line-height:1.25;font-weight:750;}}
.sheet{{margin:0 0 28px;}}
.sheet-title{{display:flex;align-items:baseline;gap:10px;margin:0 0 10px;}}
.sheet-title h2{{margin:0;font-size:16px;line-height:1.3;font-weight:700;}}
.sheet-title span,.note{{color:#8f837a;font-size:12px;}}
.table-wrap{{max-height:72vh;overflow:auto;border:1px solid #ded2c2;background:#fff;}}
table{{border-collapse:collapse;min-width:100%;font-size:13px;line-height:1.35;}}
th,td{{border:1px solid #e7ded3;padding:7px 9px;vertical-align:top;white-space:pre-wrap;min-width:72px;max-width:360px;overflow-wrap:anywhere;}}
th{{position:sticky;top:0;z-index:1;background:#f8f3eb;color:#74685f;font-weight:650;text-align:left;}}
tr:nth-child(even) td{{background:#fcfaf6;}}
.note{{margin:8px 0 0;}}
</style>
</head>
<body>{body}</body>
</html>"#,
        escape_html_text(title),
        body = body
    )
}

fn pptx_preview_html_for_path(
    path: &Path,
    source_meta: &fs::Metadata,
) -> Result<Option<PathBuf>, String> {
    let cache_path = cached_preview_path(path, source_meta, "html")?;
    if cache_path.is_file() {
        return Ok(Some(cache_path));
    }

    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    let (slide_width_emu, slide_height_emu) =
        pptx_slide_size(&mut archive).unwrap_or((DEFAULT_PPTX_WIDTH_EMU, DEFAULT_PPTX_HEIGHT_EMU));
    let mut slide_names = archive
        .file_names()
        .filter(|name| name.starts_with("ppt/slides/slide") && name.ends_with(".xml"))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    slide_names.sort_by_key(|name| pptx_slide_number(name).unwrap_or(usize::MAX));
    if slide_names.is_empty() {
        return Ok(None);
    }

    let mut slides = Vec::<PptxSlidePreview>::new();
    for slide_name in slide_names {
        let rels = pptx_slide_relationships(&mut archive, &slide_name);
        let mut xml = String::new();
        let Ok(mut entry) = archive.by_name(&slide_name) else {
            continue;
        };
        entry
            .read_to_string(&mut xml)
            .map_err(|error| error.to_string())?;
        drop(entry);
        slides.push(PptxSlidePreview {
            shapes: pptx_shapes_from_slide_xml(
                &mut archive,
                &xml,
                &slide_name,
                &rels,
                slide_width_emu,
                slide_height_emu,
            ),
        });
    }

    let title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("PPTX Preview");
    let html = render_pptx_preview_html(title, slide_width_emu, slide_height_emu, &slides);
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&cache_path, html).map_err(|error| error.to_string())?;
    Ok(Some(cache_path))
}

fn pptx_slide_number(name: &str) -> Option<usize> {
    let file_name = name.rsplit('/').next()?;
    file_name
        .strip_prefix("slide")?
        .strip_suffix(".xml")?
        .parse::<usize>()
        .ok()
}

fn pptx_slide_size(archive: &mut zip::ZipArchive<fs::File>) -> Option<(f64, f64)> {
    let mut xml = String::new();
    archive
        .by_name("ppt/presentation.xml")
        .ok()?
        .read_to_string(&mut xml)
        .ok()?;
    let attrs = first_tag_attrs(&xml, "p:sldSz").or_else(|| first_tag_attrs(&xml, "sldSz"))?;
    let width = attr_value(&attrs, "cx")?.parse::<f64>().ok()?;
    let height = attr_value(&attrs, "cy")?.parse::<f64>().ok()?;
    if width > 0.0 && height > 0.0 {
        Some((width, height))
    } else {
        None
    }
}

fn pptx_slide_relationships(
    archive: &mut zip::ZipArchive<fs::File>,
    slide_name: &str,
) -> Vec<(String, String)> {
    let slide_file = slide_name.rsplit('/').next().unwrap_or(slide_name);
    let rels_name = format!("ppt/slides/_rels/{slide_file}.rels");
    let mut xml = String::new();
    let Ok(mut entry) = archive.by_name(&rels_name) else {
        return Vec::new();
    };
    if entry.read_to_string(&mut xml).is_err() {
        return Vec::new();
    }
    tag_blocks(&xml, "Relationship")
        .into_iter()
        .filter_map(|block| {
            let attrs = tag_attrs_from_block(block)?;
            let id = attr_value(&attrs, "Id")?.to_string();
            let target = attr_value(&attrs, "Target")?.to_string();
            Some((id, target))
        })
        .collect()
}

fn pptx_shapes_from_slide_xml(
    archive: &mut zip::ZipArchive<fs::File>,
    xml: &str,
    slide_name: &str,
    relationships: &[(String, String)],
    slide_width_emu: f64,
    slide_height_emu: f64,
) -> Vec<PptxShapePreview> {
    let mut shapes = Vec::<PptxShapePreview>::new();
    for block in tag_blocks(xml, "p:sp") {
        let text = pptx_text_from_block(block);
        if text.trim().is_empty() {
            continue;
        }
        let (x, y, width, height) =
            pptx_bounds_from_block(block, slide_width_emu, slide_height_emu);
        shapes.push(PptxShapePreview {
            x,
            y,
            width,
            height,
            text,
            image_data_url: None,
            fill: pptx_fill_from_block(block),
            font_size: pptx_font_size_from_block(block),
        });
    }
    for block in tag_blocks(xml, "p:pic") {
        let embed_id =
            attr_value_in_block(block, "r:embed").or_else(|| attr_value_in_block(block, "embed"));
        let Some(embed_id) = embed_id else {
            continue;
        };
        let image_data_url =
            pptx_relationship_image_data_url(archive, slide_name, relationships, &embed_id);
        if image_data_url.is_none() {
            continue;
        }
        let (x, y, width, height) =
            pptx_bounds_from_block(block, slide_width_emu, slide_height_emu);
        shapes.push(PptxShapePreview {
            x,
            y,
            width,
            height,
            text: String::new(),
            image_data_url,
            fill: None,
            font_size: None,
        });
    }
    shapes
}

fn pptx_relationship_image_data_url(
    archive: &mut zip::ZipArchive<fs::File>,
    slide_name: &str,
    relationships: &[(String, String)],
    relationship_id: &str,
) -> Option<String> {
    let target = relationships
        .iter()
        .find_map(|(id, target)| (id == relationship_id).then_some(target.as_str()))?;
    let slide_dir = slide_name
        .rsplit_once('/')
        .map(|(dir, _)| dir)
        .unwrap_or("ppt/slides");
    let path = normalize_zip_path(&format!("{slide_dir}/{target}"));
    let mut bytes = Vec::<u8>::new();
    archive.by_name(&path).ok()?.read_to_end(&mut bytes).ok()?;
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let mime = match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "image/png",
    };
    Some(format!(
        "data:{mime};base64,{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)
    ))
}

fn normalize_zip_path(value: &str) -> String {
    let mut parts = Vec::<&str>::new();
    for part in value.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

fn pptx_bounds_from_block(
    block: &str,
    slide_width_emu: f64,
    slide_height_emu: f64,
) -> (f64, f64, f64, f64) {
    let off = first_tag_attrs(block, "a:off").or_else(|| first_tag_attrs(block, "off"));
    let ext = first_tag_attrs(block, "a:ext").or_else(|| first_tag_attrs(block, "ext"));
    let x = off
        .as_deref()
        .and_then(|attrs| attr_value(attrs, "x"))
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    let y = off
        .as_deref()
        .and_then(|attrs| attr_value(attrs, "y"))
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    let width = ext
        .as_deref()
        .and_then(|attrs| attr_value(attrs, "cx"))
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(slide_width_emu);
    let height = ext
        .as_deref()
        .and_then(|attrs| attr_value(attrs, "cy"))
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(slide_height_emu);
    (
        (x / slide_width_emu).clamp(0.0, 1.0),
        (y / slide_height_emu).clamp(0.0, 1.0),
        (width / slide_width_emu).clamp(0.02, 1.0),
        (height / slide_height_emu).clamp(0.02, 1.0),
    )
}

fn pptx_text_from_block(block: &str) -> String {
    tag_blocks(block, "a:p")
        .into_iter()
        .map(|paragraph| {
            tag_text_values(paragraph, "a:t")
                .into_iter()
                .chain(tag_text_values(paragraph, "t"))
                .collect::<Vec<_>>()
                .join("")
        })
        .filter(|paragraph| !paragraph.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn pptx_fill_from_block(block: &str) -> Option<String> {
    let color = attr_value_in_block(block, "val")?;
    if color.len() == 6 && color.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Some(format!("#{color}"))
    } else {
        None
    }
}

fn pptx_font_size_from_block(block: &str) -> Option<f64> {
    let size = attr_value_in_block(block, "sz")?.parse::<f64>().ok()?;
    (size > 0.0).then_some(size / 100.0)
}

fn render_pptx_preview_html(
    title: &str,
    slide_width_emu: f64,
    slide_height_emu: f64,
    slides: &[PptxSlidePreview],
) -> String {
    let aspect = if slide_width_emu > 0.0 {
        slide_height_emu / slide_width_emu
    } else {
        DEFAULT_PPTX_HEIGHT_EMU / DEFAULT_PPTX_WIDTH_EMU
    };
    let slide_height_px = (PPTX_FALLBACK_WIDTH_PX * aspect).round();
    let mut body = String::new();
    for (index, slide) in slides.iter().enumerate() {
        body.push_str(&format!(
            "<section class=\"slide\" aria-label=\"Slide {}\">",
            index + 1
        ));
        if slide.shapes.is_empty() {
            body.push_str("<div class=\"empty\">空白幻灯片</div>");
        }
        for shape in &slide.shapes {
            let left = shape.x * 100.0;
            let top = shape.y * 100.0;
            let width = shape.width * 100.0;
            let height = shape.height * 100.0;
            if let Some(data_url) = shape.image_data_url.as_ref() {
                body.push_str(&format!(
                    "<img class=\"pic\" src=\"{}\" style=\"left:{left:.4}%;top:{top:.4}%;width:{width:.4}%;height:{height:.4}%;\" />",
                    escape_html_attr(data_url)
                ));
                continue;
            }
            let mut style =
                format!("left:{left:.4}%;top:{top:.4}%;width:{width:.4}%;height:{height:.4}%;");
            if let Some(fill) = shape.fill.as_ref() {
                style.push_str(&format!("background:{};", escape_html_attr(fill)));
            }
            if let Some(font_size) = shape.font_size {
                style.push_str(&format!("font-size:{font_size:.2}pt;"));
            }
            body.push_str(&format!(
                "<div class=\"shape\" style=\"{}\">{}</div>",
                style,
                escape_html_text(&shape.text).replace('\n', "<br />")
            ));
        }
        body.push_str("</section>");
    }
    format!(
        r#"<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>{}</title>
<style>
html,body{{margin:0;min-height:100%;background:#f3efe7;color:#2f2724;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}}
body{{box-sizing:border-box;padding:28px 0 44px;}}
.slide{{position:relative;width:min(92vw,{width}px);height:calc(min(92vw,{width}px) * {aspect});max-height:{height}px;margin:0 auto 26px;background:white;box-shadow:0 18px 48px rgba(48,38,30,.16);overflow:hidden;}}
.shape{{position:absolute;box-sizing:border-box;display:flex;align-items:center;white-space:pre-wrap;overflow:hidden;padding:6px 8px;color:#26211f;font-size:18pt;line-height:1.18;}}
.pic{{position:absolute;object-fit:contain;}}
.empty{{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9d9288;font-size:14px;}}
</style>
</head>
<body>{body}</body>
</html>"#,
        escape_html_text(title),
        width = PPTX_FALLBACK_WIDTH_PX,
        height = slide_height_px,
        aspect = aspect,
        body = body
    )
}

fn tag_blocks<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let mut blocks = Vec::new();
    let mut cursor = 0;
    let open_prefix = format!("<{tag}");
    let close = format!("</{tag}>");
    while let Some(open_rel) = xml[cursor..].find(&open_prefix) {
        let open = cursor + open_rel;
        let Some(after_open_rel) = xml[open..].find('>') else {
            break;
        };
        let after_open = open + after_open_rel + 1;
        if xml[open..after_open].trim_end().ends_with("/>") {
            blocks.push(&xml[open..after_open]);
            cursor = after_open;
            continue;
        }
        let Some(close_rel) = xml[after_open..].find(&close) else {
            break;
        };
        let end = after_open + close_rel + close.len();
        blocks.push(&xml[open..end]);
        cursor = end;
    }
    blocks
}

fn tag_text_values(xml: &str, tag: &str) -> Vec<String> {
    tag_blocks(xml, tag)
        .into_iter()
        .filter_map(|block| {
            let start = block.find('>')? + 1;
            let end = block.rfind("</")?;
            Some(decode_xml_text(&block[start..end]))
        })
        .collect()
}

fn first_tag_attrs(xml: &str, tag: &str) -> Option<String> {
    let start = xml.find(&format!("<{tag}"))?;
    let end = xml[start..].find('>')? + start;
    tag_attrs_from_block(&xml[start..=end])
}

fn tag_attrs_from_block(block: &str) -> Option<String> {
    let start = block.find('<')? + 1;
    let end = block[start..].find('>').map(|value| start + value)?;
    let mut attrs = block[start..end].trim().to_string();
    if attrs.ends_with('/') {
        attrs.pop();
    }
    attrs
        .split_once(char::is_whitespace)
        .map(|(_, value)| value.trim().to_string())
        .or_else(|| Some(String::new()))
}

fn attr_value_in_block(block: &str, attr: &str) -> Option<String> {
    let pattern = format!("{attr}=\"");
    let start = block.find(&pattern)? + pattern.len();
    let end = block[start..].find('"')? + start;
    Some(block[start..end].to_string())
}

fn attr_value<'a>(attrs: &'a str, attr: &str) -> Option<&'a str> {
    let pattern = format!("{attr}=\"");
    let start = attrs.find(&pattern)? + pattern.len();
    let end = attrs[start..].find('"')? + start;
    Some(&attrs[start..end])
}

fn decode_xml_text(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn escape_html_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_html_attr(value: &str) -> String {
    escape_html_text(value).replace('"', "&quot;")
}

fn spreadsheet_data_to_string(value: &Data) -> String {
    match value {
        Data::Empty => String::new(),
        Data::String(text) => text.clone(),
        Data::Float(number) => number.to_string(),
        Data::Int(number) => number.to_string(),
        Data::Bool(flag) => flag.to_string(),
        Data::DateTime(value) => value.to_string(),
        Data::DateTimeIso(text) => text.clone(),
        Data::DurationIso(text) => text.clone(),
        Data::Error(error) => format!("{error:?}"),
    }
}

fn spreadsheet_column_label(mut index: usize) -> String {
    let mut label = String::new();
    loop {
        let remainder = index % 26;
        label.insert(0, (b'A' + remainder as u8) as char);
        if index < 26 {
            break;
        }
        index = (index / 26).saturating_sub(1);
    }
    label
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

#[cfg(test)]
mod tests {
    use super::{
        is_convertible_office_path, pptx_preview_html_for_path, safe_cache_stem,
        spreadsheet_column_label, spreadsheet_preview_html_for_path,
    };
    use std::fs;
    use std::io::Write;
    use std::path::Path;

    #[test]
    fn convertible_office_path_covers_expected_formats() {
        assert!(is_convertible_office_path(Path::new("deck.pptx")));
        assert!(is_convertible_office_path(Path::new("report.docx")));
        assert!(is_convertible_office_path(Path::new("sheet.xlsx")));
        assert!(!is_convertible_office_path(Path::new("notes.md")));
    }

    #[test]
    fn cache_stem_is_filesystem_friendly() {
        assert_eq!(safe_cache_stem("Vibecoding 商业化分享"), "Vibecoding");
        assert_eq!(safe_cache_stem("deck_v1-final"), "deck_v1-final");
    }

    #[test]
    fn spreadsheet_column_labels_continue_after_z() {
        assert_eq!(spreadsheet_column_label(0), "A");
        assert_eq!(spreadsheet_column_label(25), "Z");
        assert_eq!(spreadsheet_column_label(26), "AA");
        assert_eq!(spreadsheet_column_label(27), "AB");
    }

    #[test]
    fn pptx_fallback_preview_generates_html() {
        let root = std::env::temp_dir().join(format!(
            "redbox-pptx-preview-test-{}",
            super::unique_suffix()
        ));
        fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("deck.pptx");
        let file = fs::File::create(&path).expect("create pptx");
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::default();
        zip.start_file("[Content_Types].xml", options).unwrap();
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>"#).unwrap();
        zip.start_file("ppt/presentation.xml", options).unwrap();
        zip.write_all(br#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>"#).unwrap();
        zip.start_file("ppt/slides/slide1.xml", options).unwrap();
        zip.write_all(br#"<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="6096000" cy="914400"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr sz="2800"/><a:t>Hello Slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#).unwrap();
        zip.finish().unwrap();

        let meta = fs::metadata(&path).expect("pptx metadata");
        let preview = pptx_preview_html_for_path(&path, &meta)
            .expect("preview result")
            .expect("preview path");
        let html = fs::read_to_string(preview).expect("read preview html");
        assert!(html.contains("Hello Slide"));
        assert!(html.contains("class=\"slide\""));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn xlsx_fallback_preview_generates_html() {
        let root = std::env::temp_dir().join(format!(
            "redbox-xlsx-preview-test-{}",
            super::unique_suffix()
        ));
        fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("sheet.xlsx");
        let file = fs::File::create(&path).expect("create xlsx");
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::default();
        zip.start_file("[Content_Types].xml", options).unwrap();
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#).unwrap();
        zip.start_file("_rels/.rels", options).unwrap();
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#).unwrap();
        zip.start_file("xl/workbook.xml", options).unwrap();
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#).unwrap();
        zip.start_file("xl/_rels/workbook.xml.rels", options)
            .unwrap();
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#).unwrap();
        zip.start_file("xl/worksheets/sheet1.xml", options).unwrap();
        zip.write_all(r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>月份</t></is></c><c r="B1" t="inlineStr"><is><t>金额</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>26年5月</t></is></c><c r="B2"><v>128</v></c></row></sheetData></worksheet>"#.as_bytes()).unwrap();
        zip.finish().unwrap();

        let meta = fs::metadata(&path).expect("xlsx metadata");
        let preview = spreadsheet_preview_html_for_path(&path, &meta)
            .expect("preview result")
            .expect("preview path");
        let html = fs::read_to_string(preview).expect("read preview html");
        assert!(html.contains("26年5月"));
        assert!(html.contains("<table>"));
        let _ = fs::remove_dir_all(root);
    }
}
