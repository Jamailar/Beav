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
    Paperclip,
    PencilLine,
    Play,
    Plus,
    RotateCcw,
    Sparkles,
    Trash2,
    UserRound,
    X,
} from 'lucide-react';
import clsx from 'clsx';
import { REDBOX_OFFICIAL_VIDEO_BASE_URL, getRedBoxOfficialVideoModel } from '../../shared/redboxVideo';
import type { GenerationIntent, PendingChatMessage } from '../features/app-shell/types';
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
} from '../features/media-generation';
import { Chat, clearFixedSessionWarmSnapshot } from './Chat';
import { resolveAssetUrl } from '../utils/pathManager';
import { appAlert, appConfirm } from '../utils/appDialogs';

type GenerationSurface = 'manual' | 'agent';


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

const IMAGE_QUALITY_OPTIONS = [
    { value: 'low', label: 'low' },
    { value: 'medium', label: 'medium' },
    { value: 'high', label: 'high' },
] as const;

const IMAGE_RESOLUTION_OPTIONS = [
    { value: 'auto', label: '自动' },
    { value: '1K', label: '1K' },
    { value: '2K', label: '2K' },
    { value: '4K', label: '4K' },
] as const;

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
    onClear,
}: {
    label: string;
    accept: string;
    multiple?: boolean;
    items: ReferenceItem[];
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void | Promise<void>;
    onClear?: () => void;
}) {
    const lead = items[0] || null;
    const hasItems = items.length > 0;
    const leadIsVideo = isVideoReference(lead);

    return (
        <div className="group relative">
            <label className={clsx(
                'relative flex h-[88px] w-[88px] cursor-pointer flex-col items-center justify-center overflow-hidden rounded-[18px] border transition-colors',
                hasItems
                    ? 'border-border bg-surface-tertiary hover:border-border/70'
                    : 'border-border bg-surface-secondary text-text-secondary hover:bg-surface-tertiary',
            )}
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
    if (request.type === 'cover') {
        return [request.templateImage, request.baseImage].filter(Boolean) as ReferenceItem[];
    }
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

function FeedEntryMessage({
    entry,
    isActive,
    onRegenerate,
    onEdit,
    onDelete,
    onPreviewAsset,
    onOpenAssetMenu,
}: {
    entry: GenerationFeedEntry;
    isActive: boolean;
    onRegenerate: (entry: GenerationFeedEntry) => void;
    onEdit: (entry: GenerationFeedEntry) => void;
    onDelete: (entryId: string) => void;
    onPreviewAsset: (asset: GeneratedAsset) => void;
    onOpenAssetMenu: (event: React.MouseEvent<HTMLElement>, asset: GeneratedAsset, entryId?: string) => void;
}) {
    const [now, setNow] = useState(() => Date.now());
    const isRunning = entry.status === 'running';
    const progress = estimateGenerationProgress(entry.request, now - entry.createdAt);
    const placeholderCount = placeholderCountForRequest(entry.request);
    const placeholderAspectRatio = placeholderAspectRatioForRequest(entry.request);
    const mediaGridClass = feedMediaGridClass(entry.request, placeholderCount);
    const assetGridClass = feedMediaGridClass(entry.request, entry.assets.length);
    const mediaHeightClass = feedMediaHeightClass(entry.request);

    useEffect(() => {
        setNow(Date.now());
        if (!isActive || !isRunning) return;
        const timer = window.setInterval(() => setNow(Date.now()), 800);
        return () => window.clearInterval(timer);
    }, [entry.createdAt, isActive, isRunning]);

    return (
        <article className="space-y-3">
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

            <div className="flex max-w-[680px] items-start gap-2">
                <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-6 text-text-primary">
                    {entry.request.prompt}
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

            <ReferencePreviewStrip request={entry.request} />

            {isRunning && (
                <div className={clsx(
                    entry.request.type === 'audio'
                        ? 'max-w-[620px]'
                        : 'max-w-[760px] rounded-[16px] border border-border bg-surface-secondary px-4 py-3',
                )}>
                    <div className="mb-2.5 flex items-center justify-between gap-4">
                        <div className="text-[12px] font-medium text-text-secondary">
                            任务创作中 {progress}%...
                        </div>
                        <div className="text-[11px] text-text-tertiary">
                            {entry.request.type === 'cover' ? '正在生成封面' : entry.request.type === 'image' ? '正在生成图片' : entry.request.type === 'audio' ? '正在生成音频' : '正在生成视频'}
                        </div>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-surface-tertiary">
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

            {isRunning && entry.assets.length === 0 && entry.request.type !== 'audio' && (
                <div className={clsx('grid gap-4', mediaGridClass)}>
                    {Array.from({ length: placeholderCount }).map((_, index) => (
                        <div
                            key={`${entry.id}-placeholder-${index}`}
                            className={clsx(
                                'relative overflow-hidden rounded-[16px] border border-border bg-surface-secondary',
                                mediaHeightClass,
                            )}
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
    const [contextIntent, setContextIntent] = useState<GenerationIntent | null>(null);
    const [studioMode, setStudioMode] = useState<StudioMode>('image');
    const [generationSurface, setGenerationSurface] = useState<GenerationSurface>('manual');
    const [, setBindTarget] = useState('');
    const [feedEntries, setFeedEntries] = useState<FeedEntry[]>(() => readPersistedFeedEntries());
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
    const [imageQuality, setImageQuality] = useState('medium');
    const [imageResolution, setImageResolution] = useState('auto');
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
    const [coverTemplateImage, setCoverTemplateImage] = useState<ReferenceItem | null>(null);
    const [coverBaseImage, setCoverBaseImage] = useState<ReferenceItem | null>(null);
    const [coverPromptSwitches, setCoverPromptSwitches] = useState<CoverPromptSwitches>(DEFAULT_COVER_PROMPT_SWITCHES);
    const [isReadingCoverRefs, setIsReadingCoverRefs] = useState(false);
    const [coverError, setCoverError] = useState('');
    const trackedJobs = useMediaJobsStore(
        useCallback((state) => Object.values(state.jobsById), []),
        shallowArrayEqual,
    );
    const isAgentMode = generationSurface === 'agent';
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
        () => contextIntent?.sourceTitle ? `Agent 模式 · ${contextIntent.sourceTitle}` : 'Agent 模式',
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
    const isDigitalHumanMode = studioMode === 'digital-human';
    const generationJobBootstrapFilter = useMemo(() => ({ limit: 100 }), []);
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

    useMediaJobSubscription(trackedJobIds, {
        enabled: isActive,
        bootstrapFilter: generationJobBootstrapFilter,
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
            setImageQuality((prev) => (overwriteDraftDefaults || !prev.trim() ? normalizeImageQuality(normalizedSettings.image_quality) : prev));
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

    useEffect(() => {
        void loadContext(false);
    }, [isActive, loadContext]);

    useEffect(() => {
        if (!isActive) return;
        const handleSettingsUpdated = () => {
            void loadContext(false);
        };
        window.ipcRenderer.on('settings:updated', handleSettingsUpdated);
        return () => {
            window.ipcRenderer.off('settings:updated', handleSettingsUpdated);
        };
    }, [isActive, loadContext]);

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
                setAgentSessionError(error instanceof Error ? error.message : 'Agent 模式会话初始化失败');
            } finally {
                if (requestId === agentSessionRequestIdRef.current) {
                    setIsAgentSessionLoading(false);
                }
            }
        })();
    }, [ensureAgentFeedEntry, generationAgentContextId, generationAgentInitialContext, generationAgentSessionMetadata, generationAgentTitle, isAgentMode, isDigitalHumanMode]);

    useEffect(() => {
        updateFeedEntries((prev) => {
            return mergeMediaJobsIntoFeedEntries(prev, trackedJobs, deletedFeedStateRef.current);
        });
    }, [trackedJobs, updateFeedEntries]);

    useEffect(() => {
        if (!isActive) return;
        let cancelled = false;

        void (async () => {
            try {
                const result = await window.ipcRenderer.generation.listJobs({ limit: 100 }) as { items?: unknown[] };
                if (cancelled || !Array.isArray(result?.items)) return;
                const jobs = result.items
                    .map(normalizeMediaJobProjection)
                    .filter((item): item is MediaJobProjection => Boolean(item));
                updateFeedEntries((prev) => mergeMediaJobsIntoFeedEntries(prev, jobs, deletedFeedStateRef.current));
            } catch (error) {
                console.error('Failed to bootstrap generation jobs:', error);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [isActive, updateFeedEntries]);

    useEffect(() => {
        if (!previewAsset) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setPreviewAsset(null);
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [previewAsset]);

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
            quality: imageQuality,
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
        imageQuality,
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
            templateImage: coverTemplateImage,
            baseImage: coverBaseImage,
            promptSwitches: coverPromptSwitches,
        }));
        if (!accepted) return;
        setCoverPrompt('');
    }, [
        coverBaseImage,
        coverCount,
        coverModel,
        coverProjectId,
        coverPrompt,
        coverPromptSwitches,
        coverQuality,
        coverTemplateImage,
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
            setCoverTemplateImage(entry.request.templateImage);
            setCoverBaseImage(entry.request.baseImage);
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
            setImageQuality(entry.request.quality);
            setImageResolution(entry.request.resolution);
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

    const handleImageReferenceFiles = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || []);
        if (!files.length) return;
        setIsReadingImageRefs(true);
        try {
            const nextItems = await Promise.all(files.slice(0, 4).map(async (file) => ({
                name: file.name,
                dataUrl: await readFileAsDataUrl(file),
            })));
            setImageReferences((prev) => [...prev, ...nextItems].slice(0, 4));
        } catch (error) {
            console.error('Failed to read image references:', error);
            setImageError('参考图读取失败，请重试');
        } finally {
            setIsReadingImageRefs(false);
            event.target.value = '';
        }
    }, []);

    const handleCoverReferenceFile = useCallback(async (
        event: React.ChangeEvent<HTMLInputElement>,
        target: 'template' | 'base',
    ) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setIsReadingCoverRefs(true);
        try {
            const item = {
                name: file.name,
                dataUrl: await readFileAsDataUrl(file),
            };
            if (target === 'template') {
                setCoverTemplateImage(item);
            } else {
                setCoverBaseImage(item);
            }
            setCoverError('');
        } catch (error) {
            console.error('Failed to read cover reference:', error);
            setCoverError('封面素材读取失败，请重试');
        } finally {
            setIsReadingCoverRefs(false);
            event.target.value = '';
        }
    }, []);

    const handleVideoReferenceFile = useCallback(async (
        event: React.ChangeEvent<HTMLInputElement>,
        target: number | 'first' | 'last' | 'firstClip' | 'drivingAudio',
    ) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setIsReadingVideoRefs(true);
        try {
            const item = {
                name: file.name,
                dataUrl: await readFileAsDataUrl(file),
            };
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
            event.target.value = '';
        }
    }, [videoMode]);

    const handleVideoReferenceFiles = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || []);
        if (!files.length) return;
        setIsReadingVideoRefs(true);
        try {
            const nextItems = await Promise.all(files.slice(0, 5).map(async (file) => ({
                name: file.name,
                dataUrl: await readFileAsDataUrl(file),
            })));
            setVideoReferences((prev) => [...prev.filter(Boolean), ...nextItems].slice(0, 5));
            if (videoMode === 'text-to-video' && nextItems.length > 0) {
                setVideoMode('reference-guided');
            }
        } catch (error) {
            console.error('Failed to read video references:', error);
            setVideoError('参考素材读取失败，请重试');
        } finally {
            setIsReadingVideoRefs(false);
            event.target.value = '';
        }
    }, [videoMode]);

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
                templateImage: coverTemplateImage,
                baseImage: coverBaseImage,
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
            quality: imageQuality,
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
        coverBaseImage,
        coverCount,
        coverModel,
        coverProjectId,
        coverPrompt,
        coverPromptSwitches,
        coverQuality,
        coverTemplateImage,
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
        imageQuality,
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
        : studioMode === 'cover' || (studioMode === 'video' && videoMode === 'first-last-frame')
        ? 'grid items-start gap-4 md:grid-cols-[196px_minmax(0,1fr)]'
        : 'grid items-start gap-4 md:grid-cols-[104px_minmax(0,1fr)]';
    const composerWidthClass = 'mx-auto w-full max-w-[900px]';
    const canSendAgentMessage = isAgentMode
        && !isDigitalHumanMode
        && Boolean(agentSessionId)
        && !isAgentSessionLoading
        && !agentExecutionActive
        && (currentAgentRequest.prompt.trim().length > 0 || Boolean(agentAttachment));
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
                const result = await window.ipcRenderer.generation.listJobs({ limit: 100 }) as { items?: unknown[] };
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
    }, [agentSessionId, feedEntries, updateFeedEntries]);
    const handlePickAgentAttachment = useCallback(async () => {
        if (!agentSessionId || isAgentSessionLoading || agentExecutionActive) return;
        try {
            const result = await window.ipcRenderer.chat.pickAttachment({
                sessionId: agentSessionId,
            }) as { success?: boolean; canceled?: boolean; error?: string; attachment?: UploadedFileAttachment };
            if (!result?.success) {
                throw new Error(result?.error || '上传附件失败');
            }
            if (result.canceled || !result.attachment) return;
            setAgentAttachment(result.attachment);
            if (studioMode === 'cover') {
                setCoverError('');
            } else {
                setImageError('');
            }
        } catch (error) {
            console.error('Failed to pick generation agent attachment:', error);
            if (studioMode === 'cover') {
                setCoverError(error instanceof Error ? error.message : '上传附件失败');
            } else {
                setImageError(error instanceof Error ? error.message : '上传附件失败');
            }
        }
    }, [agentExecutionActive, agentSessionId, isAgentSessionLoading, studioMode]);
    const handleSendAgentMessage = useCallback(async () => {
        const content = currentAgentRequest.prompt.trim();
        if ((!content && !agentAttachment) || !agentSessionId || isAgentSessionLoading || agentExecutionActive) return;
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

        if (currentAgentRequest.type === 'image' && agentAttachment && attachmentVisualKind(agentAttachment) === 'image') {
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
                setImageError(error instanceof Error ? error.message : '参考图附件创建失败');
                return;
            }
        } else if (agentAttachment) {
            attachments.push(agentAttachment);
            if (currentAgentRequest.type === 'image' && currentAgentRequest.referenceItems.length > 0) {
                attachmentContextNotes.push(`当前轮次还存在 ${currentAgentRequest.referenceItems.length} 张创作参考图未随消息附带；如需让 AI 读取这些图，请移除当前文件附件，或把参考图直接通过左侧图片区发送。`);
            }
            if (currentAgentRequest.type === 'cover' && (currentAgentRequest.templateImage || currentAgentRequest.baseImage)) {
                attachmentContextNotes.push('当前轮次还存在封面参考图或底图未随消息附带；如需让 AI 读取这些图，请移除当前文件附件。');
            }
        } else if (currentAgentRequest.type === 'image' && currentAgentRequest.referenceItems.length > 0) {
            try {
                const contactSheet = await buildReferenceContactSheet(currentAgentRequest.referenceItems);
                attachments.push(await createInlineAttachment({ name: contactSheet.fileName, dataUrl: contactSheet.dataUrl }, contactSheet.fileName));
                attachmentContextNotes.push(contactSheet.note);
            } catch (error) {
                console.error('Failed to create inline agent attachment:', error);
                setImageError(error instanceof Error ? error.message : '参考图附件创建失败');
                return;
            }
        }
        if (currentAgentRequest.type === 'cover' && !agentAttachment) {
            const coverRefs = [currentAgentRequest.templateImage, currentAgentRequest.baseImage].filter(Boolean) as ReferenceItem[];
            if (coverRefs.length > 0) {
                try {
                    const contactSheet = await buildReferenceContactSheet(coverRefs);
                    const roleNotes = [
                        currentAgentRequest.templateImage ? '参考封面' : '',
                        currentAgentRequest.baseImage ? '底图' : '',
                    ].filter(Boolean).map((role, index) => `第 ${index + 1} 张是${role}`);
                    attachments.push(await createInlineAttachment({ name: contactSheet.fileName, dataUrl: contactSheet.dataUrl }, contactSheet.fileName));
                    attachmentContextNotes.push(`封面素材：${contactSheet.note}。${roleNotes.join('，')}。`);
                } catch (error) {
                    console.error('Failed to prepare generation agent cover attachments:', error);
                    setCoverError(error instanceof Error ? error.message : '封面素材附件创建失败');
                    return;
                }
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
        ensureAgentFeedEntry(agentSessionId, Date.now(), { bump: true, reviveDeleted: true });
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
        setAgentPendingMessage({
            content: messageContent,
            displayContent: content || (attachments[0] ? `请处理这个附件：${attachments[0].name}` : undefined),
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
            <button
                type="button"
                onClick={() => setStudioMode('digital-human')}
                className={clsx(
                    'inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-4 py-1.5 text-[14px] font-medium',
                    studioMode === 'digital-human'
                        ? 'border-brand-red/50 bg-brand-red text-white'
                        : 'border-border bg-surface-primary text-text-secondary',
                )}
            >
                <UserRound className="h-4 w-4" />
                数字人
            </button>
            {!isDigitalHumanMode && (
            <button
                type="button"
                role="switch"
                aria-checked={isAgentMode}
                aria-label="Agent 模式"
                onClick={() => setGenerationSurface((prev) => prev === 'agent' ? 'manual' : 'agent')}
                className="inline-flex shrink-0 items-center gap-3 whitespace-nowrap rounded-full px-1 py-1 text-[14px] font-medium text-text-secondary transition-colors"
            >
                <span className="inline-flex items-center gap-2">
                    <Sparkles className={clsx('h-4 w-4 transition-colors', isAgentMode ? 'text-brand-red' : 'text-text-tertiary')} />
                    <span>Agent 模式</span>
                </span>
                <span
                    className={clsx(
                        'relative inline-flex h-7 w-12 shrink-0 rounded-full border transition-colors duration-200',
                        isAgentMode
                            ? 'border-brand-red/40 bg-brand-red'
                            : 'border-border bg-surface-tertiary',
                    )}
                >
                    <span
                        className={clsx(
                            'absolute top-0.5 h-6 w-6 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.22)] transition-transform duration-200',
                            isAgentMode ? 'translate-x-[22px]' : 'translate-x-0.5',
                        )}
                    />
                </span>
            </button>
            )}
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
                    {feedEntries.length === 0 ? (
                        <div className="min-h-[280px]" />
                    ) : (
                        <div className="mx-auto max-w-[860px] space-y-7 pb-10">
                            {feedEntries.map((entry) => (
                                isGenerationFeedEntry(entry) ? (
                                    <FeedEntryMessage
                                        key={entry.id}
                                        entry={entry}
                                        isActive={isActive}
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
                                                    onClear={() => setImageReferences([])}
                                                />
                                            ) : studioMode === 'cover' ? (
                                                <div className="grid grid-cols-2 gap-3">
                                                    <UploadPreviewCard
                                                        label={isReadingCoverRefs ? '读取中' : '参考'}
                                                        accept="image/*"
                                                        items={coverTemplateImage ? [coverTemplateImage] : []}
                                                        onChange={(event) => void handleCoverReferenceFile(event, 'template')}
                                                        onClear={() => setCoverTemplateImage(null)}
                                                    />
                                                    <UploadPreviewCard
                                                        label={isReadingCoverRefs ? '读取中' : '底图'}
                                                        accept="image/*"
                                                        items={coverBaseImage ? [coverBaseImage] : []}
                                                        onChange={(event) => void handleCoverReferenceFile(event, 'base')}
                                                        onClear={() => setCoverBaseImage(null)}
                                                    />
                                                </div>
                                            ) : videoMode === 'first-last-frame' ? (
                                                <div className="grid grid-cols-2 gap-3">
                                                    <UploadPreviewCard
                                                        label={isReadingVideoRefs ? '读取中' : '首帧'}
                                                        accept="image/*"
                                                        items={videoFirstFrame ? [videoFirstFrame] : []}
                                                        onChange={(event) => void handleVideoReferenceFile(event, 'first')}
                                                        onClear={() => setVideoFirstFrame(null)}
                                                    />
                                                    <UploadPreviewCard
                                                        label={isReadingVideoRefs ? '读取中' : '尾帧'}
                                                        accept="image/*"
                                                        items={videoLastFrame ? [videoLastFrame] : []}
                                                        onChange={(event) => void handleVideoReferenceFile(event, 'last')}
                                                        onClear={() => setVideoLastFrame(null)}
                                                    />
                                                </div>
                                            ) : videoMode === 'continuation' ? (
                                                <UploadPreviewCard
                                                    label={isReadingVideoRefs ? '读取中' : '视频'}
                                                    accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                                                    items={videoFirstClip ? [videoFirstClip] : []}
                                                    onChange={(event) => void handleVideoReferenceFile(event, 'firstClip')}
                                                    onClear={() => setVideoFirstClip(null)}
                                                />
                                            ) : (
                                                <UploadPreviewCard
                                                    label={isReadingVideoRefs ? '读取中' : '图片'}
                                                    accept="image/*"
                                                    multiple
                                                    items={uploadedVideoRefs}
                                                    onChange={handleVideoReferenceFiles}
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
                                                placeholder={studioMode === 'image' ? '描述您想生成的场景、风格、细节...' : studioMode === 'cover' ? '输入封面标题，或直接描述想要的点击感...' : studioMode === 'digital-human' ? '输入角色要说的口播文案...' : '描述您想生成的视频场景、镜头、动作...'}
                                                className="min-h-[112px] max-h-[240px] w-full resize-y overflow-y-auto bg-transparent text-[14px] leading-6 text-text-primary outline-none placeholder:text-text-tertiary"
                                            />
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
                                                    {isAgentMode && (
                                                        <button
                                                            type="button"
                                                            onClick={() => void handlePickAgentAttachment()}
                                                            disabled={!agentSessionId || isAgentSessionLoading || agentExecutionActive}
                                                            className="inline-flex h-10 items-center gap-1.5 rounded-[10px] border border-border bg-surface-secondary px-3 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-tertiary disabled:opacity-45"
                                                        >
                                                            <Paperclip className="h-3.5 w-3.5" />
                                                            附件
                                                        </button>
                                                    )}
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
                                                    {!isAgentMode && (
                                                        <>
                                                            <ImageAspectRatioPicker
                                                                value={imageAspectRatio}
                                                                onChange={setImageAspectRatio}
                                                            />
                                                            <PopoverSelect
                                                                value={imageResolution}
                                                                onChange={setImageResolution}
                                                                options={IMAGE_RESOLUTION_OPTIONS}
                                                                className="min-w-[82px]"
                                                                title="分辨率"
                                                                panelClassName="w-[220px]"
                                                            />
                                                            <PopoverSelect
                                                                value={imageQuality}
                                                                onChange={setImageQuality}
                                                                options={IMAGE_QUALITY_OPTIONS}
                                                                className="min-w-[86px]"
                                                                title="质量"
                                                                panelClassName="w-[220px]"
                                                            />
                                                        </>
                                                    )}
                                                    <PopoverSelect
                                                        value={String(imageCount)}
                                                        onChange={(value) => setImageCount(Number(value) || 1)}
                                                        options={IMAGE_COUNT_OPTIONS}
                                                        className="min-w-[78px]"
                                                        title="生成数量"
                                                        panelClassName="w-[220px]"
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={isAgentMode ? handleSendAgentMessage : handleGenerateImage}
                                                        disabled={isAgentMode ? !canSendAgentMessage : (!hasImageConfig || !imageModel.trim())}
                                                        className="ml-auto flex h-11 w-11 items-center justify-center rounded-full bg-brand-red text-white shadow-[var(--ui-shadow-1)] hover:bg-brand-red/90 disabled:opacity-45"
                                                    >
                                                        {isAgentMode ? (
                                                            agentExecutionActive ? (
                                                                <Loader2 className="h-5 w-5 animate-spin" />
                                                            ) : (
                                                                <ArrowUp className="h-5 w-5" />
                                                            )
                                                        ) : (
                                                            <Sparkles className="h-5 w-5" />
                                                        )}
                                                    </button>
                                                </>
                                            ) : studioMode === 'cover' ? (
                                                <>
                                                    {isAgentMode && (
                                                        <button
                                                            type="button"
                                                            onClick={() => void handlePickAgentAttachment()}
                                                            disabled={!agentSessionId || isAgentSessionLoading || agentExecutionActive}
                                                            className="inline-flex h-10 items-center gap-1.5 rounded-[10px] border border-border bg-surface-secondary px-3 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-tertiary disabled:opacity-45"
                                                        >
                                                            <Paperclip className="h-3.5 w-3.5" />
                                                            附件
                                                        </button>
                                                    )}
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
                                                    <button
                                                        type="button"
                                                        onClick={isAgentMode ? handleSendAgentMessage : handleGenerateCover}
                                                        disabled={isAgentMode ? !canSendAgentMessage : (!hasImageConfig || !coverModel.trim())}
                                                        className="ml-auto flex h-11 w-11 items-center justify-center rounded-full bg-brand-red text-white shadow-[var(--ui-shadow-1)] hover:bg-brand-red/90 disabled:opacity-45"
                                                        title="生成封面"
                                                        aria-label="生成封面"
                                                    >
                                                        {isAgentMode ? (
                                                            agentExecutionActive ? (
                                                                <Loader2 className="h-5 w-5 animate-spin" />
                                                            ) : (
                                                                <ArrowUp className="h-5 w-5" />
                                                            )
                                                        ) : (
                                                            <Sparkles className="h-5 w-5" />
                                                        )}
                                                    </button>
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
                                                    <button
                                                        type="button"
                                                        onClick={isAgentMode ? handleSendAgentMessage : handleGenerateAudio}
                                                        disabled={isAgentMode ? !canSendAgentMessage : (!hasVoiceConfig || !audioVoiceId.trim())}
                                                        className="ml-auto flex h-11 w-11 items-center justify-center rounded-full bg-brand-red text-white shadow-[var(--ui-shadow-1)] hover:bg-brand-red/90 disabled:opacity-45"
                                                        title="生成音频"
                                                        aria-label="生成音频"
                                                    >
                                                        {isAgentMode ? (
                                                            agentExecutionActive ? (
                                                                <Loader2 className="h-5 w-5 animate-spin" />
                                                            ) : (
                                                                <ArrowUp className="h-5 w-5" />
                                                            )
                                                        ) : (
                                                            <Sparkles className="h-5 w-5" />
                                                        )}
                                                    </button>
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
                                                    <button
                                                        type="button"
                                                        onClick={handleGenerateDigitalHuman}
                                                        disabled={!digitalHumanPrompt.trim() || !selectedDigitalHumanReadiness.ok}
                                                        className="ml-auto flex h-11 w-11 items-center justify-center rounded-full bg-brand-red text-white shadow-[var(--ui-shadow-1)] hover:bg-brand-red/90 disabled:opacity-45"
                                                        title="生成数字人"
                                                        aria-label="生成数字人"
                                                    >
                                                        <Sparkles className="h-5 w-5" />
                                                    </button>
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
                                                    <button
                                                        type="button"
                                                        onClick={isAgentMode ? handleSendAgentMessage : handleGenerateVideo}
                                                        disabled={isAgentMode ? !canSendAgentMessage : !hasVideoConfig}
                                                        className="ml-auto flex h-11 w-11 items-center justify-center rounded-full bg-brand-red text-white shadow-[var(--ui-shadow-1)] hover:bg-brand-red/90 disabled:opacity-45"
                                                    >
                                                        {isAgentMode ? (
                                                            agentExecutionActive ? (
                                                                <Loader2 className="h-5 w-5 animate-spin" />
                                                            ) : (
                                                                <ArrowUp className="h-5 w-5" />
                                                            )
                                                        ) : (
                                                            <Sparkles className="h-5 w-5" />
                                                        )}
                                                    </button>
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
