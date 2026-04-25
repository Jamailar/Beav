use base64::Engine;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use super::{detect_language, ParsedSection};

const MAX_OCR_PAGES: usize = 12;
const OCR_SWIFT_SCRIPT: &str = r#"
import Foundation
import Vision

struct OcrPage: Codable {
    let path: String
    let text: String
    let confidence: Double?
}

let paths = Array(CommandLine.arguments.dropFirst())
var pages: [OcrPage] = []

for path in paths {
    let url = URL(fileURLWithPath: path)
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    if #available(macOS 13.0, *) {
        request.automaticallyDetectsLanguage = true
    }
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    let handler = VNImageRequestHandler(url: url, options: [:])
    try handler.perform([request])
    let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
    let candidates = observations.compactMap { $0.topCandidates(1).first }
    let text = candidates.map { $0.string }.joined(separator: "\n")
    let confidence = candidates.isEmpty
        ? nil
        : candidates.map { Double($0.confidence) }.reduce(0.0, +) / Double(candidates.count)
    pages.append(OcrPage(path: path, text: text, confidence: confidence))
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
let data = try encoder.encode(pages)
FileHandle.standardOutput.write(data)
"#;

#[derive(Debug, Deserialize)]
struct SwiftOcrPage {
    text: String,
    confidence: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OcrProvider {
    Auto,
    Api,
    Local,
    Disabled,
}

#[derive(Debug, Clone)]
pub(crate) struct OcrProviderConfig {
    pub provider: OcrProvider,
    pub endpoint: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub timeout_seconds: u64,
    pub local_fallback: bool,
}

impl Default for OcrProviderConfig {
    fn default() -> Self {
        Self {
            provider: OcrProvider::Auto,
            endpoint: None,
            api_key: None,
            model: None,
            timeout_seconds: 60,
            local_fallback: true,
        }
    }
}

pub(crate) fn ocr_image_to_sections(
    path: &Path,
    config: &OcrProviderConfig,
) -> Result<Option<Vec<ParsedSection>>, String> {
    let pages = run_configured_ocr(&[path.to_path_buf()], "image", config)?;
    Ok(map_ocr_pages_to_sections(&pages, "ocr-image", "image-ocr"))
}

pub(crate) fn ocr_pdf_to_sections(
    path: &Path,
    config: &OcrProviderConfig,
) -> Result<Option<Vec<ParsedSection>>, String> {
    let rendered = render_pdf_pages(path)?;
    if rendered.is_empty() {
        return Ok(None);
    }
    let pages = match run_configured_ocr(&rendered, "pdf", config) {
        Ok(pages) => pages,
        Err(error) => {
            let _ = cleanup_temp_artifacts(&rendered);
            return Err(error);
        }
    };
    let sections = map_ocr_pages_to_sections(&pages, "ocr-page", "pdf-ocr");
    let _ = cleanup_temp_artifacts(&rendered);
    Ok(sections)
}

fn run_configured_ocr(
    paths: &[PathBuf],
    source_type: &str,
    config: &OcrProviderConfig,
) -> Result<Vec<SwiftOcrPage>, String> {
    match config.provider {
        OcrProvider::Disabled => Ok(Vec::new()),
        OcrProvider::Local => run_apple_vision_ocr(paths),
        OcrProvider::Api => run_api_ocr(paths, source_type, config).or_else(|error| {
            if config.local_fallback {
                return run_apple_vision_ocr(paths);
            }
            Err(error)
        }),
        OcrProvider::Auto => {
            if config
                .endpoint
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                return run_api_ocr(paths, source_type, config).or_else(|error| {
                    if config.local_fallback {
                        return run_apple_vision_ocr(paths);
                    }
                    Err(error)
                });
            }
            run_apple_vision_ocr(paths)
        }
    }
}

