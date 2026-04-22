import modelProfilesRaw from './modelProfiles.json';

export type ModelCapability =
    | 'chat'
    | 'image'
    | 'video'
    | 'audio'
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

export const MODEL_CAPABILITY_ORDER: ModelCapability[] = [
    'chat',
    'image',
    'video',
    'audio',
    'transcription',
    'embedding',
];

export const MODEL_CAPABILITY_META: Record<ModelCapability, { label: string; shortLabel: string }> = {
    chat: { label: '聊天', shortLabel: '聊天' },
    image: { label: '图片生成', shortLabel: '图片' },
    video: { label: '视频生成', shortLabel: '视频' },
    audio: { label: '音频生成', shortLabel: '音频' },
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
    { capability: 'audio', patterns: [/\btts\b/i, /\bspeech\b/i] },
    { capability: 'video', patterns: [/\bvideo\b/i, /\bveo\b/i, /\bseedance\b/i, /\bkling\b/i, /\bvidu\b/i, /\bluma\b/i, /\bsora\b/i] },
    { capability: 'image', patterns: [/\bimage\b/i, /\bdall-?e\b/i, /\bimagen\b/i, /\bseedream\b/i, /nanobanana/i, /banana/i] },
];

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

const normalizeModelCapabilitiesList = (values: unknown): ModelCapability[] => {
    const allowed = new Set<ModelCapability>(MODEL_CAPABILITY_ORDER);
    const normalized = new Set<ModelCapability>();
    if (!Array.isArray(values)) {
        return [];
    }
    for (const value of values) {
        const text = String(value || '').trim().toLowerCase();
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
    const detected = new Set<ModelCapability>();
    for (const rule of MODEL_PROFILE_RULES) {
        if (rule.patterns.some((pattern) => pattern.test(normalized))) {
            for (const capability of rule.capabilities) {
                detected.add(capability);
            }
        }
    }
    return MODEL_CAPABILITY_ORDER.filter((capability) => detected.has(capability));
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

    return MODEL_CAPABILITY_ORDER.filter((capability) => detected.has(capability));
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
    return MODEL_INPUT_CAPABILITY_ORDER.filter((capability) => detected.has(capability));
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
        const text = String(value || '').trim().toLowerCase();
        if (!text) continue;
        if (MODEL_CAPABILITY_ORDER.includes(text as ModelCapability)) {
            normalized.add(text as ModelCapability);
        }
    }
    return MODEL_CAPABILITY_ORDER.filter((capability) => normalized.has(capability));
};
