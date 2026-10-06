use super::types::AiModelScope;

pub(crate) fn scope_for_runtime_mode(runtime_mode: Option<&str>) -> AiModelScope {
    AiModelScope::from_route_scope(runtime_mode.unwrap_or("chat"))
}

pub(crate) fn scope_for_tool_action(action: &str) -> AiModelScope {
    match action.trim() {
        "image.generate" | "cover.generate" => AiModelScope::Image,
        "video.generate" | "video.edit" => AiModelScope::Video,
        "video.analyze" | "media.analyze-video" => AiModelScope::VideoAnalysis,
        "media.transcribe" | "audio.transcribe" => AiModelScope::Transcription,
        "embedding.compute" | "knowledge.embed" => AiModelScope::Embedding,
        "knowledge.visual-index" | "visual.index" => AiModelScope::VisualIndex,
        "voice.speech" | "tts.synthesize" => AiModelScope::VoiceTts,
        "voice.clone" => AiModelScope::VoiceClone,
        _ => AiModelScope::Chat,
    }
}
