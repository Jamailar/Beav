import { findAiPresetById, inferPresetIdByEndpoint, type AiSourceConfig } from '../../config/aiSources';
import { filterAiModelsByCapability, normalizeAiModelDescriptors, parseAiSources } from '../../pages/settings/shared';
import type { GenerationAgentVoice } from './agentContext';
import type { ModelRouteOverride } from './submitPayload';

const DEFAULT_AUDIO_LANGUAGE_OPTIONS = [
    { value: '', label: '自动' },
    { value: 'Chinese', label: '中文' },
    { value: 'English', label: '英文' },
] as const;

export type SettingsShape = {
    api_endpoint?: string;
    api_key?: string;
    ai_sources_json?: string;
    ai_model_routes_json?: string;
    default_ai_source_id?: string;
    image_provider?: string;
    image_endpoint?: string;
    image_api_key?: string;
    image_model?: string;
    image_provider_template?: string;
    image_aspect_ratio?: string;
    image_size?: string;
    image_quality?: string;
    video_endpoint?: string;
    video_api_key?: string;
    video_model?: string;
    voice_endpoint?: string;
    tts_endpoint?: string;
    voice_api_key?: string;
    tts_api_key?: string;
    voice_tts_model?: string;
    tts_model?: string;
};

export type PickerOption = {
    value: string;
    label: string;
    description?: string;
    disabled?: boolean;
    disabledReason?: string;
    tone?: 'danger';
};

export type VoiceListItem = GenerationAgentVoice & {
    id: string;
    name: string;
    language: string;
    languageBoost: string;
    languageZh: string;
    languageEn: string;
    status: string;
    source: string;
    ownerAssetId: string;
    genderHint: string;
    systemVoice: boolean;
    targetTtsModel: string;
    cloneModel: string;
    provider: string;
    supportedModels: string[];
};

export const DEFAULT_AUDIO_TTS_MODEL = 'cosyvoice-v3.5-plus';

export function normalizedModelKey(value: string): string {
    return value.trim().toLowerCase();
}

export function isMinimaxTtsModel(model: string): boolean {
    const key = normalizedModelKey(model);
    return key.includes('minimax') || key.startsWith('speech-') || key.startsWith('speech_');
}

export function modelKeysMatch(left: string, right: string): boolean {
    return normalizedModelKey(left) === normalizedModelKey(right);
}

export function stringArrayValue(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => String(item || '').trim())
        .filter(Boolean);
}

function shortVoiceId(value: string): string {
    if (!value) return '';
    if (value.length <= 18) return value;
    return `${value.slice(0, 10)}...${value.slice(-4)}`;
}

export function voiceMatchesAudioModel(voice: VoiceListItem, model: string): boolean {
    const selected = model.trim();
    if (!selected) return false;
    if (voice.systemVoice) return isMinimaxTtsModel(model);
    const target = voice.targetTtsModel.trim();
    if (target) return modelKeysMatch(target, selected);
    if (voice.supportedModels.length > 0) {
        return voice.supportedModels.some((candidate) => modelKeysMatch(candidate, selected));
    }
    return false;
}

export function getAiSourceTypeLabel(source: AiSourceConfig): string {
    const presetId = String(source.presetId || inferPresetIdByEndpoint(source.baseURL || '') || '').trim();
    const preset = findAiPresetById(presetId);
    if (preset?.label) return preset.label;
    if (presetId) return presetId;
    return source.protocol ? source.protocol.toUpperCase() : 'Custom';
}

export function getAiSourceModelDescriptors(source: AiSourceConfig) {
    return normalizeAiModelDescriptors([
        ...(source.modelsMeta || []),
        ...(source.models || []).map((id) => ({ id })),
        source.model ? { id: source.model } : null,
    ]);
}

