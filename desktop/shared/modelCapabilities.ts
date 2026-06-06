import modelProfilesRaw from './modelProfiles.json';

export type ModelCapability =
    | 'chat'
    | 'image'
    | 'video'
    | 'audio'
    | 'tts'
    | 'voice_clone'
    | 'transcription'
    | 'embedding';

export type ModelInputCapability =
    | 'image'
    | 'audio'
    | 'video'
    | 'file';

export const MODEL_INPUT_CAPABILITY_ORDER: ModelInputCapability[] = [
    'image',
    'audio',
    'video',
    'file',
];

export const DEFAULT_UNKNOWN_CHAT_MODEL_INPUT_CAPABILITIES: ModelInputCapability[] = [
    'image',
    'file',
];

export const MODEL_CAPABILITY_ORDER: ModelCapability[] = [
    'chat',
    'image',
    'video',
    'audio',
    'tts',
    'voice_clone',
    'transcription',
    'embedding',
];

export const MODEL_CAPABILITY_META: Record<ModelCapability, { label: string; shortLabel: string }> = {
    chat: { label: '聊天', shortLabel: '聊天' },
    image: { label: '图片生成', shortLabel: '图片' },
    video: { label: '视频生成', shortLabel: '视频' },
    audio: { label: '音频生成', shortLabel: '音频' },
    tts: { label: '语音合成', shortLabel: 'TTS' },
    voice_clone: { label: '音色克隆', shortLabel: '克隆' },
    transcription: { label: '转录', shortLabel: '转录' },
    embedding: { label: '向量', shortLabel: '向量' },
};

export interface ModelProfileRule {
    id: string;
    vendor?: string;
    displayName?: string;
    notes?: string;
    capabilities: ModelCapability[];
    inputCapabilities: ModelInputCapability[];
    patterns: RegExp[];
}

const CAPABILITY_RULES: Array<{ capability: ModelCapability; patterns: RegExp[] }> = [
    { capability: 'embedding', patterns: [/\bembedding\b/i, /\bembed\b/i] },
    { capability: 'transcription', patterns: [/\basr\b/i, /\bwhisper\b/i] },
    { capability: 'voice_clone', patterns: [/clone/i] },
    { capability: 'tts', patterns: [/voice/i, /\btts\b/i, /\bspeech\b/i] },
    { capability: 'video', patterns: [/video/i, /\bveo\b/i, /\bseedance\b/i, /\bkling\b/i, /\bvidu\b/i, /\bluma\b/i, /\bsora\b/i] },
    { capability: 'image', patterns: [/image/i, /\bdall-?e\b/i, /\bimagen\b/i, /\bseedream\b/i, /nanobanana/i, /banana/i] },
];

const inferForcedNameCapabilities = (modelId: string): ModelCapability[] => {
    const normalized = String(modelId || '').trim().toLowerCase();
    if (!normalized) return [];
    if (normalized.includes('tts')) return ['tts'];
    if (normalized.includes('clone')) return ['voice_clone'];
    if (normalized.includes('voice')) return ['tts'];
    return [];
};

export const modelNameDisallowsChatList = (modelId: string): boolean => {
    return String(modelId || '').trim().toLowerCase().includes('omni');
};

export const enforceModelCapabilityPolicy = (
    modelId: string,
    capabilities: Iterable<ModelCapability>,
): ModelCapability[] => {
    const normalized = new Set<ModelCapability>();
    for (const capability of capabilities) {
        if (MODEL_CAPABILITY_ORDER.includes(capability)) {
            normalized.add(capability);
        }
    }
    if (modelNameDisallowsChatList(modelId)) {
        normalized.delete('chat');
    }
    return MODEL_CAPABILITY_ORDER.filter((capability) => normalized.has(capability));
};

const normalizeModelInputCapabilities = (values: unknown): ModelInputCapability[] => {
    const allowed = new Set<ModelInputCapability>(MODEL_INPUT_CAPABILITY_ORDER);
    const normalized = new Set<ModelInputCapability>();
    if (!Array.isArray(values)) {
        return [];
    }
    for (const value of values) {
        const text = String(value || '').trim().toLowerCase();
        if (allowed.has(text as ModelInputCapability)) {
            normalized.add(text as ModelInputCapability);
        }
    }
    return MODEL_INPUT_CAPABILITY_ORDER.filter((capability) => normalized.has(capability));
};

const modelNameAllowsVideoInput = (modelId: string): boolean => {
    return /\bomni\b/i.test(String(modelId || '').trim());
};

const enforceModelInputCapabilityPolicy = (
    modelId: string,
    capabilities: Iterable<ModelInputCapability>,
): ModelInputCapability[] => {
    const normalized = new Set(capabilities);
    if (!modelNameAllowsVideoInput(modelId)) {
        normalized.delete('video');
    }
    return MODEL_INPUT_CAPABILITY_ORDER.filter((capability) => normalized.has(capability));
};

const normalizeModelCapabilitiesList = (values: unknown): ModelCapability[] => {
    const allowed = new Set<ModelCapability>(MODEL_CAPABILITY_ORDER);
    const normalized = new Set<ModelCapability>();
    if (!Array.isArray(values)) {
        return [];
    }
    for (const value of values) {
        const raw = String(value || '').trim().toLowerCase();
        const text = raw === 'stt' ? 'transcription' : raw;
        if (allowed.has(text as ModelCapability)) {
            normalized.add(text as ModelCapability);
        }
    }
    return MODEL_CAPABILITY_ORDER.filter((capability) => normalized.has(capability));
};