fn run_api_ocr(
    paths: &[PathBuf],
    source_type: &str,
    config: &OcrProviderConfig,
) -> Result<Vec<SwiftOcrPage>, String> {
    let endpoint = config
        .endpoint
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "ocr api endpoint is not configured".to_string())?;
    let images = paths
        .iter()
        .map(|path| {
            let bytes = fs::read(path).map_err(|error| error.to_string())?;
            Ok(json!({
                "fileName": path.file_name().and_then(|value| value.to_str()).unwrap_or("page"),
                "mimeType": mime_type_for_path(path),
                "dataBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let body = json!({
        "model": config.model.clone(),
        "sourceType": source_type,
        "images": images,
    });
    let response = crate::run_curl_json_with_timeout(
        "POST",
        endpoint,
        config.api_key.as_deref(),
        &[],
        Some(body),
        Some(config.timeout_seconds),
    )?;
    parse_api_ocr_response(&response)
}

fn parse_api_ocr_response(value: &Value) -> Result<Vec<SwiftOcrPage>, String> {
    if let Some(pages) = parse_api_ocr_pages(value) {
        return Ok(pages);
    }
    if let Some(text) = extract_response_text(value).filter(|text| !text.trim().is_empty()) {
        return Ok(vec![SwiftOcrPage {
            text,
            confidence: extract_confidence(value),
        }]);
    }
    Err("ocr api response does not contain text".to_string())
}

fn parse_api_ocr_pages(value: &Value) -> Option<Vec<SwiftOcrPage>> {
    ["pages", "results", "data", "items"]
        .into_iter()
        .filter_map(|key| value.get(key).and_then(Value::as_array))
        .find_map(|items| {
            let pages = items
                .iter()
                .filter_map(|item| {
                    extract_response_text(item)
                        .filter(|text| !text.trim().is_empty())
                        .map(|text| SwiftOcrPage {
                            text,
                            confidence: extract_confidence(item),
                        })
                })
                .collect::<Vec<_>>();
            if pages.is_empty() {
                None
            } else {
                Some(pages)
            }
        })
}

fn extract_response_text(value: &Value) -> Option<String> {
    ["text", "output_text", "markdown", "content", "result"]
        .into_iter()
        .find_map(|key| {
            value
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(ToString::to_string)
        })
        .or_else(|| {
            value
                .get("choices")
                .and_then(Value::as_array)
                .and_then(|choices| {
                    choices.first().and_then(|choice| {
                        choice
                            .get("message")
                            .and_then(|message| message.get("content"))
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|text| !text.is_empty())
                            .map(ToString::to_string)
                    })
                })
        })
        .or_else(|| {
            value
                .get("output")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items.iter().find_map(|item| {
                        item.get("content")
                            .and_then(Value::as_array)
                            .and_then(|content| {
                                content.iter().find_map(|part| {
                                    ["text", "output_text"].into_iter().find_map(|key| {
                                        part.get(key)
                                            .and_then(Value::as_str)
                                            .map(str::trim)
                                            .filter(|text| !text.is_empty())
                                            .map(ToString::to_string)
                                    })
                                })
                            })
                    })
                })
        })
}

fn extract_confidence(value: &Value) -> Option<f64> {
    ["confidence", "score", "ocrConfidence"]
        .into_iter()
        .find_map(|key| value.get(key).and_then(Value::as_f64))
}

fn mime_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("tif") | Some("tiff") => "image/tiff",
        Some("heic") => "image/heic",
        Some("bmp") => "image/bmp",
        _ => "image/png",
    }
}

fn run_apple_vision_ocr(paths: &[PathBuf]) -> Result<Vec<SwiftOcrPage>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    if !apple_vision_ocr_is_allowed() {
        return Err(
            "local OCR is disabled; configure an OCR API endpoint or run Apple Vision on macOS"
                .to_string(),
        );
    }
    let swift = command_path("swift").ok_or_else(|| "swift is not available".to_string())?;
    let script_path = write_temp_swift_script()?;
    let output = Command::new(swift)
        .arg(script_path.as_os_str())
        .args(paths.iter().map(|path| path.as_os_str()))
        .output()
        .map_err(|error| error.to_string())?;
    let _ = fs::remove_file(&script_path);
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice::<Vec<SwiftOcrPage>>(&output.stdout).map_err(|error| error.to_string())
}

fn apple_vision_ocr_is_allowed() -> bool {
    cfg!(target_os = "macos")
}

fn map_ocr_pages_to_sections(
    pages: &[SwiftOcrPage],
    block_type: &str,
    strategy: &str,
) -> Option<Vec<ParsedSection>> {
    let sections = pages
        .iter()
        .enumerate()
        .filter_map(|(index, page)| {
            let text = page.text.trim();
            if text.is_empty() {
                return None;
            }
            Some(ParsedSection {
                strategy: strategy.to_string(),
                block_type: block_type.to_string(),
                section_path: vec!["page".to_string(), format!("{}", index + 1)],
                page: Some((index + 1) as i64),
                text: text.to_string(),
                language: detect_language(text),
                content_origin: "ocr".to_string(),
                ocr_confidence: page.confidence,
                fallback_used: true,
                attachment_path: None,
            })
        })
        .collect::<Vec<_>>();
    if sections.is_empty() {
        None
    } else {
        Some(sections)
    }
}

