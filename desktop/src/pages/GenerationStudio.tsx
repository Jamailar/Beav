import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
    ArrowLeft,
    ArrowUp,
    ChevronDown,
    Clapperboard,
    Download,
    FileText,
    FolderOpen,
    Image as ImageIcon,
    ImagePlus,
    Layers,
    Loader2,
    Music2,
    PencilLine,
    Play,
    Plus,
    RotateCcw,
    Search,
    Sparkles,
    Trash2,
    UserRound,
    X,
} from 'lucide-react';
import clsx from 'clsx';
import { REDBOX_OFFICIAL_VIDEO_BASE_URL, getRedBoxOfficialVideoModel } from '../../shared/redboxVideo';
import type { GenerationIntent, PendingChatMessage } from '../features/app-shell/types';
import { subscribeSettingsUpdated } from '../bridge/appEvents';
import type { UploadedFileAttachment } from '../components/ChatComposer';
import { useMediaJobSubscription } from '../features/media-jobs/useMediaJobSubscription';
import { mediaJobsStore, shallowArrayEqual, useMediaJobsStore } from '../features/media-jobs/useMediaJobsStore';
import { normalizeMediaJobProjection, type MediaJobProjection } from '../features/media-jobs/types';
import {
    buildRecentGenerationAssetSummaries,
    buildAudioGenerationRequest,
    buildCoverGenerationRequest,
    buildDigitalHumanGenerationRequest,
    buildImageGenerationRequest,
    buildVideoGenerationRequest,
    clientRequestIdFromJob,
    createGenerationFeedEntry,
    estimateGenerationProgress,
    feedTime,
    isAgentSessionFeedEntry,
    isFeedEntryDeleted,
    isGenerationFeedEntry,
    isGenerationStudioMediaJob,
    mergeFeedEntriesById,
    mergeMediaJobsIntoFeedEntries,
    normalizeAspectRatio,
    normalizeDeletedFeedState,
    normalizeGeneratedAssets,
    normalizeImageQuality,
    normalizeReferenceItem,
    normalizeReferenceItems,
    parseAspectRatio,
    persistDeletedFeedState,
    persistFeedEntries,
    readDeletedFeedState,
    readPersistedFeedEntries,
    requestLeadingReference,
    requestModeLabel,
    requestSupportText,
    sortFeedEntries,
    type AgentSessionFeedEntry,
    type AudioGenerationRequest,
    type CoverGenerationRequest,
    type CoverPromptSwitches,
    type DeletedFeedState,
    type DigitalHumanGenerationRequest,
    type FeedEntry,
    type GeneratedAsset,
    type GenerationFeedEntry,
    type GenerationFeedSource,
    type GenerationRequest,
    type ImageGenerationMode,
    type ImageGenerationRequest,
    type ReferenceItem,
    type StudioMode,
    type VideoGenerationMode,
    type VideoGenerationRequest,
    buildGenerationAgentRuntimeContext,
    buildGenerationAgentContextId,
    buildGenerationAgentInitialContext,
    buildGenerationAgentSessionMetadata,
    GENERATION_AGENT_CONTEXT_TYPE,
    dataUrlMimeType,
    referenceItemIsImage,
    attachmentVisualKind,
    attachmentPreviewSrc,
    formatAttachmentSize,
    attachmentKindLabel,
    buildReferenceContactSheet,
    attachmentToReferenceItem,
    isVideoAsset,
    isAudioAsset,
    generatedAssetDefaultName,
    formatRelativeTime,
    buildRequestSummary,
    shortVoiceId,
    placeholderCountForRequest,
    placeholderAspectRatioForRequest,
    feedMediaGridClass,
    feedMediaHeightClass,
    fileUrlToPath,
    digitalHumanReadiness,
    buildImageModelOptions,
    buildAudioModelOptions,
    resolveSelectedModelOverride,
    normalizeVoiceList,
    DEFAULT_AUDIO_TTS_MODEL,
    voiceMatchesAudioModel,
    voiceLanguageMatches,
    buildAudioLanguageOptions,
    buildAudioVoiceOptions,
    isRemoteUrl,
    generationAgentRoleForMode,
    generationSubmitSource,
    combineGenerationCostEstimates,
    estimateAudioGenerationPoints,
    estimateCoverGenerationPoints,
    estimateImageGenerationPoints,
    estimateVideoGenerationPoints,
    submitAudioGeneration,
    submitCoverGeneration,
    submitDigitalHumanGeneration,
    submitImageGeneration,
    submitVideoGeneration,
    validateAudioGenerationRequest,
    validateCoverGenerationRequest,
    validateDigitalHumanGenerationRequest,
    validateImageGenerationRequest,
    validateVideoGenerationRequest,
    type GenerationAgentVoice,
    type PickerOption,
    type SettingsShape,
    type VoiceListItem,
    type ModelRouteOverride,
    type GenerationCostEstimate,
} from '../features/media-generation';
import { Chat, clearFixedSessionWarmSnapshot } from './Chat';
import { resolveAssetUrl } from '../utils/pathManager';
import { appAlert, appConfirm } from '../utils/appDialogs';
import { parseAiPricingCatalog, type AiPricingCatalog } from '../features/settings/settingsModel';
import { collectNestedFiles, isInternalPackageFile, type FileNode } from '../features/manuscripts/editorModel';

type GenerationSubmitButtonProps = {
    onClick: () => void;
    disabled: boolean;
    title: string;
    ariaLabel: string;
    estimate?: GenerationCostEstimate | null;
    pending?: boolean;
    agent?: boolean;
};

function GenerationSubmitButton({
    onClick,
    disabled,
    title,
    ariaLabel,
    estimate = null,
    pending = false,
    agent = false,
}: GenerationSubmitButtonProps) {
    const showEstimate = Boolean(estimate) && !pending;
    const accessibleLabel = showEstimate ? `${ariaLabel}，预计消耗 ${estimate?.label} 积分` : ariaLabel;
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={clsx(
                'ml-auto inline-flex h-11 items-center justify-center rounded-full bg-brand-red text-white shadow-[var(--ui-shadow-1)] transition-colors hover:bg-brand-red/90 disabled:opacity-45',
                showEstimate ? 'min-w-[82px] gap-1.5 px-3' : 'w-11',
            )}
            title={showEstimate ? estimate?.title : title}
            aria-label={accessibleLabel}
        >
            {pending ? (
                <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
                <>
                    {agent ? (
                        <ArrowUp className="h-5 w-5 shrink-0" />
                    ) : (
                        <Sparkles className="h-4.5 w-4.5 shrink-0" />
                    )}
                    {showEstimate && (
                        <span className="inline-flex items-baseline gap-0.5 leading-none">
                            <span className="text-[12px] font-semibold">~{estimate?.label}</span>
                            <span className="text-[10px] font-medium opacity-85">积分</span>
                        </span>
                    )}
                </>
            )}
        </button>
    );
}

type SubjectCategoryRecord = {
    id: string;
    name: string;
};

interface GenerationStudioProps {
    isActive?: boolean;
    pendingIntent?: GenerationIntent | null;
    onIntentConsumed?: () => void;
    onExecutionStateChange?: (active: boolean) => void;
    onReturnHome?: () => void;
    onOpenAssets?: () => void;
}

const IMAGE_ASPECT_RATIO_OPTIONS = [
    { value: 'auto', label: 'Auto' },
    { value: '1:1', label: '1:1' },
    { value: '3:4', label: '3:4' },
    { value: '4:3', label: '4:3' },
    { value: '9:16', label: '9:16' },
    { value: '16:9', label: '16:9' },
] as const;

const IMAGE_RESOLUTION_OPTIONS = [
    { value: '1K', label: '1K' },
    { value: '2K', label: '2K' },
    { value: '4K', label: '4K' },
] as const;

const DEFAULT_IMAGE_QUALITY = 'medium';

const IMAGE_COUNT_OPTIONS = [
    { value: '1', label: '1 张' },
    { value: '2', label: '2 张' },
    { value: '3', label: '3 张' },
    { value: '4', label: '4 张' },
] as const;

const VIDEO_MODE_OPTIONS = [
    { value: 'text-to-video', label: '文生视频' },
    { value: 'reference-guided', label: '参考图视频' },
    { value: 'first-last-frame', label: '首尾帧视频' },
    { value: 'continuation', label: '视频续写' },
] as const;

const VIDEO_ASPECT_RATIO_OPTIONS = [
    { value: '16:9', label: '16:9' },
    { value: '9:16', label: '9:16' },
] as const;

const VIDEO_RESOLUTION_OPTIONS = [
    { value: '720p', label: '720p' },
    { value: '1080p', label: '1080p' },
] as const;

const VIDEO_DURATION_OPTIONS = [
    { value: '5', label: '5 秒' },
    { value: '6', label: '6 秒' },
    { value: '7', label: '7 秒' },
    { value: '8', label: '8 秒' },
    { value: '9', label: '9 秒' },
    { value: '10', label: '10 秒' },
    { value: '11', label: '11 秒' },
    { value: '12', label: '12 秒' },
] as const;

const VIDEO_AUDIO_OPTIONS = [
    { value: 'off', label: '音频关' },
    { value: 'on', label: '音频开' },
] as const;

const AUDIO_SPEED_OPTIONS = [
    { value: '0.5', label: '0.5' },
    { value: '0.75', label: '0.75' },
    { value: '1', label: '1' },
    { value: '1.25', label: '1.25' },
    { value: '1.5', label: '1.5' },
    { value: '1.75', label: '1.75' },
    { value: '2', label: '2' },
] as const;

const AUDIO_EMOTION_OPTIONS = [
    { value: '', label: '自然' },
    { value: 'calm', label: '平静' },
    { value: 'happy', label: '开心' },
    { value: 'sad', label: '悲伤' },
    { value: 'angry', label: '愤怒' },
    { value: 'surprised', label: '惊讶' },
    { value: 'whisper', label: '低语' },
    { value: 'fluent', label: '流畅' },
] as const;

const AUDIO_PAUSE_OPTIONS = [
    { value: '0.3', label: '0.3s' },
    { value: '0.6', label: '0.6s' },
    { value: '1.0', label: '1.0s' },
    { value: '1.5', label: '1.5s' },
    { value: '2.0', label: '2.0s' },
] as const;

const AUDIO_PAUSE_TOKEN_PATTERN = /〔停顿\s*([0-9.]+)\s*秒〕/g;

function audioPauseToken(seconds: string): string {
    return `〔停顿${seconds}秒〕`;
}

type AudioRichTextInputHandle = {
    insertPause: (seconds?: string) => void;
};

const COVER_STYLE_OPTIONS: Array<{ key: keyof CoverPromptSwitches; label: string }> = [
    { key: 'learnTypography', label: '字体' },
    { key: 'learnColorMood', label: '色彩' },
    { key: 'beautifyFace', label: '人像' },
    { key: 'replaceBackground', label: '换景' },
];

const DEFAULT_COVER_PROMPT_SWITCHES: CoverPromptSwitches = {
    learnTypography: true,
    learnColorMood: true,
    beautifyFace: false,
    replaceBackground: false,
};
const DIGITAL_HUMAN_TTS_TIMEOUT_MS = 10 * 60 * 1000;

const SOURCE_LABELS: Record<string, string> = {
    standalone: '独立创作',
    generation_studio: '独立创作',
    'media-library': '媒体库',
    manuscripts: '稿件',
    'cover-studio': '封面',
    cover_studio: '封面',
    tool: 'Agent 工具',
    redclaw: 'RedClaw',
};

type AssetContextMenuState = {
    asset: GeneratedAsset;
    entryId?: string;
    x: number;
    y: number;
};

type CoverManuscriptOption = {
    path: string;
    title: string;
    updatedAt: number;
};

type ManuscriptReadResult = {
    content?: string;
    metadata?: Record<string, unknown>;
};

function manuscriptFallbackTitle(path: string): string {
    return String(path || '').split('/').filter(Boolean).pop()?.replace(/\.md$/i, '') || '稿件';
}

function manuscriptTitleFromNode(node: FileNode): string {
    const path = String(node.path || '').trim();
    return String(node.title || node.name || manuscriptFallbackTitle(path)).trim() || manuscriptFallbackTitle(path);
}

function buildCoverManuscriptOptions(nodes: FileNode[]): CoverManuscriptOption[] {
    return collectNestedFiles(nodes)
        .filter((node) => {
            const path = String(node.path || '').trim();
            return path && !isInternalPackageFile(path);
        })
        .map((node) => ({
            path: String(node.path || '').trim(),
            title: manuscriptTitleFromNode(node),
            updatedAt: Number(node.updatedAt || 0) || 0,
        }))
        .sort((left, right) => {
            if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
            return left.path.localeCompare(right.path, 'zh-Hans-CN');
        });
}

function manuscriptReadContent(result: ManuscriptReadResult | unknown): string {
    if (!result || typeof result !== 'object') return '';
    return String((result as ManuscriptReadResult).content || '').trim();
}

