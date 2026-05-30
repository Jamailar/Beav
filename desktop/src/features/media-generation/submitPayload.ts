import type {
    AudioGenerationRequest,
    CoverGenerationRequest,
    DigitalHumanGenerationRequest,
    GeneratedAsset,
    ImageGenerationRequest,
    VideoGenerationRequest,
} from './feedModel';

export type ModelRouteOverride = {
    sourceId?: string;
    baseURL?: string;
    apiKey?: string;
    presetId?: string;
    protocol?: string;
};

export type GenerationSubmitSource = 'manuscripts' | 'generation_studio';
export type GenerationQueueMode = 'free_creation' | 'ai_generation';

export type ImageSubmitPayload = {
    clientRequestId: string;
    prompt: string;
    bypassPromptOptimizer: true;
    projectId?: string;
    title?: string;
    generationMode: ImageGenerationRequest['generationMode'];
    referenceImages: string[];
    count: number;
    model?: string;
    provider?: string;
    providerTemplate?: string;
    aspectRatio: string;
    size?: string;
    quality: string;
    resolution: string;
    source: GenerationSubmitSource;
    queueMode: GenerationQueueMode;
} & ModelRouteOverride;

export type VideoSubmitPayload = {
    clientRequestId: string;
    prompt: string;
    projectId?: string;
    title?: string;
    generationMode: VideoGenerationRequest['generationMode'] | 'video-retalk';
    referenceImages?: string[];
    firstClip?: string;
    drivingAudio?: string;
    aspectRatio?: VideoGenerationRequest['aspectRatio'];
    resolution: VideoGenerationRequest['resolution'];
    durationSeconds: number;
    model: string;
    generateAudio?: boolean;
    source?: GenerationSubmitSource;
    queueMode?: GenerationQueueMode;
    input?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
};

export type AudioSubmitPayload = {
    clientRequestId: string;
    source: GenerationSubmitSource;
    queueMode: GenerationQueueMode;
    input: string;
    title?: string;
    projectId?: string;
    voiceId: string;
    voice_id: string;
    model?: string;
    targetTtsModel?: string;
    target_tts_model?: string;
    voiceTargetTtsModel?: string;
    languageBoost?: string;
    speed?: number;
    emotion?: string;
    responseFormat: string;
    returnAudioBinary: true;
} & ModelRouteOverride;

export type CoverGeneratePayload = {
    templateImage?: string;
    baseImage?: string;
    titles: Array<{ id: string; type: 'main'; text: string }>;
    titleMode: 'titles';
    titlePrompt?: undefined;
    promptSwitches: CoverGenerationRequest['promptSwitches'];
    templateName?: string;
    count: number;
    model?: string;
    provider?: string;
    providerTemplate?: string;
    quality: string;
} & ModelRouteOverride;

export type DigitalHumanSpeechPayload = {
    source: GenerationSubmitSource;
    surface: 'digital-human';
    queueMode: GenerationQueueMode;
    subjectId: string;
    input: string;
    title: string;
    projectId?: string;
    voiceId: string;
    voice_id: string;
    model?: string;
    languageBoost?: string;
    speed?: number;
    emotion?: string;
    responseFormat: 'mp3';
    waitForCompletion: true;
    timeoutMs: number;
};

export type DigitalHumanVideoSubmitInput = {
    clientRequestId: string;
    source: GenerationSubmitSource;
    queueMode?: GenerationQueueMode;
    request: DigitalHumanGenerationRequest;
    videoUrl: string;
    audioUrl: string;
};

export type ImageSubmitOptions = {
    clientRequestId: string;
    source: GenerationSubmitSource;
    queueMode?: GenerationQueueMode;
    routeOverride?: ModelRouteOverride;
    provider?: string;
    providerTemplate?: string;
};

export type VideoSubmitOptions = {
    clientRequestId: string;
    source: GenerationSubmitSource;
    queueMode?: GenerationQueueMode;
};

export type AudioSubmitOptions = {
    clientRequestId: string;
    source: GenerationSubmitSource;
    queueMode?: GenerationQueueMode;
    routeOverride?: ModelRouteOverride;
};

export type CoverSubmitOptions = {
    titleId: string;
    routeOverride?: ModelRouteOverride;
    provider?: string;
    providerTemplate?: string;
};

export type DigitalHumanSpeechOptions = {
    source: GenerationSubmitSource;
    queueMode?: GenerationQueueMode;
    input: string;
    ttsModel: string;
    languageBoost: string;
    speed: string;
    emotion: string;
    timeoutMs: number;
};

export function generationSubmitSource(source: string | undefined): GenerationSubmitSource {
    return source === 'manuscripts' ? 'manuscripts' : 'generation_studio';
}

export function audioPromptForSpeech(input: string): string {
    return input
        .replace(/〔停顿\s*([0-9.]+)\s*秒〕/g, (_match, seconds) => `<#${seconds}#>`)
        .replace(/【停顿\s*([0-9.]+)\s*秒】/g, (_match, seconds) => `<#${seconds}#>`);
}

function optionalTrimmed(value: string): string | undefined {
    const trimmed = value.trim();
    return trimmed || undefined;
}

function numericSpeed(value: string): number | undefined {
    const speed = Number(value || '1');
    return Number.isFinite(speed) ? speed : undefined;
}

