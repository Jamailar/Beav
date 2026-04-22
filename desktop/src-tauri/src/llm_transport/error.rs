use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TransportMode {
    Auto,
    Http11,
}

impl TransportMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "default",
            Self::Http11 => "http1.1",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TransportErrorKind {
    Connect,
    Timeout,
    PartialBody,
    Http2Framing,
    EmptyReply,
    Status,
    Parse,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone)]
pub(crate) struct LlmTransportError {
    pub kind: TransportErrorKind,
    pub transport_mode: TransportMode,
    pub message: String,
    pub http_status: Option<u16>,
    pub raw: Option<String>,
}

impl LlmTransportError {
    pub(crate) fn new(
        kind: TransportErrorKind,
        transport_mode: TransportMode,
        message: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            transport_mode,
            message: message.into(),
            http_status: None,
            raw: None,
        }
    }

    pub(crate) fn with_status(
        transport_mode: TransportMode,
        status: u16,
        message: impl Into<String>,
        raw: Option<String>,
    ) -> Self {
        Self {
            kind: TransportErrorKind::Status,
            transport_mode,
            message: message.into(),
            http_status: Some(status),
            raw,
        }
    }

    pub(crate) fn should_retry_with_http1(self: &Self) -> bool {
        matches!(
            self.kind,
            TransportErrorKind::PartialBody
                | TransportErrorKind::Http2Framing
                | TransportErrorKind::EmptyReply
        ) && self.transport_mode == TransportMode::Auto
    }
}

impl Display for LlmTransportError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        if let Some(status) = self.http_status {
            if let Some(raw) = self.raw.as_deref().filter(|value| !value.trim().is_empty()) {
                return write!(f, "{}\nRaw response: {}", self.message, raw.trim());
            }
            return write!(f, "{} (HTTP {})", self.message, status);
        }
        write!(f, "{}", self.message)
    }
}

fn classify_raw_transport_message(raw: &str) -> TransportErrorKind {
    let lower = raw.trim().to_ascii_lowercase();
    if lower.contains("cancelled") {
        TransportErrorKind::Cancelled
    } else if lower.contains("timed out") || lower.contains("timeout") {
        TransportErrorKind::Timeout
    } else if lower.contains("http2 framing")
        || lower.contains("http/2 framing")
        || lower.contains("http2 stream")
        || lower.contains("http/2 stream")
    {
        TransportErrorKind::Http2Framing
    } else if lower.contains("partial file")
        || lower.contains("unexpected eof")
        || lower.contains("error decoding response body")
        || lower.contains("end of file before message length reached")
        || lower.contains("connection closed before message completed")
    {
        TransportErrorKind::PartialBody
    } else if lower.contains("empty reply")
        || lower.contains("connection reset")
        || lower.contains("broken pipe")
    {
        TransportErrorKind::EmptyReply
    } else if lower.contains("connect") {
        TransportErrorKind::Connect
    } else if lower.contains("parse") || lower.contains("invalid json") {
        TransportErrorKind::Parse
    } else {
        TransportErrorKind::Unknown
    }
}

impl From<(TransportMode, reqwest::Error)> for LlmTransportError {
    fn from(value: (TransportMode, reqwest::Error)) -> Self {
        let (transport_mode, error) = value;
        let raw = error.to_string();
        let kind = if error.is_timeout() {
            TransportErrorKind::Timeout
        } else {
            classify_raw_transport_message(&raw)
        };
        Self {
            kind,
            transport_mode,
            message: raw.clone(),
            http_status: error.status().map(|status| status.as_u16()),
            raw: Some(raw),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_raw_transport_message, TransportErrorKind};

    #[test]
    fn classifies_http2_errors_as_retryable_transport() {
        assert_eq!(
            classify_raw_transport_message("error sending request for url: HTTP/2 framing layer"),
            TransportErrorKind::Http2Framing
        );
        assert_eq!(
            classify_raw_transport_message("error decoding response body: unexpected EOF"),
            TransportErrorKind::PartialBody
        );
    }
}
