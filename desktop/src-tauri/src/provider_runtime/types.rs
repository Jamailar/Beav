use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::runtime::ProviderWireApi;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CapabilityScope {
    Chat,
    Wander,
    Team,
    Knowledge,
    Redclaw,
    Transcription,
    Embedding,
    Image,
    Video,
    VisualIndex,
    VideoAnalysis,
    VoiceTts,
    VoiceClone,
}

impl CapabilityScope {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Wander => "wander",
            Self::Team => "team",
            Self::Knowledge => "knowledge",
            Self::Redclaw => "redclaw",
            Self::Transcription => "transcription",
            Self::Embedding => "embedding",
            Self::Image => "image",
            Self::Video => "video",
            Self::VisualIndex => "visualIndex",
            Self::VideoAnalysis => "videoAnalysis",
            Self::VoiceTts => "voiceTts",
            Self::VoiceClone => "voiceClone",
        }
    }

    pub(crate) fn from_route_scope(value: &str) -> Self {
        match value.trim() {
            "wander" => Self::Wander,
            "team" | "chatroom" | "advisor-discussion" => Self::Team,
            "knowledge" => Self::Knowledge,
            "redclaw" => Self::Redclaw,
            "transcription" => Self::Transcription,
            "embedding" => Self::Embedding,
            "image" => Self::Image,
            "video" => Self::Video,
            "visualIndex" | "visual_index" | "visual-index" => Self::VisualIndex,
            "videoAnalysis" | "video_analysis" | "video-analysis" => Self::VideoAnalysis,
            "voiceTts" | "voice_tts" | "voice-tts" | "tts" => Self::VoiceTts,
            "voiceClone" | "voice_clone" | "voice-clone" => Self::VoiceClone,
            _ => Self::Chat,
        }
    }

    pub(crate) fn legacy_model_key(self) -> &'static str {
        match self {
            Self::Chat => "model_name",
            Self::Wander => "model_name_wander",
            Self::Team => "model_name_chatroom",
            Self::Knowledge => "model_name_knowledge",
            Self::Redclaw => "model_name_redclaw",
            Self::Transcription => "transcription_model",
            Self::Embedding => "embedding_model",
            Self::Image => "image_model",
            Self::Video => "video_model",
            Self::VisualIndex => "visual_index_model",
            Self::VideoAnalysis => "video_analysis_model",
            Self::VoiceTts => "voice_tts_model",
            Self::VoiceClone => "voice_clone_model",
        }
    }

    pub(crate) fn allows_source_model_fallback(self) -> bool {
        matches!(
            self,
            Self::Chat | Self::Wander | Self::Team | Self::Knowledge | Self::Redclaw
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RouteMode {
    Official,
    Custom,
    Local,
    Disabled,
}

impl RouteMode {
    pub(crate) fn from_config(value: Option<&str>) -> Option<Self> {
        match value?.trim() {
            "official" => Some(Self::Official),
            "custom" => Some(Self::Custom),
            "local" => Some(Self::Local),
            "disabled" => Some(Self::Disabled),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Official => "official",
            Self::Custom => "custom",
            Self::Local => "local",
            Self::Disabled => "disabled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum EndpointBaseKind {
    OpenAiCompatible,
    Anthropic,
    GeminiNative,
    ProviderTemplate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AuthStrategy {
    Bearer,
    XApiKey,
    QueryKey,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelListPolicy {
    pub default_path: String,
    pub version_aware: bool,
    pub allow_full_url_derive: bool,
    pub strip_suffixes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EndpointPolicy {
    pub base_kind: EndpointBaseKind,
    pub version_path: Option<String>,
    pub capability_paths: BTreeMap<String, String>,
    pub model_list: ModelListPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilityDeclaration {
    pub scope: CapabilityScope,
    pub adapter_key: String,
    pub wire_api: ProviderWireApi,
    pub default_model: Option<String>,
    pub model_patterns: Vec<String>,
    pub supports_streaming: bool,
    pub supports_tools: bool,
    pub supports_images: bool,
    pub supports_reasoning_effort: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderQuirk {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderCatalogEntry {
    pub provider_key: String,
    pub display_name: String,
    pub family: String,
    pub default_base_url: Option<String>,
    pub endpoint_policy: EndpointPolicy,
    pub auth_strategy: AuthStrategy,
    pub capabilities: Vec<CapabilityDeclaration>,
    pub quirks: Vec<ProviderQuirk>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedProviderRequest {
    pub scope: CapabilityScope,
    pub mode: RouteMode,
    pub source_id: String,
    pub source_name: String,
    pub provider_key: String,
    pub preset_id: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub protocol: String,
    pub wire_api: ProviderWireApi,
    pub reasoning_effort: Option<String>,
    pub adapter_key: String,
    pub endpoint_policy: EndpointPolicy,
    pub auth_strategy: AuthStrategy,
    pub quirks: Vec<ProviderQuirk>,
    pub provider_template: Option<String>,
    pub provider: Option<String>,
    pub is_official: bool,
    pub is_local: bool,
    pub source: serde_json::Value,
}
