use std::path::Path;

pub(super) fn extension_for_path(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
}

pub(super) fn file_name_for_path(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(ToString::to_string)
}

pub(super) fn preview_kind_for_extension(extension: Option<&str>, is_local: bool) -> &'static str {
    let Some(extension) = extension else {
        return if is_local { "unknown" } else { "web" };
    };
    match extension {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "svg" | "avif" | "ico" | "tif"
        | "tiff" => "image",
        "mp4" | "webm" | "mov" | "m4v" | "mkv" | "avi" | "ogv" => "video",
        "mp3" | "wav" | "m4a" | "flac" | "aac" | "ogg" | "oga" | "opus" => "audio",
        "pdf" => "pdf",
        "doc" | "docx" | "odt" | "ppt" | "pptx" | "odp" | "xls" | "xlsx" | "ods" => "document",
        "html" | "htm" => "html",
        "md" | "markdown" | "txt" | "srt" | "vtt" | "diff" | "patch" | "json" | "csv" | "tsv"
        | "yaml" | "yml" | "toml" | "ini" | "conf" | "config" | "env" | "xml" | "log" | "sql"
        | "sh" | "bash" | "zsh" | "fish" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "rs"
        | "py" | "go" | "java" | "c" | "cpp" | "cc" | "cxx" | "h" | "hpp" | "hh" | "hxx"
        | "css" | "scss" | "sass" | "less" | "vue" | "svelte" | "astro" | "rb" | "php"
        | "swift" | "kt" | "kts" | "scala" | "r" | "lua" | "pl" | "pm" | "dart" | "dockerfile"
        | "lock" => "text",
        "zip" | "rar" | "7z" | "tar" | "gz" | "tgz" => "archive",
        _ => {
            if is_local {
                "unknown"
            } else {
                "web"
            }
        }
    }
}

pub(super) fn mime_type_for_extension(extension: Option<&str>) -> Option<&'static str> {
    let extension = extension?;
    Some(match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "tif" | "tiff" => "image/tiff",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "ogg" => "audio/ogg",
        "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "odp" => "application/vnd.oasis.opendocument.presentation",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "html" | "htm" => "text/html",
        "md" | "markdown" => "text/markdown",
        "txt" | "log" | "srt" | "diff" | "patch" | "toml" | "ini" | "conf" | "config" | "env"
        | "sql" | "sh" | "bash" | "zsh" | "fish" | "lock" => "text/plain",
        "vtt" => "text/vtt",
        "json" => "application/json",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "yaml" | "yml" => "application/yaml",
        "xml" => "application/xml",
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "rs" | "py" | "go" | "java" | "c" | "cpp"
        | "cc" | "cxx" | "h" | "hpp" | "hh" | "hxx" | "css" | "scss" | "sass" | "less" | "vue"
        | "svelte" | "astro" | "rb" | "php" | "swift" | "kt" | "kts" | "scala" | "r" | "lua"
        | "pl" | "pm" | "dart" | "dockerfile" => "text/plain",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        "tar" => "application/x-tar",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::{mime_type_for_extension, preview_kind_for_extension};

    #[test]
    fn preview_kind_covers_common_document_and_media_extensions() {
        assert_eq!(preview_kind_for_extension(Some("docx"), true), "document");
        assert_eq!(preview_kind_for_extension(Some("pptx"), true), "document");
        assert_eq!(preview_kind_for_extension(Some("xlsx"), true), "document");
        assert_eq!(preview_kind_for_extension(Some("diff"), true), "text");
        assert_eq!(preview_kind_for_extension(Some("tiff"), true), "image");
        assert_eq!(
            mime_type_for_extension(Some("docx")),
            Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        );
    }
}