export function buildImageModelOptions(settings: SettingsShape): PickerOption[] {
    const sources = parseAiSources(settings.ai_sources_json);
    const optionsByModel = new Map<string, { label: string; sourceLabels: string[] }>();

    for (const source of sources) {
        const imageModels = filterAiModelsByCapability(getAiSourceModelDescriptors(source), 'image');
        if (imageModels.length === 0) continue;

        const sourceType = getAiSourceTypeLabel(source);
        const sourceName = String(source.name || '').trim();
        const sourceLabel = sourceName && sourceName !== sourceType
            ? `${sourceType} · ${sourceName}`
            : sourceType;

        for (const model of imageModels) {
            const existing = optionsByModel.get(model.id);
            if (!existing) {
                optionsByModel.set(model.id, { label: model.id, sourceLabels: [sourceLabel] });
                continue;
            }
            if (!existing.sourceLabels.includes(sourceLabel)) {
                existing.sourceLabels.push(sourceLabel);
            }
        }
    }
    const currentImageModel = String(settings.image_model || '').trim();
    if (currentImageModel && !optionsByModel.has(currentImageModel)) {
        optionsByModel.set(currentImageModel, { label: currentImageModel, sourceLabels: ['当前设置'] });
    }

    return Array.from(optionsByModel.entries()).map(([value, option]) => ({
        value,
        label: option.label,
        description: option.sourceLabels.join(' / '),
    }));
}

export function buildAudioModelOptions(settings: SettingsShape): PickerOption[] {
    const sources = parseAiSources(settings.ai_sources_json);
    const optionsByModel = new Map<string, { label: string; sourceLabels: string[] }>();
    const addModelOption = (modelId: string, sourceLabel: string) => {
        const id = String(modelId || '').trim();
        if (!id) return;
        const existing = optionsByModel.get(id);
        if (!existing) {
            optionsByModel.set(id, { label: id, sourceLabels: [sourceLabel] });
            return;
        }
        if (!existing.sourceLabels.includes(sourceLabel)) {
            existing.sourceLabels.push(sourceLabel);
        }
    };

    for (const source of sources) {
        const descriptors = getAiSourceModelDescriptors(source);
        const ttsModels = filterAiModelsByCapability(descriptors, 'tts');
        const audioModels = ttsModels.length > 0 ? ttsModels : filterAiModelsByCapability(descriptors, 'audio');
        if (audioModels.length === 0) continue;

        const sourceType = getAiSourceTypeLabel(source);
        const sourceName = String(source.name || '').trim();
        const sourceLabel = sourceName && sourceName !== sourceType
            ? `${sourceType} · ${sourceName}`
            : sourceType;

        for (const model of audioModels) {
            addModelOption(model.id, sourceLabel);
        }
    }

    return Array.from(optionsByModel.entries()).map(([value, option]) => ({
        value,
        label: option.label,
        description: option.sourceLabels.join(' / '),
    }));
}