export function buildImageSubmitPayload(
    request: ImageGenerationRequest,
    options: ImageSubmitOptions,
): ImageSubmitPayload {
    return {
        clientRequestId: options.clientRequestId,
        prompt: request.prompt.trim(),
        bypassPromptOptimizer: true,
        projectId: optionalTrimmed(request.projectId),
        title: optionalTrimmed(request.title),
        generationMode: request.referenceItems.length > 0 ? request.generationMode : 'text-to-image',
        referenceImages: request.referenceItems.map((item) => item.dataUrl),
        count: request.count,
        model: optionalTrimmed(request.model),
        ...options.routeOverride,
        provider: options.provider || undefined,
        providerTemplate: options.providerTemplate || undefined,
        aspectRatio: request.aspectRatio.trim() || '1:1',
        size: optionalTrimmed(request.size),
        quality: request.quality.trim() || 'medium',
        resolution: request.resolution.trim() || '2K',
        source: options.source,
        queueMode: options.queueMode || 'free_creation',
    };
}

export function buildVideoSubmitPayload(
    request: VideoGenerationRequest,
    options: VideoSubmitOptions,
): VideoSubmitPayload {
    return {
        clientRequestId: options.clientRequestId,
        prompt: request.prompt.trim(),
        projectId: optionalTrimmed(request.projectId),
        title: optionalTrimmed(request.title),
        generationMode: request.generationMode,
        referenceImages: request.referenceItems.map((item) => item.dataUrl),
        firstClip: request.firstClip?.dataUrl || undefined,
        drivingAudio: request.drivingAudio?.dataUrl || undefined,
        aspectRatio: request.aspectRatio,
        resolution: request.resolution,
        durationSeconds: request.durationSeconds,
        model: request.model,
        generateAudio: request.generateAudio,
        source: options.source,
        queueMode: options.queueMode || 'free_creation',
    };
}

export function buildAudioSubmitPayload(
    request: AudioGenerationRequest,
    options: AudioSubmitOptions,
): AudioSubmitPayload {
    return {
        clientRequestId: options.clientRequestId,
        source: options.source,
        queueMode: options.queueMode || 'free_creation',
        input: audioPromptForSpeech(request.prompt.trim()),
        title: optionalTrimmed(request.title),
        projectId: optionalTrimmed(request.projectId),
        voiceId: request.voiceId.trim(),
        voice_id: request.voiceId.trim(),
        model: optionalTrimmed(request.model),
        targetTtsModel: optionalTrimmed(request.voiceTargetTtsModel || request.model),
        target_tts_model: optionalTrimmed(request.voiceTargetTtsModel || request.model),
        voiceTargetTtsModel: optionalTrimmed(request.voiceTargetTtsModel || request.model),
        ...options.routeOverride,
        languageBoost: optionalTrimmed(request.languageBoost),
        speed: numericSpeed(request.speed),
        emotion: optionalTrimmed(request.emotion),
        responseFormat: 'mp3',
        returnAudioBinary: true,
    };
}

export function buildCoverGeneratePayload(
    request: CoverGenerationRequest,
    options: CoverSubmitOptions,
): CoverGeneratePayload {
    return {
        templateImage: request.templateImage?.dataUrl,
        baseImage: request.baseImage?.dataUrl,
        titles: [{ id: options.titleId, type: 'main', text: request.prompt.trim() }],
        titleMode: 'titles',
        titlePrompt: undefined,
        promptSwitches: request.promptSwitches,
        templateName: optionalTrimmed(request.title),
        count: request.count,
        model: optionalTrimmed(request.model),
        ...options.routeOverride,
        provider: options.provider || undefined,
        providerTemplate: options.providerTemplate || undefined,
        quality: request.quality.trim() || 'medium',
    };
}

export function buildDigitalHumanSpeechPayload(
    request: DigitalHumanGenerationRequest,
    options: DigitalHumanSpeechOptions,
): DigitalHumanSpeechPayload {
    return {
        source: options.source,
        surface: 'digital-human',
        queueMode: options.queueMode || 'free_creation',
        subjectId: request.roleId,
        input: options.input,
        title: request.title.trim() || `${request.roleName} 数字人口播声音`,
        projectId: optionalTrimmed(request.projectId),
        voiceId: request.voiceId.trim(),
        voice_id: request.voiceId.trim(),
        model: optionalTrimmed(options.ttsModel),
        languageBoost: optionalTrimmed(options.languageBoost),
        speed: numericSpeed(options.speed),
        emotion: optionalTrimmed(options.emotion),
        responseFormat: 'mp3',
        waitForCompletion: true,
        timeoutMs: options.timeoutMs,
    };
}

export function buildDigitalHumanVideoSubmitPayload(
    input: DigitalHumanVideoSubmitInput,
): VideoSubmitPayload {
    const { request } = input;
    return {
        clientRequestId: input.clientRequestId,
        source: input.source,
        queueMode: input.queueMode || 'free_creation',
        model: 'videoretalk',
        generationMode: 'video-retalk',
        title: request.title.trim() || `${request.roleName} 数字人口播`,
        prompt: request.prompt.trim(),
        projectId: optionalTrimmed(request.projectId),
        input: {
            video_url: input.videoUrl,
            audio_url: input.audioUrl,
        },
        parameters: {
            video_extension: false,
        },
        durationSeconds: request.durationSeconds,
        resolution: request.resolution,
        metadata: {
            surface: 'digital-human',
            subjectId: request.roleId,
        },
    };
}

export function normalizeGeneratedAssetsResult(value: { assets?: GeneratedAsset[] } | null | undefined): GeneratedAsset[] {
    return Array.isArray(value?.assets) ? value.assets : [];
}
