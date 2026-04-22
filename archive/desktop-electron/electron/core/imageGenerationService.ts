import { getSettings } from '../db';
import { createGeneratedMediaAsset, type MediaAsset } from './mediaLibraryStore';
import {
    getImageProviderAdapter,
    getImageProviderCapabilities,
    normalizeImageAspectRatio,
    normalizeImageSize,
    normalizeImageProviderTemplate,
    type ImageProviderTemplate,
    type ImageGenerationMode,
} from './imageProviderAdapters';
import { normalizeApiBaseUrl } from './urlUtils';

export interface GenerateImagesInput {
    prompt: string;
    projectId?: string;
    title?: string;
    generationMode?: ImageGenerationMode | string;
    referenceImages?: string[];
    count?: number;
    size?: string;
    quality?: string;
    model?: string;
    provider?: string;
    providerTemplate?: ImageProviderTemplate | string;
    endpoint?: string;
    apiKey?: string;
    aspectRatio?: string;
}

export interface GenerateImagesResult {
    provider: string;
    providerTemplate: ImageProviderTemplate;
    model: string;
    generationMode?: ImageGenerationMode;
    referenceImageCount: number;
    size: string;
    quality: string;
    aspectRatio?: string;
    assets: MediaAsset[];
}
const DASHSCOPE_LOCKED_IMAGE_MODEL = 'wan2.6-image';

function resolveDefaultImageEndpoint(template: ImageProviderTemplate): string {
    switch (template) {
        case 'gemini-openai-images':
            return 'https://generativelanguage.googleapis.com/v1beta/openai';
        case 'gemini-imagen-native':
        case 'gemini-generate-content':
            return 'https://generativelanguage.googleapis.com/v1beta';
        case 'dashscope-wan-native':
            return 'https://dashscope.aliyuncs.com';
        case 'ark-seedream-native':
            return 'https://ark.cn-beijing.volces.com/api/v3';
        case 'midjourney-proxy':
            return 'http://127.0.0.1:8080';
        case 'jimeng-openai-wrapper':
        case 'jimeng-images':
            return '';
        case 'openai-images':
        default:
            return 'https://api.openai.com/v1';
    }
}

function resolveDefaultImageModel(template: ImageProviderTemplate): string {
    switch (template) {
        case 'gemini-openai-images':
            return 'gemini-2.5-flash-image';
        case 'gemini-imagen-native':
            return 'imagen-4.0-generate-001';
        case 'dashscope-wan-native':
            return 'wan2.6-image';
        case 'ark-seedream-native':
            return 'doubao-seedream-4-0-250828';
        case 'midjourney-proxy':
            return 'midjourney';
        case 'jimeng-openai-wrapper':
        case 'jimeng-images':
            return 'jimeng-5.0';
        case 'gemini-generate-content':
            return 'gemini-2.0-flash-preview-image-generation';
        case 'openai-images':
        default:
            return 'gpt-image-1';
    }
}

export async function generateImagesToMediaLibrary(input: GenerateImagesInput): Promise<GenerateImagesResult> {
    const normalizedPrompt = String(input.prompt || '').trim();
    if (!normalizedPrompt) {
        throw new Error('Prompt is required');
    }

    const settings = (getSettings() || {}) as Record<string, unknown>;
    const provider = String(input.provider || settings.image_provider || 'openai-compatible').trim();
    const providerTemplate = normalizeImageProviderTemplate(
        String(input.providerTemplate || settings.image_provider_template || '').trim(),
        provider
    );
    const defaultImageEndpoint = resolveDefaultImageEndpoint(providerTemplate);
    const openAiFallbackEndpoint = providerTemplate === 'openai-images'
        ? String(settings.api_endpoint || '').trim()
        : '';
    const endpoint = normalizeApiBaseUrl(
        String(
            input.endpoint ||
            settings.image_endpoint ||
            openAiFallbackEndpoint ||
            defaultImageEndpoint ||
            ''
        ).trim()
    );
    const apiKey = String(input.apiKey || settings.image_api_key || settings.api_key || '').trim();
    const resolvedModel = String(input.model || settings.image_model || resolveDefaultImageModel(providerTemplate)).trim();
    const model = providerTemplate === 'dashscope-wan-native'
        ? DASHSCOPE_LOCKED_IMAGE_MODEL
        : resolvedModel;
    const size = normalizeImageSize(String(input.size || settings.image_size || '').trim());
    const quality = String(input.quality || settings.image_quality || 'standard').trim();
    const rawReferenceImages = Array.isArray(input.referenceImages)
        ? input.referenceImages.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 4)
        : [];
    const requestedGenerationMode = (
        input.generationMode === 'image-to-image' ||
        input.generationMode === 'reference-guided' ||
        input.generationMode === 'text-to-image'
            ? input.generationMode
            : undefined
    ) || (rawReferenceImages.length > 0 ? 'reference-guided' : 'text-to-image');
    const aspectRatio = normalizeImageAspectRatio(
        String(input.aspectRatio || settings.image_aspect_ratio || '').trim()
    );
    const count = Math.max(1, Math.min(4, Number(input.count) || 1));

    if (!endpoint) {
        throw new Error('Image endpoint is missing. Please configure it in Settings.');
    }
    if (!apiKey) {
        throw new Error('Image API key is missing. Please configure it in Settings.');
    }

    const adapter = getImageProviderAdapter(providerTemplate, provider);
    const capabilities = getImageProviderCapabilities(providerTemplate, provider);
    let generationMode: ImageGenerationMode = capabilities.supportedModes.includes(requestedGenerationMode)
        ? requestedGenerationMode
        : 'text-to-image';
    const referenceImages = capabilities.supportsReferenceImages
        ? rawReferenceImages.slice(0, capabilities.maxReferenceImages)
        : [];
    if (generationMode === 'reference-guided' && referenceImages.length === 0) {
        generationMode = 'text-to-image';
    }
    if (generationMode === 'image-to-image' && referenceImages.length === 0) {
        throw new Error('当前模式为图生图，请至少上传一张参考图。');
    }
    const images = adapter.supportsMultiCount
        ? await adapter.generate({
            prompt: normalizedPrompt,
            model,
            endpoint,
            apiKey,
            provider,
            providerTemplate,
            generationMode,
            referenceImages,
            aspectRatio,
            size,
            quality,
            count,
        })
        : (await Promise.all(
            Array.from({ length: count }, async () => adapter.generate({
                prompt: normalizedPrompt,
                model,
                endpoint,
                apiKey,
                provider,
                providerTemplate,
                generationMode,
                referenceImages,
                aspectRatio,
                size,
                quality,
                count: 1,
            }))
        )).flat();

    if (images.length === 0) {
        throw new Error('Image generation returned no valid image payload.');
    }

    const assets: MediaAsset[] = [];
    for (const output of images.slice(0, count)) {
        const asset = await createGeneratedMediaAsset({
            prompt: normalizedPrompt,
            dataBuffer: output.imageBuffer,
            mimeType: output.mimeType,
            projectId: input.projectId?.trim() || undefined,
            provider,
            model,
            size,
            quality,
            aspectRatio,
            title: input.title?.trim() || undefined,
        });
        assets.push(asset);
    }

    return {
        provider,
        providerTemplate,
        model,
        generationMode,
        referenceImageCount: referenceImages.length,
        size,
        quality,
        aspectRatio,
        assets,
    };
}