function clipManuscriptForAgent(content: string): string {
    const normalized = String(content || '').trim();
    const maxChars = 14_000;
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars)}\n\n[稿件过长，已截取前 ${maxChars} 字用于封面判断]`;
}

const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
});

const readBlobAsDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(blob);
});

const ACCEPT_EXTENSION_GROUPS: Record<string, string[]> = {
    'image/*': ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif', 'heic', 'heif', 'jfif'],
    'video/*': ['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv'],
    'audio/*': ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm'],
};

function fileExtension(fileName: string): string {
    const match = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return match?.[1] || '';
}

function fileMatchesAccept(file: File, accept: string): boolean {
    const tokens = String(accept || '')
        .split(',')
        .map((token) => token.trim().toLowerCase())
        .filter(Boolean);
    if (!tokens.length) return true;
    const mimeType = String(file.type || '').toLowerCase();
    const ext = fileExtension(file.name);
    return tokens.some((token) => {
        if (token.startsWith('.')) {
            return ext === token.slice(1);
        }
        if (token.endsWith('/*')) {
            const prefix = token.slice(0, -1);
            return (mimeType && mimeType.startsWith(prefix)) || ACCEPT_EXTENSION_GROUPS[token]?.includes(ext);
        }
        return mimeType === token || ACCEPT_EXTENSION_GROUPS[token]?.includes(ext);
    });
}

function transferMayContainAcceptedFile(dataTransfer: DataTransfer, accept: string): boolean {
    const items = Array.from(dataTransfer.items || []);
    if (!items.length) return Array.from(dataTransfer.files || []).some((file) => fileMatchesAccept(file, accept));
    const tokens = String(accept || '')
        .split(',')
        .map((token) => token.trim().toLowerCase())
        .filter(Boolean);
    return items.some((item) => {
        if (item.kind !== 'file') return false;
        const mimeType = String(item.type || '').toLowerCase();
        if (!mimeType) return true;
        return tokens.length === 0 || tokens.some((token) => {
            if (token.startsWith('.')) return true;
            if (token.endsWith('/*')) return mimeType.startsWith(token.slice(0, -1));
            return mimeType === token;
        });
    });
}

async function filesToReferenceItems(files: File[], maxCount: number): Promise<ReferenceItem[]> {
    return Promise.all(files.slice(0, maxCount).map(async (file) => ({
        name: file.name,
        dataUrl: await readFileAsDataUrl(file),
    })));
}

function makeId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isVideoReference(item: ReferenceItem | null | undefined): boolean {
    return String(item?.dataUrl || '').startsWith('data:video/');
}

function applyIntentPreset(
    intent: GenerationIntent,
    setters: {
        setStudioMode: (mode: StudioMode) => void;
        setBindTarget: (value: string) => void;
        setImageAspectRatio: (value: string) => void;
        setVideoAspectRatio: (value: '16:9' | '9:16') => void;
        setVideoResolution: (value: '720p' | '1080p') => void;
        setVideoDurationSeconds: (value: number) => void;
        setImageProjectId: (value: string) => void;
        setVideoProjectId: (value: string) => void;
        setAudioProjectId: (value: string) => void;
        setCoverProjectId: (value: string) => void;
        setContextIntent: (value: GenerationIntent | null) => void;
    },
): void {
    setters.setStudioMode(intent.mode);
    setters.setContextIntent(intent);
    if (intent.bindTarget?.manuscriptPath) {
        setters.setBindTarget(intent.bindTarget.manuscriptPath);
    }
    if (intent.bindTarget?.projectId) {
        setters.setImageProjectId(intent.bindTarget.projectId);
        setters.setVideoProjectId(intent.bindTarget.projectId);
        setters.setAudioProjectId(intent.bindTarget.projectId);
        setters.setCoverProjectId(intent.bindTarget.projectId);
    }
    if (intent.preset?.aspectRatio) {
        if (intent.mode === 'image') {
            setters.setImageAspectRatio(intent.preset.aspectRatio);
        } else if (intent.preset.aspectRatio === '9:16' || intent.preset.aspectRatio === '16:9') {
            setters.setVideoAspectRatio(intent.preset.aspectRatio);
        }
    }
    if (intent.preset?.resolution === '720p' || intent.preset?.resolution === '1080p') {
        setters.setVideoResolution(intent.preset.resolution);
    }
    if (typeof intent.preset?.durationSeconds === 'number' && Number.isFinite(intent.preset.durationSeconds)) {
        setters.setVideoDurationSeconds(intent.preset.durationSeconds);
    }
}

function readAudioRichText(root: HTMLElement | null): string {
    if (!root) return '';
    let text = '';
    const visit = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent || '';
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const element = node as HTMLElement;
        if (element.dataset.audioPause) {
            text += audioPauseToken(element.dataset.audioPause || '0.6');
            return;
        }
        if (element.tagName === 'BR') {
            if (element.dataset.editorSentinel) return;
            text += '\n';
            return;
        }
        if (element.tagName === 'DIV' && text && !text.endsWith('\n')) {
            text += '\n';
        }
        node.childNodes.forEach(visit);
    };
    root.childNodes.forEach(visit);
    return text.replace(/\u00a0/g, ' ');
}

function createAudioPauseElement(seconds = '0.6'): HTMLElement {
    const token = document.createElement('span');
    token.contentEditable = 'false';
    token.dataset.audioPause = seconds;
    token.className = 'mx-1 inline-flex items-center rounded-md bg-[#E8F3FF] px-1.5 py-0.5 align-baseline text-[0.92em] font-medium text-[#3F7FB5]';
    token.textContent = `停顿 ${seconds}s`;
    return token;
}

function ensureAudioEditorSentinel(root: HTMLElement | null) {
    if (!root) return;
    if (readAudioRichText(root).trim() || root.querySelector('[data-audio-pause]')) return;
    let sentinel = root.querySelector<HTMLBRElement>('[data-editor-sentinel="true"]');
    if (!sentinel) {
        root.replaceChildren();
        sentinel = document.createElement('br');
        sentinel.dataset.editorSentinel = 'true';
        root.appendChild(sentinel);
    }
}

function placeCaretAfterAudioNode(root: HTMLElement, node: Node | null) {
    if (!node || !root.contains(node)) return;
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function insertAudioNodeAtSelection(root: HTMLElement, node: Node): Node | null {
    const selection = window.getSelection();
    const insertAtEnd = () => {
        const sentinel = root.querySelector<HTMLElement>('[data-editor-sentinel="true"]');
        sentinel?.remove();
        root.appendChild(node);
        const spacer = document.createTextNode(' ');
        root.appendChild(spacer);
        placeCaretAfterAudioNode(root, spacer);
        return spacer;
    };
    if (!selection || selection.rangeCount === 0) return insertAtEnd();
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer)) return insertAtEnd();
    range.deleteContents();
    const spacer = document.createTextNode(' ');
    range.insertNode(spacer);
    range.insertNode(node);
    placeCaretAfterAudioNode(root, spacer);
    return spacer;
}

function renderAudioRichTextValue(root: HTMLElement, value: string) {
    root.replaceChildren();
    const text = String(value || '');
    if (!text) {
        ensureAudioEditorSentinel(root);
        return;
    }
    const parts = text.split(AUDIO_PAUSE_TOKEN_PATTERN);
    for (let index = 0; index < parts.length; index += 2) {
        const part = parts[index] || '';
        if (part) {
            const lines = part.split('\n');
            lines.forEach((line, lineIndex) => {
                if (lineIndex > 0) root.appendChild(document.createElement('br'));
                if (line) root.appendChild(document.createTextNode(line));
            });
        }
        const seconds = parts[index + 1];
        if (seconds) {
            root.appendChild(createAudioPauseElement(seconds));
            root.appendChild(document.createTextNode(' '));
        }
    }
}

const AudioRichTextInput = forwardRef<AudioRichTextInputHandle, {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
}>(function AudioRichTextInput({ value, onChange, placeholder }, ref) {
    const editorRef = useRef<HTMLDivElement | null>(null);
    const [isEmpty, setIsEmpty] = useState(true);

    const syncFromDom = useCallback(() => {
        const editor = editorRef.current;
        const nextValue = readAudioRichText(editor);
        setIsEmpty(!nextValue.trim() && !editor?.querySelector('[data-audio-pause]'));
        onChange(nextValue);
    }, [onChange]);

    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;
        const currentValue = readAudioRichText(editor);
        if (document.activeElement === editor || currentValue === value) return;
        renderAudioRichTextValue(editor, value);
        setIsEmpty(!value.trim());
    }, [value]);

    useImperativeHandle(ref, () => ({
        insertPause: (seconds = '0.6') => {
            const editor = editorRef.current;
            if (!editor) return;
            editor.focus({ preventScroll: true });
            const caretNode = insertAudioNodeAtSelection(editor, createAudioPauseElement(seconds));
            syncFromDom();
            window.requestAnimationFrame(() => {
                editor.focus({ preventScroll: true });
                placeCaretAfterAudioNode(editor, caretNode);
            });
        },
    }), [syncFromDom]);

    return (
        <div
            className="relative min-h-[112px] max-h-[240px] overflow-y-auto text-left"
            onMouseDown={(event) => {
                if (!isEmpty) return;
                event.preventDefault();
                const editor = editorRef.current;
                ensureAudioEditorSentinel(editor);
                editor?.focus();
            }}
        >
            {isEmpty ? (
                <div className="pointer-events-none absolute left-0 top-0 select-none text-[14px] leading-6 text-text-tertiary">
                    {placeholder}
                </div>
            ) : null}
            <div
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                onInput={syncFromDom}
                onFocus={(event) => ensureAudioEditorSentinel(event.currentTarget)}
                onPaste={(event) => {
                    event.preventDefault();
                    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
                }}
                className="min-h-[112px] w-full whitespace-pre-wrap break-words bg-transparent text-[14px] leading-6 text-text-primary outline-none"
            />
        </div>
    );
});

function useDismissiblePopover(open: boolean, onClose: () => void) {
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return;

        const handlePointerDown = (event: MouseEvent) => {
            if (!(event.target instanceof Node)) return;
            if (rootRef.current?.contains(event.target)) return;
            onClose();
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };

        document.addEventListener('mousedown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [onClose, open]);

    return rootRef;
}

function PopoverSelect({
    value,
    onChange,
    onDisabledOptionClick,
    options,
    className,
    title,
    panelClassName,
    layout = 'wrap',
    disabled = false,
    emptyText = '未选择',
    optionAlign = 'left',
}: {
    value: string;
    onChange: (value: string) => void;
    onDisabledOptionClick?: (option: PickerOption) => void;
    options: readonly PickerOption[];
    className?: string;
    title?: string;
    panelClassName?: string;
    layout?: 'wrap' | 'column';
    disabled?: boolean;
    emptyText?: string;
    optionAlign?: 'left' | 'center';
}) {
    const [open, setOpen] = useState(false);
    const rootRef = useDismissiblePopover(open, () => setOpen(false));
    const active = options.find((option) => option.value === value) || options[0];

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                onClick={() => {
                    if (disabled || options.length === 0) return;
                    setOpen((prev) => !prev);
                }}
                disabled={disabled || options.length === 0}
                className={clsx(
                    'inline-flex h-9 min-w-[104px] items-center gap-2 rounded-full border border-border bg-surface-primary px-3 shadow-[var(--ui-shadow-1)] transition-colors hover:border-border/70',
                    open && 'border-brand-red/50 ring-1 ring-brand-red/20',
                    (disabled || options.length === 0) && 'cursor-not-allowed opacity-55 hover:border-border',
                    className,
                )}
            >
                <span className="truncate text-[12px] font-medium text-text-primary">{active?.label || value || emptyText}</span>
                <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-accent-muted text-text-tertiary">
                    <ChevronDown className="h-3 w-3" />
                </span>
            </button>

            {open && (
                <div
                    className={clsx(
                        'absolute bottom-[calc(100%+10px)] left-0 z-20 min-w-[96px] max-w-[340px] rounded-[20px] border border-border bg-surface-secondary p-3 shadow-[var(--ui-shadow-2)]',
                        panelClassName,
                    )}
                >
                    {title && <div className="mb-3 text-[13px] font-semibold text-text-secondary">{title}</div>}
                    <div className={clsx(
                        'max-h-[420px] overflow-y-auto pr-1',
                        layout === 'column' ? 'flex flex-col gap-2' : 'flex flex-wrap gap-2',
                    )}>
                        {options.map((option) => {
                            const selected = option.value === active?.value;
                            const disabledOption = option.disabled === true;
                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => {
                                        if (disabledOption) {
                                            onDisabledOptionClick?.(option);
                                            return;
                                        }
                                        onChange(option.value);
                                        setOpen(false);
                                    }}
                                    className={clsx(
                                        'rounded-[14px] border px-3 py-2.5 text-[12px] font-semibold transition-colors',
                                        layout === 'column' ? 'w-full' : 'min-w-[92px] flex-1',
                                        optionAlign === 'center' ? 'text-center' : 'text-left',
                                        disabledOption
                                            ? 'cursor-not-allowed border-brand-red/25 bg-brand-red/10 text-brand-red hover:bg-brand-red/15'
                                        : selected
                                            ? 'border-brand-red/50 bg-brand-red text-white'
                                            : 'border-transparent bg-surface-tertiary text-text-secondary hover:bg-accent-muted',
                                    )}
                                >
                                    <div className="flex min-w-0 items-center gap-2">
                                        {option.tone === 'danger' && (
                                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-red" />
                                        )}
                                        <span className="truncate">{option.label}</span>
                                    </div>
                                    {option.description && (
                                        <div className={clsx(
                                            'mt-1 truncate text-[11px] font-normal',
                                            disabledOption ? 'text-brand-red/75' : selected ? 'text-white/75' : 'text-text-tertiary',
                                        )}>
                                            {option.description}
                                        </div>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

function ImageAspectRatioPicker({
    value,
    onChange,
}: {
    value: string;
    onChange: (value: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const rootRef = useDismissiblePopover(open, () => setOpen(false));
    const active =
        IMAGE_ASPECT_RATIO_OPTIONS.find((option) => option.value === value) || IMAGE_ASPECT_RATIO_OPTIONS[0];

    const frameClassName = (ratio: string) => {
        switch (ratio) {
            case '16:9':
                return 'h-3 w-6';
            case '9:16':
                return 'h-6 w-3';
            case '4:3':
                return 'h-4 w-5';
            case '3:4':
                return 'h-5 w-4';
            case '1:1':
            case 'auto':
            default:
                return 'h-4 w-4';
        }
    };

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                className={clsx(
                    'inline-flex h-9 min-w-[84px] items-center gap-2 rounded-full border border-border bg-surface-primary px-3 shadow-[var(--ui-shadow-1)] transition-colors hover:border-border/70',
                    open && 'border-brand-red/50 ring-1 ring-brand-red/20',
                )}
            >
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-muted text-text-secondary">
                    <span className={clsx('rounded-[3px] border border-current', frameClassName(active.value))} />
                </span>
                <span className="text-[12px] font-medium text-text-primary">{active.label}</span>
                <ChevronDown className="ml-auto h-3 w-3 text-text-tertiary" />
            </button>

            {open && (
                <div className="absolute bottom-[calc(100%+10px)] left-0 z-20 w-[372px] rounded-[20px] border border-border bg-surface-secondary p-4 shadow-[var(--ui-shadow-2)]">
                    <div className="mb-3 text-[13px] font-semibold text-text-secondary">图片比例</div>
                    <div className="grid grid-cols-3 gap-2.5">
                        {IMAGE_ASPECT_RATIO_OPTIONS.map((option) => {
                            const selected = option.value === active.value;
                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => {
                                        onChange(option.value);
                                        setOpen(false);
                                    }}
                                    className={clsx(
                                        'flex h-[84px] flex-col items-center justify-center rounded-[16px] border text-center transition-colors',
                                        selected
                                            ? 'border-brand-red/50 bg-brand-red text-white'
                                            : 'border-transparent bg-surface-tertiary text-text-secondary hover:bg-accent-muted',
                                    )}
                                >
                                    <span className={clsx(
                                        'mb-3 rounded-[4px] border',
                                        selected ? 'border-current' : 'border-text-tertiary',
                                        frameClassName(option.value),
                                    )} />
                                    <span className="text-[12px] font-semibold">{option.label}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

function UploadPreviewCard({
    label,
    accept,
    multiple = false,
    items,
    onChange,
    onFiles,
    onClear,
}: {
    label: string;
    accept: string;
    multiple?: boolean;
    items: ReferenceItem[];
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void | Promise<void>;
    onFiles?: (files: File[]) => void | Promise<void>;
    onClear?: () => void;
}) {
    const [isDragActive, setIsDragActive] = useState(false);
    const lead = items[0] || null;
    const hasItems = items.length > 0;
    const leadIsVideo = isVideoReference(lead);
    const handleDragEnter = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
        if (!onFiles || !transferMayContainAcceptedFile(event.dataTransfer, accept)) return;
        event.preventDefault();
        event.stopPropagation();
        setIsDragActive(true);
    }, [accept, onFiles]);
    const handleDragOver = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
        if (!onFiles || !transferMayContainAcceptedFile(event.dataTransfer, accept)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        setIsDragActive(true);
    }, [accept, onFiles]);
    const handleDragLeave = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        setIsDragActive(false);
    }, []);
    const handleDrop = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
        if (!onFiles) return;
        event.preventDefault();
        event.stopPropagation();
        setIsDragActive(false);
        const droppedFiles = Array.from(event.dataTransfer.files || [])
            .filter((file) => fileMatchesAccept(file, accept));
        const nextFiles = multiple ? droppedFiles : droppedFiles.slice(0, 1);
        if (!nextFiles.length) return;
        void onFiles(nextFiles);
    }, [accept, multiple, onFiles]);

    return (
        <div className="group relative">
            <label className={clsx(
                'relative flex h-[88px] w-[88px] cursor-pointer flex-col items-center justify-center overflow-hidden rounded-[18px] border transition-colors',
                isDragActive
                    ? 'border-brand-red/55 bg-brand-red/10 text-brand-red'
                    : hasItems
                    ? 'border-border bg-surface-tertiary hover:border-border/70'
                    : 'border-border bg-surface-secondary text-text-secondary hover:bg-surface-tertiary',
            )}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                <input
                    type="file"
                    accept={accept}
                    multiple={multiple}
                    className="hidden"
                    onChange={onChange}
                />

                {hasItems ? (
                    <>
                        {items.length === 1 ? (
                            leadIsVideo ? (
                                <div className="absolute inset-0 flex items-center justify-center bg-surface-elevated text-text-primary">
                                    <Clapperboard className="h-7 w-7" />
                                </div>
                            ) : (
                                <img src={lead?.dataUrl} alt={lead?.name || label} className="absolute inset-0 h-full w-full object-cover" />
                            )
                        ) : (
                            <div className="absolute inset-0 flex items-center justify-center bg-surface-secondary">
                                {items.slice(0, 3).reverse().map((item, index) => (
                                    <div
                                        key={`${item.name}-${index}`}
                                        className="absolute h-[48px] w-[38px] overflow-hidden rounded-[10px] border border-white/40 bg-surface-tertiary shadow-[var(--ui-shadow-1)]"
                                        style={{
                                            transform: `translate(${index * 10 - 10}px, ${index * -4}px) rotate(${index === 1 ? -4 : index === 2 ? 5 : 0}deg)`,
                                        }}
                                    >
                                        {isVideoReference(item) ? (
                                            <div className="flex h-full w-full items-center justify-center bg-surface-elevated text-text-primary">
                                                <Clapperboard className="h-4 w-4" />
                                            </div>
                                        ) : (
                                            <img src={item.dataUrl} alt={item.name} className="h-full w-full object-cover" />
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent px-2 pb-2 pt-4 text-center">
                            <div className="truncate text-[11px] font-semibold text-white">{label}</div>
                            {items.length > 1 && (
                                <div className="mt-0.5 text-[10px] text-white/90">{items.length} 张</div>
                            )}
                        </div>
                    </>
                ) : (
                    <>
                        <Plus className="h-7 w-7" strokeWidth={1.8} />
                        <span className="mt-1.5 text-[11px] font-medium">{label}</span>
                    </>
                )}
            </label>

            {hasItems && onClear && (
                <button
                    type="button"
                    onClick={onClear}
                    className="absolute -right-1.5 -top-1.5 hidden h-6 w-6 items-center justify-center rounded-full bg-black/75 text-white shadow-[0_6px_16px_rgba(0,0,0,0.28)] group-hover:flex"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            )}
        </div>
    );
}

function VideoAssetPreview({
    asset,
    src,
    className,
    style,
}: {
    asset: GeneratedAsset;
    src: string;
    className?: string;
    style?: React.CSSProperties;
}) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const posterSeekRef = useRef(false);
    const [capturedPoster, setCapturedPoster] = useState('');
    const posterSource = asset.thumbnailUrl || asset.thumbnail_url || capturedPoster;
    const posterUrl = posterSource ? resolveAssetUrl(posterSource) : undefined;
    const shouldCapturePoster = !posterSource;

    useEffect(() => {
        setCapturedPoster('');
    }, [asset.id, asset.previewUrl, asset.thumbnailUrl, asset.thumbnail_url]);

    const capturePosterFrame = useCallback(() => {
        if (!shouldCapturePoster || capturedPoster) return;
        const video = videoRef.current;
        if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return;
        try {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const context = canvas.getContext('2d');
            if (!context) return;
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            setCapturedPoster(canvas.toDataURL('image/jpeg', 0.82));
        } catch {
            // Some remote/file URLs cannot be drawn to canvas; the video remains playable.
        }
    }, [capturedPoster, shouldCapturePoster]);

    const preparePosterFrame = useCallback(() => {
        const video = videoRef.current;
        if (!video || !shouldCapturePoster) return;
        const targetTime = Math.min(0.5, Math.max(0, (Number.isFinite(video.duration) ? video.duration : 1) - 0.05));
        if (Math.abs(video.currentTime - targetTime) > 0.05) {
            try {
                posterSeekRef.current = true;
                video.currentTime = targetTime;
            } catch {
                capturePosterFrame();
            }
        } else {
            capturePosterFrame();
        }
    }, [capturePosterFrame, shouldCapturePoster]);

    return (
        <video
            ref={videoRef}
            src={src}
            poster={posterUrl}
            controls
            preload="metadata"
            onLoadedData={preparePosterFrame}
            onSeeked={capturePosterFrame}
            onPlay={() => {
                const video = videoRef.current;
                if (posterSeekRef.current && video) {
                    posterSeekRef.current = false;
                    video.currentTime = 0;
                }
            }}
            className={className}
            style={style}
        />
    );
}

function AssetPreview({
    asset,
    className,
    style,
    interactive = false,
}: {
    asset: GeneratedAsset;
    className?: string;
    style?: React.CSSProperties;
    interactive?: boolean;
}) {
    if (!asset.previewUrl || !asset.exists) {
        return (
            <div
                className={clsx('flex items-center justify-center rounded-[16px] bg-surface-secondary text-xs text-text-tertiary', className)}
                style={style}
            >
                无法预览
            </div>
        );
    }
    const src = resolveAssetUrl(asset.previewUrl);
    if (isVideoAsset(asset)) {
        return (
            <VideoAssetPreview
                asset={asset}
                src={src}
                className={clsx('w-full rounded-[16px] bg-black object-cover', interactive && 'pointer-events-none', className)}
                style={style}
            />
        );
    }
    if (isAudioAsset(asset)) {
        return (
            <audio
                src={src}
                controls
                preload="metadata"
                className={clsx('w-full', className)}
                style={style}
            />
        );
    }
    return (
        <img
            src={src}
            alt={asset.title || asset.id}
            className={clsx('w-full rounded-[16px] object-cover', interactive && 'pointer-events-none', className)}
            style={style}
        />
    );
}

function AgentAttachmentCard({
    attachment,
    onClear,
}: {
    attachment: UploadedFileAttachment;
    onClear: () => void;
}) {
    const kind = attachmentVisualKind(attachment);
    const previewSrc = kind === 'image' ? attachmentPreviewSrc(attachment) : '';
    const meta = [attachmentKindLabel(kind), formatAttachmentSize(attachment.size)].filter(Boolean).join(' · ');

    return (
        <div className="flex items-center gap-3 rounded-[16px] border border-border bg-surface-secondary p-3">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[12px] bg-surface-tertiary">
                {previewSrc ? (
                    <img src={previewSrc} alt={attachment.name} className="h-full w-full object-cover" />
                ) : kind === 'video' ? (
                    <Clapperboard className="h-5 w-5 text-text-tertiary" />
                ) : kind === 'audio' ? (
                    <Music2 className="h-5 w-5 text-text-tertiary" />
                ) : (
                    <FileText className="h-5 w-5 text-text-tertiary" />
                )}
            </div>
            <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-text-primary">{attachment.name}</div>
                <div className="mt-0.5 text-[11px] text-text-tertiary">{meta || '附件'}</div>
            </div>
            <button
                type="button"
                onClick={onClear}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-primary text-text-tertiary transition-colors hover:text-text-primary"
                aria-label="移除附件"
            >
                <X className="h-4 w-4" />
            </button>
        </div>
    );
}

function ReferenceStack({
    request,
    preview,
}: {
    request: GenerationRequest;
    preview?: ReferenceItem | null;
}) {
    const lead = preview || requestLeadingReference(request);
    if (!lead) {
        return (
            <div className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-surface-secondary text-text-tertiary">
                {request.type === 'cover'
                    ? <Layers className="h-3.5 w-3.5" />
                    : request.type === 'image'
                    ? <ImageIcon className="h-3.5 w-3.5" />
                    : request.type === 'audio'
                        ? <Music2 className="h-3.5 w-3.5" />
                        : <Clapperboard className="h-3.5 w-3.5" />}
            </div>
        );
    }
    return (
        <div className="h-10 w-10 overflow-hidden rounded-[12px] bg-surface-tertiary">
            <img src={lead.dataUrl} alt={lead.name} className="h-full w-full object-cover" />
        </div>
    );
}

function requestReferenceItems(request: GenerationRequest): ReferenceItem[] {
    if (request.type === 'audio' || request.type === 'digital-human') return [];
    const items = [...request.referenceItems];
    if (request.type === 'video') {
        if (request.firstClip) items.push(request.firstClip);
        if (request.drivingAudio) items.push(request.drivingAudio);
    }
    const seen = new Set<string>();
    return items.filter((item) => {
        const key = item.dataUrl || item.name;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function ReferencePreviewStrip({ request }: { request: GenerationRequest }) {
    const items = requestReferenceItems(request);
    if (items.length === 0) return null;
    return (
        <div className="flex max-w-[680px] items-center gap-2 overflow-x-auto">
            <div className="shrink-0 text-[11px] text-text-tertiary">参考图</div>
            <div className="flex min-w-0 items-center gap-2">
                {items.slice(0, 6).map((item, index) => (
                    <div
                        key={`${item.dataUrl}-${index}`}
                        className="h-12 w-12 shrink-0 overflow-hidden rounded-[10px] border border-border bg-surface-secondary"
                        title={item.name}
                    >
                        {dataUrlMimeType(item.dataUrl).startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac|ogg|opus|webm)$/i.test(item.name) ? (
                            <div className="flex h-full w-full items-center justify-center text-text-tertiary">
                                <Music2 className="h-4 w-4" />
                            </div>
                        ) : dataUrlMimeType(item.dataUrl).startsWith('video/') || /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(item.name) ? (
                            <div className="flex h-full w-full items-center justify-center text-text-tertiary">
                                <Clapperboard className="h-4 w-4" />
                            </div>
                        ) : (
                            <img src={item.dataUrl} alt={item.name} className="h-full w-full object-cover" />
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

function MetaRow({ request }: { request: GenerationRequest }) {
    const summary = buildRequestSummary(request);
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="inline-flex h-7 items-center rounded-[9px] bg-accent-muted px-2.5 text-[12px] font-semibold text-brand-red">
                {requestModeLabel(request)}
            </span>
            <div className="inline-flex min-w-0 flex-wrap items-center gap-2.5 rounded-[9px] bg-surface-secondary px-3 py-1.5 text-[12px] text-text-secondary">
                <span className="max-w-[240px] truncate font-medium text-text-primary">{summary[0]}</span>
                <span className="text-text-tertiary">|</span>
                <span>{summary[1]}</span>
                <span className="text-text-tertiary">|</span>
                <span>{summary[2]}</span>
                <span className="text-text-tertiary">|</span>
                <span>{requestSupportText(request)}</span>
            </div>
        </div>
    );
}

function requestDisplayPrompt(request: GenerationRequest): string {
    const prompt = request.prompt.trim();
    if (prompt) return prompt;
    if (request.type === 'cover' && request.manuscriptSource) {
        return `根据稿件《${request.manuscriptSource.title}》做封面`;
    }
    if (request.type === 'cover') return '封面创作';
    return '';
}

function placeholderMediaGridClass(request: GenerationRequest, itemCount: number, aspectRatio: string): string {
    if (request.type === 'audio') return 'max-w-[520px]';
    const ratio = parseAspectRatio(aspectRatio, request.type === 'video' ? '16 / 9' : '4 / 3');
    const portrait = ratio.height > ratio.width;
    if (itemCount === 1) {
        return portrait ? 'max-w-[220px]' : 'max-w-[360px]';
    }
    return portrait ? 'max-w-[380px] grid-cols-2' : 'max-w-[520px] grid-cols-2';
}

function FeedEntryMessage({
    entry,
    isActive,
    inlineWithAgent = false,
    onRegenerate,
    onEdit,
    onDelete,
    onPreviewAsset,
    onOpenAssetMenu,
}: {
    entry: GenerationFeedEntry;
    isActive: boolean;
    inlineWithAgent?: boolean;
    onRegenerate: (entry: GenerationFeedEntry) => void;
    onEdit: (entry: GenerationFeedEntry) => void;
    onDelete: (entryId: string) => void;
    onPreviewAsset: (asset: GeneratedAsset) => void;
    onOpenAssetMenu: (event: React.MouseEvent<HTMLElement>, asset: GeneratedAsset, entryId?: string) => void;
}) {
    const [now, setNow] = useState(() => Date.now());
    const hasMediaJob = Boolean(entry.jobId);
    const isRunning = entry.status === 'running';
    const showMediaProgress = isRunning && hasMediaJob;
    const progress = estimateGenerationProgress(entry.request, now - entry.createdAt);
    const placeholderCount = placeholderCountForRequest(entry.request);
    const placeholderAspectRatio = placeholderAspectRatioForRequest(entry.request);
    const placeholderGridClass = placeholderMediaGridClass(entry.request, placeholderCount, placeholderAspectRatio);
    const assetGridClass = feedMediaGridClass(entry.request, entry.assets.length);
    const mediaHeightClass = feedMediaHeightClass(entry.request);

    useEffect(() => {
        setNow(Date.now());
        if (!isActive || !showMediaProgress) return;
        const timer = window.setInterval(() => setNow(Date.now()), 800);
        return () => window.clearInterval(timer);
    }, [entry.createdAt, isActive, showMediaProgress]);

    return (
        <article className={clsx('space-y-3', inlineWithAgent && '-mt-4 space-y-2')}>
            {inlineWithAgent ? (
                <div className="flex max-w-[620px] items-center gap-2">
                    <div className="min-w-0 flex-1">
                        <MetaRow request={entry.request} />
                    </div>
                    <button
                        type="button"
                        onClick={() => onDelete(entry.id)}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-brand-red/10 hover:text-brand-red"
                        aria-label="删除创作记录"
                        title="删除创作记录"
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                    </button>
                </div>
            ) : (
                <>
                    <div className="flex items-start gap-2.5">
                        <ReferenceStack request={entry.request} preview={entry.referencePreview} />
                        <div className="min-w-0 flex-1 space-y-2">
                            <MetaRow request={entry.request} />
                            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-text-tertiary">
                                <span>{formatRelativeTime(entry.createdAt)}</span>
                                <span>·</span>
                                <span>{SOURCE_LABELS[entry.source] || entry.source}</span>
                                {entry.sourceTitle && (
                                    <>
                                        <span>·</span>
                                        <span className="truncate">{entry.sourceTitle}</span>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>

                    {requestDisplayPrompt(entry.request) && (
                        <div className="flex max-w-[680px] items-start gap-2">
                            <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-6 text-text-primary">
                                {requestDisplayPrompt(entry.request)}
                            </div>
                            <button
                                type="button"
                                onClick={() => onDelete(entry.id)}
                                className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-brand-red/10 hover:text-brand-red"
                                aria-label="删除创作记录"
                                title="删除创作记录"
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    )}

                    <ReferencePreviewStrip request={entry.request} />
                </>
            )}

            {showMediaProgress && (
                <div className="max-w-[560px] space-y-2">
                    <div className="flex items-center justify-between gap-4">
                        <div className="text-[12px] font-medium text-text-secondary">
                            任务创作中 {progress}%...
                        </div>
                        <div className="text-[11px] text-text-tertiary">
                            {entry.request.type === 'cover' ? '正在生成封面' : entry.request.type === 'image' ? '正在生成图片' : entry.request.type === 'audio' ? '正在生成音频' : '正在生成视频'}
                        </div>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-tertiary">
                        <div
                            className="h-full rounded-full bg-[linear-gradient(90deg,rgb(var(--color-brand-red)/1)_0%,rgb(var(--color-accent-primary)/1)_100%)] transition-[width] duration-700 ease-out"
                            style={{ width: `${progress}%` }}
                        />
                    </div>
                </div>
            )}

            {entry.status === 'error' && (
                <div className="max-w-[620px] rounded-[14px] bg-brand-red/10 px-4 py-3 text-sm text-brand-red">
                    {entry.error || '生成失败'}
                </div>
            )}

            {showMediaProgress && entry.assets.length === 0 && entry.request.type !== 'audio' && (
                <div className={clsx('grid gap-3', placeholderGridClass)}>
                    {Array.from({ length: placeholderCount }).map((_, index) => (
                        <div
                            key={`${entry.id}-placeholder-${index}`}
                            className="relative w-full overflow-hidden rounded-[14px] border border-border bg-surface-secondary"
                            style={{ aspectRatio: placeholderAspectRatio }}
                        >
                            <div
                                className="absolute inset-0"
                                style={{
                                    background: 'linear-gradient(180deg, rgb(var(--color-surface-primary) / 0.92) 0%, rgb(var(--color-surface-secondary) / 0.98) 100%)',
                                }}
                            />
                            <div
                                className="absolute -left-[12%] top-[-16%] h-[52%] w-[58%] rounded-full blur-[28px] animate-[pulse_2.1s_ease-in-out_infinite]"
                                style={{ background: 'radial-gradient(circle, rgb(var(--color-brand-red) / 0.3) 0%, rgb(var(--color-brand-red) / 0.14) 30%, rgb(var(--color-brand-red) / 0) 72%)' }}
                            />
                            <div
                                className="absolute right-[-10%] top-[8%] h-[42%] w-[46%] rounded-full blur-[24px] animate-[pulse_1.7s_ease-in-out_infinite]"
                                style={{ background: 'radial-gradient(circle, rgb(var(--color-accent-primary) / 0.24) 0%, rgb(var(--color-accent-primary) / 0.1) 36%, rgb(var(--color-accent-primary) / 0) 74%)' }}
                            />
                            <div
                                className="absolute bottom-[-12%] left-[18%] h-[44%] w-[50%] rounded-full blur-[26px] animate-[pulse_2.4s_ease-in-out_infinite]"
                                style={{ background: 'radial-gradient(circle, rgb(var(--color-brand-red) / 0.2) 0%, rgb(var(--color-brand-red) / 0.08) 34%, rgb(var(--color-brand-red) / 0) 76%)' }}
                            />
                            <div
                                className="absolute inset-0 opacity-90 animate-[pulse_1.35s_linear_infinite]"
                                style={{
                                    backgroundImage: 'radial-gradient(circle, rgb(var(--color-brand-red) / 0.32) 1.15px, transparent 1.55px)',
                                    backgroundSize: '20px 20px',
                                    backgroundPosition: '0 0',
                                    maskImage: 'linear-gradient(180deg, transparent 2%, rgba(0,0,0,0.86) 24%, rgba(0,0,0,0.94) 62%, transparent 98%)',
                                    WebkitMaskImage: 'linear-gradient(180deg, transparent 2%, rgba(0,0,0,0.86) 24%, rgba(0,0,0,0.94) 62%, transparent 98%)',
                                }}
                            />
                            <div
                                className="absolute inset-0 opacity-85 animate-[pulse_1.1s_ease-in-out_infinite]"
                                style={{
                                    backgroundImage: 'radial-gradient(circle, rgb(var(--color-accent-primary) / 0.42) 1.2px, transparent 1.7px)',
                                    backgroundSize: '18px 18px',
                                    backgroundPosition: '9px 6px',
                                    maskImage: 'radial-gradient(circle at 80% 22%, rgba(0,0,0,0.98) 0%, rgba(0,0,0,0.88) 15%, rgba(0,0,0,0.6) 29%, transparent 54%)',
                                    WebkitMaskImage: 'radial-gradient(circle at 80% 22%, rgba(0,0,0,0.98) 0%, rgba(0,0,0,0.88) 15%, rgba(0,0,0,0.6) 29%, transparent 54%)',
                                }}
                            />
                            <div
                                className="absolute inset-0 opacity-85 animate-[pulse_0.95s_ease-in-out_infinite]"
                                style={{
                                    backgroundImage: 'radial-gradient(circle, rgb(var(--color-brand-red) / 0.36) 1.1px, transparent 1.6px)',
                                    backgroundSize: '17px 17px',
                                    backgroundPosition: '4px 10px',
                                    maskImage: 'radial-gradient(circle at 18% 80%, rgba(0,0,0,0.98) 0%, rgba(0,0,0,0.88) 16%, rgba(0,0,0,0.58) 31%, transparent 56%)',
                                    WebkitMaskImage: 'radial-gradient(circle at 18% 80%, rgba(0,0,0,0.98) 0%, rgba(0,0,0,0.88) 16%, rgba(0,0,0,0.58) 31%, transparent 56%)',
                                }}
                            />
                            <div
                                className="absolute inset-0 opacity-65 animate-[pulse_1.45s_ease-in-out_infinite]"
                                style={{
                                    backgroundImage: 'radial-gradient(circle, rgb(var(--color-brand-red) / 0.22) 0.95px, transparent 1.45px)',
                                    backgroundSize: '14px 14px',
                                    backgroundPosition: '2px 3px',
                                    maskImage: 'linear-gradient(135deg, transparent 0%, rgba(0,0,0,0.94) 18%, rgba(0,0,0,0.94) 46%, transparent 68%)',
                                    WebkitMaskImage: 'linear-gradient(135deg, transparent 0%, rgba(0,0,0,0.94) 18%, rgba(0,0,0,0.94) 46%, transparent 68%)',
                                }}
                            />
                            <div
                                className="absolute inset-0 opacity-55 animate-[pulse_0.8s_linear_infinite]"
                                style={{
                                    background: 'linear-gradient(110deg, transparent 12%, rgb(var(--color-surface-primary) / 0.24) 34%, rgb(var(--color-brand-red) / 0.18) 50%, rgb(var(--color-surface-primary) / 0.18) 63%, transparent 82%)',
                                    transform: 'translateX(-18%)',
                                    mixBlendMode: 'screen',
                                }}
                            />
                            <div className="absolute left-5 top-5 text-[12px] font-semibold text-text-secondary">
                                {entry.request.type === 'cover' ? '正在创建封面' : entry.request.type === 'image' ? '正在创建图片' : entry.request.type === 'audio' ? '正在创建音频' : '正在创建视频'}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {entry.assets.length > 0 && (
                <div className={clsx('grid gap-4', assetGridClass)}>
                    {entry.assets.map((asset) => {
                        if (isAudioAsset(asset)) {
                            return (
                                <div
                                    key={asset.id}
                                    className="max-w-[620px]"
                                    onContextMenu={(event) => onOpenAssetMenu(event, asset, entry.id)}
                                >
                                    <AssetPreview asset={asset} />
                                </div>
                            );
                        }
                        if (isVideoAsset(asset)) {
                            return (
                                <div
                                    key={asset.id}
                                    className="group relative overflow-hidden rounded-[16px]"
                                    onContextMenu={(event) => onOpenAssetMenu(event, asset, entry.id)}
                                    title="直接播放视频"
                                >
                                    <AssetPreview
                                        asset={asset}
                                        className={clsx(mediaHeightClass, asset.previewUrl && asset.exists && 'transition-[filter] duration-200')}
                                        style={{ aspectRatio: normalizeAspectRatio(asset.aspectRatio, placeholderAspectRatio) }}
                                    />
                                </div>
                            );
                        }
                        return (
                            <button
                                key={asset.id}
                                type="button"
                                onClick={() => onPreviewAsset(asset)}
                                onContextMenu={(event) => onOpenAssetMenu(event, asset, entry.id)}
                                disabled={!asset.previewUrl || !asset.exists}
                                className={clsx(
                                    'group relative overflow-hidden rounded-[16px] text-left transition-transform',
                                    asset.previewUrl && asset.exists
                                        ? 'cursor-pointer hover:-translate-y-0.5'
                                        : 'cursor-default',
                                )}
                                title={isVideoAsset(asset) ? '点击打开视频预览' : '点击放大图片'}
                            >
                                <AssetPreview
                                    asset={asset}
                                    className={clsx(mediaHeightClass, asset.previewUrl && asset.exists && 'transition-[filter] duration-200 group-hover:brightness-[0.94]')}
                                    style={{ aspectRatio: normalizeAspectRatio(asset.aspectRatio, placeholderAspectRatio) }}
                                    interactive
                                />
                                {asset.previewUrl && asset.exists && isVideoAsset(asset) && (
                                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-black/55 text-white shadow-[0_10px_24px_rgba(0,0,0,0.28)]">
                                            <Play className="ml-0.5 h-5 w-5 fill-current" />
                                        </div>
                                    </div>
                                )}
                            </button>
                        );
                    })}
                </div>
            )}

            {!isRunning && (
                <div className="flex flex-wrap items-center gap-2.5">
                    <button
                        type="button"
                        onClick={() => onRegenerate(entry)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-border bg-surface-secondary px-3 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-tertiary"
                    >
                        <RotateCcw className="h-3.5 w-3.5" />
                        再次生成
                    </button>
                    <button
                        type="button"
                        onClick={() => onEdit(entry)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-border bg-surface-secondary px-3 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-tertiary"
                    >
                        <PencilLine className="h-3.5 w-3.5" />
                        重新编辑
                    </button>
                </div>
            )}
        </article>
    );
}

export function GenerationStudio({
    isActive = false,
    pendingIntent = null,
    onIntentConsumed,
    onExecutionStateChange,
    onReturnHome,
    onOpenAssets,
}: GenerationStudioProps) {
    const [settings, setSettings] = useState<SettingsShape>({});
    const [pricingCatalog, setPricingCatalog] = useState<AiPricingCatalog | null>(null);
    const [contextIntent, setContextIntent] = useState<GenerationIntent | null>(null);
    const [studioMode, setStudioMode] = useState<StudioMode>('image');
    const [, setBindTarget] = useState('');
    const [feedEntries, setFeedEntries] = useState<FeedEntry[]>([]);
    const deletedFeedStateRef = useRef<DeletedFeedState>(readDeletedFeedState());
    const [previewAsset, setPreviewAsset] = useState<GeneratedAsset | null>(null);
    const [assetContextMenu, setAssetContextMenu] = useState<AssetContextMenuState | null>(null);
    const feedScrollRef = useRef<HTMLElement | null>(null);
    const feedBottomRef = useRef<HTMLDivElement | null>(null);
    const shouldScrollFeedToBottomRef = useRef(false);
    const lastFeedCountRef = useRef(feedEntries.length);
    const agentSessionRequestIdRef = useRef(0);
    const lastSettingsVoiceTtsModelRef = useRef('');

    const [imagePrompt, setImagePrompt] = useState('');
    const [imageTitle, setImageTitle] = useState('');
    const [imageProjectId, setImageProjectId] = useState('');
    const [imageCount, setImageCount] = useState(1);
    const [imageModel, setImageModel] = useState('');
    const [imageAspectRatio, setImageAspectRatio] = useState('4:3');
    const [imageSize, setImageSize] = useState('');
    const [imageResolution, setImageResolution] = useState('1K');
    const [imageMode, setImageMode] = useState<ImageGenerationMode>('text-to-image');
    const [imageReferences, setImageReferences] = useState<ReferenceItem[]>([]);
    const [isReadingImageRefs, setIsReadingImageRefs] = useState(false);
    const [imageError, setImageError] = useState('');
    const [agentSessionId, setAgentSessionId] = useState<string | null>(null);
    const [isAgentSessionLoading, setIsAgentSessionLoading] = useState(false);
    const [agentSessionError, setAgentSessionError] = useState('');
    const [agentExecutionActive, setAgentExecutionActive] = useState(false);
    const [agentPendingMessage, setAgentPendingMessage] = useState<PendingChatMessage | null>(null);
    const [agentAttachment, setAgentAttachment] = useState<UploadedFileAttachment | null>(null);
    const [agentSendNonce, setAgentSendNonce] = useState(0);
    const [agentClearNonce, setAgentClearNonce] = useState(0);

    const [videoPrompt, setVideoPrompt] = useState('');
    const [videoTitle, setVideoTitle] = useState('');
    const [videoProjectId, setVideoProjectId] = useState('');
    const [videoMode, setVideoMode] = useState<VideoGenerationMode>('text-to-video');
    const [videoReferences, setVideoReferences] = useState<Array<ReferenceItem | null>>([]);
    const [videoFirstFrame, setVideoFirstFrame] = useState<ReferenceItem | null>(null);
    const [videoLastFrame, setVideoLastFrame] = useState<ReferenceItem | null>(null);
    const [videoFirstClip, setVideoFirstClip] = useState<ReferenceItem | null>(null);
    const [videoDrivingAudio, setVideoDrivingAudio] = useState<ReferenceItem | null>(null);
    const [videoAspectRatio, setVideoAspectRatio] = useState<'16:9' | '9:16'>('16:9');
    const [videoResolution, setVideoResolution] = useState<'720p' | '1080p'>('720p');
    const [videoDurationSeconds, setVideoDurationSeconds] = useState(8);
    const [videoGenerateAudio, setVideoGenerateAudio] = useState(false);
    const [isReadingVideoRefs, setIsReadingVideoRefs] = useState(false);
    const [videoError, setVideoError] = useState('');
    const [audioPrompt, setAudioPrompt] = useState('');
    const [audioTitle, setAudioTitle] = useState('');
    const [audioProjectId, setAudioProjectId] = useState('');
    const [audioModel, setAudioModel] = useState('');
    const [audioVoiceId, setAudioVoiceId] = useState('');
    const [audioLanguageBoost, setAudioLanguageBoost] = useState('Chinese');
    const [audioSpeed, setAudioSpeed] = useState('1');
    const [audioEmotion, setAudioEmotion] = useState('');
    const [audioSpeedTouched, setAudioSpeedTouched] = useState(false);
    const [digitalHumanPrompt, setDigitalHumanPrompt] = useState('');
    const [digitalHumanTitle, setDigitalHumanTitle] = useState('');
    const [digitalHumanProjectId, setDigitalHumanProjectId] = useState('');
    const [digitalHumanRoleId, setDigitalHumanRoleId] = useState('');
    const [digitalHumanSubjects, setDigitalHumanSubjects] = useState<SubjectRecord[]>([]);
    const [digitalHumanCategories, setDigitalHumanCategories] = useState<SubjectCategoryRecord[]>([]);
    const [isLoadingDigitalHumanRoles, setIsLoadingDigitalHumanRoles] = useState(false);
    const [digitalHumanError, setDigitalHumanError] = useState('');
    const digitalHumanUploadCacheRef = useRef(new Map<string, string>());
    const [audioEmotionTouched, setAudioEmotionTouched] = useState(false);
    const [audioVoices, setAudioVoices] = useState<VoiceListItem[]>([]);
    const [isLoadingAudioVoices, setIsLoadingAudioVoices] = useState(false);
    const [audioError, setAudioError] = useState('');
    const audioRichTextInputRef = useRef<AudioRichTextInputHandle | null>(null);
    const [audioPauseMenuOpen, setAudioPauseMenuOpen] = useState(false);
    const audioPauseMenuRef = useDismissiblePopover(audioPauseMenuOpen, () => setAudioPauseMenuOpen(false));
    const [coverPrompt, setCoverPrompt] = useState('');
    const [coverTitle, setCoverTitle] = useState('');
    const [coverProjectId, setCoverProjectId] = useState('');
    const [coverCount, setCoverCount] = useState(1);
    const [coverModel, setCoverModel] = useState('');
    const [coverQuality, setCoverQuality] = useState('medium');
    const [coverReferences, setCoverReferences] = useState<ReferenceItem[]>([]);
    const [coverManuscriptPath, setCoverManuscriptPath] = useState('');
    const [coverManuscripts, setCoverManuscripts] = useState<CoverManuscriptOption[]>([]);
    const [isLoadingCoverManuscripts, setIsLoadingCoverManuscripts] = useState(false);
    const [coverManuscriptPickerOpen, setCoverManuscriptPickerOpen] = useState(false);
    const [coverManuscriptSearch, setCoverManuscriptSearch] = useState('');
    const [coverPromptSwitches, setCoverPromptSwitches] = useState<CoverPromptSwitches>(DEFAULT_COVER_PROMPT_SWITCHES);
    const [isReadingCoverRefs, setIsReadingCoverRefs] = useState(false);
    const [coverError, setCoverError] = useState('');
    const trackedJobs = useMediaJobsStore(
        useCallback((state) => (
            Object.values(state.jobsById).filter((job) => isGenerationStudioMediaJob(job, agentSessionId))
        ), [agentSessionId]),
        shallowArrayEqual,
    );
    const isAgentMode = true;
    const activeGenerationProjectId = studioMode === 'image'
        ? imageProjectId
        : studioMode === 'video'
            ? videoProjectId
            : studioMode === 'cover'
                ? coverProjectId
            : studioMode === 'digital-human'
                ? digitalHumanProjectId
                : audioProjectId;
    const generationAgentTitle = useMemo(
        () => contextIntent?.sourceTitle || '自由创作',
        [contextIntent?.sourceTitle],
    );
    const generationAgentContextId = useMemo(
        () => buildGenerationAgentContextId(activeGenerationProjectId, contextIntent?.source, contextIntent?.sourceTitle),
        [activeGenerationProjectId, contextIntent?.source, contextIntent?.sourceTitle],
    );
    const generationAgentInitialContext = useMemo(
        () => buildGenerationAgentInitialContext(activeGenerationProjectId, contextIntent?.sourceTitle),
        [activeGenerationProjectId, contextIntent?.sourceTitle],
    );
    const generationAgentSessionMetadata = useMemo(
        () => buildGenerationAgentSessionMetadata(studioMode, activeGenerationProjectId, contextIntent?.sourceTitle),
        [activeGenerationProjectId, contextIntent?.sourceTitle, studioMode],
    );
    const trackedJobIds = useMemo(
        () => feedEntries
            .filter(isGenerationFeedEntry)
            .map((entry) => entry.jobId)
            .filter((jobId): jobId is string => Boolean(jobId)),
        [feedEntries],
    );
    const visibleFeedItems = useMemo(
        () => feedEntries
            .map((entry, index) => ({ entry, index }))
            .filter(({ entry, index }) => !(
                isGenerationFeedEntry(entry)
                && entry.status === 'success'
                && index > 0
                && isAgentSessionFeedEntry(feedEntries[index - 1])
            )),
        [feedEntries],
    );
    const isDigitalHumanMode = studioMode === 'digital-human';
    const generationJobBootstrapFilter = useMemo(() => ({ limit: 100, queueMode: 'free_creation' as const }), []);
    const agentGenerationJobBootstrapFilter = useMemo(
        () => agentSessionId
            ? { limit: 100, queueMode: 'ai_generation' as const, ownerSessionId: agentSessionId }
            : null,
        [agentSessionId],
    );
    const updateFeedEntries = useCallback(
        (updater: FeedEntry[] | ((prev: FeedEntry[]) => FeedEntry[])) => {
            setFeedEntries((prev) => {
                const next = typeof updater === 'function'
                    ? (updater as (prev: FeedEntry[]) => FeedEntry[])(prev)
                    : updater;
                const normalized = sortFeedEntries(next)
                    .filter((entry) => !isFeedEntryDeleted(entry, deletedFeedStateRef.current));
                persistFeedEntries(normalized);
                return normalized;
            });
        },
        [],
    );
    const ensureAgentFeedEntry = useCallback((sessionId: string, createdAt = Date.now(), options?: { bump?: boolean; reviveDeleted?: boolean }) => {
        const agentEntryId = `agent-feed:${generationAgentContextId}`;
        const isDeletedAgentEntry = deletedFeedStateRef.current.entryIds.includes(agentEntryId)
            || deletedFeedStateRef.current.agentSessionIds.includes(sessionId)
            || deletedFeedStateRef.current.agentContextIds.includes(generationAgentContextId);
        if (isDeletedAgentEntry && !options?.reviveDeleted) {
            return;
        }
        if (options?.reviveDeleted && isDeletedAgentEntry) {
            const nextDeleted = {
                ...deletedFeedStateRef.current,
                entryIds: deletedFeedStateRef.current.entryIds.filter((id) => id !== agentEntryId),
                agentSessionIds: deletedFeedStateRef.current.agentSessionIds.filter((id) => id !== sessionId),
                agentContextIds: deletedFeedStateRef.current.agentContextIds.filter((id) => id !== generationAgentContextId),
            };
            deletedFeedStateRef.current = nextDeleted;
            persistDeletedFeedState(nextDeleted);
        }
        updateFeedEntries((prev) => {
            const existingIndex = prev.findIndex((entry) => (
                isAgentSessionFeedEntry(entry)
                && (entry.sessionId === sessionId || entry.contextId === generationAgentContextId)
            ));
            const nextEntry: AgentSessionFeedEntry = {
                kind: 'agent-session',
                id: existingIndex >= 0 ? prev[existingIndex].id : agentEntryId,
                createdAt: existingIndex >= 0 && !options?.bump ? prev[existingIndex].createdAt : createdAt,
                source: contextIntent?.source || 'standalone',
                sourceTitle: contextIntent?.sourceTitle,
                sessionId,
                contextId: generationAgentContextId,
                title: generationAgentTitle,
            };
            if (existingIndex < 0) {
                return sortFeedEntries([...prev, nextEntry]);
            }
            const existing = prev[existingIndex] as AgentSessionFeedEntry;
            if (
                existing.sessionId === nextEntry.sessionId
                && existing.contextId === nextEntry.contextId
                && existing.title === nextEntry.title
                && existing.source === nextEntry.source
                && existing.sourceTitle === nextEntry.sourceTitle
                && existing.createdAt === nextEntry.createdAt
            ) {
                return prev;
            }
            const next = [...prev];
            next[existingIndex] = nextEntry;
            return next;
        });
    }, [contextIntent?.source, contextIntent?.sourceTitle, generationAgentContextId, generationAgentTitle, updateFeedEntries]);

    useEffect(() => {
        let cancelled = false;
        let timeoutId: number | null = null;
        const frameId = window.requestAnimationFrame(() => {
            timeoutId = window.setTimeout(() => {
                if (cancelled) return;
                const persistedEntries = readPersistedFeedEntries();
                if (persistedEntries.length === 0) return;
                updateFeedEntries((prev) => mergeFeedEntriesById(prev, persistedEntries));
            }, 0);
        });
        return () => {
            cancelled = true;
            window.cancelAnimationFrame(frameId);
            if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
            }
        };
    }, [updateFeedEntries]);

    useMediaJobSubscription(trackedJobIds, {
        enabled: isActive,
        bootstrapFilter: generationJobBootstrapFilter,
        bootstrapIncludesTrackedJobs: true,
    });
    useMediaJobSubscription([], {
        enabled: isActive && Boolean(agentGenerationJobBootstrapFilter),
        bootstrapFilter: agentGenerationJobBootstrapFilter,
    });

    const loadContext = useCallback(async (overwriteDraftDefaults = false) => {
        try {
            const nextSettings = await window.ipcRenderer.getSettings() as SettingsShape;

            const normalizedSettings = (nextSettings || {}) as SettingsShape;
            setSettings(normalizedSettings);

            setImageModel((prev) => (overwriteDraftDefaults || !prev.trim() ? (normalizedSettings.image_model || '') : prev));
            setCoverModel((prev) => (overwriteDraftDefaults || !prev.trim() ? (normalizedSettings.image_model || '') : prev));
            setImageAspectRatio((prev) => (overwriteDraftDefaults || !prev.trim() ? (normalizedSettings.image_aspect_ratio || '4:3') : prev));
            setImageSize((prev) => (overwriteDraftDefaults || !prev.trim() ? (normalizedSettings.image_size || '') : prev));
            setCoverQuality((prev) => (overwriteDraftDefaults || !prev.trim() ? normalizeImageQuality(normalizedSettings.image_quality) : prev));
            const nextSettingsVoiceTtsModel = String(normalizedSettings.voice_tts_model || normalizedSettings.tts_model || DEFAULT_AUDIO_TTS_MODEL).trim();
            const previousSettingsVoiceTtsModel = lastSettingsVoiceTtsModelRef.current;
            setAudioModel((prev) => {
                const current = prev.trim();
                if (
                    overwriteDraftDefaults
                    || !current
                    || current === previousSettingsVoiceTtsModel
                    || (!previousSettingsVoiceTtsModel && current === DEFAULT_AUDIO_TTS_MODEL)
                ) {
                    return nextSettingsVoiceTtsModel;
                }
                return prev;
            });
            lastSettingsVoiceTtsModelRef.current = nextSettingsVoiceTtsModel;
        } catch (error) {
            console.error('Failed to load generation studio context:', error);
        }
    }, []);

    const loadPricingCatalog = useCallback(async () => {
        try {
            const result = await window.ipcRenderer.officialAuth.getPricing();
            setPricingCatalog(parseAiPricingCatalog(result?.pricing));
        } catch (error) {
            console.error('Failed to load generation pricing catalog:', error);
            setPricingCatalog(null);
        }
    }, []);

    useEffect(() => {
        void loadContext(false);
        if (isActive) void loadPricingCatalog();
    }, [isActive, loadContext, loadPricingCatalog]);

    useEffect(() => {
        if (!isActive || studioMode !== 'cover') return;
        let cancelled = false;
        setIsLoadingCoverManuscripts(true);
        void (async () => {
            try {
                const tree = await window.ipcRenderer.manuscripts.list<FileNode[]>();
                if (cancelled) return;
                setCoverManuscripts(buildCoverManuscriptOptions(Array.isArray(tree) ? tree : []));
            } catch (error) {
                if (!cancelled) {
                    console.error('Failed to load cover manuscripts:', error);
                }
            } finally {
                if (!cancelled) {
                    setIsLoadingCoverManuscripts(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [isActive, studioMode]);

    useEffect(() => {
        if (!isActive) return;
        const handleSettingsUpdated = () => {
            void loadContext(false);
            void loadPricingCatalog();
        };
        return subscribeSettingsUpdated(handleSettingsUpdated);
    }, [isActive, loadContext, loadPricingCatalog]);

    useEffect(() => {
        if (!pendingIntent) return;
        applyIntentPreset(pendingIntent, {
            setStudioMode,
            setBindTarget,
            setImageAspectRatio,
            setVideoAspectRatio,
            setVideoResolution,
            setVideoDurationSeconds,
            setImageProjectId,
            setVideoProjectId,
            setAudioProjectId,
            setCoverProjectId,
            setContextIntent,
        });
        onIntentConsumed?.();
    }, [onIntentConsumed, pendingIntent]);

    useEffect(() => {
        onExecutionStateChange?.(agentExecutionActive || feedEntries.some((entry) => isGenerationFeedEntry(entry) && entry.status === 'running'));
    }, [agentExecutionActive, feedEntries, onExecutionStateChange]);

    useEffect(() => {
        if (!isAgentMode || isDigitalHumanMode) {
            agentSessionRequestIdRef.current += 1;
            setAgentExecutionActive(false);
            setAgentSessionError('');
            setAgentPendingMessage(null);
            setAgentAttachment(null);
            setIsAgentSessionLoading(false);
            return;
        }

        const requestId = ++agentSessionRequestIdRef.current;
        setIsAgentSessionLoading(true);
        setAgentSessionError('');

        void (async () => {
            try {
                const session = await window.ipcRenderer.chat.getOrCreateContextSession({
                    contextId: generationAgentContextId,
                    contextType: GENERATION_AGENT_CONTEXT_TYPE,
                    title: generationAgentTitle,
                    initialContext: generationAgentInitialContext,
                    metadata: generationAgentSessionMetadata,
                });
                if (requestId !== agentSessionRequestIdRef.current) return;
                setAgentSessionId(session.id);
                const rawSessionTimestamp = session.createdAt || session.created_at || session.updatedAt || Date.now();
                const numericSessionTimestamp = typeof rawSessionTimestamp === 'number'
                    ? rawSessionTimestamp
                    : Number(rawSessionTimestamp);
                const sessionCreatedAt = Number.isFinite(numericSessionTimestamp)
                    ? numericSessionTimestamp
                    : Date.parse(String(rawSessionTimestamp));
                const existingMessages = await window.ipcRenderer.chat.getMessages(session.id);
                if (requestId !== agentSessionRequestIdRef.current) return;
                const hasExistingMessages = Array.isArray(existingMessages) && existingMessages.length > 0;
                if (hasExistingMessages) {
                    const rawFirstTimestamp = existingMessages[0]?.createdAt
                        || existingMessages[0]?.created_at
                        || existingMessages[0]?.timestamp
                        || Date.now();
                    const numericTimestamp = typeof rawFirstTimestamp === 'number'
                        ? rawFirstTimestamp
                        : Number(rawFirstTimestamp);
                    const firstTimestamp = Number.isFinite(numericTimestamp)
                        ? numericTimestamp
                        : Date.parse(String(rawFirstTimestamp));
                    ensureAgentFeedEntry(session.id, Number.isFinite(firstTimestamp) ? firstTimestamp : Date.now());
                } else {
                    ensureAgentFeedEntry(session.id, Number.isFinite(sessionCreatedAt) ? sessionCreatedAt : Date.now());
                }
            } catch (error) {
                if (requestId !== agentSessionRequestIdRef.current) return;
                console.error('Failed to initialize generation agent session:', error);
                setAgentSessionError(error instanceof Error ? error.message : '创作会话初始化失败');
            } finally {
                if (requestId === agentSessionRequestIdRef.current) {
                    setIsAgentSessionLoading(false);
                }
            }
        })();
    }, [ensureAgentFeedEntry, generationAgentContextId, generationAgentInitialContext, generationAgentSessionMetadata, generationAgentTitle, isAgentMode, isDigitalHumanMode]);

    useEffect(() => {
        updateFeedEntries((prev) => {
            return mergeMediaJobsIntoFeedEntries(prev, trackedJobs, deletedFeedStateRef.current, {
                ownerSessionId: agentSessionId,
            });
        });
    }, [agentSessionId, trackedJobs, updateFeedEntries]);

    useEffect(() => {
        if (!previewAsset) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setPreviewAsset(null);
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [previewAsset]);

    useEffect(() => {
        if (!coverManuscriptPickerOpen) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setCoverManuscriptPickerOpen(false);
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [coverManuscriptPickerOpen]);

    useEffect(() => {
        if (!assetContextMenu) return;
        const handlePointerDown = () => setAssetContextMenu(null);
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setAssetContextMenu(null);
        };
        window.addEventListener('mousedown', handlePointerDown);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('mousedown', handlePointerDown);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [assetContextMenu]);

    useEffect(() => {
        if (!isActive || feedEntries.length === 0) return;
        const frame = window.requestAnimationFrame(() => {
            feedBottomRef.current?.scrollIntoView({ block: 'end' });
        });
        return () => window.cancelAnimationFrame(frame);
    }, [isActive]);

    useEffect(() => {
        const previousCount = lastFeedCountRef.current;
        lastFeedCountRef.current = feedEntries.length;
        if (feedEntries.length === 0 || feedEntries.length <= previousCount) return;
        const frame = window.requestAnimationFrame(() => {
            const container = feedScrollRef.current;
            if (!container) return;
            container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
        });
        return () => window.cancelAnimationFrame(frame);
    }, [feedEntries.length]);

    useEffect(() => {
        if (!isActive || !shouldScrollFeedToBottomRef.current) return;
        shouldScrollFeedToBottomRef.current = false;
        const frame = window.requestAnimationFrame(() => {
            const container = feedScrollRef.current;
            if (!container) return;
            container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
        });
        return () => window.cancelAnimationFrame(frame);
    }, [feedEntries, isActive]);

    const resolvedImageEndpoint = (settings.image_endpoint || settings.api_endpoint || '').trim();
    const resolvedImageApiKey = (settings.image_api_key || settings.api_key || '').trim();
    const hasImageConfig = Boolean(resolvedImageEndpoint) && Boolean(resolvedImageApiKey);
    const resolvedVideoEndpoint = (settings.video_endpoint || REDBOX_OFFICIAL_VIDEO_BASE_URL).trim();
    const resolvedVideoApiKey = (settings.video_api_key || settings.api_key || '').trim();
    const hasVideoConfig = Boolean(resolvedVideoEndpoint) && Boolean(resolvedVideoApiKey);
    const effectiveVideoModel = resolvedVideoEndpoint === REDBOX_OFFICIAL_VIDEO_BASE_URL
        ? getRedBoxOfficialVideoModel(videoMode)
        : (settings.video_model || getRedBoxOfficialVideoModel(videoMode)).trim();
    const resolvedVoiceEndpoint = (settings.voice_endpoint || settings.tts_endpoint || settings.api_endpoint || '').trim();
    const resolvedVoiceApiKey = (settings.voice_api_key || settings.tts_api_key || settings.api_key || '').trim();
    const hasVoiceConfig = Boolean(resolvedVoiceEndpoint) && Boolean(resolvedVoiceApiKey);
    const audioModelOptions = useMemo<PickerOption[]>(() => buildAudioModelOptions(settings), [settings]);
    const effectiveAudioModel = (audioModel || settings.voice_tts_model || settings.tts_model || DEFAULT_AUDIO_TTS_MODEL).trim();
    const audioVoicesForModel = useMemo(
        () => audioVoices.filter((voice) => voiceMatchesAudioModel(voice, effectiveAudioModel)),
        [audioVoices, effectiveAudioModel],
    );
    const selectedAudioVoice = useMemo(
        () => audioVoicesForModel.find((voice) => voice.id === audioVoiceId.trim()) || null,
        [audioVoiceId, audioVoicesForModel],
    );

    const imageModelOptions = useMemo<PickerOption[]>(() => buildImageModelOptions(settings), [settings]);
    const activeImageModelOption = useMemo(
        () => imageModelOptions.find((option) => option.value === imageModel.trim()) || null,
        [imageModel, imageModelOptions],
    );
    const selectedCoverManuscript = useMemo(() => {
        const selectedPath = coverManuscriptPath.trim();
        if (!selectedPath) return null;
        return coverManuscripts.find((item) => item.path === selectedPath) || {
            path: selectedPath,
            title: manuscriptFallbackTitle(selectedPath),
            updatedAt: 0,
        };
    }, [coverManuscriptPath, coverManuscripts]);
    const filteredCoverManuscripts = useMemo(() => {
        const query = coverManuscriptSearch.trim().toLowerCase();
        if (!query) return coverManuscripts;
        return coverManuscripts.filter((item) => (
            item.title.toLowerCase().includes(query)
            || item.path.toLowerCase().includes(query)
        ));
    }, [coverManuscriptSearch, coverManuscripts]);
    const audioLanguageOptions = useMemo<PickerOption[]>(
        () => buildAudioLanguageOptions(audioVoicesForModel),
        [audioVoicesForModel],
    );
    const audioVoiceOptions = useMemo<PickerOption[]>(
        () => buildAudioVoiceOptions(audioVoicesForModel, audioLanguageBoost),
        [audioLanguageBoost, audioVoicesForModel],
    );
    const mergedAudioVoiceOptions = useMemo<PickerOption[]>(() => {
        const normalizedVoiceId = audioVoiceId.trim();
        if (!normalizedVoiceId || audioVoiceOptions.some((option) => option.value === normalizedVoiceId)) {
            return audioVoiceOptions;
        }
        if (!audioVoicesForModel.some((voice) => voice.id === normalizedVoiceId)) {
            return audioVoiceOptions;
        }
        return [
            { value: normalizedVoiceId, label: shortVoiceId(normalizedVoiceId), description: '当前音色' },
            ...audioVoiceOptions,
        ];
    }, [audioVoiceId, audioVoiceOptions, audioVoicesForModel]);
    const activeError = studioMode === 'image'
        ? imageError
        : studioMode === 'cover'
            ? coverError
        : studioMode === 'audio'
            ? audioError
        : studioMode === 'digital-human'
            ? digitalHumanError
            : videoError;
    const visibleError = isAgentMode ? (agentSessionError || activeError) : activeError;
    const imageCostEstimate = useMemo(() => estimateImageGenerationPoints(pricingCatalog, {
        model: imageModel,
        count: imageCount,
        quality: DEFAULT_IMAGE_QUALITY,
        resolution: imageResolution,
    }), [imageCount, imageModel, imageResolution, pricingCatalog]);
    const coverCostEstimate = useMemo(() => estimateCoverGenerationPoints(pricingCatalog, {
        model: coverModel,
        count: coverCount,
        quality: coverQuality,
    }), [coverCount, coverModel, coverQuality, pricingCatalog]);
    const audioCostEstimate = useMemo(() => estimateAudioGenerationPoints(pricingCatalog, {
        model: effectiveAudioModel,
        text: audioPrompt,
    }), [audioPrompt, effectiveAudioModel, pricingCatalog]);
    const videoCostEstimate = useMemo(() => estimateVideoGenerationPoints(pricingCatalog, {
        model: effectiveVideoModel,
        durationSeconds: videoDurationSeconds,
        resolution: videoResolution,
    }), [effectiveVideoModel, pricingCatalog, videoDurationSeconds, videoResolution]);
    const digitalHumanCostEstimate = useMemo(() => combineGenerationCostEstimates([
        estimateAudioGenerationPoints(pricingCatalog, {
            model: effectiveAudioModel,
            text: digitalHumanPrompt,
        }),
        estimateVideoGenerationPoints(pricingCatalog, {
            model: 'videoretalk',
            durationSeconds: 8,
            resolution: '1080p',
        }),
    ]), [digitalHumanPrompt, effectiveAudioModel, pricingCatalog]);

    useEffect(() => {
        setImageModel((prev) => {
            const current = prev.trim();
            if (current && imageModelOptions.some((option) => option.value === current)) {
                return prev;
            }
            return imageModelOptions[0]?.value || '';
        });
        setCoverModel((prev) => {
            const current = prev.trim();
            if (current && imageModelOptions.some((option) => option.value === current)) {
                return prev;
            }
            return imageModelOptions[0]?.value || '';
        });
    }, [imageModelOptions]);

    useEffect(() => {
        setAudioModel((prev) => {
            const current = prev.trim();
            if (current && audioModelOptions.some((option) => option.value === current)) {
                return prev;
            }
            return audioModelOptions[0]?.value || '';
        });
    }, [audioModelOptions]);

    useEffect(() => {
        if (!isActive || !hasVoiceConfig) {
            setAudioVoices([]);
            return;
        }

        let cancelled = false;
        setIsLoadingAudioVoices(true);
        void (async () => {
            try {
                const result = await window.ipcRenderer.voice.list({ model: effectiveAudioModel }) as unknown;
                if (cancelled) return;
                const voices = normalizeVoiceList(result);
                setAudioVoices(voices);
                setAudioVoiceId((prev) => {
                    if (prev.trim() && voices.some((voice) => voice.id === prev.trim() && voiceMatchesAudioModel(voice, effectiveAudioModel))) {
                        return prev;
                    }
                    return voices.find((voice) => voiceMatchesAudioModel(voice, effectiveAudioModel))?.id || '';
                });
            } catch (error) {
                if (cancelled) return;
                console.error('Failed to load audio voices:', error);
                setAudioVoices([]);
            } finally {
                if (!cancelled) setIsLoadingAudioVoices(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [effectiveAudioModel, hasVoiceConfig, isActive]);

    useEffect(() => {
        setAudioVoiceId((prev) => {
            const current = prev.trim();
            if (current && audioVoicesForModel.some((voice) => voice.id === current && voiceLanguageMatches(voice, audioLanguageBoost))) {
                return prev;
            }
            return audioVoicesForModel.find((voice) => voiceLanguageMatches(voice, audioLanguageBoost))?.id || '';
        });
    }, [audioLanguageBoost, audioVoicesForModel]);

    const loadDigitalHumanRoles = useCallback(async () => {
        setIsLoadingDigitalHumanRoles(true);
        setDigitalHumanError('');
        try {
            const [subjectResult, categoryResult] = await Promise.all([
                window.ipcRenderer.subjects.list({ limit: 500 }),
                window.ipcRenderer.subjects.categories.list(),
            ]);
            if (subjectResult?.success === false) throw new Error(subjectResult.error || '加载角色失败');
            if (categoryResult?.success === false) throw new Error(categoryResult.error || '加载角色分类失败');
            const nextSubjects = Array.isArray(subjectResult?.subjects) ? subjectResult.subjects : [];
            const nextCategories = Array.isArray(categoryResult?.categories) ? categoryResult.categories as SubjectCategoryRecord[] : [];
            setDigitalHumanSubjects(nextSubjects);
            setDigitalHumanCategories(nextCategories);
            setDigitalHumanRoleId((current) => current || nextSubjects[0]?.id || '');
        } catch (error) {
            setDigitalHumanError(error instanceof Error ? error.message : '加载角色失败');
        } finally {
            setIsLoadingDigitalHumanRoles(false);
        }
    }, []);

    useEffect(() => {
        if (!isActive || studioMode !== 'digital-human') return;
        void loadDigitalHumanRoles();
    }, [isActive, loadDigitalHumanRoles, studioMode]);

    const digitalHumanRoleCategoryIds = useMemo(() => new Set(digitalHumanCategories
        .filter((category) => /角色|人物|数字人|role|character|avatar/i.test(category.name || ''))
        .map((category) => category.id)), [digitalHumanCategories]);
    const digitalHumanRoles = useMemo(() => {
        const categorized = digitalHumanRoleCategoryIds.size > 0
            ? digitalHumanSubjects.filter((subject) => subject.categoryId && digitalHumanRoleCategoryIds.has(subject.categoryId))
            : digitalHumanSubjects;
        return categorized.filter((subject) => {
            const readiness = digitalHumanReadiness(subject);
            return readiness.voiceId || readiness.videoPath || digitalHumanRoleCategoryIds.size > 0;
        });
    }, [digitalHumanRoleCategoryIds, digitalHumanSubjects]);
    const selectedDigitalHumanRole = useMemo(
        () => digitalHumanRoles.find((role) => role.id === digitalHumanRoleId)
            || digitalHumanRoles.find((role) => digitalHumanReadiness(role).ok)
            || digitalHumanRoles[0]
            || null,
        [digitalHumanRoleId, digitalHumanRoles],
    );
    const selectedDigitalHumanReadiness = useMemo(() => digitalHumanReadiness(selectedDigitalHumanRole), [selectedDigitalHumanRole]);
    const digitalHumanRoleOptions = useMemo<PickerOption[]>(() => digitalHumanRoles.map((role) => {
        const readiness = digitalHumanReadiness(role);
        return {
            value: role.id,
            label: readiness.ok ? role.name : `${role.name} · 不可用`,
            description: readiness.ok ? shortVoiceId(readiness.voiceId) : readiness.issue,
            disabled: !readiness.ok,
            disabledReason: readiness.ok ? undefined : (
                readiness.videoPath
                    ? `「${role.name}」已具备参考视频，系统会从视频音轨自动复刻音色。请等待音色克隆完成后再生成数字人。`
                    : `请先在资产库为「${role.name}」上传带音轨的参考视频。上传后系统会自动抽取音轨复刻音色。缺少：${readiness.issue}`
            ),
            tone: readiness.ok ? undefined : 'danger',
        };
    }), [digitalHumanRoles]);
    const handleDisabledDigitalHumanRoleClick = useCallback((option: PickerOption) => {
        void appAlert(option.disabledReason || '请先在资产库上传带音轨的角色参考视频。', {
            title: '角色还不能用于数字人',
        });
    }, []);

    const createFeedEntry = useCallback((request: GenerationRequest): GenerationFeedEntry => createGenerationFeedEntry(request, {
        id: makeId('generation'),
        source: contextIntent?.source || 'standalone',
        sourceTitle: contextIntent?.sourceTitle,
    }), [contextIntent?.source, contextIntent?.sourceTitle]);

    const runImageRequest = useCallback((request: ImageGenerationRequest): boolean => {
        const validationError = validateImageGenerationRequest(request, { hasImageConfig });
        if (validationError) {
            setImageError(validationError);
            return false;
        }

        const entry = createFeedEntry(request);
        updateFeedEntries((prev) => [...prev, entry]);
        setImageError('');

        void (async () => {
            try {
                const modelRouteOverride = resolveSelectedModelOverride(settings, 'image', 'image', request.model);
                const result = await submitImageGeneration(window.ipcRenderer.generation, request, {
                    clientRequestId: entry.id,
                    source: generationSubmitSource(contextIntent?.source),
                    routeOverride: modelRouteOverride,
                    provider: settings.image_provider,
                    providerTemplate: settings.image_provider_template,
                });

                updateFeedEntries((prev) => prev.map((item) => (
                    item.id === entry.id
                        ? { ...item, jobId: result.jobId, jobStatus: 'queued', status: 'running', error: undefined }
                        : item
                )));
            } catch (error) {
                const message = error instanceof Error ? error.message : '生图失败';
                setImageError(message);
                updateFeedEntries((prev) => prev.map((item) => (
                    item.id === entry.id
                        ? { ...item, status: 'error', error: message }
                        : item
                )));
            }
        })();
        return true;
    }, [
        createFeedEntry,
        hasImageConfig,
        contextIntent?.source,
        settings,
        settings.image_provider,
        settings.image_provider_template,
        updateFeedEntries,
    ]);

    const runVideoRequest = useCallback((request: VideoGenerationRequest): boolean => {
        const validationError = validateVideoGenerationRequest(request, { hasVideoConfig });
        if (validationError) {
            setVideoError(validationError);
            return false;
        }

        const entry = createFeedEntry(request);
        updateFeedEntries((prev) => [...prev, entry]);
        setVideoError('');

        void (async () => {
            try {
                const result = await submitVideoGeneration(window.ipcRenderer.generation, request, {
                    clientRequestId: entry.id,
                    source: generationSubmitSource(contextIntent?.source),
                });

                updateFeedEntries((prev) => prev.map((item) => (
                    item.id === entry.id
                        ? { ...item, jobId: result.jobId, jobStatus: 'queued', status: 'running', error: undefined }
                        : item
                )));
            } catch (error) {
                const message = error instanceof Error ? error.message : '生视频失败';
                setVideoError(message);
                updateFeedEntries((prev) => prev.map((item) => (
                    item.id === entry.id
                        ? { ...item, status: 'error', error: message }
                        : item
                )));
            }
        })();
        return true;
    }, [contextIntent?.source, createFeedEntry, hasVideoConfig, updateFeedEntries]);

    const runAudioRequest = useCallback((request: AudioGenerationRequest): boolean => {
        const validationError = validateAudioGenerationRequest(request, {
            hasVoiceConfig,
            audioVoiceIdsForModel: audioVoicesForModel.map((voice) => voice.id),
        });
        if (validationError) {
            setAudioError(validationError);
            return false;
        }

        const entry = createFeedEntry(request);
        updateFeedEntries((prev) => [...prev, entry]);
        setAudioError('');

        void (async () => {
            try {
                const modelRouteOverride = resolveSelectedModelOverride(settings, 'voiceTts', 'tts', request.model);
                const result = await submitAudioGeneration(window.ipcRenderer.generation, request, {
                    clientRequestId: entry.id,
                    source: generationSubmitSource(contextIntent?.source),
                    routeOverride: modelRouteOverride,
                });

                updateFeedEntries((prev) => prev.map((item) => (
                    item.id === entry.id
                        ? { ...item, jobId: result.jobId, jobStatus: 'queued', status: 'running', error: undefined }
                        : item
                )));
            } catch (error) {
                const message = error instanceof Error ? error.message : '生音频失败';
                setAudioError(message);
                updateFeedEntries((prev) => prev.map((item) => (
                    item.id === entry.id
                        ? { ...item, status: 'error', error: message }
                        : item
                )));
            }
        })();
        return true;
    }, [audioVoicesForModel, contextIntent?.source, createFeedEntry, hasVoiceConfig, settings, updateFeedEntries]);

    const uploadDigitalHumanMedia = useCallback(async (path: string, contentType: string, keyPrefix: string) => {
        if (isRemoteUrl(path)) return path;
        const normalizedPath = fileUrlToPath(path);
        const cacheKey = `${keyPrefix}:${normalizedPath}`;
        const cached = digitalHumanUploadCacheRef.current.get(cacheKey);
        if (cached) return cached;
        const result = await window.ipcRenderer.generation.uploadTempFile({
            path: normalizedPath,
            contentType,
            keyPrefix,
        });
        if (result?.success === false || !result?.fileUrl) {
            throw new Error(result?.error || '上传媒体失败');
        }
        digitalHumanUploadCacheRef.current.set(cacheKey, result.fileUrl);
        return result.fileUrl;
    }, []);

    const runDigitalHumanRequest = useCallback((request: DigitalHumanGenerationRequest): boolean => {
        const validationError = validateDigitalHumanGenerationRequest(request, { hasVoiceConfig });
        if (validationError) {
            setDigitalHumanError(validationError);
            return false;
        }

        const entry = createFeedEntry(request);
        updateFeedEntries((prev) => [...prev, entry]);
        setDigitalHumanError('');

        void (async () => {
            try {
                const result = await submitDigitalHumanGeneration(window.ipcRenderer.generation, window.ipcRenderer.voice, request, {
                    clientRequestId: entry.id,
                    source: generationSubmitSource(contextIntent?.source),
                    ttsModel: effectiveAudioModel,
                    languageBoost: audioLanguageBoost,
                    speed: audioSpeed,
                    emotion: audioEmotion,
                    timeoutMs: DIGITAL_HUMAN_TTS_TIMEOUT_MS,
                    uploadMedia: uploadDigitalHumanMedia,
                    onStage: (stage) => {
                        updateFeedEntries((prev) => prev.map((item) => item.id === entry.id ? { ...item, jobStatus: stage } : item));
                    },
                });
                updateFeedEntries((prev) => prev.map((item) => (
                    item.id === entry.id
                        ? { ...item, jobId: result.jobId, jobStatus: 'queued', status: 'running', error: undefined }
                        : item
                )));
            } catch (error) {
                const message = error instanceof Error ? error.message : '数字人生成失败';
                setDigitalHumanError(message);
                updateFeedEntries((prev) => prev.map((item) => (
                    item.id === entry.id
                        ? { ...item, status: 'error', error: message }
                        : item
                )));
            }
        })();
        return true;
    }, [
        audioEmotion,
        audioLanguageBoost,
        audioSpeed,
        contextIntent?.source,
        createFeedEntry,
        effectiveAudioModel,
        hasVoiceConfig,
        settings,
        updateFeedEntries,
        uploadDigitalHumanMedia,
    ]);

    const runCoverRequest = useCallback((request: CoverGenerationRequest): boolean => {
        const validationError = validateCoverGenerationRequest(request, { hasImageConfig });
        if (validationError) {
            setCoverError(validationError);
            return false;
        }

        const entry = createFeedEntry(request);
        updateFeedEntries((prev) => [...prev, entry]);
        setCoverError('');

        void (async () => {
            try {
                const modelRouteOverride = resolveSelectedModelOverride(settings, 'image', 'image', request.model);
                const result = await submitCoverGeneration(window.ipcRenderer.cover, request, {
                    titleId: makeId('cover-title'),
                    routeOverride: modelRouteOverride,
                    provider: settings.image_provider,
                    providerTemplate: settings.image_provider_template,
                });

                updateFeedEntries((prev) => prev.map((item) => (
                    item.id === entry.id
                        ? { ...item, status: 'success', completedAt: new Date().toISOString(), assets: normalizeGeneratedAssets(result.assets), error: undefined }
                        : item
                )));
            } catch (error) {
                const message = error instanceof Error ? error.message : '封面生成失败';
                setCoverError(message);
                updateFeedEntries((prev) => prev.map((item) => (
                    item.id === entry.id
                        ? { ...item, status: 'error', error: message }
                        : item
                )));
            }
        })();
        return true;
    }, [
        createFeedEntry,
        hasImageConfig,
        settings,
        settings.image_provider,
        settings.image_provider_template,
        updateFeedEntries,
    ]);

    const handleGenerateImage = useCallback(() => {
        const accepted = runImageRequest(buildImageGenerationRequest({
            prompt: imagePrompt,
            title: imageTitle,
            projectId: imageProjectId,
            count: imageCount,
            model: imageModel,
            aspectRatio: imageAspectRatio,
            size: imageSize,
            quality: DEFAULT_IMAGE_QUALITY,
            resolution: imageResolution,
            imageMode,
            referenceItems: imageReferences,
        }));
        if (!accepted) return;
        setImagePrompt('');
        setImageReferences([]);
    }, [
        imageAspectRatio,
        imageCount,
        imageMode,
        imageModel,
        imagePrompt,
        imageProjectId,
        imageReferences,
        imageResolution,
        imageSize,
        imageTitle,
        runImageRequest,
    ]);

    const handleGenerateVideo = useCallback(() => {
        const accepted = runVideoRequest(buildVideoGenerationRequest({
            prompt: videoPrompt,
            title: videoTitle,
            projectId: videoProjectId,
            model: effectiveVideoModel,
            aspectRatio: videoAspectRatio,
            resolution: videoResolution,
            durationSeconds: videoDurationSeconds,
            generateAudio: videoGenerateAudio,
            videoMode,
            referenceItems: videoReferences,
            firstFrame: videoFirstFrame,
            lastFrame: videoLastFrame,
            firstClip: videoFirstClip,
            drivingAudio: videoDrivingAudio,
        }));
        if (!accepted) return;
        setVideoPrompt('');
        setVideoReferences([]);
        setVideoFirstFrame(null);
        setVideoLastFrame(null);
        setVideoFirstClip(null);
        setVideoDrivingAudio(null);
    }, [
        runVideoRequest,
        videoAspectRatio,
        videoDrivingAudio,
        videoDurationSeconds,
        videoFirstClip,
        videoFirstFrame,
        videoGenerateAudio,
        videoLastFrame,
        effectiveVideoModel,
        videoMode,
        videoProjectId,
        videoPrompt,
        videoReferences,
        videoResolution,
        videoTitle,
    ]);

    const handleGenerateAudio = useCallback(() => {
        const accepted = runAudioRequest(buildAudioGenerationRequest({
            prompt: audioPrompt,
            title: audioTitle,
            projectId: audioProjectId,
            model: effectiveAudioModel,
            voiceId: audioVoiceId,
            voiceTargetTtsModel: selectedAudioVoice?.targetTtsModel || effectiveAudioModel,
            languageBoost: audioLanguageBoost,
            speed: audioSpeed,
            emotion: audioEmotion,
            responseFormat: 'mp3',
        }));
        if (!accepted) return;
        setAudioPrompt('');
    }, [
        audioLanguageBoost,
        audioProjectId,
        audioPrompt,
        audioSpeed,
        audioEmotion,
        audioTitle,
        audioVoiceId,
        effectiveAudioModel,
        runAudioRequest,
        selectedAudioVoice?.targetTtsModel,
    ]);

    const handleGenerateDigitalHuman = useCallback(() => {
        const role = selectedDigitalHumanRole;
        const readiness = selectedDigitalHumanReadiness;
        const accepted = runDigitalHumanRequest(buildDigitalHumanGenerationRequest({
            prompt: digitalHumanPrompt,
            title: digitalHumanTitle,
            projectId: digitalHumanProjectId,
            roleId: role?.id || '',
            roleName: role?.name || '数字人',
            voiceId: readiness.voiceId,
            videoPath: readiness.videoPath,
            resolution: '1080p',
            durationSeconds: 8,
        }));
        if (!accepted) return;
        setDigitalHumanPrompt('');
    }, [
        digitalHumanProjectId,
        digitalHumanPrompt,
        digitalHumanTitle,
        runDigitalHumanRequest,
        selectedDigitalHumanReadiness,
        selectedDigitalHumanRole,
    ]);

    const handleGenerateCover = useCallback(() => {
        const accepted = runCoverRequest(buildCoverGenerationRequest({
            prompt: coverPrompt,
            title: coverTitle,
            projectId: coverProjectId,
            count: coverCount,
            model: coverModel,
            quality: coverQuality,
            referenceItems: coverReferences,
            manuscriptSource: selectedCoverManuscript
                ? { path: selectedCoverManuscript.path, title: selectedCoverManuscript.title }
                : null,
            promptSwitches: coverPromptSwitches,
        }));
        if (!accepted) return;
        setCoverPrompt('');
    }, [
        coverCount,
        coverModel,
        coverProjectId,
        coverPrompt,
        coverPromptSwitches,
        coverQuality,
        coverReferences,
        selectedCoverManuscript,
        coverTitle,
        runCoverRequest,
    ]);

    const replayQueuedMediaRequest = useCallback((entry: GenerationFeedEntry): boolean => {
        if (!entry.jobRequest || entry.request.type === 'cover') return false;
        const replayEntry = createFeedEntry(entry.request);
        updateFeedEntries((prev) => [...prev, replayEntry]);

        const replayPayload = {
            ...entry.jobRequest,
            clientRequestId: replayEntry.id,
            clientFeedEntryId: replayEntry.id,
        };

        if (entry.request.type === 'image') {
            setImageError('');
        } else if (entry.request.type === 'audio') {
            setAudioError('');
        } else {
            setVideoError('');
            setDigitalHumanError('');
        }

        void (async () => {
            try {
                const submit = entry.request.type === 'image'
                    ? window.ipcRenderer.generation.submitImage
                    : entry.request.type === 'audio'
                        ? window.ipcRenderer.generation.submitAudio
                        : window.ipcRenderer.generation.submitVideo;
                const result = await submit(replayPayload) as { success?: boolean; error?: string; jobId?: string };
                if (!result?.success || !result?.jobId) {
                    throw new Error(result?.error || '重新生成失败');
                }
                updateFeedEntries((prev) => prev.map((item) => (
                    item.id === replayEntry.id
                        ? { ...item, jobId: result.jobId, jobStatus: 'queued', status: 'running', error: undefined }
                        : item
                )));
            } catch (error) {
                const message = error instanceof Error ? error.message : '重新生成失败';
                if (entry.request.type === 'image') {
                    setImageError(message);
                } else if (entry.request.type === 'audio') {
                    setAudioError(message);
                } else if (entry.request.type === 'digital-human') {
                    setDigitalHumanError(message);
                } else {
                    setVideoError(message);
                }
                updateFeedEntries((prev) => prev.map((item) => (
                    item.id === replayEntry.id
                        ? { ...item, status: 'error', error: message }
                        : item
                )));
            }
        })();

        return true;
    }, [createFeedEntry, updateFeedEntries]);

    const handleRegenerate = useCallback((entry: GenerationFeedEntry) => {
        if (replayQueuedMediaRequest(entry)) {
            return;
        }
        if (entry.request.type === 'cover') {
            runCoverRequest(entry.request);
            return;
        }
        if (entry.request.type === 'image') {
            runImageRequest(entry.request);
            return;
        }
        if (entry.request.type === 'audio') {
            runAudioRequest(entry.request);
            return;
        }
        if (entry.request.type === 'digital-human') {
            runDigitalHumanRequest(entry.request);
            return;
        }
        runVideoRequest(entry.request);
    }, [replayQueuedMediaRequest, runAudioRequest, runCoverRequest, runDigitalHumanRequest, runImageRequest, runVideoRequest]);

    const handleEditEntry = useCallback((entry: GenerationFeedEntry) => {
        setStudioMode(entry.request.type);
        if (entry.request.type === 'cover') {
            setCoverPrompt(entry.request.prompt);
            setCoverTitle(entry.request.title);
            setCoverProjectId(entry.request.projectId);
            setCoverCount(entry.request.count);
            setCoverModel(entry.request.model);
            setCoverQuality(entry.request.quality);
            setCoverReferences(entry.request.referenceItems);
            setCoverManuscriptPath(entry.request.manuscriptSource?.path || '');
            setCoverPromptSwitches(entry.request.promptSwitches);
            return;
        }
        if (entry.request.type === 'image') {
            setImagePrompt(entry.request.prompt);
            setImageTitle(entry.request.title);
            setImageProjectId(entry.request.projectId);
            setImageCount(entry.request.count);
            setImageModel(entry.request.model);
            setImageAspectRatio(entry.request.aspectRatio);
            setImageSize(entry.request.size);
            setImageResolution(entry.request.resolution || '1K');
            setImageMode(entry.request.generationMode);
            setImageReferences(entry.request.referenceItems);
            return;
        }
        if (entry.request.type === 'audio') {
            setAudioPrompt(entry.request.prompt);
            setAudioTitle(entry.request.title);
            setAudioProjectId(entry.request.projectId);
            setAudioModel(entry.request.model);
            setAudioVoiceId(entry.request.voiceId);
            setAudioLanguageBoost(entry.request.languageBoost || 'Chinese');
            setAudioSpeed(entry.request.speed || '1');
            setAudioEmotion(entry.request.emotion || '');
            setAudioSpeedTouched(Boolean(entry.request.speed));
            setAudioEmotionTouched(Boolean(entry.request.emotion));
            return;
        }
        if (entry.request.type === 'digital-human') {
            setDigitalHumanPrompt(entry.request.prompt);
            setDigitalHumanTitle(entry.request.title);
            setDigitalHumanProjectId(entry.request.projectId);
            setDigitalHumanRoleId(entry.request.roleId);
            return;
        }
        setVideoPrompt(entry.request.prompt);
        setVideoTitle(entry.request.title);
        setVideoProjectId(entry.request.projectId);
        setVideoMode(entry.request.generationMode);
        setVideoAspectRatio(entry.request.aspectRatio);
        setVideoResolution(entry.request.resolution);
        setVideoDurationSeconds(entry.request.durationSeconds);
        setVideoGenerateAudio(entry.request.generateAudio);
        setVideoReferences(entry.request.generationMode === 'reference-guided' ? entry.request.referenceItems : []);
        setVideoFirstFrame(entry.request.generationMode === 'first-last-frame' ? entry.request.referenceItems[0] || null : null);
        setVideoLastFrame(entry.request.generationMode === 'first-last-frame' ? entry.request.referenceItems[1] || null : null);
        setVideoFirstClip(entry.request.firstClip || null);
        setVideoDrivingAudio(entry.request.drivingAudio || null);
    }, []);

    const handleDeleteEntry = useCallback((entryId: string) => {
        const entryToDelete = feedEntries.find((item) => item.id === entryId);
        const agentSessionIdToClear = entryToDelete && isAgentSessionFeedEntry(entryToDelete)
            ? entryToDelete.sessionId
            : '';
        const jobIdToDelete = entryToDelete && isGenerationFeedEntry(entryToDelete)
            ? entryToDelete.jobId
            : null;
        updateFeedEntries((prev) => {
            const entry = prev.find((item) => item.id === entryId);
            if (entry) {
                const deleted = normalizeDeletedFeedState(deletedFeedStateRef.current);
                deleted.entryIds = Array.from(new Set([...deleted.entryIds, entry.id]));
                if (isGenerationFeedEntry(entry)) {
                    if (entry.jobId) {
                        deleted.jobIds = Array.from(new Set([...deleted.jobIds, entry.jobId]));
                    }
                    deleted.clientRequestIds = Array.from(new Set([...deleted.clientRequestIds, entry.id]));
                } else if (isAgentSessionFeedEntry(entry)) {
                    deleted.agentSessionIds = Array.from(new Set([...deleted.agentSessionIds, entry.sessionId]));
                    deleted.agentContextIds = Array.from(new Set([...deleted.agentContextIds, entry.contextId]));
                }
                deletedFeedStateRef.current = deleted;
                persistDeletedFeedState(deleted);
            }
            return prev.filter((entry) => entry.id !== entryId);
        });
        if (jobIdToDelete) {
            mediaJobsStore.removeJob(jobIdToDelete);
            void window.ipcRenderer.generation.deleteJob(jobIdToDelete).catch((error) => {
                console.error('Failed to archive generation job:', error);
            });
        }
        setAssetContextMenu((current) => (current?.entryId === entryId ? null : current));
        if (agentSessionIdToClear) {
            if (agentSessionIdToClear === agentSessionId) {
                setAgentPendingMessage(null);
                setAgentExecutionActive(false);
            }
            void window.ipcRenderer.chat.clearMessages(agentSessionIdToClear).catch((error) => {
                console.error('Failed to clear generation agent session:', error);
            });
        }
    }, [agentSessionId, feedEntries, generationAgentContextId, updateFeedEntries]);

    const resolveAssetSource = useCallback((asset: GeneratedAsset) => (
        asset.previewUrl || asset.relativePath || ''
    ), []);

    const handleSaveAsset = useCallback(async (asset: GeneratedAsset) => {
        const source = resolveAssetSource(asset);
        if (!source) return;
        try {
            const result = await window.ipcRenderer.files.saveAs({
                source,
                defaultName: generatedAssetDefaultName(asset, source),
            }) as {
                success?: boolean;
                error?: string;
                canceled?: boolean;
            };
            if (!result?.success && !result?.canceled) {
                throw new Error(result?.error || '保存失败');
            }
        } catch (error) {
            console.error('Failed to save generated asset:', error);
            void appAlert(error instanceof Error ? error.message : '保存失败');
        }
    }, [resolveAssetSource]);

    const handleShowAssetInFolder = useCallback(async (asset: GeneratedAsset) => {
        const source = resolveAssetSource(asset);
        if (!source) return;
        try {
            const result = await window.ipcRenderer.files.showInFolder({ source }) as {
                success?: boolean;
                error?: string;
            };
            if (!result?.success) {
                throw new Error(result?.error || '打开文件夹失败');
            }
        } catch (error) {
            console.error('Failed to reveal generated asset:', error);
            void appAlert(error instanceof Error ? error.message : '打开文件夹失败');
        }
    }, [resolveAssetSource]);

    const handleOpenAssetMenu = useCallback((
        event: React.MouseEvent<HTMLElement>,
        asset: GeneratedAsset,
        entryId: string,
    ) => {
        event.preventDefault();
        setAssetContextMenu({
            asset,
            entryId,
            x: event.clientX,
            y: event.clientY,
        });
    }, []);

    const appendImageReferenceFiles = useCallback(async (files: File[]) => {
        if (!files.length) return;
        setIsReadingImageRefs(true);
        try {
            const nextItems = await filesToReferenceItems(files, 4);
            setImageReferences((prev) => [...prev, ...nextItems].slice(0, 4));
        } catch (error) {
            console.error('Failed to read image references:', error);
            setImageError('参考图读取失败，请重试');
        } finally {
            setIsReadingImageRefs(false);
        }
    }, []);

    const handleImageReferenceFiles = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        try {
            await appendImageReferenceFiles(Array.from(event.target.files || []));
        } finally {
            event.target.value = '';
        }
    }, [appendImageReferenceFiles]);

    const appendCoverReferenceFiles = useCallback(async (files: File[]) => {
        if (!files.length) return;
        setIsReadingCoverRefs(true);
        try {
            const nextItems = await filesToReferenceItems(files, 4);
            setCoverReferences((prev) => [...prev, ...nextItems].slice(0, 4));
            setCoverError('');
        } catch (error) {
            console.error('Failed to read cover reference:', error);
            setCoverError('封面素材读取失败，请重试');
        } finally {
            setIsReadingCoverRefs(false);
        }
    }, []);

    const handleCoverReferenceFiles = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        try {
            await appendCoverReferenceFiles(Array.from(event.target.files || []));
        } finally {
            event.target.value = '';
        }
    }, [appendCoverReferenceFiles]);

    const setVideoReferenceFile = useCallback(async (
        file: File | undefined,
        target: number | 'first' | 'last' | 'firstClip' | 'drivingAudio',
    ) => {
        if (!file) return;
        setIsReadingVideoRefs(true);
        try {
            const [item] = await filesToReferenceItems([file], 1);
            if (typeof target === 'number') {
                setVideoReferences((prev) => {
                    const next = [...prev];
                    next[target] = item;
                    return next.slice(0, 5);
                });
                if (videoMode === 'text-to-video') {
                    setVideoMode('reference-guided');
                }
            } else if (target === 'first') {
                setVideoFirstFrame(item);
            } else if (target === 'last') {
                setVideoLastFrame(item);
            } else if (target === 'firstClip') {
                setVideoFirstClip(item);
            } else {
                setVideoDrivingAudio(item);
            }
        } catch (error) {
            console.error('Failed to read video reference:', error);
            setVideoError('参考素材读取失败，请重试');
        } finally {
            setIsReadingVideoRefs(false);
        }
    }, [videoMode]);

    const handleVideoReferenceFile = useCallback(async (
        event: React.ChangeEvent<HTMLInputElement>,
        target: number | 'first' | 'last' | 'firstClip' | 'drivingAudio',
    ) => {
        try {
            await setVideoReferenceFile(event.target.files?.[0], target);
        } finally {
            event.target.value = '';
        }
    }, [setVideoReferenceFile]);

    const appendVideoReferenceFiles = useCallback(async (files: File[]) => {
        if (!files.length) return;
        setIsReadingVideoRefs(true);
        try {
            const nextItems = await filesToReferenceItems(files, 5);
            setVideoReferences((prev) => [...prev.filter(Boolean), ...nextItems].slice(0, 5));
            if (videoMode === 'text-to-video' && nextItems.length > 0) {
                setVideoMode('reference-guided');
            }
        } catch (error) {
            console.error('Failed to read video references:', error);
            setVideoError('参考素材读取失败，请重试');
        } finally {
            setIsReadingVideoRefs(false);
        }
    }, [videoMode]);

    const handleVideoReferenceFiles = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        try {
            await appendVideoReferenceFiles(Array.from(event.target.files || []));
        } finally {
            event.target.value = '';
        }
    }, [appendVideoReferenceFiles]);

    const uploadedVideoRefs = useMemo(() => {
        if (videoMode === 'reference-guided') {
            return videoReferences.filter(Boolean) as ReferenceItem[];
        }
        if (videoMode === 'first-last-frame') {
            return [videoFirstFrame, videoLastFrame].filter(Boolean) as ReferenceItem[];
        }
        return [];
    }, [videoFirstFrame, videoLastFrame, videoMode, videoReferences]);

    const currentAgentRequest = useMemo<GenerationRequest>(() => {
        if (studioMode === 'video') {
            return buildVideoGenerationRequest({
                prompt: videoPrompt,
                title: videoTitle,
                projectId: videoProjectId,
                model: effectiveVideoModel,
                aspectRatio: videoAspectRatio,
                resolution: videoResolution,
                durationSeconds: videoDurationSeconds,
                generateAudio: videoGenerateAudio,
                videoMode,
                referenceItems: videoReferences,
                firstFrame: videoFirstFrame,
                lastFrame: videoLastFrame,
                firstClip: videoFirstClip,
                drivingAudio: videoDrivingAudio,
            });
        }
        if (studioMode === 'audio') {
            return buildAudioGenerationRequest({
                prompt: audioPrompt,
                title: audioTitle,
                projectId: audioProjectId,
                model: effectiveAudioModel,
                voiceId: audioVoiceId,
                voiceTargetTtsModel: selectedAudioVoice?.targetTtsModel || effectiveAudioModel,
                languageBoost: audioLanguageBoost,
                speed: audioSpeed,
                emotion: audioEmotion,
                responseFormat: 'mp3',
            });
        }
        if (studioMode === 'cover') {
            return buildCoverGenerationRequest({
                prompt: coverPrompt,
                title: coverTitle,
                projectId: coverProjectId,
                count: coverCount,
                model: coverModel,
                quality: coverQuality,
                referenceItems: coverReferences,
                manuscriptSource: selectedCoverManuscript
                    ? { path: selectedCoverManuscript.path, title: selectedCoverManuscript.title }
                    : null,
                promptSwitches: coverPromptSwitches,
            });
        }
        return buildImageGenerationRequest({
            prompt: imagePrompt,
            title: imageTitle,
            projectId: imageProjectId,
            count: imageCount,
            model: imageModel,
            aspectRatio: imageAspectRatio,
            size: imageSize,
            quality: DEFAULT_IMAGE_QUALITY,
            resolution: imageResolution,
            imageMode,
            referenceItems: imageReferences,
        });
    }, [
        audioLanguageBoost,
        audioProjectId,
        audioPrompt,
        audioSpeed,
        audioEmotion,
        audioTitle,
        audioVoiceId,
        coverCount,
        coverModel,
        coverProjectId,
        coverPrompt,
        coverPromptSwitches,
        coverQuality,
        coverReferences,
        selectedCoverManuscript,
        coverTitle,
        effectiveAudioModel,
        effectiveVideoModel,
        selectedAudioVoice?.targetTtsModel,
        imageAspectRatio,
        imageCount,
        imageMode,
        imageModel,
        imageProjectId,
        imagePrompt,
        imageReferences,
        imageResolution,
        imageSize,
        imageTitle,
        studioMode,
        videoAspectRatio,
        videoDrivingAudio,
        videoDurationSeconds,
        videoFirstClip,
        videoFirstFrame,
        videoGenerateAudio,
        videoLastFrame,
        videoMode,
        videoProjectId,
        videoPrompt,
        videoReferences,
        videoResolution,
        videoTitle,
    ]);
    const recentAgentAssets = useMemo(
        () => buildRecentGenerationAssetSummaries(feedEntries, activeGenerationProjectId, contextIntent?.source || 'standalone'),
        [activeGenerationProjectId, contextIntent?.source, feedEntries],
    );

    const composerGridClass = studioMode === 'audio' || studioMode === 'digital-human'
        ? 'grid gap-4'
        : (studioMode === 'video' && videoMode === 'first-last-frame')
        ? 'grid items-start gap-4 md:grid-cols-[196px_minmax(0,1fr)]'
        : 'grid items-start gap-4 md:grid-cols-[104px_minmax(0,1fr)]';
    const composerWidthClass = 'mx-auto w-full max-w-[900px]';
    const coverHasAgentContext = currentAgentRequest.type === 'cover'
        && (currentAgentRequest.referenceItems.length > 0 || Boolean(currentAgentRequest.manuscriptSource));
    const canSendAgentMessage = isAgentMode
        && !isDigitalHumanMode
        && Boolean(agentSessionId)
        && !isAgentSessionLoading
        && !agentExecutionActive
        && (currentAgentRequest.prompt.trim().length > 0 || Boolean(agentAttachment) || coverHasAgentContext);
    const handleClearGenerationRecords = useCallback(async () => {
        if (feedEntries.length === 0) return;
        const confirmed = await appConfirm('只清空本页生成记录；已经入库的媒体文件会保留。', {
            title: '清空生成记录',
            confirmLabel: '清空',
            tone: 'danger',
        });
        if (!confirmed) return;
        try {
            const deleted = normalizeDeletedFeedState(deletedFeedStateRef.current);
            const nextEntryIds = new Set(deleted.entryIds);
            const nextJobIds = new Set(deleted.jobIds);
            const nextClientRequestIds = new Set(deleted.clientRequestIds);
            const nextAgentSessionIds = new Set(deleted.agentSessionIds);
            const nextAgentContextIds = new Set(deleted.agentContextIds);
            const agentSessionIds = new Set<string>();
            if (agentSessionId) {
                agentSessionIds.add(agentSessionId);
                nextAgentSessionIds.add(agentSessionId);
                nextAgentContextIds.add(generationAgentContextId);
            }
            for (const entry of feedEntries) {
                nextEntryIds.add(entry.id);
                if (isGenerationFeedEntry(entry)) {
                    if (entry.jobId) nextJobIds.add(entry.jobId);
                    const requestClientId = String(
                        (entry.request as unknown as Record<string, unknown>).clientRequestId
                        || (entry.request as unknown as Record<string, unknown>).clientFeedEntryId
                        || '',
                    ).trim();
                    if (requestClientId) nextClientRequestIds.add(requestClientId);
                } else if (isAgentSessionFeedEntry(entry)) {
                    agentSessionIds.add(entry.sessionId);
                    nextAgentSessionIds.add(entry.sessionId);
                    nextAgentContextIds.add(entry.contextId);
                }
            }
            try {
                const result = await window.ipcRenderer.generation.listJobs(generationJobBootstrapFilter) as { items?: unknown[] };
                const jobs = Array.isArray(result?.items)
                    ? result.items
                        .map(normalizeMediaJobProjection)
                        .filter((item): item is MediaJobProjection => Boolean(item && isGenerationStudioMediaJob(item)))
                    : [];
                for (const job of jobs) {
                    nextJobIds.add(job.jobId);
                    nextEntryIds.add(`job:${job.jobId}`);
                    const clientRequestId = clientRequestIdFromJob(job);
                    if (clientRequestId) nextClientRequestIds.add(clientRequestId);
                }
            } catch (error) {
                console.error('Failed to list generation jobs before clearing records:', error);
            }
            const nextDeleted = normalizeDeletedFeedState({
                entryIds: Array.from(nextEntryIds),
                jobIds: Array.from(nextJobIds),
                clientRequestIds: Array.from(nextClientRequestIds),
                agentSessionIds: Array.from(nextAgentSessionIds),
                agentContextIds: Array.from(nextAgentContextIds),
            });
            deletedFeedStateRef.current = nextDeleted;
            persistDeletedFeedState(nextDeleted);
            for (const sessionId of agentSessionIds) {
                clearFixedSessionWarmSnapshot(sessionId);
            }
            updateFeedEntries([]);
            setAssetContextMenu(null);
            setPreviewAsset(null);
            setAgentPendingMessage(null);
            setAgentExecutionActive(false);
            setAgentClearNonce((value) => value + 1);
            const jobIdsToArchive = Array.from(nextJobIds);
            mediaJobsStore.removeJobs(jobIdsToArchive);
            await Promise.all(
                jobIdsToArchive.map((jobId) => window.ipcRenderer.generation.deleteJob(jobId)),
            );
            await Promise.all(
                Array.from(agentSessionIds).map((sessionId) => window.ipcRenderer.chat.clearMessages(sessionId)),
            );
        } catch (error) {
            console.error('Failed to clear generation records:', error);
            void appAlert(error instanceof Error ? error.message : '清空生成记录失败');
        }
    }, [agentSessionId, feedEntries, generationAgentContextId, generationJobBootstrapFilter, updateFeedEntries]);
    const handleSendAgentMessage = useCallback(async () => {
        const content = currentAgentRequest.prompt.trim();
        const hasCoverContext = currentAgentRequest.type === 'cover'
            && (currentAgentRequest.referenceItems.length > 0 || Boolean(currentAgentRequest.manuscriptSource));
        if ((!content && !agentAttachment && !hasCoverContext) || !agentSessionId || isAgentSessionLoading || agentExecutionActive) return;
        const attachments: UploadedFileAttachment[] = [];
        const attachmentContextNotes: string[] = [];

        const createInlineAttachment = async (item: ReferenceItem, fallbackName: string): Promise<UploadedFileAttachment> => {
            const result = await window.ipcRenderer.chat.createInlineAttachment({
                dataUrl: item.dataUrl,
                fileName: item.name || fallbackName,
                sessionId: agentSessionId,
            }) as { success?: boolean; error?: string; attachment?: UploadedFileAttachment };
            if (!result?.success || !result.attachment) {
                throw new Error(result?.error || '附件创建失败');
            }
            return result.attachment;
        };

        if (currentAgentRequest.type === 'cover' && currentAgentRequest.manuscriptSource?.path) {
            try {
                const manuscript = currentAgentRequest.manuscriptSource;
                const result = await window.ipcRenderer.manuscripts.read<ManuscriptReadResult>(manuscript.path);
                const manuscriptContent = clipManuscriptForAgent(manuscriptReadContent(result));
                attachmentContextNotes.push([
                    `已选择稿件：${manuscript.title}`,
                    `稿件路径：${manuscript.path}`,
                    manuscriptContent
                        ? `稿件正文：\n${manuscriptContent}`
                        : '稿件正文为空；请主要根据用户补充要求和参考图判断封面。',
                    '请用 social-cover-director 判断封面点击钩子、图片文字、画面策略和参考图角色；不要把整篇正文排进画面。',
                ].join('\n'));
            } catch (error) {
                console.error('Failed to read cover manuscript:', error);
                setCoverError(error instanceof Error ? error.message : '稿件读取失败');
                return;
            }
        }

        if ((currentAgentRequest.type === 'image' || currentAgentRequest.type === 'cover') && agentAttachment && attachmentVisualKind(agentAttachment) === 'image') {
            try {
                const uploadedImage = await attachmentToReferenceItem(agentAttachment);
                const combinedReferences = uploadedImage
                    ? [uploadedImage, ...currentAgentRequest.referenceItems]
                    : [...currentAgentRequest.referenceItems];
                const contactSheet = await buildReferenceContactSheet(combinedReferences);
                attachments.push(await createInlineAttachment({ name: contactSheet.fileName, dataUrl: contactSheet.dataUrl }, contactSheet.fileName));
                attachmentContextNotes.push(contactSheet.note);
            } catch (error) {
                console.error('Failed to merge generation references:', error);
                if (currentAgentRequest.type === 'cover') {
                    setCoverError(error instanceof Error ? error.message : '参考图附件创建失败');
                } else {
                    setImageError(error instanceof Error ? error.message : '参考图附件创建失败');
                }
                return;
            }
        } else if (agentAttachment) {
            attachments.push(agentAttachment);
            if ((currentAgentRequest.type === 'image' || currentAgentRequest.type === 'cover') && currentAgentRequest.referenceItems.length > 0) {
                attachmentContextNotes.push(`当前轮次还存在 ${currentAgentRequest.referenceItems.length} 张参考图未随消息附带；如需让 AI 读取这些图，请移除当前文件附件，或把参考图直接通过左侧图片区发送。`);
            }
        } else if ((currentAgentRequest.type === 'image' || currentAgentRequest.type === 'cover') && currentAgentRequest.referenceItems.length > 0) {
            try {
                const contactSheet = await buildReferenceContactSheet(currentAgentRequest.referenceItems);
                attachments.push(await createInlineAttachment({ name: contactSheet.fileName, dataUrl: contactSheet.dataUrl }, contactSheet.fileName));
                attachmentContextNotes.push(currentAgentRequest.type === 'cover' ? `封面参考图：${contactSheet.note}` : contactSheet.note);
            } catch (error) {
                console.error('Failed to create inline agent attachment:', error);
                if (currentAgentRequest.type === 'cover') {
                    setCoverError(error instanceof Error ? error.message : '参考图附件创建失败');
                } else {
                    setImageError(error instanceof Error ? error.message : '参考图附件创建失败');
                }
                return;
            }
        }
        if (currentAgentRequest.type === 'video') {
            try {
                const imageReferences = currentAgentRequest.referenceItems.filter(referenceItemIsImage);
                if (imageReferences.length > 0) {
                    const contactSheet = await buildReferenceContactSheet(imageReferences);
                    attachments.push(await createInlineAttachment({ name: contactSheet.fileName, dataUrl: contactSheet.dataUrl }, contactSheet.fileName));
                    attachmentContextNotes.push(`视频参考图：${contactSheet.note}`);
                }
                if (currentAgentRequest.firstClip?.dataUrl) {
                    attachments.push(await createInlineAttachment(currentAgentRequest.firstClip, currentAgentRequest.firstClip.name || 'first-clip.mp4'));
                    attachmentContextNotes.push(`视频续写起始素材：${currentAgentRequest.firstClip.name || 'first-clip'}`);
                }
                if (currentAgentRequest.drivingAudio?.dataUrl) {
                    attachments.push(await createInlineAttachment(currentAgentRequest.drivingAudio, currentAgentRequest.drivingAudio.name || 'driving-audio.mp3'));
                    attachmentContextNotes.push(`驱动音频素材：${currentAgentRequest.drivingAudio.name || 'driving-audio'}`);
                }
            } catch (error) {
                console.error('Failed to prepare generation agent video attachments:', error);
                setVideoError(error instanceof Error ? error.message : '参考素材附件创建失败');
                return;
            }
        }
        shouldScrollFeedToBottomRef.current = true;
        setAgentSendNonce((value) => value + 1);
        const agentSendTimestamp = Date.now();
        ensureAgentFeedEntry(agentSessionId, agentSendTimestamp, { bump: true, reviveDeleted: true });
        updateFeedEntries((prev) => [
            ...prev,
            createGenerationFeedEntry(currentAgentRequest, {
                id: makeId('generation'),
                createdAt: agentSendTimestamp + 1,
                source: contextIntent?.source || 'standalone',
                sourceTitle: contextIntent?.sourceTitle,
            }),
        ]);
        const runtimeContext = buildGenerationAgentRuntimeContext({
            mode: studioMode,
            request: currentAgentRequest,
            source: contextIntent?.source || 'standalone',
            sourceTitle: contextIntent?.sourceTitle,
            recentAssets: recentAgentAssets,
            attachmentNote: attachmentContextNotes.join('\n'),
            audioVoices: audioVoicesForModel,
            audioLanguageBoost,
        });
        const messageContent = [content, runtimeContext, attachmentContextNotes.join('\n')].filter(Boolean).join('\n\n').trim();
        const coverDisplayContent = currentAgentRequest.type === 'cover' && currentAgentRequest.manuscriptSource
            ? `请根据稿件《${currentAgentRequest.manuscriptSource.title}》做封面`
            : undefined;
        setAgentPendingMessage({
            content: messageContent,
            displayContent: content || coverDisplayContent || (attachments[0] ? `请处理这个附件：${attachments[0].name}` : undefined),
            attachments: attachments.length > 0 ? attachments : undefined,
        });
        if (studioMode === 'image') {
            setImagePrompt('');
            setImageError('');
        } else if (studioMode === 'cover') {
            setCoverPrompt('');
            setCoverError('');
        } else if (studioMode === 'video') {
            setVideoPrompt('');
            setVideoError('');
        } else {
            setAudioPrompt('');
            setAudioError('');
        }
        setAgentAttachment(null);
    }, [
        agentAttachment,
        agentExecutionActive,
        agentSessionId,
        audioLanguageBoost,
        audioVoicesForModel,
        contextIntent?.source,
        contextIntent?.sourceTitle,
        currentAgentRequest,
        ensureAgentFeedEntry,
        isAgentSessionLoading,
        recentAgentAssets,
        studioMode,
        updateFeedEntries,
    ]);
    const studioToolbar = (
        <div className="flex items-center gap-2.5 overflow-x-auto">
            <button
                type="button"
                onClick={() => setStudioMode('image')}
                className={clsx(
                    'inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-4 py-1.5 text-[14px] font-medium',
                    studioMode === 'image'
                        ? 'border-brand-red/50 bg-brand-red text-white'
                        : 'border-border bg-surface-primary text-text-secondary',
                )}
            >
                <ImagePlus className="h-4 w-4" />
                生图
            </button>
            <button
                type="button"
                onClick={() => setStudioMode('cover')}
                className={clsx(
                    'inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-4 py-1.5 text-[14px] font-medium',
                    studioMode === 'cover'
                        ? 'border-brand-red/50 bg-brand-red text-white'
                        : 'border-border bg-surface-primary text-text-secondary',
                )}
            >
                <Layers className="h-4 w-4" />
                做封面
            </button>
            <button
                type="button"
                onClick={() => setStudioMode('video')}
                className={clsx(
                    'inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-4 py-1.5 text-[14px] font-medium',
                    studioMode === 'video'
                        ? 'border-brand-red/50 bg-brand-red text-white'
                        : 'border-border bg-surface-primary text-text-secondary',
                )}
            >
                <Clapperboard className="h-4 w-4" />
                生视频
            </button>
            <button
                type="button"
                onClick={() => setStudioMode('audio')}
                className={clsx(
                    'inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-4 py-1.5 text-[14px] font-medium',
                    studioMode === 'audio'
                        ? 'border-brand-red/50 bg-brand-red text-white'
                        : 'border-border bg-surface-primary text-text-secondary',
                )}
            >
                <Music2 className="h-4 w-4" />
                生音频
            </button>
            {feedEntries.length > 0 && (
                <button
                    type="button"
                    onClick={() => void handleClearGenerationRecords()}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface-primary text-text-tertiary transition-colors hover:border-brand-red/30 hover:bg-brand-red/10 hover:text-brand-red disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label="清空生成记录"
                    title="清空生成记录"
                >
                    <Trash2 className="h-4 w-4" />
                </button>
            )}
        </div>
    );

    return (
        <div className="h-full min-h-0 text-text-primary">
            <div className="mx-auto flex h-full min-h-0 max-w-[1180px] flex-col px-6">
                {onReturnHome && (
                    <div className="flex h-12 shrink-0 items-center">
                        <button
                            type="button"
                            onClick={onReturnHome}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface-primary text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                            aria-label="返回主页"
                            title="返回主页"
                        >
                            <ArrowLeft className="h-4 w-4" />
                        </button>
                    </div>
                )}
                <main ref={feedScrollRef} className={clsx('flex-1 min-h-0 overflow-y-auto', onReturnHome ? 'pt-0' : 'pt-6')}>
                    {visibleFeedItems.length === 0 ? (
                        <div className="min-h-[280px]" />
                    ) : (
                        <div className="mx-auto max-w-[860px] space-y-7 pb-10">
                            {visibleFeedItems.map(({ entry, index }) => (
                                isGenerationFeedEntry(entry) ? (
                                    <FeedEntryMessage
                                        key={entry.id}
                                        entry={entry}
                                        isActive={isActive}
                                        inlineWithAgent={index > 0 && isAgentSessionFeedEntry(feedEntries[index - 1])}
                                        onRegenerate={handleRegenerate}
                                        onEdit={handleEditEntry}
                                        onDelete={handleDeleteEntry}
                                        onPreviewAsset={setPreviewAsset}
                                        onOpenAssetMenu={handleOpenAssetMenu}
                                    />
                                ) : (
                                    <article key={entry.id} className="space-y-3">
                                        <div className="flex max-w-[680px] items-start gap-2">
                                            <div className="min-w-0 flex-1 text-[13px] font-medium leading-6 text-text-primary">
                                                {entry.title}
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => handleDeleteEntry(entry.id)}
                                                className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-brand-red/10 hover:text-brand-red"
                                                aria-label="删除创作记录"
                                                title="删除创作记录"
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                        <Chat
                                            key={`${entry.sessionId}:${entry.sessionId === agentSessionId ? agentSendNonce : 0}`}
                                            isActive={isActive}
                                            fixedSessionId={entry.sessionId}
                                            pendingMessage={entry.sessionId === agentSessionId ? agentPendingMessage : null}
                                            onMessageConsumed={() => {
                                                if (entry.sessionId === agentSessionId) {
                                                    setAgentPendingMessage(null);
                                                }
                                            }}
                                            showClearButton={false}
                                            showWelcomeShortcuts={false}
                                            showComposerShortcuts={false}
                                            showComposer={false}
                                            showMessageAttachments={true}
                                            showWelcomeHeader={false}
                                            collapseEmptyFixedSession={true}
                                            fixedSessionContextIndicatorMode="none"
                                            welcomeTitle=""
                                            welcomeSubtitle=""
                                            contentLayout="wide"
                                            allowFileUpload={false}
                                            messageWorkflowPlacement="top"
                                            messageWorkflowVariant="compact"
                                            messageWorkflowEmphasis="thoughts-first"
                                            messageWorkflowDisplayMode="all"
                                            onExecutionStateChange={entry.sessionId === agentSessionId ? setAgentExecutionActive : undefined}
                                            clearSignal={entry.sessionId === agentSessionId ? agentClearNonce : 0}
                                            onSessionActivity={(sessionId, updatedAt) => {
                                                if (entry.sessionId !== agentSessionId || sessionId !== agentSessionId) return;
                                                if (feedEntries.some((item) => isGenerationFeedEntry(item) && item.status === 'running')) return;
                                                const nextCreatedAt = feedTime(updatedAt);
                                                ensureAgentFeedEntry(agentSessionId, nextCreatedAt || Date.now(), { bump: true });
                                            }}
                                        />
                                    </article>
                                )
                            ))}
                            <div ref={feedBottomRef} />
                        </div>
                    )}
                </main>

                <footer className="bg-background pb-5 pt-4">
                    <div className={composerWidthClass}>
                        <div className="rounded-[24px] border border-border bg-surface-secondary px-5 py-3 shadow-[var(--ui-shadow-1)]">
                            {studioToolbar}

                            <div className="mt-3 rounded-[20px] border border-border bg-surface-primary p-4">
                                <div className={composerGridClass}>
                                    {(studioMode === 'image' || studioMode === 'cover' || studioMode === 'video') && (
                                        <div className="space-y-3">
                                            {studioMode === 'image' ? (
                                                <UploadPreviewCard
                                                    label={isReadingImageRefs ? '读取中' : '图片'}
                                                    accept="image/*"
                                                    multiple
                                                    items={imageReferences}
                                                    onChange={handleImageReferenceFiles}
                                                    onFiles={appendImageReferenceFiles}
                                                    onClear={() => setImageReferences([])}
                                                />
                                            ) : studioMode === 'cover' ? (
                                                <UploadPreviewCard
                                                    label={isReadingCoverRefs ? '读取中' : '图片'}
                                                    accept="image/*"
                                                    multiple
                                                    items={coverReferences}
                                                    onChange={handleCoverReferenceFiles}
                                                    onFiles={appendCoverReferenceFiles}
                                                    onClear={() => setCoverReferences([])}
                                                />
                                            ) : videoMode === 'first-last-frame' ? (
                                                <div className="grid grid-cols-2 gap-3">
                                                    <UploadPreviewCard
                                                        label={isReadingVideoRefs ? '读取中' : '首帧'}
                                                        accept="image/*"
                                                        items={videoFirstFrame ? [videoFirstFrame] : []}
                                                        onChange={(event) => void handleVideoReferenceFile(event, 'first')}
                                                        onFiles={(files) => void setVideoReferenceFile(files[0], 'first')}
                                                        onClear={() => setVideoFirstFrame(null)}
                                                    />
                                                    <UploadPreviewCard
                                                        label={isReadingVideoRefs ? '读取中' : '尾帧'}
                                                        accept="image/*"
                                                        items={videoLastFrame ? [videoLastFrame] : []}
                                                        onChange={(event) => void handleVideoReferenceFile(event, 'last')}
                                                        onFiles={(files) => void setVideoReferenceFile(files[0], 'last')}
                                                        onClear={() => setVideoLastFrame(null)}
                                                    />
                                                </div>
                                            ) : videoMode === 'continuation' ? (
                                                <UploadPreviewCard
                                                    label={isReadingVideoRefs ? '读取中' : '视频'}
                                                    accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                                                    items={videoFirstClip ? [videoFirstClip] : []}
                                                    onChange={(event) => void handleVideoReferenceFile(event, 'firstClip')}
                                                    onFiles={(files) => void setVideoReferenceFile(files[0], 'firstClip')}
                                                    onClear={() => setVideoFirstClip(null)}
                                                />
                                            ) : (
                                                <UploadPreviewCard
                                                    label={isReadingVideoRefs ? '读取中' : '图片'}
                                                    accept="image/*"
                                                    multiple
                                                    items={uploadedVideoRefs}
                                                    onChange={handleVideoReferenceFiles}
                                                    onFiles={appendVideoReferenceFiles}
                                                    onClear={() => setVideoReferences([])}
                                                />
                                            )}
                                        </div>
                                    )}

                                    <div className="space-y-3">
                                        {studioMode === 'audio' ? (
                                            <AudioRichTextInput
                                                ref={audioRichTextInputRef}
                                                value={audioPrompt}
                                                onChange={setAudioPrompt}
                                                placeholder="输入要合成的旁白、台词或口播文本..."
                                            />
                                        ) : (
                                            <div className="relative">
                                                {studioMode === 'cover' && (
                                                    <div className="absolute left-0 top-0 z-10 flex max-w-full items-center gap-1.5">
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                setCoverManuscriptSearch('');
                                                                setCoverManuscriptPickerOpen(true);
                                                            }}
                                                            className={clsx(
                                                                'flex h-7 max-w-[260px] items-center gap-1.5 rounded-full border px-2.5 text-left transition-colors',
                                                                selectedCoverManuscript
                                                                    ? 'border-brand-red/35 bg-brand-red/10'
                                                                    : 'border-border bg-surface-secondary hover:border-brand-red/30',
                                                            )}
                                                        >
                                                            <FileText className={clsx(
                                                                'h-3.5 w-3.5 shrink-0',
                                                                selectedCoverManuscript ? 'text-brand-red' : 'text-text-tertiary',
                                                            )} />
                                                            <span className="min-w-0 truncate text-[12px] font-medium text-text-primary">
                                                                {selectedCoverManuscript?.title || (isLoadingCoverManuscripts ? '加载稿件' : '选择稿件')}
                                                            </span>
                                                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                                                        </button>
                                                        {selectedCoverManuscript && (
                                                            <button
                                                                type="button"
                                                                onClick={() => setCoverManuscriptPath('')}
                                                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface-secondary text-text-tertiary transition-colors hover:bg-surface-primary hover:text-text-primary"
                                                                aria-label="清除已选稿件"
                                                            >
                                                                <X className="h-3.5 w-3.5" />
                                                            </button>
                                                        )}
                                                    </div>
                                                )}

                                                <textarea
                                                    value={studioMode === 'image' ? imagePrompt : studioMode === 'cover' ? coverPrompt : studioMode === 'digital-human' ? digitalHumanPrompt : videoPrompt}
                                                    onChange={(event) => (
                                                        studioMode === 'image'
                                                            ? setImagePrompt(event.target.value)
                                                            : studioMode === 'cover'
                                                                ? setCoverPrompt(event.target.value)
                                                            : studioMode === 'digital-human'
                                                                ? setDigitalHumanPrompt(event.target.value)
                                                                : setVideoPrompt(event.target.value)
                                                    )}
                                                    rows={4}
                                                    placeholder={studioMode === 'image' ? '描述您想生成的场景、风格、细节...' : studioMode === 'cover' ? '输入封面标题，或补充想要的点击感...' : studioMode === 'digital-human' ? '输入角色要说的口播文案...' : '描述您想生成的视频场景、镜头、动作...'}
                                                    className={clsx(
                                                        'min-h-[112px] max-h-[240px] w-full resize-y overflow-y-auto bg-transparent text-[14px] leading-6 text-text-primary outline-none placeholder:text-text-tertiary',
                                                        studioMode === 'cover' && 'pt-9',
                                                    )}
                                                />
                                            </div>
                                        )}

                                        {(studioMode === 'image' || studioMode === 'cover') && isAgentMode && agentAttachment && (
                                            <AgentAttachmentCard
                                                attachment={agentAttachment}
                                                onClear={() => setAgentAttachment(null)}
                                            />
                                        )}

                                        <div className="flex flex-wrap items-center gap-2">
                                            {studioMode === 'image' ? (
                                                <>
                                                    <PopoverSelect
                                                        value={imageModel}
                                                        onChange={setImageModel}
                                                        options={imageModelOptions}
                                                        className="min-w-[156px]"
                                                        title="图片模型"
                                                        panelClassName="w-[240px]"
                                                        layout="column"
                                                        disabled={imageModelOptions.length === 0}
                                                        emptyText="未添加生图模型"
                                                    />
                                                    <ImageAspectRatioPicker
                                                        value={imageAspectRatio}
                                                        onChange={setImageAspectRatio}
                                                    />
                                                    <PopoverSelect
                                                        value={imageResolution}
                                                        onChange={setImageResolution}
                                                        options={IMAGE_RESOLUTION_OPTIONS}
                                                        className="min-w-[82px]"
                                                        title="清晰度"
                                                        panelClassName="w-[220px]"
                                                    />
                                                    <PopoverSelect
                                                        value={String(imageCount)}
                                                        onChange={(value) => setImageCount(Number(value) || 1)}
                                                        options={IMAGE_COUNT_OPTIONS}
                                                        className="min-w-[78px]"
                                                        title="生成数量"
                                                        panelClassName="w-[220px]"
                                                    />
                                                    <GenerationSubmitButton
                                                        onClick={isAgentMode ? handleSendAgentMessage : handleGenerateImage}
                                                        disabled={isAgentMode ? !canSendAgentMessage : (!hasImageConfig || !imageModel.trim())}
                                                        title={isAgentMode ? '发送给 Agent' : '生成图片'}
                                                        ariaLabel={isAgentMode ? '发送给 Agent' : '生成图片'}
                                                        estimate={imageCostEstimate}
                                                        pending={isAgentMode && agentExecutionActive}
                                                        agent={isAgentMode}
                                                    />
                                                </>
                                            ) : studioMode === 'cover' ? (
                                                <>
                                                    <PopoverSelect
                                                        value={coverModel}
                                                        onChange={setCoverModel}
                                                        options={imageModelOptions}
                                                        className="min-w-[156px]"
                                                        title="图片模型"
                                                        panelClassName="w-[240px]"
                                                        layout="column"
                                                        disabled={imageModelOptions.length === 0}
                                                        emptyText="未添加生图模型"
                                                    />
                                                    {!isAgentMode && (
                                                        <>
                                                            {COVER_STYLE_OPTIONS.map((option) => {
                                                                const active = coverPromptSwitches[option.key];
                                                                return (
                                                                    <button
                                                                        key={option.key}
                                                                        type="button"
                                                                        onClick={() => setCoverPromptSwitches((prev) => ({
                                                                            ...prev,
                                                                            [option.key]: !prev[option.key],
                                                                        }))}
                                                                        className={clsx(
                                                                            'inline-flex h-9 items-center rounded-full border px-3 text-[12px] font-medium transition-colors',
                                                                            active
                                                                                ? 'border-brand-red/40 bg-brand-red/10 text-brand-red'
                                                                                : 'border-border bg-surface-primary text-text-secondary',
                                                                        )}
                                                                    >
                                                                        {option.label}
                                                                    </button>
                                                                );
                                                            })}
                                                        </>
                                                    )}
                                                    <PopoverSelect
                                                        value={String(coverCount)}
                                                        onChange={(value) => setCoverCount(Number(value) || 1)}
                                                        options={IMAGE_COUNT_OPTIONS}
                                                        className="min-w-[78px]"
                                                        title="生成数量"
                                                        panelClassName="w-[220px]"
                                                    />
                                                    <GenerationSubmitButton
                                                        onClick={isAgentMode ? handleSendAgentMessage : handleGenerateCover}
                                                        disabled={isAgentMode ? !canSendAgentMessage : (!hasImageConfig || !coverModel.trim())}
                                                        title={isAgentMode ? '发送给 Agent' : '生成封面'}
                                                        ariaLabel={isAgentMode ? '发送给 Agent' : '生成封面'}
                                                        estimate={coverCostEstimate}
                                                        pending={isAgentMode && agentExecutionActive}
                                                        agent={isAgentMode}
                                                    />
                                                </>
                                            ) : studioMode === 'audio' ? (
                                                <>
                                                    <PopoverSelect
                                                        value={effectiveAudioModel}
                                                        onChange={setAudioModel}
                                                        options={audioModelOptions}
                                                        className="min-w-[170px]"
                                                        title="TTS 模型"
                                                        panelClassName="w-[280px]"
                                                        layout="column"
                                                        disabled={audioModelOptions.length === 0}
                                                        emptyText="未添加音频模型"
                                                    />
                                                    <PopoverSelect
                                                        value={audioLanguageBoost}
                                                        onChange={setAudioLanguageBoost}
                                                        options={audioLanguageOptions}
                                                        className="min-w-[92px]"
                                                        title="语言"
                                                        panelClassName="w-[220px]"
                                                        layout="column"
                                                    />
                                                    <PopoverSelect
                                                        value={audioVoiceId}
                                                        onChange={setAudioVoiceId}
                                                        options={mergedAudioVoiceOptions}
                                                        className="min-w-[150px]"
                                                        title="音色"
                                                        panelClassName="w-[280px]"
                                                        layout="column"
                                                        disabled={!hasVoiceConfig || isLoadingAudioVoices || mergedAudioVoiceOptions.length === 0}
                                                        emptyText={isLoadingAudioVoices ? '加载音色' : '暂无音色'}
                                                    />
                                                    <PopoverSelect
                                                        value={audioSpeed}
                                                        onChange={(value) => {
                                                            setAudioSpeed(value || '1');
                                                            setAudioSpeedTouched(true);
                                                        }}
                                                        options={AUDIO_SPEED_OPTIONS}
                                                        className="min-w-[76px]"
                                                        title="语速"
                                                        panelClassName="w-[112px]"
                                                        layout="column"
                                                        emptyText="语速"
                                                        optionAlign="center"
                                                    />
                                                    <PopoverSelect
                                                        value={audioEmotionTouched ? audioEmotion : ''}
                                                        onChange={(value) => {
                                                            setAudioEmotion(value);
                                                            setAudioEmotionTouched(true);
                                                        }}
                                                        options={AUDIO_EMOTION_OPTIONS}
                                                        className="min-w-[92px]"
                                                        title="情绪"
                                                        panelClassName="w-[200px]"
                                                        layout="column"
                                                        emptyText="情绪"
                                                    />
                                                    <div ref={audioPauseMenuRef} className="relative">
                                                        <button
                                                            type="button"
                                                            onClick={() => setAudioPauseMenuOpen((open) => !open)}
                                                            className="inline-flex h-9 items-center rounded-full border border-border bg-surface-primary px-3 text-[12px] font-medium text-text-secondary shadow-[var(--ui-shadow-1)] transition-colors hover:border-border/70 hover:bg-surface-tertiary"
                                                        >
                                                            插入停顿
                                                        </button>
                                                        {audioPauseMenuOpen && (
                                                            <div className="absolute bottom-[calc(100%+10px)] left-0 z-20 w-[112px] rounded-[20px] border border-border bg-surface-secondary p-3 shadow-[var(--ui-shadow-2)]">
                                                                <div className="mb-3 text-center text-[13px] font-semibold text-text-secondary">停顿</div>
                                                                <div className="flex max-h-[260px] flex-col gap-2 overflow-y-auto">
                                                                    {AUDIO_PAUSE_OPTIONS.map((option) => (
                                                                        <button
                                                                            key={option.value}
                                                                            type="button"
                                                                            onClick={() => {
                                                                                audioRichTextInputRef.current?.insertPause(option.value);
                                                                                setAudioPauseMenuOpen(false);
                                                                            }}
                                                                            className="w-full rounded-[14px] border border-transparent bg-surface-tertiary px-3 py-2.5 text-center text-[12px] font-semibold text-text-secondary transition-colors hover:bg-accent-muted"
                                                                        >
                                                                            {option.label}
                                                                        </button>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                    <GenerationSubmitButton
                                                        onClick={isAgentMode ? handleSendAgentMessage : handleGenerateAudio}
                                                        disabled={isAgentMode ? !canSendAgentMessage : (!hasVoiceConfig || !audioVoiceId.trim())}
                                                        title={isAgentMode ? '发送给 Agent' : '生成音频'}
                                                        ariaLabel={isAgentMode ? '发送给 Agent' : '生成音频'}
                                                        estimate={audioCostEstimate}
                                                        pending={isAgentMode && agentExecutionActive}
                                                        agent={isAgentMode}
                                                    />
                                                </>
                                            ) : studioMode === 'digital-human' ? (
                                                <>
                                                    <PopoverSelect
                                                        value={selectedDigitalHumanRole?.id || ''}
                                                        onChange={setDigitalHumanRoleId}
                                                        onDisabledOptionClick={handleDisabledDigitalHumanRoleClick}
                                                        options={digitalHumanRoleOptions}
                                                        className="min-w-[180px]"
                                                        title="角色"
                                                        panelClassName="w-[300px]"
                                                        layout="column"
                                                        disabled={isLoadingDigitalHumanRoles || digitalHumanRoleOptions.length === 0}
                                                        emptyText={isLoadingDigitalHumanRoles ? '加载角色' : '暂无角色'}
                                                    />
                                                    {onOpenAssets && (
                                                        <button
                                                            type="button"
                                                            onClick={onOpenAssets}
                                                            className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-surface-primary px-3 text-[12px] font-medium text-text-secondary shadow-[var(--ui-shadow-1)] transition-colors hover:border-border/70 hover:bg-surface-tertiary"
                                                        >
                                                            <UserRound className="h-3.5 w-3.5" />
                                                            资产库
                                                        </button>
                                                    )}
                                                    <PopoverSelect
                                                        value="1080p"
                                                        onChange={() => undefined}
                                                        options={VIDEO_RESOLUTION_OPTIONS.filter((option) => option.value === '1080p')}
                                                        className="min-w-[96px]"
                                                        title="视频清晰度"
                                                        panelClassName="w-[180px]"
                                                    />
                                                    <GenerationSubmitButton
                                                        onClick={handleGenerateDigitalHuman}
                                                        disabled={!digitalHumanPrompt.trim() || !selectedDigitalHumanReadiness.ok}
                                                        title="生成数字人"
                                                        ariaLabel="生成数字人"
                                                        estimate={digitalHumanCostEstimate}
                                                    />
                                                </>
                                            ) : (
                                                <>
                                                    <PopoverSelect
                                                        value={videoMode}
                                                        onChange={(value) => setVideoMode(value as VideoGenerationMode)}
                                                        options={VIDEO_MODE_OPTIONS}
                                                        className="min-w-[150px]"
                                                        title="视频模式"
                                                        panelClassName="w-[280px]"
                                                    />
                                                    <PopoverSelect
                                                        value={videoAspectRatio}
                                                        onChange={(value) => setVideoAspectRatio(value as '16:9' | '9:16')}
                                                        options={VIDEO_ASPECT_RATIO_OPTIONS}
                                                        className="min-w-[96px]"
                                                        title="视频比例"
                                                        panelClassName="w-[220px]"
                                                    />
                                                    <PopoverSelect
                                                        value={videoResolution}
                                                        onChange={(value) => setVideoResolution(value as '720p' | '1080p')}
                                                        options={VIDEO_RESOLUTION_OPTIONS}
                                                        className="min-w-[96px]"
                                                        title="视频清晰度"
                                                        panelClassName="w-[220px]"
                                                    />
                                                    <PopoverSelect
                                                        value={String(videoDurationSeconds)}
                                                        onChange={(value) => setVideoDurationSeconds(Number(value) || 8)}
                                                        options={VIDEO_DURATION_OPTIONS}
                                                        className="min-w-[96px]"
                                                        title="视频时长"
                                                        panelClassName="w-[188px]"
                                                        layout="column"
                                                    />
                                                    <PopoverSelect
                                                        value={videoGenerateAudio ? 'on' : 'off'}
                                                        onChange={(value) => setVideoGenerateAudio(value === 'on')}
                                                        options={VIDEO_AUDIO_OPTIONS}
                                                        className="min-w-[92px]"
                                                        title="音频"
                                                        panelClassName="w-[220px]"
                                                    />
                                                    <GenerationSubmitButton
                                                        onClick={isAgentMode ? handleSendAgentMessage : handleGenerateVideo}
                                                        disabled={isAgentMode ? !canSendAgentMessage : !hasVideoConfig}
                                                        title={isAgentMode ? '发送给 Agent' : '生成视频'}
                                                        ariaLabel={isAgentMode ? '发送给 Agent' : '生成视频'}
                                                        estimate={videoCostEstimate}
                                                        pending={isAgentMode && agentExecutionActive}
                                                        agent={isAgentMode}
                                                    />
                                                </>
                                            )}
                                        </div>

                                        {studioMode === 'image' && isReadingImageRefs && (
                                            <div className="flex flex-wrap items-center gap-3 text-[12px] text-text-tertiary">
                                                <span>正在读取参考图...</span>
                                            </div>
                                        )}

                                        {studioMode === 'cover' && isReadingCoverRefs && (
                                            <div className="flex flex-wrap items-center gap-3 text-[12px] text-text-tertiary">
                                                <span>正在读取封面素材...</span>
                                            </div>
                                        )}

                                        {studioMode === 'video' && (
                                            <div className="flex flex-wrap items-center gap-3 text-[12px] text-text-tertiary">
                                                {videoDrivingAudio && <span>已附带驱动音频</span>}
                                                {isReadingVideoRefs && <span>正在读取素材...</span>}
                                            </div>
                                        )}

                                        {studioMode === 'digital-human' && selectedDigitalHumanRole && !selectedDigitalHumanReadiness.ok && (
                                            <div className="flex flex-wrap items-center gap-3 text-[12px] text-brand-red">
                                                <span>{selectedDigitalHumanReadiness.issue}</span>
                                            </div>
                                        )}

                                        {visibleError && (
                                            <div className="rounded-[14px] bg-brand-red/10 px-4 py-3 text-sm text-brand-red">
                                                {visibleError}
                                            </div>
                                        )}

                                        {studioMode === 'image' && !isAgentMode && !hasImageConfig && (
                                            <div className="rounded-[14px] bg-brand-red/10 px-4 py-3 text-sm text-brand-red">
                                                未检测到生图配置。请先到“设置 → AI 模型”填写图片生成的 Endpoint、API Key 和模型。
                                            </div>
                                        )}

                                        {studioMode === 'cover' && !isAgentMode && !hasImageConfig && (
                                            <div className="rounded-[14px] bg-brand-red/10 px-4 py-3 text-sm text-brand-red">
                                                未检测到生图配置。请先到“设置 → AI 模型”填写图片生成的 Endpoint、API Key 和模型。
                                            </div>
                                        )}

                                        {studioMode === 'video' && !isAgentMode && !hasVideoConfig && (
                                            <div className="rounded-[14px] bg-brand-red/10 px-4 py-3 text-sm text-brand-red">
                                                未检测到生视频配置。请先完成官方视频登录或填写视频生成所需的 API Key。
                                            </div>
                                        )}

                                        {studioMode === 'audio' && !isAgentMode && !hasVoiceConfig && (
                                            <div className="rounded-[14px] bg-brand-red/10 px-4 py-3 text-sm text-brand-red">
                                                未检测到声音合成配置。请先到“设置 → AI 模型”填写 TTS 配置。
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </footer>
            </div>

            {coverManuscriptPickerOpen && (
                <div
                    className="fixed inset-0 z-[1180] flex items-center justify-center bg-black/45 p-6 backdrop-blur-[1px]"
                    role="dialog"
                    aria-modal="true"
                    onMouseDown={() => setCoverManuscriptPickerOpen(false)}
                >
                    <div
                        className="flex max-h-[82vh] w-full max-w-[760px] flex-col overflow-hidden rounded-[22px] border border-border bg-surface-primary shadow-[var(--ui-shadow-2)]"
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-muted text-brand-red">
                                <FileText className="h-4.5 w-4.5" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-[14px] font-semibold text-text-primary">选择稿件</div>
                                <div className="mt-0.5 text-[11px] text-text-tertiary">
                                    {coverManuscripts.length} 篇
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setCoverManuscriptPickerOpen(false)}
                                className="flex h-8 w-8 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                                aria-label="关闭"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>

                        <div className="border-b border-border px-5 py-4">
                            <div className="flex h-10 items-center gap-2 rounded-[14px] border border-border bg-surface-secondary px-3">
                                <Search className="h-4 w-4 shrink-0 text-text-tertiary" />
                                <input
                                    autoFocus
                                    value={coverManuscriptSearch}
                                    onChange={(event) => setCoverManuscriptSearch(event.target.value)}
                                    placeholder="搜索标题或路径"
                                    className="min-w-0 flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-tertiary"
                                />
                                {coverManuscriptSearch && (
                                    <button
                                        type="button"
                                        onClick={() => setCoverManuscriptSearch('')}
                                        className="flex h-6 w-6 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-surface-tertiary hover:text-text-primary"
                                        aria-label="清空搜索"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                    </button>
                                )}
                            </div>
                        </div>

                        <div className="min-h-0 flex-1 overflow-y-auto p-3">
                            <button
                                type="button"
                                onClick={() => {
                                    setCoverManuscriptPath('');
                                    setCoverManuscriptPickerOpen(false);
                                }}
                                className={clsx(
                                    'mb-2 flex w-full items-center gap-3 rounded-[14px] border px-3 py-3 text-left transition-colors',
                                    !coverManuscriptPath
                                        ? 'border-brand-red/45 bg-brand-red/10'
                                        : 'border-transparent hover:bg-surface-secondary',
                                )}
                            >
                                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-secondary text-text-tertiary">
                                    <FileText className="h-4 w-4" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-[13px] font-semibold text-text-primary">不使用稿件</div>
                                    <div className="mt-0.5 text-[11px] text-text-tertiary">只根据输入和参考图做封面</div>
                                </div>
                            </button>

                            {isLoadingCoverManuscripts ? (
                                <div className="flex h-32 items-center justify-center text-[13px] text-text-tertiary">
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    加载稿件
                                </div>
                            ) : filteredCoverManuscripts.length === 0 ? (
                                <div className="flex h-32 items-center justify-center text-[13px] text-text-tertiary">
                                    没有匹配稿件
                                </div>
                            ) : (
                                <div className="space-y-1">
                                    {filteredCoverManuscripts.map((item) => {
                                        const selected = item.path === coverManuscriptPath;
                                        return (
                                            <button
                                                key={item.path}
                                                type="button"
                                                onClick={() => {
                                                    setCoverManuscriptPath(item.path);
                                                    setCoverManuscriptPickerOpen(false);
                                                }}
                                                className={clsx(
                                                    'flex w-full items-center gap-3 rounded-[14px] border px-3 py-3 text-left transition-colors',
                                                    selected
                                                        ? 'border-brand-red/45 bg-brand-red/10'
                                                        : 'border-transparent hover:bg-surface-secondary',
                                                )}
                                            >
                                                <div className={clsx(
                                                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                                                    selected ? 'bg-brand-red text-white' : 'bg-surface-secondary text-text-tertiary',
                                                )}>
                                                    <FileText className="h-4 w-4" />
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate text-[13px] font-semibold text-text-primary">{item.title}</div>
                                                    <div className="mt-0.5 truncate text-[11px] text-text-tertiary">{item.path}</div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {previewAsset && (
                <div
                    className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/72 p-6 backdrop-blur-[1px]"
                    onMouseDown={() => setPreviewAsset(null)}
                >
                    <div
                        className="relative flex max-h-[90vh] max-w-[92vw] items-center justify-center"
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <button
                            type="button"
                            onClick={() => setPreviewAsset(null)}
                            className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-white transition-colors hover:bg-black/65"
                        >
                            <X className="h-4 w-4" />
                        </button>
                        {isVideoAsset(previewAsset) ? (
                            <video
                                src={resolveAssetUrl(previewAsset.previewUrl || '')}
                                controls
                                autoPlay
                                preload="metadata"
                                className="max-h-[90vh] max-w-[92vw] rounded-2xl bg-black shadow-2xl"
                            />
                        ) : isAudioAsset(previewAsset) ? (
                            <div className="w-[min(560px,92vw)] rounded-2xl border border-white/10 bg-surface-primary p-5 shadow-2xl">
                                <div className="mb-4 flex items-center gap-3 text-text-primary">
                                    <Music2 className="h-5 w-5 text-brand-red" />
                                    <div className="min-w-0 flex-1 truncate text-sm font-semibold">{previewAsset.title || '生成音频'}</div>
                                </div>
                                <audio
                                    src={resolveAssetUrl(previewAsset.previewUrl || '')}
                                    controls
                                    autoPlay
                                    className="w-full"
                                />
                            </div>
                        ) : (
                            <img
                                src={resolveAssetUrl(previewAsset.previewUrl || '')}
                                alt={previewAsset.title || previewAsset.id}
                                className="max-h-[90vh] max-w-[92vw] rounded-2xl border border-white/10 bg-black/10 object-contain shadow-2xl"
                            />
                        )}
                    </div>
                </div>
            )}

            {assetContextMenu && (
                <div
                    className="fixed z-[1250] min-w-[148px] overflow-hidden rounded-[16px] border border-border bg-surface-elevated p-1.5 text-text-primary shadow-[var(--ui-shadow-2)]"
                    style={{
                        left: Math.min(assetContextMenu.x, window.innerWidth - 172),
                        top: Math.min(assetContextMenu.y, window.innerHeight - 244),
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                >
                    <button
                        type="button"
                        onClick={() => {
                            void handleShowAssetInFolder(assetContextMenu.asset);
                            setAssetContextMenu(null);
                        }}
                        className="flex w-full items-center gap-2 rounded-[12px] px-3 py-2 text-left text-[13px] font-medium text-text-primary transition-colors hover:bg-surface-secondary"
                    >
                        <FolderOpen className="h-3.5 w-3.5" />
                        在文件夹中打开
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            void handleSaveAsset(assetContextMenu.asset);
                            setAssetContextMenu(null);
                        }}
                        className="flex w-full items-center gap-2 rounded-[12px] px-3 py-2 text-left text-[13px] font-medium text-text-primary transition-colors hover:bg-surface-secondary"
                    >
                        <Download className="h-3.5 w-3.5" />
                        另存为
                    </button>
                </div>
            )}
        </div>
    );
}
