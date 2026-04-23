import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ExternalLink,
    FolderOpen,
    ImagePlus,
    Plus,
    RefreshCw,
    Save,
    Sparkles,
    Trash2,
    Type,
    Layers,
} from 'lucide-react';
import { appAlert, appConfirm } from '../utils/appDialogs';
import clsx from 'clsx';
import { resolveAssetUrl } from '../utils/pathManager';

type AiProtocol = 'openai' | 'gemini';

interface SettingsShape {
    api_endpoint?: string;
    api_key?: string;
    image_provider?: string;
    image_endpoint?: string;
    image_api_key?: string;
    image_model?: string;
    image_provider_template?: string;
    image_quality?: string;
    active_space_id?: string;
}

interface CoverTemplate {
    id: string;
    name: string;
    templateImage?: string;
    styleHint: string;
    titleGuide: string;
    promptSwitches?: CoverPromptSwitches;
    model: string;
    quality: string;
    count: number;
    updatedAt: string;
    // Backward compatibility fields
    prompt?: string;
    referenceImages?: string[];
}

interface CoverTitleEntry {
    id: string;
    type: 'main' | 'subtitle' | 'badge' | 'tag' | 'custom';
    text: string;
}

type CoverTitleInputMode = 'titles' | 'prompt';

interface CoverPromptSwitches {
    learnTypography: boolean;
    learnColorMood: boolean;
    beautifyFace: boolean;
    replaceBackground: boolean;
}

interface CoverAsset {
    id: string;
    title?: string;
    templateName?: string;
    prompt?: string;
    provider?: string;
    providerTemplate?: string;
    model?: string;
    aspectRatio?: string;
    size?: string;
    quality?: string;
    relativePath?: string;
    previewUrl?: string;
    exists?: boolean;
    updatedAt: string;
}

interface CoverListResponse {
    success?: boolean;
    error?: string;
    assets?: CoverAsset[];
}

interface CoverTemplateListResponse {
    success?: boolean;
    error?: string;
    templates?: unknown[];
    template?: unknown;
    imported?: number;
}

interface CoverStudioProps {
    isActive?: boolean;
}

interface CoverGenerationJob {
    id: string;
    status: 'pending' | 'success' | 'error';
    mode: CoverTitleInputMode;
    summary: string;
    submittedAt: string;
    count: number;
    assets: CoverAsset[];
    error?: string;
}

const DEFAULT_PROMPT_SWITCHES: CoverPromptSwitches = {
    learnTypography: true,
    learnColorMood: true,
    beautifyFace: false,
    replaceBackground: false,
};

const TEMPLATE_STORAGE_PREFIX = 'redbox:cover-templates:v1';
const getTemplateStorageKey = (spaceId: string) => `${TEMPLATE_STORAGE_PREFIX}:${spaceId || 'default'}`;

const IMAGE_PROVIDER_TEMPLATE_VALUES: Set<string> = new Set([
    'openai-images',
    'gemini-openai-images',
    'gemini-imagen-native',
    'dashscope-wan-native',
    'ark-seedream-native',
    'midjourney-proxy',
    'jimeng-openai-wrapper',
    'gemini-generate-content',
    'jimeng-images',
]);

const inferImageTemplateByProvider = (provider: string, currentTemplate = ''): string => {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const normalizedTemplate = String(currentTemplate || '').trim();
    if (IMAGE_PROVIDER_TEMPLATE_VALUES.has(normalizedTemplate)) {
        return normalizedTemplate;
    }
    if (normalizedProvider.includes('gemini-imagen') || normalizedProvider.includes('imagen')) {
        return 'gemini-imagen-native';
    }
    if (normalizedProvider.includes('gemini') || normalizedProvider.includes('nanobanana') || normalizedProvider.includes('nano-banana')) {
        return 'gemini-openai-images';
    }
    if (normalizedProvider.includes('dashscope') || normalizedProvider.includes('wan') || normalizedProvider.includes('通义万相')) {
        return 'dashscope-wan-native';
    }
    if (normalizedProvider.includes('buts')) {
        return 'dashscope-wan-native';
    }
    if (normalizedProvider.includes('ark') || normalizedProvider.includes('volc') || normalizedProvider.includes('seedream') || normalizedProvider.includes('方舟')) {
        return 'ark-seedream-native';
    }
    if (normalizedProvider.includes('midjourney') || normalizedProvider === 'mj') {
        return 'midjourney-proxy';
    }
    if (normalizedProvider.includes('jimeng') || normalizedProvider.includes('即梦')) {
        return 'ark-seedream-native';
    }
    return 'openai-images';
};

const IMAGE_TEMPLATE_DEFAULT_ENDPOINTS: Record<string, string> = {
    'openai-images': 'https://api.openai.com/v1',
    'gemini-openai-images': 'https://generativelanguage.googleapis.com/v1beta/openai',
    'gemini-imagen-native': 'https://generativelanguage.googleapis.com/v1beta',
    'dashscope-wan-native': 'https://dashscope.aliyuncs.com',
    'ark-seedream-native': 'https://ark.cn-beijing.volces.com/api/v3',
    'midjourney-proxy': 'http://127.0.0.1:8080',
    'jimeng-openai-wrapper': '',
    'gemini-generate-content': 'https://generativelanguage.googleapis.com/v1beta',
    'jimeng-images': '',
};

const resolveDefaultImageEndpoint = (provider: string, template: string): string => {
    const normalizedTemplate = inferImageTemplateByProvider(provider, template);
    if (Object.prototype.hasOwnProperty.call(IMAGE_TEMPLATE_DEFAULT_ENDPOINTS, normalizedTemplate)) {
        return IMAGE_TEMPLATE_DEFAULT_ENDPOINTS[normalizedTemplate];
    }
    return IMAGE_TEMPLATE_DEFAULT_ENDPOINTS['openai-images'];
};

