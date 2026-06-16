use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub(crate) enum AiModelScope {
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

impl AiModelScope {
    pub(crate) const ALL: [AiModelScope; 13] = [
        AiModelScope::Chat,
        AiModelScope::Wander,
        AiModelScope::Team,
        AiModelScope::Knowledge,
        AiModelScope::Redclaw,
        AiModelScope::Transcription,
        AiModelScope::Embedding,
        AiModelScope::Image,
        AiModelScope::Video,
        AiModelScope::VisualIndex,
        AiModelScope::VideoAnalysis,
        AiModelScope::VoiceTts,
        AiModelScope::VoiceClone,
    ];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            AiModelScope::Chat => "chat",
            AiModelScope::Wander => "wander",
            AiModelScope::Team => "team",
            AiModelScope::Knowledge => "knowledge",
            AiModelScope::Redclaw => "redclaw",
            AiModelScope::Transcription => "transcription",
            AiModelScope::Embedding => "embedding",
            AiModelScope::Image => "image",
            AiModelScope::Video => "video",
            AiModelScope::VisualIndex => "visualIndex",
            AiModelScope::VideoAnalysis => "videoAnalysis",
            AiModelScope::VoiceTts => "voiceTts",
            AiModelScope::VoiceClone => "voiceClone",
        }
    }

    pub(crate) fn from_route_scope(value: &str) -> AiModelScope {
        match value.trim() {
            "wander" => AiModelScope::Wander,
            "team" | "chatroom" | "advisor-discussion" => AiModelScope::Team,
            "knowledge" => AiModelScope::Knowledge,
            "redclaw" => AiModelScope::Redclaw,
            "transcription" => AiModelScope::Transcription,
            "embedding" => AiModelScope::Embedding,
            "image" => AiModelScope::Image,
            "video" => AiModelScope::Video,
            "visualIndex" | "visual_index" | "visual-index" => AiModelScope::VisualIndex,
            "videoAnalysis" | "video_analysis" | "video-analysis" => AiModelScope::VideoAnalysis,
            "voiceTts" | "voice_tts" | "voice-tts" | "tts" => AiModelScope::VoiceTts,
            "voiceClone" | "voice_clone" | "voice-clone" => AiModelScope::VoiceClone,
            _ => AiModelScope::Chat,
        }
    }

    pub(crate) fn legacy_model_key(self) -> &'static str {
        match self {
            AiModelScope::Chat => "model_name",
            AiModelScope::Wander => "model_name_wander",
            AiModelScope::Team => "model_name_chatroom",
            AiModelScope::Knowledge => "model_name_knowledge",
            AiModelScope::Redclaw => "model_name_redclaw",
            AiModelScope::Transcription => "transcription_model",
            AiModelScope::Embedding => "embedding_model",
            AiModelScope::Image => "image_model",
            AiModelScope::Video => "video_model",
            AiModelScope::VisualIndex => "visual_index_model",
            AiModelScope::VideoAnalysis => "video_analysis_model",
            AiModelScope::VoiceTts => "voice_tts_model",
            AiModelScope::VoiceClone => "voice_clone_model",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct AiProviderSource {
    pub id: String,
    pub name: String,
    pub preset_id: String,
    pub base_url: String,
    pub protocol: String,
    pub wire_api: String,
    pub model: String,
    pub api_key_present: bool,
    pub is_official: bool,
    pub is_local: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct AiModelRoute {
    pub scope: String,
    pub mode: String,
    pub source_id: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct AiResolvedRoute {
    pub scope: String,
    pub mode: String,
    pub source_id: String,
    pub source_name: String,
    pub preset_id: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model_name: String,
    pub protocol: String,
    pub wire_api: crate::runtime::ProviderWireApi,
    pub reasoning_effort: Option<String>,
    pub provider_template: Option<String>,
    pub provider: Option<String>,
    pub is_official: bool,
    pub is_local: bool,
    pub source: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct AiReadiness {
    pub ready: bool,
    pub mode: String,
    pub reason: String,
    pub source_id: String,
    pub source_name: String,
    pub base_url: String,
    pub model: String,
    pub protocol: String,
    pub official_logged_in: bool,
    pub can_use_official: bool,
    pub can_use_custom: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct AiModelManagerSnapshot {
    pub providers: Vec<AiProviderSource>,
    pub routes: Vec<AiModelRoute>,
    pub readiness: AiReadiness,
    pub updated_at: String,
}