export function parseAiModelRoutes(settings: SettingsShape): Record<string, unknown> {
    const raw = settings.ai_model_routes_json;
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

export function sourceContainsModel(source: AiSourceConfig, capability: 'image' | 'tts' | 'audio', modelId: string): boolean {
    const target = modelId.trim();
    if (!target) return false;
    const descriptors = getAiSourceModelDescriptors(source);
    const scoped = capability === 'tts'
        ? (
            filterAiModelsByCapability(descriptors, 'tts').length > 0
                ? filterAiModelsByCapability(descriptors, 'tts')
                : filterAiModelsByCapability(descriptors, 'audio')
        )
        : capability === 'audio'
            ? filterAiModelsByCapability(descriptors, 'audio')
            : filterAiModelsByCapability(descriptors, capability);
    return scoped.some((model) => model.id === target);
}

export function aiSourceToRouteOverride(source: AiSourceConfig | null | undefined): ModelRouteOverride {
    if (!source) return {};
    return {
        sourceId: source.id || undefined,
        baseURL: source.baseURL || undefined,
        apiKey: source.apiKey || undefined,
        presetId: source.presetId || undefined,
        protocol: source.protocol || undefined,
    };
}

export function resolveSelectedModelOverride(
    settings: SettingsShape,
    scope: 'image' | 'voiceTts',
    capability: 'image' | 'tts' | 'audio',
    modelId: string,
): ModelRouteOverride {
    const selectedModel = modelId.trim();
    if (!selectedModel) return {};
    const sources = parseAiSources(settings.ai_sources_json);
    const candidates = sources.filter((source) => sourceContainsModel(source, capability, selectedModel));
    if (candidates.length === 0) return {};

    const routes = parseAiModelRoutes(settings);
    const route = routes[scope];
    const routeRecord = route && typeof route === 'object' && !Array.isArray(route)
        ? route as Record<string, unknown>
        : {};
    const routeSourceId = String(routeRecord.sourceId || routeRecord.source_id || '').trim();
    const routeModel = String(routeRecord.model || routeRecord.modelName || routeRecord.model_name || '').trim();
    const defaultSourceId = String(settings.default_ai_source_id || '').trim();

    const selectedSource = (
        routeSourceId && (!routeModel || routeModel === selectedModel)
            ? candidates.find((source) => source.id === routeSourceId)
            : null
    )
        || (defaultSourceId ? candidates.find((source) => source.id === defaultSourceId) : null)
        || candidates[0];

    return aiSourceToRouteOverride(selectedSource);
}

export function extractVoiceListItems(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    const hasVoiceId = Boolean(record.voice_id || record.voiceId || record.id || record.value);
    if (hasVoiceId) return [record];
    for (const key of ['voices', 'items', 'data', 'results']) {
        const items = extractVoiceListItems(record[key]);
        if (items.length > 0) return items;
    }
    return [];
}

export function normalizeVoiceList(value: unknown): VoiceListItem[] {
    const rawItems = extractVoiceListItems(value);

    return rawItems
        .map((item) => {
            if (!item || typeof item !== 'object') return null;
            const voice = item as Record<string, unknown>;
            const id = String(voice.voice_id || voice.voiceId || voice.id || voice.value || '').trim();
            if (!id) return null;
            return {
                id,
                name: String(voice.name || voice.title || id).trim() || id,
                language: String(voice.language || voice.lang || '').trim(),
                languageBoost: String(voice.languageBoost || voice.language_boost || voice.language || '').trim(),
                languageZh: String(voice.languageZh || voice.language_zh || '').trim(),
                languageEn: String(voice.languageEn || voice.language_en || '').trim(),
                status: String(voice.status || '').trim(),
                source: String(voice.source || '').trim(),
                ownerAssetId: String(voice.ownerAssetId || voice.assetId || voice.subjectId || '').trim(),
                genderHint: String(voice.genderHint || voice.gender_hint || '').trim(),
                systemVoice: Boolean(voice.systemVoice || voice.system_voice || voice.source === 'system'),
                targetTtsModel: String(voice.targetTtsModel || voice.target_tts_model || voice.ttsModel || voice.tts_model || voice.model || '').trim(),
                cloneModel: String(voice.cloneModel || voice.clone_model || '').trim(),
                provider: String(voice.provider || '').trim(),
                supportedModels: [
                    ...stringArrayValue(voice.supportedModels),
                    ...stringArrayValue(voice.supported_models),
                    ...stringArrayValue(voice.ttsModels),
                    ...stringArrayValue(voice.tts_models),
                ],
            } satisfies VoiceListItem;
        })
        .filter((item): item is VoiceListItem => {
            if (!item) return false;
            const status = item.status.trim().toLowerCase();
            return !['failed', 'error', 'dead_lettered', 'deleted', 'cancelled', 'canceled'].includes(status);
        });
}

function voiceLanguageValue(voice: VoiceListItem): string {
    return (voice.languageBoost || voice.language).trim();
}

export function voiceLanguageMatches(voice: VoiceListItem, languageBoost: string): boolean {
    const selected = languageBoost.trim();
    if (!selected) return true;
    const value = voiceLanguageValue(voice);
    if (!value) return !voice.systemVoice;
    return value.split(',').map((item) => item.trim()).includes(selected);
}

export function buildAudioLanguageOptions(voices: VoiceListItem[]): PickerOption[] {
    const options = new Map<string, PickerOption>();
    for (const option of DEFAULT_AUDIO_LANGUAGE_OPTIONS) {
        options.set(option.value, { ...option });
    }
    for (const voice of voices) {
        const value = voiceLanguageValue(voice);
        if (!value || options.has(value)) continue;
        options.set(value, {
            value,
            label: voice.languageZh || voice.languageEn || value,
        });
    }
    return Array.from(options.values());
}

export function buildAudioVoiceOptions(voices: VoiceListItem[], languageBoost: string): PickerOption[] {
    return voices
        .filter((voice) => voiceLanguageMatches(voice, languageBoost))
        .map((voice) => ({
            value: voice.id,
            label: voice.name,
            description: [
                shortVoiceId(voice.id),
                voice.source === 'subject' ? '角色音色' : voice.systemVoice ? '系统音色' : '',
                voice.languageZh || voice.languageEn || voiceLanguageValue(voice),
                voice.genderHint,
                voice.status && voice.status !== 'ready' ? voice.status : '',
            ].filter(Boolean).join(' · '),
        }));
}