const resolveImageModelFetchProtocol = (template: string): AiProtocol => {
    const normalized = String(template || '').trim();
    if (normalized === 'gemini-openai-images' || normalized === 'gemini-imagen-native' || normalized === 'gemini-generate-content') {
        return 'gemini';
    }
    return 'openai';
};

const resolveImageModelFetchPresetId = (provider: string, template: string, endpoint: string): string | undefined => {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const normalizedTemplate = String(template || '').trim().toLowerCase();
    const normalizedEndpoint = String(endpoint || '').trim().toLowerCase();
    const merged = `${normalizedProvider} ${normalizedTemplate} ${normalizedEndpoint}`;

    if (merged.includes('buts')) return 'buts';
    if (
        normalizedTemplate === 'dashscope-wan-native'
        || merged.includes('dashscope')
        || merged.includes('bailian')
        || merged.includes('wan')
    ) {
        return 'dashscope';
    }
    if (
        normalizedTemplate === 'ark-seedream-native'
        || merged.includes('ark')
        || merged.includes('volc')
        || merged.includes('seedream')
        || merged.includes('doubao')
        || merged.includes('jimeng')
    ) {
        return 'ark';
    }
    if (
        normalizedTemplate === 'gemini-openai-images'
        || normalizedTemplate === 'gemini-imagen-native'
        || normalizedTemplate === 'gemini-generate-content'
        || merged.includes('gemini')
        || merged.includes('generativelanguage.googleapis.com')
    ) {
        return 'gemini';
    }
    if (merged.includes('openrouter')) return 'openrouter';
    if (merged.includes('deepseek')) return 'deepseek';
    if (merged.includes('minimax')) return 'minimax-cn';
    if (merged.includes('api.openai.com') || normalizedTemplate === 'openai-images') return 'openai';
    return undefined;
};

const normalizeImageModelFetchBaseURL = (baseURL: string, template: string): string => {
    const normalizedBase = String(baseURL || '').trim().replace(/\/+$/, '');
    if (!normalizedBase) return '';
    if (template === 'gemini-openai-images' && /generativelanguage\.googleapis\.com/i.test(normalizedBase)) {
        return normalizedBase.replace(/\/openai(?:\/.*)?$/i, '');
    }
    if (template === 'dashscope-wan-native') {
        const stripped = normalizedBase
            .replace(/\/compatible-mode\/v\d+(\.\d+)?(?:\/.*)?$/i, '')
            .replace(/\/api\/v1(?:\/.*)?$/i, '')
            .replace(/\/v1(?:\/.*)?$/i, '');
        return `${stripped}/compatible-mode/v1`;
    }
    return normalizedBase;
};

const isImageTemplateRemoteModelFetchEnabled = (template: string): boolean => {
    const normalized = String(template || '').trim();
    return (
        normalized === 'openai-images' ||
        normalized === 'gemini-openai-images' ||
        normalized === 'gemini-imagen-native' ||
        normalized === 'gemini-generate-content' ||
        normalized === 'dashscope-wan-native' ||
        normalized === 'ark-seedream-native'
    );
};

const isLikelyLocalEndpoint = (baseURL: string): boolean => {
    const normalized = String(baseURL || '').toLowerCase();
    return (
        normalized.includes('127.0.0.1') ||
        normalized.includes('localhost') ||
        normalized.includes('0.0.0.0') ||
        normalized.includes('::1')
    );
};

const TITLE_TYPE_OPTIONS: Array<{ value: CoverTitleEntry['type']; label: string }> = [
    { value: 'main', label: '主标题' },
    { value: 'subtitle', label: '副标题' },
    { value: 'badge', label: '角标' },
    { value: 'tag', label: '标签词' },
    { value: 'custom', label: '自定义' },
];

const TITLE_INPUT_MODE_OPTIONS: Array<{ value: CoverTitleInputMode; label: string; description: string }> = [
    { value: 'titles', label: '标题模式', description: '你自己写封面文案，AI按这些字来出图。' },
    { value: 'prompt', label: '提示词模式', description: '你只写意图和方向，AI自己决定封面上写什么。' },
];

const PROMPT_SWITCH_OPTIONS: Array<{
    key: keyof CoverPromptSwitches;
    label: string;
    description: string;
}> = [
    { key: 'learnTypography', label: '学习字体样式', description: '学习模板图中的标题字体风格（字重/描边/阴影/字距）' },
    { key: 'learnColorMood', label: '学习颜色氛围', description: '学习模板图主辅色和画面氛围色' },
    { key: 'beautifyFace', label: '美颜', description: '人物轻度自然美颜，保持真实不变形' },
    { key: 'replaceBackground', label: '换背景', description: '在不改主体的前提下允许替换或重绘背景' },
];

