use super::types::AiModelScope;

pub(crate) fn default_model_for_scope(scope: AiModelScope) -> Option<&'static str> {
    match scope {
        AiModelScope::Transcription => Some("whisper-1"),
        AiModelScope::Embedding => Some("text-embedding-3-small"),
        AiModelScope::Image => Some("gpt-image-1"),
        AiModelScope::VoiceTts => Some("speech-02-hd"),
        AiModelScope::VoiceClone => Some("cosyvoice-v3.5-plus-voice-clone"),
        _ => None,
    }
}
