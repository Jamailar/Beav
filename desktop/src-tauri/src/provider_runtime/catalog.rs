use std::collections::BTreeMap;

use crate::runtime::ProviderWireApi;

use super::{
    AuthStrategy, CapabilityDeclaration, CapabilityScope, EndpointBaseKind, EndpointPolicy,
    ModelListPolicy, ProviderCatalogEntry, ProviderQuirk,
};

const COMPAT_SUFFIXES: &[&str] = &[
    "/api/claudecode",
    "/api/anthropic",
    "/apps/anthropic",
    "/api/coding",
    "/claudecode",
    "/anthropic",
    "/step_plan",
    "/coding",
    "/claude",
];

pub(crate) fn provider_key_from_parts(
    source_provider_key: Option<&str>,
    preset_id: &str,
    protocol: &str,
    base_url: &str,
) -> String {
    let explicit = source_provider_key
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(value) = explicit {
        return normalize_key(value);
    }
    let preset = preset_id.trim();
    if !preset.is_empty() {
        return normalize_key(preset);
    }
    let hint = format!("{protocol} {base_url}").to_ascii_lowercase();
    if hint.contains("anthropic") {
        "anthropic".to_string()
    } else if hint.contains("gemini") || hint.contains("generativelanguage") {
        "gemini".to_string()
    } else {
        "custom".to_string()
    }
}

pub(crate) fn catalog_entry_for(
    provider_key: &str,
    preset_id: &str,
    protocol: &str,
    base_url: &str,
) -> ProviderCatalogEntry {
    let key = normalize_key(provider_key);
    let hint = format!("{key} {preset_id} {protocol} {base_url}").to_ascii_lowercase();
    let (family, display_name, base_kind, auth_strategy, default_base_url) =
        if hint.contains("anthropic") {
            (
                "anthropic",
                "Anthropic",
                EndpointBaseKind::Anthropic,
                AuthStrategy::XApiKey,
                Some("https://api.anthropic.com/v1".to_string()),
            )
        } else if hint.contains("gemini") || hint.contains("generativelanguage") {
            (
                "gemini",
                "Gemini",
                EndpointBaseKind::GeminiNative,
                AuthStrategy::QueryKey,
                Some("https://generativelanguage.googleapis.com/v1beta".to_string()),
            )
        } else if hint.contains("dashscope") || hint.contains("qwen") || hint.contains("aliyun") {
            (
                "dashscope",
                "DashScope",
                EndpointBaseKind::OpenAiCompatible,
                AuthStrategy::Bearer,
                Some("https://dashscope.aliyuncs.com/compatible-mode/v1".to_string()),
            )
        } else if hint.contains("volc") || hint.contains("ark") || hint.contains("jimeng") {
            (
                "volcengine",
                "Volcengine",
                EndpointBaseKind::OpenAiCompatible,
                AuthStrategy::Bearer,
                None,
            )
        } else if hint.contains("minimax") {
            (
                "minimax",
                "MiniMax",
                EndpointBaseKind::OpenAiCompatible,
                AuthStrategy::Bearer,
                None,
            )
        } else if hint.contains("openrouter") {
            (
                "openrouter",
                "OpenRouter",
                EndpointBaseKind::OpenAiCompatible,
                AuthStrategy::Bearer,
                Some("https://openrouter.ai/api/v1".to_string()),
            )
        } else if hint.contains("openai") || protocol.trim().is_empty() {
            (
                "openai",
                "OpenAI Compatible",
                EndpointBaseKind::OpenAiCompatible,
                AuthStrategy::Bearer,
                Some("https://api.openai.com/v1".to_string()),
            )
        } else {
            (
                "custom",
                "Custom",
                EndpointBaseKind::OpenAiCompatible,
                AuthStrategy::Bearer,
                None,
            )
        };

    let endpoint_policy = match base_kind {
        EndpointBaseKind::Anthropic => anthropic_endpoint_policy(),
        EndpointBaseKind::GeminiNative => gemini_endpoint_policy(),
        EndpointBaseKind::OpenAiCompatible => openai_compatible_endpoint_policy(),
        EndpointBaseKind::ProviderTemplate => provider_template_endpoint_policy(),
    };

    ProviderCatalogEntry {
        provider_key: key,
        display_name: display_name.to_string(),
        family: family.to_string(),
        default_base_url,
        auth_strategy,
        capabilities: default_capabilities(&hint, base_kind),
        quirks: provider_quirks(&hint),
        endpoint_policy,
    }
}

