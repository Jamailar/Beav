import { getSettings } from '../db';
import {
    getImageProviderAdapter,
    getImageProviderCapabilities,
    normalizeImageProviderTemplate,
    type ImageProviderTemplate,
} from './imageProviderAdapters';
import { normalizeApiBaseUrl } from './urlUtils';
import { createGeneratedCoverAsset, type CoverAsset } from './coverStudioStore';

export interface CoverTitleInput {
    type: string;
    text: string;
}

export interface CoverPromptSwitches {
    learnTypography?: boolean;
    learnColorMood?: boolean;
    beautifyFace?: boolean;
    replaceBackground?: boolean;
}

export interface GenerateCoverInput {
    templateImage: string;
    baseImage: string;
    titles: CoverTitleInput[];
    styleHint?: string;
    promptSwitches?: CoverPromptSwitches;
    templateName?: string;
    count?: number;
    model?: string;
    provider?: string;
    providerTemplate?: ImageProviderTemplate | string;
    endpoint?: string;
    apiKey?: string;
    quality?: string;
}

export interface GenerateCoverResult {
    provider: string;
    providerTemplate: ImageProviderTemplate;
    model: string;
    aspectRatio: '3:4';
    size: string;
    quality: string;
    assets: CoverAsset[];
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

function normalizeTitleItems(titles: CoverTitleInput[]): Array<{ type: string; text: string }> {
    return (Array.isArray(titles) ? titles : [])
        .map((item) => ({
            type: String(item?.type || 'main').trim() || 'main',
            text: String(item?.text || '').trim(),
        }))
        .filter((item) => Boolean(item.text))
        .slice(0, 20);
}

function normalizePromptSwitches(raw: CoverPromptSwitches | undefined): Required<CoverPromptSwitches> {
    return {
        learnTypography: raw?.learnTypography !== false,
        learnColorMood: raw?.learnColorMood !== false,
        beautifyFace: raw?.beautifyFace === true,
        replaceBackground: raw?.replaceBackground === true,
    };
}

function buildCoverPrompt(input: {
    titles: Array<{ type: string; text: string }>;
    styleHint?: string;
    promptSwitches?: CoverPromptSwitches;
}): string {
    const titleLines = input.titles.map((item) => `- ${item.type}: ${item.text}`);
    const style = String(input.styleHint || '').trim();
    const switches = normalizePromptSwitches(input.promptSwitches);
    const switchPromptBlocks = [
        switches.learnTypography
            ? '- [学习字体样式=开] 学习模板图的字体视觉风格：字重、字宽感、笔画粗细、字距、行距、描边/阴影强度，并在底图中复现同款字体表达。'
            : '- [学习字体样式=关] 不强调复刻模板图字体细节，优先保证文字可读与版面清晰。',
        switches.learnColorMood
            ? '- [学习颜色氛围=开] 学习模板图的标题配色与整体氛围色（主色/辅色/强调色/明暗对比），在底图中迁移同款情绪与对比关系。'
            : '- [学习颜色氛围=关] 不强制跟随模板图配色，采用与底图内容更匹配且可读性优先的配色。',
        switches.beautifyFace
            ? '- [美颜=开] 若底图含人物，对人物做轻度自然美颜（肤色更干净、瑕疵轻修、五官不变形），保持真实不过度磨皮。'
            : '- [美颜=关] 不进行美颜增强，保持底图人物原始质感。',
        switches.replaceBackground
            ? '- [换背景=开] 在不改变主体身份与姿态前提下，可替换或重绘背景，使其更贴近模板图风格氛围并服务标题可读性。'
            : '- [换背景=关] 不更换背景，仅允许轻微背景清理，不改变场景主体语义。',
    ];
    return [
        '任务：基于双图输入，生成可直接发布的小红书封面（3:4 竖版）。',
        '输入角色：模板图=只负责标题样式/颜色氛围学习；底图=唯一允许被编辑的主体图。',
        '核心原则：模板图只学习不修改，所有可见改动必须发生在底图之上。',
        '硬性约束（必须遵守）：',
        '1) 禁止输出“模板图被修改后的版本”。',
        '2) 输出必须是“底图改造版封面”，主体身份、主体结构、主体语义来自底图。',
        '3) 如两图顺序不确定，自动识别：带明显标题排版风格的为模板图；承载主体内容的为底图。',
        '执行流程（必须遵守）：',
        '1. 先从模板图提炼“标题蓝图”（仅内部执行，不输出分析）：',
        '   - 文本区块数量与层级（主标题/副标题/角标/标签）。',
        '   - 每个区块的相对锚点位置（上中下、左右关系、留白关系）。',
        '   - 文本容器形态（底条、色块、角标、装饰块）与画面占比/视觉重心。',
        '2. 将“标题蓝图”迁移到底图：',
        '   - 保持底图主体身份、动作、服饰、场景逻辑不变。',
        '   - 标题布局尽量保持与模板图同构（位置关系和层级关系一致），避免遮挡主体关键区域。',
        '   - 允许为适配底图做微调，但不能改成另一套风格。',
        '3. 标题类型映射规则：',
        '   - main：最大、最强对比、第一视线落点。',
        '   - subtitle：围绕 main 提供补充信息，层级低于 main。',
        '   - badge：用于角标或爆点词，面积小但对比强。',
        '   - tag：短标签，作为辅助信息点缀。',
        '   - custom：按模板图最相近文本组件样式放置。',
        '4. 文本约束（强约束）：',
        '   - 必须逐字使用“标题输入”中的文本，不改写、不扩写、不缩写、不替换同义词。',
        '   - 中文必须清晰可读，禁止错别字、乱码、异体替换、缺字、多字。',
        '   - 文本过长时只允许智能换行与字距微调，不得改动文字内容。',
        '开关注入（按当前配置执行）：',
        ...switchPromptBlocks,
        '5. 成片目标：',
        '   - 一眼看出与模板图同款标题风格与版式语言。',
        '   - 同时保留底图的真实主体信息和场景可信度。',
        '   - 画面信息聚焦、点击感强、不过度堆砌元素。',
        '禁止项：',
        '- 不要添加水印、logo、边框贴纸、无关小字。',
        '- 不要脱离模板图风格另起版式，不要生成与模板无关的排版。',
        '- 不要大幅重绘底图主体，不要篡改主体身份或场景叙事。',
        '- 不要输出解释或分析文字，只输出最终封面图。',
        '标题输入（按顺序使用）：',
        ...titleLines,
        style ? `补充风格约束：${style}` : '',
        '最终要求：标题样式与布局高度贴近模板图，主体内容忠于底图，输出高完成度中文封面。',
    ].filter(Boolean).join('\n');
}

export async function generateCoverAssets(input: GenerateCoverInput): Promise<GenerateCoverResult> {
    const templateImage = String(input.templateImage || '').trim();
    const baseImage = String(input.baseImage || '').trim();
    if (!templateImage || !baseImage) {
        throw new Error('封面生成需要模板图和底图。');
    }
    const titleItems = normalizeTitleItems(input.titles || []);
    if (titleItems.length === 0) {
        throw new Error('请至少填写一条标题内容。');
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
    const quality = String(input.quality || settings.image_quality || 'standard').trim();
    const count = Math.max(1, Math.min(4, Number(input.count) || 1));
    const aspectRatio = '3:4' as const;
    const size = '1024x1536';

    if (!endpoint) {
        throw new Error('Image endpoint is missing. Please configure it in Settings.');
    }
    if (!apiKey) {
        throw new Error('Image API key is missing. Please configure it in Settings.');
    }

    const capabilities = getImageProviderCapabilities(providerTemplate, provider);
    if (!capabilities.supportsReferenceImages || capabilities.maxReferenceImages < 2) {
        throw new Error(`当前生图模板（${providerTemplate}）不支持“模板图+底图”的双图封面模式，请更换生图模板。`);
    }
    if (!capabilities.supportedModes.includes('image-to-image')) {
        throw new Error(`当前生图模板（${providerTemplate}）不支持图生图模式，请更换生图模板。`);
    }

    const prompt = buildCoverPrompt({
        titles: titleItems,
        styleHint: input.styleHint,
        promptSwitches: input.promptSwitches,
    });
    // Important: many image-edit APIs treat the first reference image as the editable base image.
    // We must keep baseImage first to avoid accidentally editing the style template image.
    const transportReferenceImages = [baseImage, templateImage];
    const adapter = getImageProviderAdapter(providerTemplate, provider);
    const generated = adapter.supportsMultiCount
        ? await adapter.generate({
            prompt,
            model,
            endpoint,
            apiKey,
            provider,
            providerTemplate,
            generationMode: 'image-to-image',
            referenceImages: transportReferenceImages,
            aspectRatio,
            size,
            quality,
            count,
        })
        : (await Promise.all(
            Array.from({ length: count }, async () => adapter.generate({
                prompt,
                model,
                endpoint,
                apiKey,
                provider,
                providerTemplate,
                generationMode: 'image-to-image',
                referenceImages: transportReferenceImages,
                aspectRatio,
                size,
                quality,
                count: 1,
            }))
        )).flat();

    if (generated.length === 0) {
        throw new Error('Cover generation returned no valid image payload.');
    }

    const titlePreview = titleItems.map((item) => item.text).join(' / ').slice(0, 80);
    const assets: CoverAsset[] = [];
    for (const output of generated.slice(0, count)) {
        const asset = await createGeneratedCoverAsset({
            imageBuffer: output.imageBuffer,
            mimeType: output.mimeType,
            prompt,
            title: titlePreview || undefined,
            templateName: input.templateName?.trim() || undefined,
            provider,
            providerTemplate,
            model,
            aspectRatio,
            size,
            quality,
        });
        assets.push(asset);
    }

    return {
        provider,
        providerTemplate,
        model,
        aspectRatio,
        size,
        quality,
        assets,
    };
}