const MODEL_PROFILE_RULES: ModelProfileRule[] = Array.isArray(modelProfilesRaw)
    ? modelProfilesRaw.map((item) => {
        const record = (item && typeof item === 'object') ? item as Record<string, unknown> : {};
        return {
            id: String(record.id || '').trim(),
            vendor: String(record.vendor || '').trim() || undefined,
            displayName: String(record.displayName || '').trim() || undefined,
            notes: String(record.notes || '').trim() || undefined,
            capabilities: normalizeModelCapabilitiesList(record.capabilities),
            inputCapabilities: normalizeModelInputCapabilities(record.inputCapabilities),
            patterns: Array.isArray(record.matchers)
                ? record.matchers
                    .map((value) => String(value || '').trim())
                    .filter(Boolean)
                    .map((value) => new RegExp(value, 'i'))
                : [],
        };
    }).filter((item) => item.id && (item.capabilities.length > 0 || item.inputCapabilities.length > 0) && item.patterns.length > 0)
    : [];

const ATTACHMENT_KIND_TO_INPUT_CAPABILITY: Record<string, ModelInputCapability | null> = {
    image: 'image',
    audio: 'audio',
    video: 'video',
    document: 'file',
    text: 'file',
    binary: 'file',
};

export const findMatchedModelProfiles = (modelId: string): Array<Omit<ModelProfileRule, 'patterns'>> => {
    const normalized = String(modelId || '').trim().toLowerCase();
    if (!normalized) return [];
    return MODEL_PROFILE_RULES
        .filter((rule) => rule.patterns.some((pattern) => pattern.test(normalized)))
        .map(({ patterns: _patterns, ...rest }) => rest);
};

export const getForcedModelCapabilities = (modelId: string): ModelCapability[] => {
    const normalized = String(modelId || '').trim().toLowerCase();
    if (!normalized) return [];
    const forcedByName = inferForcedNameCapabilities(normalized);
    if (forcedByName.length > 0) return enforceModelCapabilityPolicy(normalized, forcedByName);
    const detected = new Set<ModelCapability>();
    for (const rule of MODEL_PROFILE_RULES) {
        if (rule.patterns.some((pattern) => pattern.test(normalized))) {
            for (const capability of rule.capabilities) {
                detected.add(capability);
            }
        }
    }
    return enforceModelCapabilityPolicy(normalized, detected);
};

export const inferModelCapabilities = (modelId: string): ModelCapability[] => {
    const normalized = String(modelId || '').trim().toLowerCase();
    if (!normalized) return ['chat'];

    const forced = getForcedModelCapabilities(normalized);
    if (forced.length > 0) {
        return forced;
    }

    const detected = new Set<ModelCapability>();
    for (const rule of CAPABILITY_RULES) {
        if (rule.patterns.some((pattern) => pattern.test(normalized))) {
            detected.add(rule.capability);
        }
    }

    if (!detected.size) {
        detected.add('chat');
    }

    return enforceModelCapabilityPolicy(normalized, detected);
};

export const hasModelCapability = (modelId: string, capability: ModelCapability): boolean => {
    return inferModelCapabilities(modelId).includes(capability);
};

export const getModelInputCapabilities = (modelId: string): ModelInputCapability[] => {
    const normalized = String(modelId || '').trim().toLowerCase();
    if (!normalized) return [];

    const detected = new Set<ModelInputCapability>();
    for (const rule of MODEL_PROFILE_RULES) {
        if (rule.patterns.some((pattern) => pattern.test(normalized))) {
            for (const input of rule.inputCapabilities) {
                detected.add(input);
            }
        }
    }
    if (detected.size > 0) {
        return enforceModelInputCapabilityPolicy(normalized, detected);
    }

    if (inferModelCapabilities(normalized).includes('chat')) {
        return enforceModelInputCapabilityPolicy(normalized, DEFAULT_UNKNOWN_CHAT_MODEL_INPUT_CAPABILITIES);
    }

    return enforceModelInputCapabilityPolicy(normalized, detected);
};

export const hasModelInputCapability = (modelId: string, capability: ModelInputCapability): boolean => {
    return getModelInputCapabilities(modelId).includes(capability);
};

export const supportsAttachmentKindDirectInput = (modelId: string, attachmentKind: string): boolean => {
    const mapped = ATTACHMENT_KIND_TO_INPUT_CAPABILITY[String(attachmentKind || '').trim().toLowerCase()] || null;
    if (!mapped) return false;
    return hasModelInputCapability(modelId, mapped);
};

export const normalizeModelCapabilities = (values: Array<ModelCapability | string | null | undefined>): ModelCapability[] => {
    const normalized = new Set<ModelCapability>();
    for (const value of values) {
        const raw = String(value || '').trim().toLowerCase();
        const text = raw === 'stt' ? 'transcription' : raw;
        if (!text) continue;
        if (MODEL_CAPABILITY_ORDER.includes(text as ModelCapability)) {
            normalized.add(text as ModelCapability);
        }
    }
    return MODEL_CAPABILITY_ORDER.filter((capability) => normalized.has(capability));
};