pub(crate) fn openai_compatible_endpoint_policy() -> EndpointPolicy {
    let mut capability_paths = BTreeMap::new();
    capability_paths.insert("chat".to_string(), "/chat/completions".to_string());
    capability_paths.insert("wander".to_string(), "/chat/completions".to_string());
    capability_paths.insert("team".to_string(), "/chat/completions".to_string());
    capability_paths.insert("knowledge".to_string(), "/chat/completions".to_string());
    capability_paths.insert("redclaw".to_string(), "/chat/completions".to_string());
    capability_paths.insert("visualIndex".to_string(), "/chat/completions".to_string());
    capability_paths.insert("videoAnalysis".to_string(), "/chat/completions".to_string());
    capability_paths.insert("embedding".to_string(), "/embeddings".to_string());
    capability_paths.insert(
        "transcription".to_string(),
        "/audio/transcriptions".to_string(),
    );
    capability_paths.insert("image".to_string(), "/images/generations".to_string());
    EndpointPolicy {
        base_kind: EndpointBaseKind::OpenAiCompatible,
        version_path: Some("/v1".to_string()),
        capability_paths,
        model_list: ModelListPolicy {
            default_path: "/v1/models".to_string(),
            version_aware: true,
            allow_full_url_derive: true,
            strip_suffixes: COMPAT_SUFFIXES
                .iter()
                .map(|item| item.to_string())
                .collect(),
        },
    }
}

fn anthropic_endpoint_policy() -> EndpointPolicy {
    let mut policy = openai_compatible_endpoint_policy();
    policy.base_kind = EndpointBaseKind::Anthropic;
    policy.capability_paths.insert(
        CapabilityScope::Chat.as_str().to_string(),
        "/messages".to_string(),
    );
    policy
}

fn gemini_endpoint_policy() -> EndpointPolicy {
    EndpointPolicy {
        base_kind: EndpointBaseKind::GeminiNative,
        version_path: Some("/v1beta".to_string()),
        capability_paths: BTreeMap::new(),
        model_list: ModelListPolicy {
            default_path: "/v1beta/models".to_string(),
            version_aware: true,
            allow_full_url_derive: true,
            strip_suffixes: Vec::new(),
        },
    }
}

fn provider_template_endpoint_policy() -> EndpointPolicy {
    EndpointPolicy {
        base_kind: EndpointBaseKind::ProviderTemplate,
        version_path: None,
        capability_paths: BTreeMap::new(),
        model_list: ModelListPolicy {
            default_path: "/v1/models".to_string(),
            version_aware: true,
            allow_full_url_derive: false,
            strip_suffixes: Vec::new(),
        },
    }
}

