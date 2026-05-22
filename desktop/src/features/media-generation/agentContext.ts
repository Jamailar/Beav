import {
    latestAssetOfKind,
    type GenerationAgentAssetSummary,
    type GenerationFeedSource,
    type GenerationRequest,
    type ReferenceItem,
    type StudioMode,
} from './feedModel';

export type GenerationAgentPreferredRole = 'image-director' | 'video-director' | 'audio-director';

export type GenerationAgentVoice = {
    id: string;
    name: string;
    language: string;
    languageBoost: string;
    languageZh: string;
    languageEn: string;
    source: string;
    genderHint: string;
    systemVoice: boolean;
    targetTtsModel: string;
    cloneModel: string;
};

export type GenerationAgentRuntimeContextParams = {
    mode: StudioMode;
    request: GenerationRequest;
    source?: GenerationFeedSource;
    sourceTitle?: string;
    recentAssets: GenerationAgentAssetSummary[];
    attachmentNote?: string;
    audioVoices?: GenerationAgentVoice[];
    audioLanguageBoost?: string;
};

export function generationAgentRoleForMode(mode: StudioMode): GenerationAgentPreferredRole {
    if (mode === 'video') return 'video-director';
    if (mode === 'audio') return 'audio-director';
    return 'image-director';
}

function dataUrlMimeType(dataUrl: string): string {
    const match = String(dataUrl || '').match(/^data:([^;,]+)[;,]/i);
    return String(match?.[1] || '').trim().toLowerCase();
}

export function summarizeGenerationReferenceItems(
    items: ReferenceItem[],
): Array<{ name: string; kind: 'image' | 'video' | 'audio' | 'file' }> {
    return items.map((item) => {
        const mimeType = dataUrlMimeType(item.dataUrl);
        const kind = mimeType.startsWith('image/')
            ? 'image'
            : mimeType.startsWith('video/')
                ? 'video'
                : mimeType.startsWith('audio/')
                    ? 'audio'
                    : 'file';
        return { name: item.name, kind };
    });
}

export function sanitizeGenerationRequestForAgent(request: GenerationRequest): Record<string, unknown> {
    if (request.type === 'cover') {
        return {
            ...request,
            templateImage: request.templateImage ? summarizeGenerationReferenceItems([request.templateImage])[0] : null,
            baseImage: request.baseImage ? summarizeGenerationReferenceItems([request.baseImage])[0] : null,
        };
    }
    if (request.type === 'video') {
        return {
            ...request,
            referenceItems: summarizeGenerationReferenceItems(request.referenceItems),
            firstClip: request.firstClip ? summarizeGenerationReferenceItems([request.firstClip])[0] : null,
            drivingAudio: request.drivingAudio ? summarizeGenerationReferenceItems([request.drivingAudio])[0] : null,
        };
    }
    if (request.type === 'image') {
        return {
            ...request,
            aspectRatio: 'agent-decides',
            size: 'agent-decides',
            referenceItems: summarizeGenerationReferenceItems(request.referenceItems),
        };
    }
    return { ...request };
}

function shortVoiceId(value: string): string {
    if (!value) return '';
    if (value.length <= 18) return value;
    return `${value.slice(0, 10)}...${value.slice(-4)}`;
}

function voiceLanguageValue(voice: GenerationAgentVoice): string {
    return (voice.languageBoost || voice.language).trim();
}

function voiceLanguageMatches(voice: GenerationAgentVoice, languageBoost: string): boolean {
    const selected = languageBoost.trim();
    if (!selected) return true;
    const value = voiceLanguageValue(voice);
    if (!value) return !voice.systemVoice;
    return value.split(',').map((item) => item.trim()).includes(selected);
}

export function summarizeAudioVoicesForAgent(
    voices: GenerationAgentVoice[],
    languageBoost: string,
    selectedVoiceId: string,
) {
    const selected = selectedVoiceId.trim();
    return voices
        .filter((voice) => voice.id === selected || voiceLanguageMatches(voice, languageBoost) || voice.source === 'subject')
        .sort((left, right) => {
            if (left.id === selected) return -1;
            if (right.id === selected) return 1;
            if (left.source === 'subject' && right.source !== 'subject') return -1;
            if (right.source === 'subject' && left.source !== 'subject') return 1;
            if (left.systemVoice !== right.systemVoice) return left.systemVoice ? 1 : -1;
            return left.name.localeCompare(right.name);
        })
        .slice(0, 40)
        .map((voice) => ({
            voiceId: voice.id,
            name: voice.name || shortVoiceId(voice.id),
            languageBoost: voice.languageBoost || voice.language || '',
            language: voice.languageZh || voice.languageEn || voice.language || '',
            genderHint: voice.genderHint || '',
            source: voice.source || (voice.systemVoice ? 'system' : 'custom'),
            targetTtsModel: voice.targetTtsModel || '',
            cloneModel: voice.cloneModel || '',
            selected: voice.id === selected,
        }));
}

export function buildGenerationAgentRuntimeContext(params: GenerationAgentRuntimeContextParams): string {
    const latest = {
        image: latestAssetOfKind(params.recentAssets, 'image') || null,
        cover: latestAssetOfKind(params.recentAssets, 'cover') || null,
        video: latestAssetOfKind(params.recentAssets, 'video') || null,
        audio: latestAssetOfKind(params.recentAssets, 'audio') || null,
    };
    return [
        '[GenerationAgentContext]',
        JSON.stringify({
            executionMode: 'auto',
            noSecondConfirmation: true,
            currentMode: params.mode,
            preferredRole: generationAgentRoleForMode(params.mode),
            source: params.source || 'standalone',
            sourceTitle: params.sourceTitle || '',
            currentRequest: sanitizeGenerationRequestForAgent(params.request),
            availableVoicesForAgent: params.mode === 'audio'
                ? summarizeAudioVoicesForAgent(
                    params.audioVoices || [],
                    params.audioLanguageBoost || '',
                    params.request.type === 'audio' ? params.request.voiceId : '',
                )
                : undefined,
            audioVoicePolicy: params.mode === 'audio'
                ? 'Use currentRequest.model and currentRequest.voiceId unless the task or available voices require a deliberate change. Voices are model-bound; each availableVoicesForAgent item includes targetTtsModel when known.'
                : undefined,
            recentAssets: params.recentAssets,
            latestAssets: latest,
            fuzzyReferencePolicy: 'When the user says 上一张图/刚才那张/之前的图片, use latestAssets.image by default; for video/audio use the matching latest asset.',
            imageSizingPolicy: 'In Agent mode, image aspectRatio and size are selected by the agent from the user goal. Ignore composer defaults unless the user explicitly asks for a ratio or pixel size.',
            attachmentNote: params.attachmentNote || '',
            executionExpectation: 'Use the current mode, request fields, available tools, and skill catalog to decide the next executable steps. Complete the requested generation without asking for a second confirmation unless a required field is genuinely missing.',
        }, null, 2),
        '[/GenerationAgentContext]',
    ].join('\n');
}
