import type {
    AudioGenerationRequest,
    CoverGenerationRequest,
    DigitalHumanGenerationRequest,
    ImageGenerationRequest,
    VideoGenerationRequest,
} from './feedModel';

export type GenerationValidationConfig = {
    hasImageConfig?: boolean;
    hasVideoConfig?: boolean;
    hasVoiceConfig?: boolean;
    audioVoiceIdsForModel?: string[];
};

export function validateImageGenerationRequest(
    request: ImageGenerationRequest,
    config: GenerationValidationConfig,
): string | null {
    if (!request.prompt.trim()) return '请先输入提示词';
    if (!config.hasImageConfig) return '未检测到生图配置，请先在设置中补齐';
    if (!request.model.trim()) return '未检测到已添加的生图模型，请先在设置中添加生图模型';
    if (request.generationMode === 'image-to-image' && request.referenceItems.length === 0) {
        return '图生图模式至少需要 1 张参考图';
    }
    return null;
}

export function validateVideoGenerationRequest(
    request: VideoGenerationRequest,
    config: GenerationValidationConfig,
): string | null {
    if (!request.prompt.trim()) return '请先输入提示词';
    if (!config.hasVideoConfig) return '未检测到生视频配置，请先在设置中补齐';
    if (request.generationMode === 'reference-guided' && request.referenceItems.length === 0) {
        return '参考图视频模式至少需要 1 张参考图';
    }
    if (request.generationMode === 'first-last-frame' && request.referenceItems.length < 2) {
        return '首尾帧模式需要首帧和尾帧两张图片';
    }
    if (request.generationMode === 'continuation' && !request.firstClip?.dataUrl) {
        return '视频续写模式需要上传起始视频';
    }
    return null;
}

export function validateAudioGenerationRequest(
    request: AudioGenerationRequest,
    config: GenerationValidationConfig,
): string | null {
    if (!request.prompt.trim()) return '请先输入要合成的文本';
    if (!request.voiceId.trim()) return '请先填写 voice_id';
    if (!config.hasVoiceConfig) return '未检测到声音合成配置，请先在设置中补齐';
    if (config.audioVoiceIdsForModel && !config.audioVoiceIdsForModel.includes(request.voiceId.trim())) {
        return '当前音色不属于所选 TTS 模型，请重新选择匹配的音色';
    }
    return null;
}

export function validateDigitalHumanGenerationRequest(
    request: DigitalHumanGenerationRequest,
    config: GenerationValidationConfig,
): string | null {
    if (!request.prompt.trim()) return '请先输入文案';
    if (!request.roleId || !request.voiceId || !request.videoPath) {
        return '角色需要参考视频；音色会从视频音轨自动克隆，完成后即可生成';
    }
    if (!config.hasVoiceConfig) return '未检测到声音合成配置，请先在设置中补齐';
    return null;
}

export function validateCoverGenerationRequest(
    request: CoverGenerationRequest,
    config: GenerationValidationConfig,
): string | null {
    if (!request.prompt.trim()) return '请先输入封面标题或要求';
    if (!config.hasImageConfig) return '未检测到生图配置，请先在设置中补齐';
    if (!request.model.trim()) return '未检测到已添加的生图模型，请先在设置中添加生图模型';
    return null;
}