fn render_pdf_pages(path: &Path) -> Result<Vec<PathBuf>, String> {
    let pdftoppm =
        command_path("pdftoppm").ok_or_else(|| "pdftoppm is not available".to_string())?;
    let temp_dir = unique_temp_dir("redbox-ocr-pdf");
    fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;
    let prefix = temp_dir.join("page");
    let status = Command::new(pdftoppm)
        .args([
            "-png",
            "-f",
            "1",
            "-l",
            &MAX_OCR_PAGES.to_string(),
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

fn write_temp_swift_script() -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!("redbox-ocr-{}.swift", unique_suffix()));
    fs::write(&path, OCR_SWIFT_SCRIPT).map_err(|error| error.to_string())?;
    Ok(path)
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

fn cleanup_temp_artifacts(paths: &[PathBuf]) -> Result<(), String> {
    let Some(parent) = paths.first().and_then(|path| path.parent()) else {
        return Ok(());
    };
    fs::remove_dir_all(parent).map_err(|error| error.to_string())
}

fn command_path(name: &str) -> Option<PathBuf> {
    Command::new("sh")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_ocr_pages_to_sections_with_confidence() {
        let pages = vec![SwiftOcrPage {
            text: "Scanned clause".to_string(),
            confidence: Some(0.71),
        }];
        let sections = map_ocr_pages_to_sections(&pages, "ocr-page", "pdf-ocr").unwrap();
        assert_eq!(sections[0].content_origin, "ocr");
        assert_eq!(sections[0].ocr_confidence, Some(0.71));
        assert_eq!(sections[0].page, Some(1));
    }

    #[test]
    fn parses_image_only_pdf_via_ocr_when_tools_are_available() {
        if !apple_vision_ocr_is_allowed()
            || command_path("swift").is_none()
            || command_path("pdftoppm").is_none()
        {
            return;
        }

        let unique = format!("redbox-ocr-pdf-test-{}", unique_suffix());
        let root = std::env::temp_dir().join(unique);
        fs::create_dir_all(&root).unwrap();
        let png_path = root.join("scan.png");
        let pdf_path = root.join("scan.pdf");
        write_test_png(&png_path, "Scanned Clause 123");
        write_image_pdf(&png_path, &pdf_path);

        let sections = ocr_pdf_to_sections(&pdf_path, &OcrProviderConfig::default())
            .unwrap()
            .unwrap();
        let text = sections
            .iter()
            .map(|section| section.text.clone())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.to_lowercase().contains("scanned") || text.to_lowercase().contains("clause"));
        assert_eq!(sections[0].content_origin, "ocr");
        assert_eq!(sections[0].page, Some(1));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parses_api_ocr_page_response() {
        let response = json!({
            "pages": [
                { "text": "First page", "confidence": 0.91 },
                { "markdown": "Second page", "score": 0.82 }
            ]
        });
        let pages = parse_api_ocr_response(&response).unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].text, "First page");
        assert_eq!(pages[0].confidence, Some(0.91));
        assert_eq!(pages[1].text, "Second page");
        assert_eq!(pages[1].confidence, Some(0.82));
    }

    #[test]
    fn parses_api_ocr_single_text_response() {
        let response = json!({
            "output_text": "Single document text",
            "confidence": 0.77
        });
        let pages = parse_api_ocr_response(&response).unwrap();
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].text, "Single document text");
        assert_eq!(pages[0].confidence, Some(0.77));
    }

    fn write_test_png(path: &Path, text: &str) {
        let script = format!(
            r#"
import AppKit
import Foundation

let output = URL(fileURLWithPath: CommandLine.arguments[1])
let size = NSSize(width: 1400, height: 320)
let image = NSImage(size: size)
image.lockFocus()
NSColor.white.setFill()
NSBezierPath(rect: NSRect(origin: .zero, size: size)).fill()
let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 96, weight: .regular),
    .foregroundColor: NSColor.black
]
("{text}".replacingOccurrences(of: "\"", with: "\\\"") as NSString).draw(at: NSPoint(x: 40, y: 110), withAttributes: attrs)
image.unlockFocus()
let data = image.tiffRepresentation!
let rep = NSBitmapImageRep(data: data)!
try rep.representation(using: .png, properties: [:])!.write(to: output)
"#
        );
        run_swift_script(&script, &[path.to_string_lossy().to_string()]);
    }

    fn write_image_pdf(image_path: &Path, pdf_path: &Path) {
        let script = r#"
import AppKit
import CoreGraphics
import Foundation

let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
let pdfURL = URL(fileURLWithPath: CommandLine.arguments[2])
let image = NSImage(contentsOf: imageURL)!
let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)!
var mediaBox = CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height)
let context = CGContext(pdfURL as CFURL, mediaBox: &mediaBox, nil)!
context.beginPDFPage(nil)
context.draw(cgImage, in: mediaBox)
context.endPDFPage()
context.closePDF()
"#;
        run_swift_script(
            script,
            &[
                image_path.to_string_lossy().to_string(),
                pdf_path.to_string_lossy().to_string(),
            ],
        );
    }

    fn run_swift_script(script: &str, args: &[String]) {
        let script_path =
            std::env::temp_dir().join(format!("redbox-ocr-test-{}.swift", unique_suffix()));
        fs::write(&script_path, script).unwrap();
        let output = Command::new(command_path("swift").unwrap())
            .arg(&script_path)
            .args(args)
            .output()
            .unwrap();
        let _ = fs::remove_file(&script_path);
        if !output.status.success() {
            panic!("{}", String::from_utf8_lossy(&output.stderr));
        }
    }
}
