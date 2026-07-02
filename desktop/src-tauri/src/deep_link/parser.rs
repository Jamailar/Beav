use url::Url;

use super::types::{DeepLinkIntent, DeepLinkIntentKind, DeepLinkParseError};

const APP_SCHEME: &str = "beav";
const MAX_RAW_URL_LEN: usize = 4096;
const MAX_TEXT_LEN: usize = 4000;
const MAX_TITLE_LEN: usize = 200;
const MAX_EXTERNAL_URL_LEN: usize = 2048;

pub(crate) fn parse_deep_link(raw_url: &str) -> Result<DeepLinkIntent, DeepLinkParseError> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err(DeepLinkParseError::new(
            "empty_url",
            "Deep link URL is empty",
        ));
    }
    if trimmed.len() > MAX_RAW_URL_LEN {
        return Err(DeepLinkParseError::new(
            "url_too_long",
            "Deep link URL is too long",
        ));
    }

    let parsed = Url::parse(trimmed)
        .map_err(|error| DeepLinkParseError::new("invalid_url", error.to_string()))?;
    if parsed.scheme() != APP_SCHEME {
        return Err(DeepLinkParseError::new(
            "unsupported_scheme",
            format!("Unsupported deep link scheme `{}`", parsed.scheme()),
        ));
    }

    let segments = normalized_segments(&parsed);
    let segment_refs = segments.iter().map(String::as_str).collect::<Vec<_>>();
    match segment_refs.as_slice() {
        ["open"] | [] => Ok(DeepLinkIntent {
            kind: DeepLinkIntentKind::Open,
            text: None,
            url: None,
            title: query_text(&parsed, "title", MAX_TITLE_LEN)?,
        }),
        ["chat", "new"] => Ok(DeepLinkIntent {
            kind: DeepLinkIntentKind::ChatNew,
            text: query_text(&parsed, "text", MAX_TEXT_LEN)?,
            url: None,
            title: query_text(&parsed, "title", MAX_TITLE_LEN)?,
        }),
        ["import", "url"] => Ok(DeepLinkIntent {
            kind: DeepLinkIntentKind::ImportUrl,
            text: query_text(&parsed, "text", MAX_TEXT_LEN)?,
            url: Some(required_external_url(&parsed, "url")?),
            title: query_text(&parsed, "title", MAX_TITLE_LEN)?,
        }),
        ["knowledge", "save"] => Ok(DeepLinkIntent {
            kind: DeepLinkIntentKind::KnowledgeSave,
            text: query_text(&parsed, "text", MAX_TEXT_LEN)?,
            url: Some(required_external_url(&parsed, "url")?),
            title: query_text(&parsed, "title", MAX_TITLE_LEN)?,
        }),
        _ => Err(DeepLinkParseError::new(
            "unsupported_action",
            format!("Unsupported deep link action `{}`", segments.join("/")),
        )),
    }
}

fn normalized_segments(parsed: &Url) -> Vec<String> {
    let mut segments = Vec::new();
    if let Some(host) = parsed.host_str() {
        let host = host.trim_matches('/');
        if !host.is_empty() {
            segments.push(host.to_ascii_lowercase());
        }
    }
    if let Some(path_segments) = parsed.path_segments() {
        for segment in path_segments {
            let normalized = segment.trim();
            if !normalized.is_empty() {
                segments.push(normalized.to_ascii_lowercase());
            }
        }
    }
    segments
}

fn query_text(
    parsed: &Url,
    key: &str,
    max_len: usize,
) -> Result<Option<String>, DeepLinkParseError> {
    for (name, value) in parsed.query_pairs() {
        if name == key {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            if trimmed.len() > max_len {
                return Err(DeepLinkParseError::new(
                    "param_too_long",
                    format!("Deep link parameter `{key}` is too long"),
                ));
            }
            return Ok(Some(trimmed.to_string()));
        }
    }
    Ok(None)
}

fn required_external_url(parsed: &Url, key: &str) -> Result<String, DeepLinkParseError> {
    let Some(value) = query_text(parsed, key, MAX_EXTERNAL_URL_LEN)? else {
        return Err(DeepLinkParseError::new(
            "missing_url",
            format!("Deep link parameter `{key}` is required"),
        ));
    };
    let external = Url::parse(&value)
        .map_err(|error| DeepLinkParseError::new("invalid_external_url", error.to_string()))?;
    if external.scheme() != "http" && external.scheme() != "https" {
        return Err(DeepLinkParseError::new(
            "unsupported_external_url_scheme",
            "Deep link external URL must use http or https",
        ));
    }
    if !external.username().is_empty() || external.password().is_some() {
        return Err(DeepLinkParseError::new(
            "external_url_credentials",
            "Deep link external URL must not include credentials",
        ));
    }
    Ok(external.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_open_host_form() {
        let intent = parse_deep_link("beav://open").unwrap();
        assert_eq!(intent.kind, DeepLinkIntentKind::Open);
    }

    #[test]
    fn parses_open_path_form() {
        let intent = parse_deep_link("beav:///open").unwrap();
        assert_eq!(intent.kind, DeepLinkIntentKind::Open);
    }

    #[test]
    fn parses_chat_new_text() {
        let intent = parse_deep_link("beav://chat/new?text=%E4%BD%A0%E5%A5%BD").unwrap();
        assert_eq!(intent.kind, DeepLinkIntentKind::ChatNew);
        assert_eq!(intent.text.as_deref(), Some("你好"));
    }

    #[test]
    fn parses_import_url() {
        let intent = parse_deep_link(
            "beav://import/url?url=https%3A%2F%2Fexample.com%2Fpost%3Fa%3D1&title=Demo",
        )
        .unwrap();
        assert_eq!(intent.kind, DeepLinkIntentKind::ImportUrl);
        assert_eq!(intent.url.as_deref(), Some("https://example.com/post?a=1"));
        assert_eq!(intent.title.as_deref(), Some("Demo"));
    }

    #[test]
    fn rejects_wrong_scheme() {
        let error = parse_deep_link("redbox://open").unwrap_err();
        assert_eq!(error.code, "unsupported_scheme");
    }

    #[test]
    fn rejects_external_file_url() {
        let error =
            parse_deep_link("beav://knowledge/save?url=file%3A%2F%2F%2Ftmp%2Fdemo.md").unwrap_err();
        assert_eq!(error.code, "unsupported_external_url_scheme");
    }

    #[test]
    fn rejects_external_javascript_url() {
        let error = parse_deep_link("beav://import/url?url=javascript%3Aalert%281%29").unwrap_err();
        assert_eq!(error.code, "unsupported_external_url_scheme");
    }

    #[test]
    fn rejects_external_url_credentials() {
        let error =
            parse_deep_link("beav://import/url?url=https%3A%2F%2Fuser%3Apass%40example.com")
                .unwrap_err();
        assert_eq!(error.code, "external_url_credentials");
    }
}
