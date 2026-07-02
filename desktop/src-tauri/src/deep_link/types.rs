use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeepLinkEventPayload {
    pub success: bool,
    pub source: String,
    pub raw_url: String,
    pub received_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<DeepLinkIntent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<DeepLinkErrorPayload>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeepLinkIntent {
    #[serde(rename = "type")]
    pub kind: DeepLinkIntentKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub market_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) enum DeepLinkIntentKind {
    #[serde(rename = "open")]
    Open,
    #[serde(rename = "chat.new")]
    ChatNew,
    #[serde(rename = "import.url")]
    ImportUrl,
    #[serde(rename = "knowledge.save")]
    KnowledgeSave,
    #[serde(rename = "skills.open")]
    SkillsOpen,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeepLinkErrorPayload {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeepLinkParseError {
    pub code: &'static str,
    pub message: String,
}

impl DeepLinkParseError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn payload(&self) -> DeepLinkErrorPayload {
        DeepLinkErrorPayload {
            code: self.code.to_string(),
            message: self.message.clone(),
        }
    }
}