const createTemplateId = () => `cover_tpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const createTitleId = () => `cover_title_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const createCoverGenerationJobId = () => `cover_job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const createTemplateName = () => {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `封面模板_${stamp}`;
};

const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
});

const normalizePromptSwitches = (raw: unknown): CoverPromptSwitches => {
    const item = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    return {
        learnTypography: item.learnTypography !== false,
        learnColorMood: item.learnColorMood !== false,
        beautifyFace: item.beautifyFace === true,
        replaceBackground: item.replaceBackground === true,
    };
};

const normalizeTemplate = (raw: unknown): CoverTemplate | null => {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    const name = String(item.name || '').trim();
    if (!name) return null;

    const referenceImages = Array.isArray(item.referenceImages)
        ? item.referenceImages.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 4)
        : [];

    const templateImage = String(
        item.templateImage ||
        referenceImages[0] ||
        ''
    ).trim();

    const count = Number(item.count || 1);
    return {
        id: String(item.id || createTemplateId()),
        name,
        templateImage: templateImage || undefined,
        styleHint: String(item.styleHint || ''),
        titleGuide: String(item.titleGuide || item.prompt || ''),
        promptSwitches: normalizePromptSwitches(item.promptSwitches),
        model: String(item.model || 'gpt-image-1'),
        quality: String(item.quality || 'auto'),
        count: Math.max(1, Math.min(4, Number.isFinite(count) ? Math.floor(count) : 1)),
        updatedAt: String(item.updatedAt || new Date().toISOString()),
        prompt: String(item.prompt || ''),
        referenceImages,
    };
};

const normalizeTitleEntries = (entries: CoverTitleEntry[]): Array<{ type: string; text: string }> => {
    return entries
        .map((item) => ({
            type: String(item.type || 'main').trim() || 'main',
            text: String(item.text || '').trim(),
        }))
        .filter((item) => Boolean(item.text))
        .slice(0, 20);
};

export function CoverStudio({ isActive = false }: CoverStudioProps) {
    const [settings, setSettings] = useState<SettingsShape>({});
    const [spaceId, setSpaceId] = useState('default');

    const [templates, setTemplates] = useState<CoverTemplate[]>([]);
    const [activeTemplateId, setActiveTemplateId] = useState('');

    const [templateImage, setTemplateImage] = useState<{ name: string; dataUrl: string } | null>(null);
    const [count, setCount] = useState(1);
    const [model, setModel] = useState('gpt-image-1');
    const [quality, setQuality] = useState('auto');

    const [baseImage, setBaseImage] = useState<{ name: string; dataUrl: string } | null>(null);
    const [promptSwitches, setPromptSwitches] = useState<CoverPromptSwitches>(DEFAULT_PROMPT_SWITCHES);
    const [titleInputMode, setTitleInputMode] = useState<CoverTitleInputMode>('titles');
    const [titleEntries, setTitleEntries] = useState<CoverTitleEntry[]>([
        { id: createTitleId(), type: 'main', text: '' },
    ]);
    const [titlePrompt, setTitlePrompt] = useState('');

    const [isReadingTemplateImage, setIsReadingTemplateImage] = useState(false);
    const [isReadingBaseImage, setIsReadingBaseImage] = useState(false);
    const [generateError, setGenerateError] = useState('');

    const [generationJobs, setGenerationJobs] = useState<CoverGenerationJob[]>([]);
    const [recentAssets, setRecentAssets] = useState<CoverAsset[]>([]);

    const storageKey = useMemo(() => getTemplateStorageKey(spaceId), [spaceId]);
    const normalizeTemplateList = useCallback((items: unknown[] | undefined): CoverTemplate[] => (
        Array.isArray(items)
            ? items.map(normalizeTemplate).filter((item): item is CoverTemplate => Boolean(item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            : []
    ), []);
    const imageTemplate = useMemo(
        () => inferImageTemplateByProvider(settings.image_provider || 'openai-compatible', settings.image_provider_template || ''),
        [settings.image_provider, settings.image_provider_template]
    );
    const resolvedEndpoint = (settings.image_endpoint || settings.api_endpoint || '').trim();
    const resolvedApiKey = (settings.image_api_key || settings.api_key || '').trim();
    const hasImageConfig = Boolean(resolvedEndpoint) && Boolean(resolvedApiKey);
    const normalizedTitles = useMemo(() => normalizeTitleEntries(titleEntries), [titleEntries]);
    const normalizedTitlePrompt = useMemo(() => titlePrompt.trim(), [titlePrompt]);
    const hasRequiredInputs = Boolean(templateImage?.dataUrl)
        && Boolean(baseImage?.dataUrl)
        && (
            titleInputMode === 'prompt'
                ? Boolean(normalizedTitlePrompt)
                : normalizedTitles.length > 0
        );
    const pendingJobCount = useMemo(
        () => generationJobs.filter((item) => item.status === 'pending').length,
        [generationJobs]
    );

    const resetEditor = useCallback(() => {
        setActiveTemplateId('');
        setTemplateImage(null);
        setCount(1);
        setModel(settings.image_model || 'gpt-image-1');
        setQuality(settings.image_quality || 'auto');
        setBaseImage(null);
        setPromptSwitches(DEFAULT_PROMPT_SWITCHES);
        setTitleInputMode('titles');
        setTitleEntries([{ id: createTitleId(), type: 'main', text: '' }]);
        setTitlePrompt('');
        setGenerateError('');
    }, [settings.image_model, settings.image_quality]);

    const loadSettings = useCallback(async () => {
        try {
            const raw = await window.ipcRenderer.getSettings();
            const next = (raw || {}) as SettingsShape;
            setSettings(next);
            setSpaceId(next.active_space_id || 'default');
            setModel(next.image_model || 'gpt-image-1');
            setQuality(next.image_quality || 'auto');
        } catch (error) {
            console.error('Failed to load cover settings:', error);
        }
    }, []);

    const loadRecentAssets = useCallback(async () => {
        try {
            const result = await window.ipcRenderer.invoke('cover:list', { limit: 120 }) as CoverListResponse;
            if (!result?.success) {
                setRecentAssets([]);
                return;
            }
            setRecentAssets(Array.isArray(result.assets) ? result.assets.slice(0, 20) : []);
        } catch (error) {
            console.error('Failed to load cover assets:', error);
            setRecentAssets([]);
        }
    }, []);

    const loadTemplates = useCallback(() => {
        if (!storageKey) {
            setTemplates([]);
            return Promise.resolve();
        }
        return (async () => {
            try {
                const result = await window.ipcRenderer.cover.templates.list() as CoverTemplateListResponse;
                if (!result?.success) {
                    console.error('Failed to load cover templates:', result?.error || 'unknown error');
                    return;
                }
                setTemplates(normalizeTemplateList(result.templates));
            } catch (error) {
                console.error('Failed to load cover templates:', error);
            }
        })();
    }, [normalizeTemplateList, storageKey]);

    const migrateLegacyTemplates = useCallback(async () => {
        if (!storageKey) return false;
        let legacyTemplates: CoverTemplate[] = [];
        try {
            const raw = window.localStorage.getItem(storageKey);
            if (!raw) return false;
            const parsed = JSON.parse(raw);
            legacyTemplates = Array.isArray(parsed)
                ? parsed.map(normalizeTemplate).filter((item): item is CoverTemplate => Boolean(item))
                : [];
        } catch (error) {
            console.error('Failed to parse legacy cover templates:', error);
            return false;
        }
        if (legacyTemplates.length === 0) {
            return false;
        }
        try {
            const result = await window.ipcRenderer.cover.templates.importLegacy({
                templates: legacyTemplates as unknown as Record<string, unknown>[],
            }) as CoverTemplateListResponse;
            if (!result?.success) {
                console.error('Failed to migrate legacy cover templates:', result?.error || 'unknown error');
                return false;
            }
            window.localStorage.removeItem(storageKey);
            setTemplates(normalizeTemplateList(result.templates));
            return (result.imported || 0) > 0;
        } catch (error) {
            console.error('Failed to migrate legacy cover templates:', error);
            return false;
        }
    }, [normalizeTemplateList, storageKey]);

    useEffect(() => {
        if (!isActive) return;
        void loadSettings();
        void loadRecentAssets();
    }, [isActive, loadRecentAssets, loadSettings]);

    useEffect(() => {
        if (!isActive) return;
        let cancelled = false;
        void (async () => {
            await loadTemplates();
            if (cancelled) return;
            const migrated = await migrateLegacyTemplates();
            if (!cancelled && migrated) {
                await loadTemplates();
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [isActive, loadTemplates, migrateLegacyTemplates]);

    useEffect(() => {
        const handleTemplatesUpdated = (event: Event) => {
            const detail = (event as CustomEvent<{ spaceId?: string }>).detail;
            if (detail?.spaceId && String(detail.spaceId) !== String(spaceId)) {
                return;
            }
            void loadTemplates();
        };
        window.addEventListener('cover:templates-updated', handleTemplatesUpdated as EventListener);
        return () => {
            window.removeEventListener('cover:templates-updated', handleTemplatesUpdated as EventListener);
        };
    }, [loadTemplates, spaceId]);

    const applyTemplate = useCallback((template: CoverTemplate) => {
        setActiveTemplateId(template.id);
        setCount(Math.max(1, Math.min(4, Number(template.count) || 1)));
        setModel(template.model || 'gpt-image-1');
        setQuality(template.quality || 'auto');
        setPromptSwitches(normalizePromptSwitches(template.promptSwitches));
        setTemplateImage(template.templateImage
            ? { name: `${template.name}-模板图`, dataUrl: template.templateImage }
            : null
        );
    }, []);

    const saveTemplate = useCallback(async () => {
        if (!templateImage?.dataUrl) {
            void appAlert('请先上传模板图');
            return;
        }

        const now = new Date().toISOString();
        const existing = activeTemplateId
            ? templates.find((item) => item.id === activeTemplateId)
            : null;
        const name = (existing?.name || '').trim() || createTemplateName();
        const result = await window.ipcRenderer.cover.templates.save({
            template: {
                ...(existing || {}),
                id: existing?.id || activeTemplateId || createTemplateId(),
                name,
                templateImage: templateImage.dataUrl,
                promptSwitches: { ...promptSwitches },
                model: model.trim() || 'gpt-image-1',
                quality,
                count: Math.max(1, Math.min(4, Math.floor(Number(count) || 1))),
                updatedAt: now,
            }
        }) as CoverTemplateListResponse;
        if (!result?.success) {
            void appAlert(result?.error || '保存模板失败');
            return;
        }

        const nextTemplates = normalizeTemplateList(result.templates);
        setTemplates(nextTemplates);
        const savedTemplate = normalizeTemplate(result.template);
        if (savedTemplate?.id) {
            setActiveTemplateId(savedTemplate.id);
        }
        window.dispatchEvent(new CustomEvent('cover:templates-updated', {
            detail: { spaceId },
        }));
    }, [activeTemplateId, count, model, normalizeTemplateList, promptSwitches, quality, spaceId, templateImage, templates]);

    const deleteTemplate = useCallback(async (templateId: string) => {
        const target = templates.find((item) => item.id === templateId);
        if (!target) return;
        if (!(await appConfirm(`确认删除模板「${target.name}」吗？`, { title: '删除模板', confirmLabel: '删除', tone: 'danger' }))) return;
        const result = await window.ipcRenderer.cover.templates.delete({
            templateId,
        }) as CoverTemplateListResponse;
        if (!result?.success) {
            void appAlert(result?.error || '删除模板失败');
            return;
        }
        setTemplates(normalizeTemplateList(result.templates));
        if (activeTemplateId === templateId) {
            resetEditor();
        }
        window.dispatchEvent(new CustomEvent('cover:templates-updated', {
            detail: { spaceId },
        }));
    }, [activeTemplateId, normalizeTemplateList, resetEditor, spaceId, templates]);

    const handleTemplateImageFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setIsReadingTemplateImage(true);
        try {
            const dataUrl = await readFileAsDataUrl(file);
            setTemplateImage({ name: file.name, dataUrl });
        } catch (error) {
            console.error('Failed to parse template image:', error);
            setGenerateError('模板图读取失败，请重试');
        } finally {
            setIsReadingTemplateImage(false);
            event.target.value = '';
        }
    }, []);

    const handleBaseImageFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setIsReadingBaseImage(true);
        try {
            const dataUrl = await readFileAsDataUrl(file);
            setBaseImage({ name: file.name, dataUrl });
        } catch (error) {
            console.error('Failed to parse base image:', error);
            setGenerateError('底图读取失败，请重试');
        } finally {
            setIsReadingBaseImage(false);
            event.target.value = '';
        }
    }, []);

    const addTitleEntry = useCallback(() => {
        setTitleEntries((prev) => [...prev, { id: createTitleId(), type: 'subtitle', text: '' }]);
    }, []);

    const updateTitleEntry = useCallback((id: string, patch: Partial<CoverTitleEntry>) => {
        setTitleEntries((prev) => prev.map((item) => item.id === id ? { ...item, ...patch } : item));
    }, []);

    const removeTitleEntry = useCallback((id: string) => {
        setTitleEntries((prev) => {
            const next = prev.filter((item) => item.id !== id);
            return next.length > 0 ? next : [{ id: createTitleId(), type: 'main', text: '' }];
        });
    }, []);

    const handleGenerate = useCallback(() => {
        if (!templateImage?.dataUrl) {
            setGenerateError('请先上传模板图');
            return;
        }
        if (!baseImage?.dataUrl) {
            setGenerateError('请先上传底图');
            return;
        }
        if (titleInputMode === 'prompt' && !normalizedTitlePrompt) {
            setGenerateError('请先填写提示词');
            return;
        }
        if (titleInputMode === 'titles' && normalizedTitles.length === 0) {
            setGenerateError('请至少填写一条标题内容');
            return;
        }

        setGenerateError('');
        const jobId = createCoverGenerationJobId();
        const submittedAt = new Date().toISOString();
        const summary = titleInputMode === 'prompt'
            ? normalizedTitlePrompt
            : normalizedTitles.map((item) => `${item.type}：${item.text}`).join(' / ');
        const nextJob: CoverGenerationJob = {
            id: jobId,
            status: 'pending',
            mode: titleInputMode,
            summary,
            submittedAt,
            count: Math.max(1, Math.min(4, Math.floor(Number(count) || 1))),
            assets: [],
        };
        setGenerationJobs((prev) => [nextJob, ...prev].slice(0, 24));

        void (async () => {
            try {
                const result = await window.ipcRenderer.invoke('cover:generate', {
                    templateImage: templateImage.dataUrl,
                    baseImage: baseImage.dataUrl,
                    titles: normalizedTitles,
                    titleMode: titleInputMode,
                    titlePrompt: titleInputMode === 'prompt' ? normalizedTitlePrompt : undefined,
                    styleHint: templates.find((item) => item.id === activeTemplateId)?.styleHint || undefined,
                    titleGuide: templates.find((item) => item.id === activeTemplateId)?.titleGuide || undefined,
                    promptSwitches,
                    templateName: templates.find((item) => item.id === activeTemplateId)?.name || undefined,
                    count: Math.max(1, Math.min(4, Math.floor(Number(count) || 1))),
                    model: model.trim() || undefined,
                    provider: settings.image_provider || undefined,
                    providerTemplate: imageTemplate || undefined,
                    quality: quality.trim() || undefined,
                }) as { success?: boolean; error?: string; assets?: CoverAsset[] };

                if (!result?.success) {
                    setGenerationJobs((prev) => prev.map((item) => (
                        item.id === jobId
                            ? { ...item, status: 'error', error: result?.error || '封面生成失败' }
                            : item
                    )));
                    return;
                }
                const list = Array.isArray(result.assets) ? result.assets : [];
                setGenerationJobs((prev) => prev.map((item) => (
                    item.id === jobId
                        ? { ...item, status: 'success', assets: list, error: '' }
                        : item
                )));
                await loadRecentAssets();
            } catch (error) {
                console.error('Failed to generate cover assets:', error);
                setGenerationJobs((prev) => prev.map((item) => (
                    item.id === jobId
                        ? { ...item, status: 'error', error: '封面生成失败' }
                        : item
                )));
            }
        })();
    }, [
        activeTemplateId,
        baseImage,
        count,
        imageTemplate,
        loadRecentAssets,
        model,
        normalizedTitlePrompt,
        normalizedTitles,
        promptSwitches,
        quality,
        settings.image_provider,
        templateImage,
        templates,
        titleInputMode,
    ]);

    const removeGenerationJob = useCallback((jobId: string) => {
        setGenerationJobs((prev) => prev.filter((item) => item.id !== jobId));
    }, []);

    return (
        <div className="flex h-full min-h-0 bg-background overflow-hidden">
            <div className="flex-1 min-h-0 flex overflow-hidden">
                <div className="w-80 border-r border-border bg-surface-secondary/30 flex flex-col shrink-0">
                    <div className="p-4 border-b border-border flex items-center justify-between">
                        <div className="inline-flex items-center gap-2 text-sm font-semibold text-text-primary">
                            <Layers className="w-4 h-4 text-accent-primary" />
                            模板画廊
                        </div>
                        <span className="text-[11px] text-text-tertiary">{templates.length}</span>
                    </div>
                    <div className="px-4 py-2 text-[11px] text-text-tertiary border-b border-border">
                        空间：<span className="font-mono">{spaceId}</span>
                    </div>

                    <div className="flex-1 overflow-auto p-2">
                        {templates.length === 0 ? (
                            <div className="text-center text-text-tertiary text-xs py-8">还没有模板，请在右侧先上传模板图并保存。</div>
                        ) : (
                            <div className="grid grid-cols-2 gap-2">
                                {templates.map((template) => {
                                    const active = activeTemplateId === template.id;
                                    return (
                                        <div key={template.id} className="relative">
                                            <button
                                                type="button"
                                                onClick={() => applyTemplate(template)}
                                                className={clsx(
                                                    'w-full text-left rounded-lg border overflow-hidden transition-all bg-surface-primary',
                                                    active
                                                        ? 'border-accent-primary ring-1 ring-accent-primary/40 shadow-sm'
                                                        : 'border-transparent hover:border-border'
                                                )}
                                                title={`选择模板：${template.name}`}
                                            >
                                                <div className="w-full aspect-[3/4] bg-surface-secondary">
                                                    {template.templateImage ? (
                                                        <img src={resolveAssetUrl(template.templateImage)} alt={template.name} className="w-full h-full object-cover" />
                                                    ) : (
                                                        <div className="w-full h-full flex items-center justify-center text-text-tertiary text-[11px]">无图</div>
                                                    )}
                                                </div>
                                                <div className="p-2">
                                                    <div className="text-[11px] text-text-primary truncate">{template.name}</div>
                                                </div>
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => deleteTemplate(template.id)}
                                                className="absolute top-1 right-1 w-5 h-5 rounded-md border border-border bg-black/45 text-white hover:bg-black/65"
                                                title="删除模板"
                                            >
                                                <Trash2 className="w-3 h-3 mx-auto" />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    <div className="border-t border-border p-3">
                        <div className="text-[11px] font-medium text-text-primary mb-2">当前模板</div>
                        {activeTemplateId ? (
                            (() => {
                                const selected = templates.find((item) => item.id === activeTemplateId);
                                if (!selected) {
                                    return <div className="text-xs text-text-tertiary">当前模板已不存在，请重新选择。</div>;
                                }
                                return (
                                    <div className="flex items-center gap-2">
                                        <div className="w-10 h-14 rounded border border-border overflow-hidden bg-surface-secondary shrink-0">
                                            {selected.templateImage ? (
                                                <img src={resolveAssetUrl(selected.templateImage)} alt={selected.name} className="w-full h-full object-cover" />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center text-[10px] text-text-tertiary">无图</div>
                                            )}
                                        </div>
                                        <div className="min-w-0">
                                            <div className="text-xs text-text-primary truncate">{selected.name}</div>
                                        </div>
                                    </div>
                                );
                            })()
                        ) : (
                            <div className="text-xs text-text-tertiary">未选择模板</div>
                        )}
                    </div>
                </div>

                <div className="flex-1 min-w-0 flex flex-col">
                    <div className="px-6 py-2.5 border-b border-border bg-surface-primary/60 space-y-1">
                        <div className="flex items-center gap-3">
                            <h1 className="text-lg font-semibold text-text-primary">封面</h1>
                            <div className="ml-auto flex items-center gap-2">
                                <button
                                    onClick={() => void window.ipcRenderer.invoke('cover:open-root')}
                                    className="px-2 py-1 text-[11px] rounded-md border border-border hover:bg-surface-secondary text-text-secondary"
                                >
                                    <span className="inline-flex items-center gap-1">
                                        <FolderOpen className="w-3 h-3" />
                                        目录
                                    </span>
                                </button>
                                <button
                                    onClick={() => {
                                        void loadSettings();
                                        loadTemplates();
                                        void loadRecentAssets();
                                    }}
                                    className="px-2 py-1 text-[11px] rounded-md border border-border hover:bg-surface-secondary text-text-secondary"
                                >
                                    <span className="inline-flex items-center gap-1">
                                        <RefreshCw className="w-3 h-3" />
                                        刷新
                                    </span>
                                </button>
                            </div>
                        </div>
                        {!hasImageConfig && (
                            <div className="text-xs text-status-error">
                                未检测到生图配置。请先到“设置 → AI 模型”填写生图 Endpoint 和 API Key。
                            </div>
                        )}
                    </div>

                    <div className="flex-1 min-h-0 overflow-auto p-6">
                        <div className="space-y-4">
                            <div className="border border-border rounded-xl bg-surface-primary p-4 md:p-5 space-y-4 shadow-sm">
                            <div className="text-[11px] text-text-tertiary">
                                当前封面生图模型跟随“设置 → AI 模型”：<span className="font-mono">{model || '(未设置)'}</span>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="border border-border rounded-lg p-3 space-y-2 bg-surface-secondary/10">
                                    <div className="text-xs font-medium text-text-primary">图1 模板图（必填）</div>
                                    <label
                                        className={clsx(
                                            'group relative block rounded border overflow-hidden aspect-[3/4] transition-colors',
                                            templateImage?.dataUrl
                                                ? 'border-border bg-surface-secondary cursor-pointer'
                                                : 'border-dashed border-border/70 bg-surface-secondary/20 cursor-pointer hover:border-accent-primary/70 hover:bg-surface-secondary/30',
                                            isReadingTemplateImage && 'opacity-70 cursor-wait'
                                        )}
                                    >
                                        <input type="file" accept="image/*" className="hidden" onChange={handleTemplateImageFile} />
                                        {templateImage?.dataUrl ? (
                                            <>
                                                <img src={resolveAssetUrl(templateImage.dataUrl)} alt={templateImage.name} className="w-full h-full object-cover" />
                                                <div className="absolute inset-x-0 bottom-0 px-2 py-1.5 bg-black/45 text-[11px] text-white opacity-0 group-hover:opacity-100 transition-opacity">
                                                    {isReadingTemplateImage ? '读取模板图中...' : '点击更换模板图'}
                                                </div>
                                            </>
                                        ) : (
                                            <div className="h-full w-full flex flex-col items-center justify-center text-text-tertiary">
                                                <Plus className="w-10 h-10 mb-2" />
                                                <div className="text-xs">{isReadingTemplateImage ? '读取模板图中...' : '点击上传模板图'}</div>
                                            </div>
                                        )}
                                    </label>
                                </div>

                                <div className="border border-border rounded-lg p-3 space-y-2 bg-surface-secondary/10">
                                    <div className="text-xs font-medium text-text-primary">图2 底图（必填）</div>
                                    <label
                                        className={clsx(
                                            'group relative block rounded border overflow-hidden aspect-[3/4] transition-colors',
                                            baseImage?.dataUrl
                                                ? 'border-border bg-surface-secondary cursor-pointer'
                                                : 'border-dashed border-border/70 bg-surface-secondary/20 cursor-pointer hover:border-accent-primary/70 hover:bg-surface-secondary/30',
                                            isReadingBaseImage && 'opacity-70 cursor-wait'
                                        )}
                                    >
                                        <input type="file" accept="image/*" className="hidden" onChange={handleBaseImageFile} />
                                        {baseImage?.dataUrl ? (
                                            <>
                                                <img src={resolveAssetUrl(baseImage.dataUrl)} alt={baseImage.name} className="w-full h-full object-cover" />
                                                <div className="absolute inset-x-0 bottom-0 px-2 py-1.5 bg-black/45 text-[11px] text-white opacity-0 group-hover:opacity-100 transition-opacity">
                                                    {isReadingBaseImage ? '读取底图中...' : '点击更换底图'}
                                                </div>
                                            </>
                                        ) : (
                                            <div className="h-full w-full flex flex-col items-center justify-center text-text-tertiary">
                                                <Plus className="w-10 h-10 mb-2" />
                                                <div className="text-xs">{isReadingBaseImage ? '读取底图中...' : '点击上传底图'}</div>
                                            </div>
                                        )}
                                    </label>
                                </div>
                            </div>

                            <div className="border border-border rounded-lg p-3 space-y-3 bg-surface-secondary/10">
                                <div className="text-xs font-medium text-text-primary">提示词开关（注入策略）</div>
                                <div className="flex flex-wrap gap-2">
                                    {PROMPT_SWITCH_OPTIONS.map((item) => (
                                        <div
                                            key={item.key}
                                            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-primary/70 px-2.5 py-1.5"
                                            title={item.description}
                                        >
                                            <span className="text-[11px] font-medium text-text-primary">{item.label}</span>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setPromptSwitches((prev) => ({
                                                        ...prev,
                                                        [item.key]: !prev[item.key],
                                                    }));
                                                }}
                                                className="ui-switch-track"
                                                data-size="md"
                                                data-state={promptSwitches[item.key] ? 'on' : 'off'}
                                                aria-label={item.label}
                                                aria-pressed={Boolean(promptSwitches[item.key])}
                                            >
                                                <span className="ui-switch-thumb" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="border border-border rounded-lg p-3 space-y-3 bg-surface-secondary/10">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="text-xs font-medium text-text-primary inline-flex items-center gap-1.5">
                                            <Type className="w-3.5 h-3.5" />
                                            标题输入（必填）
                                        </div>
                                        <div className="mt-1 text-[11px] text-text-tertiary">
                                            {TITLE_INPUT_MODE_OPTIONS.find((item) => item.value === titleInputMode)?.description}
                                        </div>
                                    </div>
                                    {titleInputMode === 'titles' && (
                                        <button
                                            type="button"
                                            onClick={addTitleEntry}
                                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border text-[11px] text-text-secondary hover:text-text-primary hover:border-accent-primary shrink-0"
                                        >
                                            <Plus className="w-3 h-3" />
                                            新增一条
                                        </button>
                                    )}
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                    {TITLE_INPUT_MODE_OPTIONS.map((option) => {
                                        const active = titleInputMode === option.value;
                                        return (
                                            <button
                                                key={option.value}
                                                type="button"
                                                onClick={() => setTitleInputMode(option.value)}
                                                className={clsx(
                                                    'rounded-lg border px-3 py-2.5 text-left transition-colors',
                                                    active
                                                        ? 'border-accent-primary bg-accent-primary/8 shadow-sm'
                                                        : 'border-border bg-surface-primary hover:border-accent-primary/40'
                                                )}
                                            >
                                                <div className="text-sm font-medium text-text-primary">{option.label}</div>
                                                <div className="mt-1 text-[11px] text-text-tertiary">{option.description}</div>
                                            </button>
                                        );
                                    })}
                                </div>
                                {titleInputMode === 'titles' ? (
                                    <div className="space-y-2">
                                        {titleEntries.map((entry) => (
                                            <div key={entry.id} className="grid grid-cols-[120px_minmax(0,1fr)_34px] gap-2 items-center">
                                                <select
                                                    value={entry.type}
                                                    onChange={(event) => updateTitleEntry(entry.id, { type: event.target.value as CoverTitleEntry['type'] })}
                                                    className="px-2.5 py-2 text-xs rounded-md border border-border bg-surface-secondary/20 focus:outline-none"
                                                >
                                                    {TITLE_TYPE_OPTIONS.map((option) => (
                                                        <option key={option.value} value={option.value}>{option.label}</option>
                                                    ))}
                                                </select>
                                                <input
                                                    value={entry.text}
                                                    onChange={(event) => updateTitleEntry(entry.id, { text: event.target.value })}
                                                    placeholder="输入这一类标题文本"
                                                    className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => removeTitleEntry(entry.id)}
                                                    className="w-8 h-8 rounded border border-border text-text-tertiary hover:text-text-primary hover:bg-surface-secondary"
                                                    title="删除"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5 mx-auto" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        <textarea
                                            value={titlePrompt}
                                            onChange={(event) => setTitlePrompt(event.target.value)}
                                            placeholder="写你想让 AI 自己决定封面文案的方向，例如：突出反差感、像真人经验分享、主标题短促有记忆点，副标题补充结果或场景。"
                                            className="min-h-[120px] w-full resize-y rounded-md border border-border bg-surface-secondary/20 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-primary"
                                        />
                                        <div className="text-[11px] text-text-tertiary">
                                            这里不用自己写最终标题，直接描述你想要的语气、信息重心、受众和点击感即可。
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <div className="text-xs text-text-secondary px-3 py-2 rounded-md border border-border bg-surface-secondary/20">
                                    输出比例：<span className="font-mono">3:4</span>
                                </div>
                                <select
                                    value={quality}
                                    onChange={(event) => setQuality(event.target.value)}
                                    className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none"
                                >
                                    <option value="standard">standard</option>
                                    <option value="high">high</option>
                                    <option value="auto">auto</option>
                                </select>
                                <select
                                    value={count}
                                    onChange={(event) => setCount(Number(event.target.value))}
                                    className="px-3 py-2 text-sm rounded-md border border-border bg-surface-secondary/20 focus:outline-none"
                                >
                                    <option value={1}>1 张</option>
                                    <option value={2}>2 张</option>
                                    <option value={3}>3 张</option>
                                    <option value={4}>4 张</option>
                                </select>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    onClick={() => saveTemplate()}
                                    className="px-4 py-2 text-sm rounded-md border border-border hover:bg-surface-secondary text-text-secondary"
                                >
                                    <span className="inline-flex items-center gap-1.5">
                                        <Save className="w-4 h-4" />
                                        保存模板
                                    </span>
                                </button>
                                <button
                                    onClick={() => void handleGenerate()}
                                    disabled={!hasImageConfig || !hasRequiredInputs}
                                    className="px-4 py-2 text-sm rounded-md bg-accent-primary text-white hover:bg-accent-primary/90 disabled:opacity-50"
                                >
                                    <span className="inline-flex items-center gap-1.5">
                                        <ImagePlus className="w-4 h-4" />
                                        生成封面
                                    </span>
                                </button>
                                <button
                                    onClick={() => resetEditor()}
                                    className="px-3 py-2 text-xs rounded-md border border-border hover:bg-surface-secondary text-text-secondary"
                                >
                                    重置
                                </button>
                            </div>

                            {generateError && <div className="text-xs text-status-error">{generateError}</div>}
                            {pendingJobCount > 0 && (
                                <div className="text-[11px] text-text-tertiary">
                                    当前还有 {pendingJobCount} 个任务在后台生成。你可以继续提交下一条，或切去别的页面等结果回来。
                                </div>
                            )}
                        </div>

                        {generationJobs.length > 0 && (
                            <div className="space-y-3">
                                <div className="text-sm font-medium text-text-primary inline-flex items-center gap-2">
                                    <Sparkles className="w-4 h-4 text-accent-primary" />
                                    生成任务（{generationJobs.length}）
                                </div>
                                <div className="space-y-4">
                                    {generationJobs.map((job) => (
                                        <div key={job.id} className="border border-border rounded-xl bg-surface-primary p-4 shadow-sm space-y-3">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <span
                                                            className={clsx(
                                                                'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] border',
                                                                job.status === 'pending'
                                                                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-700'
                                                                    : job.status === 'success'
                                                                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700'
                                                                        : 'border-red-500/30 bg-red-500/10 text-red-700'
                                                            )}
                                                        >
                                                            {job.status === 'pending' ? '生成中' : job.status === 'success' ? '已完成' : '失败'}
                                                        </span>
                                                        <span className="text-[11px] text-text-tertiary">
                                                            {job.mode === 'prompt' ? '提示词模式' : '标题模式'} · {new Date(job.submittedAt).toLocaleString()}
                                                        </span>
                                                    </div>
                                                    <div className="mt-2 text-sm text-text-primary break-words">{job.summary}</div>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => removeGenerationJob(job.id)}
                                                    className="w-8 h-8 rounded border border-border text-text-tertiary hover:text-text-primary hover:bg-surface-secondary shrink-0"
                                                    title="移除任务"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5 mx-auto" />
                                                </button>
                                            </div>

                                            {job.status === 'pending' && (
                                                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                                                    {Array.from({ length: job.count }).map((_, index) => (
                                                        <div key={`${job.id}-${index}`} className="border border-border rounded-xl overflow-hidden bg-surface-secondary/20">
                                                            <div className="w-full aspect-[3/4] bg-surface-secondary/60 animate-pulse" />
                                                            <div className="p-3 space-y-2">
                                                                <div className="flex items-center gap-2 text-xs text-text-secondary">
                                                                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                                                    正在排队生成第 {index + 1} 张
                                                                </div>
                                                                <div className="text-[11px] text-text-tertiary">
                                                                    任务已提交，你现在可以继续发下一条。
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}

                                            {job.status === 'error' && (
                                                <div className="text-xs text-status-error">{job.error || '封面生成失败'}</div>
                                            )}

                                            {job.status === 'success' && (
                                                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                                                    {job.assets.map((asset) => (
                                                        <div key={asset.id} className="group border border-border rounded-xl bg-surface-primary overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                                                            {asset.previewUrl && asset.exists ? (
                                                                <img src={resolveAssetUrl(asset.previewUrl)} alt={asset.title || asset.id} className="w-full aspect-[3/4] object-cover" />
                                                            ) : (
                                                                <div className="w-full aspect-[3/4] bg-surface-secondary flex items-center justify-center text-text-tertiary text-xs">无法预览</div>
                                                            )}
                                                            <div className="p-3 space-y-1.5">
                                                                <div className="text-sm text-text-primary truncate">{asset.title || asset.id}</div>
                                                                <div className="text-[11px] text-text-tertiary truncate">{asset.model || ''} · {asset.aspectRatio || '3:4'} · {asset.quality || ''}</div>
                                                                <button
                                                                    onClick={() => void window.ipcRenderer.invoke('cover:open', { assetId: asset.id })}
                                                                    className="mt-1 px-2.5 py-1.5 text-xs rounded border border-border hover:bg-surface-secondary text-text-secondary"
                                                                >
                                                                    <span className="inline-flex items-center gap-1">
                                                                        <ExternalLink className="w-3.5 h-3.5" />
                                                                        打开文件
                                                                    </span>
                                                                </button>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="space-y-3">
                            <div className="text-sm font-medium text-text-primary">最近封面素材</div>
                            {recentAssets.length === 0 ? (
                                <div className="text-xs text-text-tertiary">暂无封面素材</div>
                            ) : (
                                <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
                                    {recentAssets.map((asset) => (
                                        <button
                                            key={asset.id}
                                            onClick={() => void window.ipcRenderer.invoke('cover:open', { assetId: asset.id })}
                                            className="text-left border border-border rounded-lg overflow-hidden bg-surface-primary hover:shadow-sm transition-shadow"
                                        >
                                            {asset.previewUrl && asset.exists ? (
                                                <img src={resolveAssetUrl(asset.previewUrl)} alt={asset.title || asset.id} className="w-full aspect-[3/4] object-cover" />
                                            ) : (
                                                <div className="w-full aspect-[3/4] bg-surface-secondary flex items-center justify-center text-text-tertiary text-[11px]">无预览</div>
                                            )}
                                            <div className="p-2.5">
                                                <div className="text-xs text-text-primary truncate">{asset.title || asset.id}</div>
                                                <div className="text-[10px] text-text-tertiary truncate mt-1">{new Date(asset.updatedAt).toLocaleDateString()}</div>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
    );
}
