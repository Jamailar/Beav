import {
    digitalHumanResultErrorMessage,
    extractDigitalHumanFinalAudioResult,
} from './digitalHuman';
import type {
    AudioGenerationRequest,
    CoverGenerationRequest,
    DigitalHumanGenerationRequest,
    GeneratedAsset,
    ImageGenerationRequest,
    VideoGenerationRequest,
} from './feedModel';
import {
    audioPromptForSpeech,
    buildAudioSubmitPayload,
    buildCoverGeneratePayload,
    buildDigitalHumanSpeechPayload,
    buildDigitalHumanVideoSubmitPayload,
    buildImageSubmitPayload,
    buildVideoSubmitPayload,
    type AudioSubmitOptions,
    type CoverSubmitOptions,
    type DigitalHumanSpeechOptions,
    type ImageSubmitOptions,
    type VideoSubmitOptions,
} from './submitPayload';

export type MediaGenerationJobSubmitResult = {
    success?: boolean;
    error?: string;
    jobId?: string;
};

export type CoverGenerationSubmitResult = {
    success?: boolean;
    error?: string;
    assets?: GeneratedAsset[];
};

export type DigitalHumanSubmitStage = 'preparing' | 'generating_audio' | 'submitting';

export type GenerationSubmitApi = {
    submitImage: (payload: ReturnType<typeof buildImageSubmitPayload>) => Promise<MediaGenerationJobSubmitResult> | MediaGenerationJobSubmitResult;
    submitVideo: (payload: ReturnType<typeof buildVideoSubmitPayload>) => Promise<MediaGenerationJobSubmitResult> | MediaGenerationJobSubmitResult;
    submitAudio: (payload: ReturnType<typeof buildAudioSubmitPayload>) => Promise<MediaGenerationJobSubmitResult> | MediaGenerationJobSubmitResult;
    prepareVideoRetalkSource: (payload: { path: string; resolution: DigitalHumanGenerationRequest['resolution'] }) => Promise<{ success?: boolean; error?: string; path?: string }> | { success?: boolean; error?: string; path?: string };
};

export type CoverSubmitApi = {
    generate: (payload: ReturnType<typeof buildCoverGeneratePayload>) => Promise<CoverGenerationSubmitResult> | CoverGenerationSubmitResult;
};

export type VoiceSubmitApi = {
    speech: (payload: ReturnType<typeof buildDigitalHumanSpeechPayload>) => Promise<unknown> | unknown;
};

export type DigitalHumanSubmitOptions = {
    clientRequestId: string;
    source: DigitalHumanSpeechOptions['source'];
    queueMode?: DigitalHumanSpeechOptions['queueMode'];
    ttsModel: string;
    languageBoost: string;
    speed: string;
    emotion: string;
    timeoutMs: number;
    uploadMedia: (path: string, contentType: string, keyPrefix: string) => Promise<string>;
    onStage?: (stage: DigitalHumanSubmitStage) => void;
};

function ensureJobResult(result: MediaGenerationJobSubmitResult, fallback: string): MediaGenerationJobSubmitResult {
    if (!result?.success || !result?.jobId) {
        throw new Error(result?.error || fallback);
    }
    return result;
}

export async function submitImageGeneration(
    api: GenerationSubmitApi,
    request: ImageGenerationRequest,
    options: ImageSubmitOptions,
): Promise<MediaGenerationJobSubmitResult> {
    return ensureJobResult(
        await api.submitImage(buildImageSubmitPayload(request, options)),
        '生图失败',
    );
}

export async function submitVideoGeneration(
    api: GenerationSubmitApi,
    request: VideoGenerationRequest,
    options: VideoSubmitOptions,
): Promise<MediaGenerationJobSubmitResult> {
    return ensureJobResult(
        await api.submitVideo(buildVideoSubmitPayload(request, options)),
        '生视频失败',
    );
}

export async function submitAudioGeneration(
    api: GenerationSubmitApi,
    request: AudioGenerationRequest,
    options: AudioSubmitOptions,
): Promise<MediaGenerationJobSubmitResult> {
    return ensureJobResult(
        await api.submitAudio(buildAudioSubmitPayload(request, options)),
        '生音频失败',
    );
}

export async function submitCoverGeneration(
    api: CoverSubmitApi,
    request: CoverGenerationRequest,
    options: CoverSubmitOptions,
): Promise<CoverGenerationSubmitResult> {
    const result = await api.generate(buildCoverGeneratePayload(request, options));
    if (!result?.success) {
        throw new Error(result?.error || '封面生成失败');
    }
    return result;
}

export async function submitDigitalHumanGeneration(
    generationApi: GenerationSubmitApi,
    voiceApi: VoiceSubmitApi,
    request: DigitalHumanGenerationRequest,
    options: DigitalHumanSubmitOptions,
): Promise<MediaGenerationJobSubmitResult> {
    options.onStage?.('preparing');
    const preparedVideo = await generationApi.prepareVideoRetalkSource({
        path: request.videoPath,
        resolution: request.resolution,
    });
    if (preparedVideo?.success === false || !preparedVideo?.path) {
        throw new Error(preparedVideo?.error || '参考视频不符合数字人生成要求');
    }

    const videoUrl = await options.uploadMedia(String(preparedVideo.path), 'video/mp4', 'ai/digital-human/video');
    options.onStage?.('generating_audio');
    const speechResult = await voiceApi.speech(buildDigitalHumanSpeechPayload(request, {
        source: options.source,
        queueMode: options.queueMode,
        input: audioPromptForSpeech(request.prompt.trim()),
        ttsModel: options.ttsModel,
        languageBoost: options.languageBoost,
        speed: options.speed,
        emotion: options.emotion,
        timeoutMs: options.timeoutMs,
    }));
    const finalAudio = extractDigitalHumanFinalAudioResult(speechResult);
    if (!finalAudio) {
        throw new Error(digitalHumanResultErrorMessage(speechResult));
    }

    const audioUrl = await options.uploadMedia(finalAudio.path, finalAudio.mimeType, 'ai/digital-human/audio');
    options.onStage?.('submitting');
    return ensureJobResult(
        await generationApi.submitVideo(buildDigitalHumanVideoSubmitPayload({
            clientRequestId: options.clientRequestId,
            source: options.source,
            queueMode: options.queueMode,
            request,
            videoUrl,
            audioUrl,
        })),
        '数字人视频提交失败',
    );
}