fn default_capabilities(hint: &str, base_kind: EndpointBaseKind) -> Vec<CapabilityDeclaration> {
    let chat_wire_api = match base_kind {
        EndpointBaseKind::Anthropic => ProviderWireApi::Anthropic,
        EndpointBaseKind::GeminiNative => ProviderWireApi::Gemini,
        _ => ProviderWireApi::ChatCompat,
    };
    let supports_tools = !hint.contains("deepseek");
    vec![
        chat_capability(CapabilityScope::Chat, chat_wire_api, supports_tools),
        chat_capability(CapabilityScope::Wander, chat_wire_api, supports_tools),
        chat_capability(CapabilityScope::Team, chat_wire_api, supports_tools),
        chat_capability(CapabilityScope::Knowledge, chat_wire_api, supports_tools),
        chat_capability(CapabilityScope::Redclaw, chat_wire_api, supports_tools),
        chat_capability(CapabilityScope::VisualIndex, chat_wire_api, supports_tools),
        chat_capability(
            CapabilityScope::VideoAnalysis,
            chat_wire_api,
            supports_tools,
        ),
        CapabilityDeclaration {
            scope: CapabilityScope::Embedding,
            adapter_key: "openai_embedding".to_string(),
            wire_api: ProviderWireApi::ChatCompat,
            default_model: None,
            model_patterns: vec!["embedding".to_string()],
            supports_streaming: false,
            supports_tools: false,
            supports_images: false,
            supports_reasoning_effort: false,
        },
        CapabilityDeclaration {
            scope: CapabilityScope::Transcription,
            adapter_key: "openai_transcription".to_string(),
            wire_api: ProviderWireApi::ChatCompat,
            default_model: None,
            model_patterns: vec!["whisper".to_string(), "asr".to_string()],
            supports_streaming: false,
            supports_tools: false,
            supports_images: false,
            supports_reasoning_effort: false,
        },
        CapabilityDeclaration {
            scope: CapabilityScope::Image,
            adapter_key: "openai_images".to_string(),
            wire_api: ProviderWireApi::ChatCompat,
            default_model: None,
            model_patterns: vec!["image".to_string()],
            supports_streaming: false,
            supports_tools: false,
            supports_images: false,
            supports_reasoning_effort: false,
        },
    ]
}

pub(crate) fn adapter_key_for(
    scope: CapabilityScope,
    wire_api: ProviderWireApi,
    provider_template: Option<&str>,
) -> String {
    if provider_template
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
    {
        return "media_provider_template".to_string();
    }
    match scope {
        CapabilityScope::Embedding => "openai_embedding".to_string(),
        CapabilityScope::Transcription => "openai_transcription".to_string(),
        CapabilityScope::Image => "openai_images".to_string(),
        CapabilityScope::Video | CapabilityScope::VoiceTts | CapabilityScope::VoiceClone => {
            "media_provider_template".to_string()
        }
        _ => match wire_api {
            ProviderWireApi::Responses => "openai_responses_chat".to_string(),
            ProviderWireApi::ChatCompat => "openai_chat".to_string(),
            ProviderWireApi::Anthropic => "anthropic_messages".to_string(),
            ProviderWireApi::Gemini => "gemini_generate_content".to_string(),
        },
    }
}

fn chat_capability(
    scope: CapabilityScope,
    wire_api: ProviderWireApi,
    supports_tools: bool,
) -> CapabilityDeclaration {
    CapabilityDeclaration {
        scope,
        adapter_key: adapter_key_for(scope, wire_api, None),
        wire_api,
        default_model: None,
        model_patterns: Vec::new(),
        supports_streaming: true,
        supports_tools,
        supports_images: matches!(
            scope,
            CapabilityScope::Chat
                | CapabilityScope::VisualIndex
                | CapabilityScope::VideoAnalysis
                | CapabilityScope::Redclaw
                | CapabilityScope::Team
        ),
        supports_reasoning_effort: matches!(
            wire_api,
            ProviderWireApi::ChatCompat | ProviderWireApi::Responses
        ),
    }
}

fn provider_quirks(hint: &str) -> Vec<ProviderQuirk> {
    let mut quirks = Vec::new();
    if hint.contains("dashscope") || hint.contains("qwen") {
        quirks.push(ProviderQuirk {
            key: "qwenSearchContractSplit".to_string(),
            value: "chatCompletionsAndResponsesDiffer".to_string(),
        });
    }
    if hint.contains("coding") || hint.contains("step_plan") {
        quirks.push(ProviderQuirk {
            key: "modelListMayRequireCustomUserAgent".to_string(),
            value: "true".to_string(),
        });
    }
    quirks
}

fn normalize_key(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    normalized
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}
