import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { PlayerRef } from '@remotion/player';
import {
    CheckCircle2,
    Clapperboard,
    Download,
    Film,
    MessageSquare,
    RefreshCw,
    Sparkles,
    Upload,
} from 'lucide-react';
import { resolveAssetUrl } from '../../utils/pathManager';
import { subscribeRuntimeEventStream } from '../../runtime/runtimeEventStream';
import { RemotionVideoPreview } from './remotion/RemotionVideoPreview';
import { RemotionTransportBar } from './remotion/RemotionTransportBar';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import type { RemotionCompositionConfig } from './remotion/types';

const ChatWorkspace = lazy(async () => ({
    default: (await import('../../pages/Chat')).Chat,
}));

type MediaAssetLike = {
    id: string;
    title?: string;
    relativePath?: string;
    absolutePath?: string;
    previewUrl?: string;
    mimeType?: string;
};

type ScriptApprovalLike = {
    status?: 'pending' | 'confirmed';
    lastScriptUpdateAt?: number | null;
    lastScriptUpdateSource?: string | null;
    confirmedAt?: number | null;
};

type VideoProjectLike = {
    scriptBody?: string;
    scriptApproval?: ScriptApprovalLike;
    assets?: Array<Record<string, unknown>>;
    baseMedia?: {
        sourceAssetIds?: string[];
        outputPath?: string | null;
        durationMs?: number;
        width?: number | null;
        height?: number | null;
        status?: string;
        updatedAt?: number | null;
    };
    ffmpegRecipeSummary?: string | null;
    remotion?: RemotionCompositionConfig | null;
    renderOutput?: string | null;
    legacy?: Record<string, unknown>;
};

type PackageStateLike = Record<string, unknown> & {
    videoProject?: VideoProjectLike | null;
    remotion?: RemotionCompositionConfig | null;
};

type ExperimentalVideoWorkbenchProps = {
    title: string;
    editorFile: string;
    packageState?: PackageStateLike | null;
    packagePreviewAssets: MediaAssetLike[];
    primaryVideoAsset?: MediaAssetLike | null;
    packageAssets?: Array<Record<string, unknown>>;
    timelineClipCount?: number;
    timelineTrackNames?: string[];
    timelineClips?: Array<Record<string, unknown>>;
    editorBody: string;
    editorBodyDirty: boolean;
    isSavingEditorBody: boolean;
    materialsCollapsed?: boolean;
    timelineCollapsed?: boolean;
    isActive?: boolean;
    editorChatSessionId: string | null;
    remotionComposition?: RemotionCompositionConfig | null;
    remotionRenderPath?: string | null;
    isGeneratingRemotion?: boolean;
    isRenderingRemotion?: boolean;
    onEditorBodyChange: (value: string) => void;
    onOpenBindAssets: () => void;
    onPackageStateChange: (state: PackageStateLike) => void;
    onConfirmScript?: () => void;
    onGenerateRemotionScene?: (instructions?: string) => void;
    onSaveRemotionScene?: (scene: RemotionCompositionConfig) => void;
    onRenderRemotionVideo: () => void;
    onOpenRenderedVideo?: () => void;
};

type CenterTab = 'preview' | 'script' | 'remotion';

function inferAssetKind(asset: MediaAssetLike | null | undefined): 'video' | 'image' | 'audio' | 'unknown' {
    const mimeType = String(asset?.mimeType || '').trim().toLowerCase();
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'unknown';
}

function parseToolState(raw: unknown): PackageStateLike | null {
    const text = String(raw || '').trim();
    if (!text) return null;
    try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const nextState = parsed?.state;
        return nextState && typeof nextState === 'object' ? (nextState as PackageStateLike) : null;
    } catch {
        return null;
    }
}

function statusLabel(scriptApproval?: ScriptApprovalLike | null) {
    return scriptApproval?.status === 'confirmed' ? '脚本已确认' : '脚本待确认';
}

function formatDuration(durationMs?: number) {
    if (!durationMs || durationMs <= 0) return '未知时长';
    const totalSeconds = Math.round(durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function inferSceneAssetKind(
    composition: RemotionCompositionConfig | null | undefined,
): 'video' | 'image' | 'audio' | 'unknown' {
    const firstScene = composition?.scenes?.[0];
    const kind = String(firstScene?.assetKind || '').trim().toLowerCase();
    if (kind === 'video' || kind === 'image' || kind === 'audio') return kind;
    const src = String(firstScene?.src || '').trim().toLowerCase();
    if (/\.(mp4|mov|m4v|webm|mkv)(?:[?#].*)?$/.test(src)) return 'video';
    if (/\.(png|jpe?g|webp|gif|bmp|svg|avif)(?:[?#].*)?$/.test(src)) return 'image';
    if (/\.(mp3|wav|m4a|aac|ogg|flac)(?:[?#].*)?$/.test(src)) return 'audio';
    return 'unknown';
}

function hasLayeredMotion(composition: RemotionCompositionConfig | null | undefined) {
    if (!composition) return false;
    if ((composition.transitions?.length || 0) > 0) return true;
    return composition.scenes.some((scene) => (
        Boolean(String(scene.overlayBody || '').trim())
        || (scene.overlays?.length || 0) > 0
        || (scene.entities?.length || 0) > 0
    ));
}

function shouldAutoExpandDuration(
    composition: RemotionCompositionConfig | null | undefined,
    naturalDurationInFrames: number,
) {
    if (!composition || naturalDurationInFrames <= 0) return false;
    if (hasLayeredMotion(composition)) return false;
    if (!Array.isArray(composition.scenes) || composition.scenes.length !== 1) return false;
    const onlyScene = composition.scenes[0];
    const currentDuration = Number(composition.durationInFrames || 0);
    const sceneDuration = Number(onlyScene?.durationInFrames || 0);
    const usesDefaultStub = currentDuration <= 90 && sceneDuration <= 90;
    return usesDefaultStub && naturalDurationInFrames > currentDuration;
}

function formatCanvasSize(width: number, height: number) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return '未识别尺寸';
    }
    return `${Math.round(width)}×${Math.round(height)}`;
}

export function ExperimentalVideoWorkbench({
    title,
    editorFile,
    packageState,
    packagePreviewAssets,
    primaryVideoAsset,
    editorBody,
    editorBodyDirty,
    isSavingEditorBody,
    isActive = true,
    editorChatSessionId,
    remotionComposition,
    remotionRenderPath,
    isGeneratingRemotion = false,
    isRenderingRemotion = false,
    onEditorBodyChange,
    onOpenBindAssets,
    onPackageStateChange,
    onConfirmScript,
    onGenerateRemotionScene,
    onSaveRemotionScene,
    onRenderRemotionVideo,
    onOpenRenderedVideo,
}: ExperimentalVideoWorkbenchProps) {
    const [activeTab, setActiveTab] = useState<CenterTab>('preview');
    const [previewCurrentFrame, setPreviewCurrentFrame] = useState(0);
    const [previewPlaying, setPreviewPlaying] = useState(false);
    const [previewMediaMetrics, setPreviewMediaMetrics] = useState<{
        width: number;
        height: number;
        durationSeconds: number;
    } | null>(null);
    const remotionPlayerRef = useRef<PlayerRef | null>(null);
    const rawVideoRef = useRef<HTMLVideoElement | null>(null);
    const lastAutoSizedCompositionKeyRef = useRef<string>('');
    const videoProject = packageState?.videoProject || null;
    const scriptApproval = videoProject?.scriptApproval || null;
    const scriptConfirmed = scriptApproval?.status === 'confirmed';
    const baseMediaOutputPath = String(videoProject?.baseMedia?.outputPath || '').trim();
    const baseMediaUrl = resolveAssetUrl(baseMediaOutputPath);
    const renderOutputPath = String(videoProject?.renderOutput || remotionRenderPath || '').trim();
    const renderOutputUrl = resolveAssetUrl(renderOutputPath);
    const composition = (videoProject?.remotion || remotionComposition || null) as RemotionCompositionConfig | null;
    const hasCompositionPreview = Boolean(composition && Array.isArray(composition.scenes) && composition.scenes.length > 0);
    const compositionHasMotion = useMemo(() => hasLayeredMotion(composition), [composition]);
    const primaryAssetUrl = resolveAssetUrl(
        primaryVideoAsset?.absolutePath
        || primaryVideoAsset?.previewUrl
        || primaryVideoAsset?.relativePath
        || '',
    );
    const compositionSceneUrl = resolveAssetUrl(String(composition?.scenes?.[0]?.src || '').trim());
    const displayPreviewUrl = baseMediaUrl || primaryAssetUrl || compositionSceneUrl;
    const previewAssetKind = inferAssetKind(primaryVideoAsset);
    const compositionAssetKind = inferSceneAssetKind(composition);
    const displayAssetKind = previewAssetKind !== 'unknown' ? previewAssetKind : compositionAssetKind;
    const naturalDurationInFrames = Math.max(
        1,
        Math.round(((previewMediaMetrics?.durationSeconds || 0) * (composition?.fps || 30))),
    );
    const effectiveComposition = useMemo(() => {
        if (!composition) return null;
        if (!previewMediaMetrics?.width || !previewMediaMetrics?.height) return composition;
        const nextWidth = compositionHasMotion ? composition.width : previewMediaMetrics.width;
        const nextHeight = compositionHasMotion ? composition.height : previewMediaMetrics.height;
        const nextDurationInFrames = shouldAutoExpandDuration(composition, naturalDurationInFrames)
            ? naturalDurationInFrames
            : composition.durationInFrames;
        const nextBaseDurationMs = shouldAutoExpandDuration(composition, naturalDurationInFrames)
            ? Math.round((naturalDurationInFrames / (composition.fps || 30)) * 1000)
            : composition.baseMedia?.durationMs;
        const onlyScene = composition.scenes[0];
        const nextScenes = shouldAutoExpandDuration(composition, naturalDurationInFrames) && onlyScene
            ? [{
                ...onlyScene,
                durationInFrames: naturalDurationInFrames,
            }]
            : composition.scenes;
        const unchanged = composition.width === nextWidth
            && composition.height === nextHeight
            && composition.durationInFrames === nextDurationInFrames
            && (composition.baseMedia?.durationMs || 0) === (nextBaseDurationMs || 0)
            && (composition.baseMedia?.width || 0) === (previewMediaMetrics.width || 0)
            && (composition.baseMedia?.height || 0) === (previewMediaMetrics.height || 0)
            && nextScenes === composition.scenes;
        if (unchanged) {
            return composition;
        }
        return {
            ...composition,
            width: nextWidth,
            height: nextHeight,
            durationInFrames: nextDurationInFrames,
            scenes: nextScenes,
            baseMedia: {
                ...(composition.baseMedia || {}),
                durationMs: nextBaseDurationMs,
                width: previewMediaMetrics.width,
                height: previewMediaMetrics.height,
            },
        };
    }, [composition, compositionHasMotion, naturalDurationInFrames, previewMediaMetrics]);
    const previewFps = effectiveComposition?.fps || composition?.fps || 30;
    const previewDurationInFrames = Math.max(
        1,
        effectiveComposition?.durationInFrames
            || composition?.durationInFrames
            || Math.round(((previewMediaMetrics?.durationSeconds || (videoProject?.baseMedia?.durationMs || 0) / 1000 || 3) * previewFps)),
    );
    const previewStageWidth = effectiveComposition?.width || composition?.width || previewMediaMetrics?.width || 1080;
    const previewStageHeight = effectiveComposition?.height || composition?.height || previewMediaMetrics?.height || 1920;
    const previewStageIsLandscape = previewStageWidth >= previewStageHeight;
    const showPreviewTransport = hasCompositionPreview || displayAssetKind === 'video';
    const sourceAssetIds = videoProject?.baseMedia?.sourceAssetIds || [];
    const leftAssets = useMemo(() => {
        return packagePreviewAssets.slice(0, 24);
    }, [packagePreviewAssets]);

    useEffect(() => {
        if (!displayPreviewUrl || (displayAssetKind !== 'video' && displayAssetKind !== 'image')) {
            setPreviewMediaMetrics(null);
            return;
        }
        let cancelled = false;
        if (displayAssetKind === 'image') {
            const image = new window.Image();
            image.onload = () => {
                if (cancelled) return;
                setPreviewMediaMetrics({
                    width: Number(image.naturalWidth) || 0,
                    height: Number(image.naturalHeight) || 0,
                    durationSeconds: 0,
                });
            };
            image.onerror = () => {
                if (!cancelled) setPreviewMediaMetrics(null);
            };
            image.src = displayPreviewUrl;
            return () => {
                cancelled = true;
            };
        }
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;
        const handleLoadedMetadata = () => {
            if (cancelled) return;
            setPreviewMediaMetrics({
                width: Number(video.videoWidth) || 0,
                height: Number(video.videoHeight) || 0,
                durationSeconds: Number(video.duration) || 0,
            });
        };
        const handleError = () => {
            if (!cancelled) setPreviewMediaMetrics(null);
        };
        video.addEventListener('loadedmetadata', handleLoadedMetadata);
        video.addEventListener('error', handleError);
        video.src = displayPreviewUrl;
        video.load();
        return () => {
            cancelled = true;
            video.removeEventListener('loadedmetadata', handleLoadedMetadata);
            video.removeEventListener('error', handleError);
            video.pause();
            video.removeAttribute('src');
            video.load();
        };
    }, [displayAssetKind, displayPreviewUrl]);

    useEffect(() => {
        if (!onSaveRemotionScene || !composition || !previewMediaMetrics?.width || !previewMediaMetrics?.height) return;
        const needsCanvasResize = composition.width === 1080
            && composition.height === 1920
            && !(composition.width === previewMediaMetrics.width && composition.height === previewMediaMetrics.height);
        const needsDurationResize = shouldAutoExpandDuration(composition, naturalDurationInFrames);
        const needsBaseMediaSizing = (composition.baseMedia?.width || 0) !== previewMediaMetrics.width
            || (composition.baseMedia?.height || 0) !== previewMediaMetrics.height;
        if (compositionHasMotion && !needsBaseMediaSizing) return;
        if (!needsCanvasResize && !needsDurationResize && !needsBaseMediaSizing) return;
        const nextKey = `${editorFile}:${previewMediaMetrics.width}x${previewMediaMetrics.height}:${naturalDurationInFrames}`;
        if (lastAutoSizedCompositionKeyRef.current === nextKey) return;
        lastAutoSizedCompositionKeyRef.current = nextKey;
        onSaveRemotionScene({
            ...composition,
            width: !compositionHasMotion && needsCanvasResize ? previewMediaMetrics.width : composition.width,
            height: !compositionHasMotion && needsCanvasResize ? previewMediaMetrics.height : composition.height,
            durationInFrames: needsDurationResize ? naturalDurationInFrames : composition.durationInFrames,
            scenes: needsDurationResize && composition.scenes[0]
                ? [{
                    ...composition.scenes[0],
                    durationInFrames: naturalDurationInFrames,
                }]
                : composition.scenes,
            baseMedia: {
                ...(composition.baseMedia || {}),
                durationMs: needsDurationResize
                    ? Math.round((naturalDurationInFrames / (composition.fps || 30)) * 1000)
                    : composition.baseMedia?.durationMs,
                width: previewMediaMetrics.width,
                height: previewMediaMetrics.height,
            },
        });
    }, [composition, compositionHasMotion, editorFile, naturalDurationInFrames, onSaveRemotionScene, previewMediaMetrics]);

    useEffect(() => {
        if (!isActive || !editorChatSessionId) return;
        return subscribeRuntimeEventStream({
            getActiveSessionId: () => editorChatSessionId,
            onToolResult: ({ name, output }) => {
                if (name !== 'redbox_editor' || !output?.success) return;
                const nextState = parseToolState(output.content);
                if (nextState) {
                    onPackageStateChange(nextState);
                }
            },
        });
    }, [editorChatSessionId, isActive, onPackageStateChange]);

    useEffect(() => {
        if (!hasCompositionPreview || (activeTab !== 'preview' && activeTab !== 'remotion')) return;
        const player = remotionPlayerRef.current;
        if (!player) return;
        const handleFrameUpdate = ({ detail }: { detail: { frame: number } }) => {
            setPreviewCurrentFrame(detail.frame);
        };
        const handleSeeked = ({ detail }: { detail: { frame: number } }) => {
            setPreviewCurrentFrame(detail.frame);
        };
        const handlePlay = () => setPreviewPlaying(true);
        const handlePause = () => setPreviewPlaying(false);
        const handleEnded = () => {
            setPreviewPlaying(false);
            setPreviewCurrentFrame(Math.max(0, previewDurationInFrames - 1));
        };
        player.addEventListener('frameupdate', handleFrameUpdate);
        player.addEventListener('seeked', handleSeeked);
        player.addEventListener('play', handlePlay);
        player.addEventListener('pause', handlePause);
        player.addEventListener('ended', handleEnded);
        setPreviewCurrentFrame(player.getCurrentFrame());
        setPreviewPlaying(player.isPlaying());
        return () => {
            player.removeEventListener('frameupdate', handleFrameUpdate);
            player.removeEventListener('seeked', handleSeeked);
            player.removeEventListener('play', handlePlay);
            player.removeEventListener('pause', handlePause);
            player.removeEventListener('ended', handleEnded);
        };
    }, [activeTab, hasCompositionPreview, previewDurationInFrames]);

    useEffect(() => {
        if (activeTab !== 'preview' || hasCompositionPreview || displayAssetKind !== 'video') return;
        const video = rawVideoRef.current;
        if (!video) return;
        const syncFrame = () => {
            setPreviewCurrentFrame(Math.max(0, Math.round((video.currentTime || 0) * previewFps)));
        };
        const handlePlay = () => setPreviewPlaying(true);
        const handlePause = () => setPreviewPlaying(false);
        const handleEnded = () => {
            setPreviewPlaying(false);
            syncFrame();
        };
        video.addEventListener('loadedmetadata', syncFrame);
        video.addEventListener('timeupdate', syncFrame);
        video.addEventListener('play', handlePlay);
        video.addEventListener('pause', handlePause);
        video.addEventListener('ended', handleEnded);
        syncFrame();
        setPreviewPlaying(!video.paused && !video.ended);
        return () => {
            video.removeEventListener('loadedmetadata', syncFrame);
            video.removeEventListener('timeupdate', syncFrame);
            video.removeEventListener('play', handlePlay);
            video.removeEventListener('pause', handlePause);
            video.removeEventListener('ended', handleEnded);
        };
    }, [activeTab, displayAssetKind, hasCompositionPreview, previewFps]);

    useEffect(() => {
        if (activeTab === 'preview' || activeTab === 'remotion') return;
        remotionPlayerRef.current?.pause();
        rawVideoRef.current?.pause();
        setPreviewPlaying(false);
    }, [activeTab]);

    const seekPreviewFrame = (frame: number) => {
        const boundedFrame = Math.max(0, Math.min(frame, Math.max(0, previewDurationInFrames - 1)));
        setPreviewCurrentFrame(boundedFrame);
        if (hasCompositionPreview) {
            remotionPlayerRef.current?.seekTo(boundedFrame);
            return;
        }
        if (displayAssetKind === 'video' && rawVideoRef.current) {
            rawVideoRef.current.currentTime = boundedFrame / previewFps;
        }
    };

    const togglePreviewPlayback = () => {
        if (hasCompositionPreview) {
            const player = remotionPlayerRef.current;
            if (!player) return;
            if (player.isPlaying()) {
                player.pause();
            } else {
                player.play();
            }
            return;
        }
        const video = rawVideoRef.current;
        if (!video) return;
        if (video.paused || video.ended) {
            void video.play().catch(() => undefined);
        } else {
            video.pause();
        }
    };

    const stepPreviewFrame = (delta: number) => {
        seekPreviewFrame(previewCurrentFrame + delta);
    };

    return (
        <div className="grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)_420px] bg-[#0b0d10] text-white">
            <aside className="flex min-h-0 flex-col border-r border-white/10 bg-[#101216]">
                <div className="border-b border-white/10 px-5 py-4">
                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-white/35">
                        <Film className="h-3.5 w-3.5" />
                        AI Video Project
                    </div>
                    <div className="mt-2 text-lg font-semibold text-white">{title}</div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                        <span className={clsx(
                            'rounded-full border px-2.5 py-1',
                            scriptConfirmed
                                ? 'border-emerald-400/30 bg-emerald-400/12 text-emerald-100'
                                : 'border-amber-400/30 bg-amber-400/12 text-amber-100',
                        )}>
                            {statusLabel(scriptApproval)}
                        </span>
                        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-white/65">
                            {videoProject?.baseMedia?.status || '未生成基础剪辑'}
                        </span>
                    </div>
                </div>

                <div className="space-y-3 border-b border-white/10 px-5 py-4 text-sm">
                    <button
                        type="button"
                        onClick={onOpenBindAssets}
                        className="flex w-full items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-left transition hover:bg-white/10"
                    >
                        <span className="flex items-center gap-2">
                            <Upload className="h-4 w-4 text-white/55" />
                            绑定素材
                        </span>
                        <span className="text-xs text-white/45">{leftAssets.length} 个素材</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => onGenerateRemotionScene?.(editorBody)}
                        disabled={isGeneratingRemotion || !scriptConfirmed}
                        className="flex w-full items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-left transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                        <span className="flex items-center gap-2">
                            <Sparkles className="h-4 w-4 text-fuchsia-200" />
                            {isGeneratingRemotion ? '生成动画中...' : '生成 Remotion 动画'}
                        </span>
                        <span className="text-xs text-white/45">{scriptConfirmed ? '可执行' : '先确认脚本'}</span>
                    </button>
                    <button
                        type="button"
                        onClick={onRenderRemotionVideo}
                        disabled={isRenderingRemotion || !scriptConfirmed}
                        className="flex w-full items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-left transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                        <span className="flex items-center gap-2">
                            <Download className="h-4 w-4 text-cyan-100" />
                            {isRenderingRemotion ? '导出中...' : '导出成片'}
                        </span>
                        <span className="text-xs text-white/45">{renderOutputPath ? '已有导出' : '生成输出'}</span>
                    </button>
                    {!scriptConfirmed ? (
                        <button
                            type="button"
                            onClick={onConfirmScript}
                            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-emerald-400/30 bg-emerald-400/12 px-3 py-3 text-sm text-emerald-50 transition hover:bg-emerald-400/18"
                        >
                            <CheckCircle2 className="h-4 w-4" />
                            确认当前脚本
                        </button>
                    ) : null}
                </div>

                <div className="border-b border-white/10 px-5 py-4">
                    <div className="text-xs uppercase tracking-[0.2em] text-white/35">基础视频</div>
                    <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-sm text-white/75">
                        <div>来源素材：{sourceAssetIds.length ? sourceAssetIds.join(', ') : '未绑定'}</div>
                        <div className="mt-1">时长：{formatDuration(videoProject?.baseMedia?.durationMs)}</div>
                        <div className="mt-1 break-all text-white/45">
                            {baseMediaOutputPath || '尚未生成基础剪辑产物'}
                        </div>
                    </div>
                    {videoProject?.ffmpegRecipeSummary ? (
                        <div className="mt-3 rounded-2xl border border-white/10 bg-white/5 p-3 text-sm text-white/70">
                            <div className="text-xs uppercase tracking-[0.18em] text-white/35">FFmpeg Recipe</div>
                            <div className="mt-2 leading-6">{videoProject.ffmpegRecipeSummary}</div>
                        </div>
                    ) : null}
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                    <div className="mb-3 text-xs uppercase tracking-[0.2em] text-white/35">素材池</div>
                    <div className="space-y-2">
                        {leftAssets.length ? leftAssets.map((asset) => (
                            <div key={asset.id} className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3">
                                <div className="truncate text-sm text-white/85">{asset.title || asset.id}</div>
                                <div className="mt-1 truncate text-xs text-white/45">
                                    {asset.absolutePath || asset.relativePath || asset.previewUrl || asset.id}
                                </div>
                            </div>
                        )) : (
                            <div className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-sm text-white/45">
                                当前稿件还没有绑定素材。
                            </div>
                        )}
                    </div>
                </div>
            </aside>

            <main className="flex min-h-0 flex-col">
                <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3">
                    {([
                        { id: 'preview', label: 'Preview' },
                        { id: 'script', label: 'Script' },
                        { id: 'remotion', label: 'Remotion' },
                    ] as Array<{ id: CenterTab; label: string }>).map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            onClick={() => setActiveTab(tab.id)}
                            className={clsx(
                                'rounded-full px-3 py-1.5 text-sm transition',
                                activeTab === tab.id
                                    ? 'bg-white text-black'
                                    : 'border border-white/10 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white',
                            )}
                        >
                            {tab.label}
                        </button>
                    ))}
                    <div className="ml-auto flex items-center gap-2 text-xs text-white/45">
                        <RefreshCw className={clsx('h-3.5 w-3.5', isSavingEditorBody && 'animate-spin')} />
                        {isSavingEditorBody ? '脚本保存中' : editorBodyDirty ? '脚本待保存' : '脚本已同步'}
                    </div>
                </div>

                <div className="min-h-0 flex-1">
                    {activeTab === 'preview' ? (
                        <div className="flex h-full min-h-0 flex-col bg-[radial-gradient(circle_at_top,rgba(92,112,255,0.16),transparent_45%)]">
                            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3 text-sm text-white/60">
                                <div className="truncate">{editorFile}</div>
                                <div className="flex items-center gap-3">
                                    <span className="text-xs uppercase tracking-[0.16em] text-white/35">
                                        画布 {formatCanvasSize(previewStageWidth, previewStageHeight)}
                                    </span>
                                    {renderOutputPath ? (
                                        <button
                                            type="button"
                                            onClick={onOpenRenderedVideo}
                                            className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/75 transition hover:bg-white/10 hover:text-white"
                                        >
                                            打开导出文件
                                        </button>
                                    ) : null}
                                </div>
                            </div>
                            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 p-6">
                                <div className="flex min-h-0 w-full flex-1 items-center justify-center">
                                    {hasCompositionPreview ? (
                                        <div
                                            className="overflow-hidden rounded-[28px] border border-white/10 bg-black shadow-[0_20px_60px_rgba(0,0,0,0.35)]"
                                            style={previewStageIsLandscape
                                                ? { width: 'min(100%, 1080px)', aspectRatio: `${previewStageWidth} / ${previewStageHeight}` }
                                                : { height: 'min(100%, 820px)', maxWidth: '100%', aspectRatio: `${previewStageWidth} / ${previewStageHeight}` }}
                                        >
                                            <RemotionVideoPreview composition={effectiveComposition || composition!} playerRef={remotionPlayerRef} />
                                        </div>
                                    ) : displayPreviewUrl ? (
                                        displayAssetKind === 'image' ? (
                                            <img
                                                src={displayPreviewUrl}
                                                alt={title}
                                                className="rounded-[28px] border border-white/10 object-contain shadow-[0_20px_60px_rgba(0,0,0,0.35)]"
                                                style={previewStageIsLandscape
                                                    ? { width: 'min(100%, 1080px)', aspectRatio: `${previewStageWidth} / ${previewStageHeight}` }
                                                    : { height: 'min(100%, 820px)', maxWidth: '100%', aspectRatio: `${previewStageWidth} / ${previewStageHeight}` }}
                                            />
                                        ) : (
                                            <video
                                                ref={rawVideoRef}
                                                src={displayPreviewUrl}
                                                playsInline
                                                preload="metadata"
                                                className="rounded-[28px] border border-white/10 bg-black object-contain shadow-[0_20px_60px_rgba(0,0,0,0.35)]"
                                                style={previewStageIsLandscape
                                                    ? { width: 'min(100%, 1080px)', aspectRatio: `${previewStageWidth} / ${previewStageHeight}` }
                                                    : { height: 'min(100%, 820px)', maxWidth: '100%', aspectRatio: `${previewStageWidth} / ${previewStageHeight}` }}
                                            />
                                        )
                                    ) : (
                                        <div className="flex max-w-md flex-col items-center rounded-[28px] border border-dashed border-white/15 bg-white/[0.03] px-8 py-10 text-center">
                                            <Clapperboard className="h-10 w-10 text-white/35" />
                                            <div className="mt-4 text-lg text-white/80">尚未生成基础剪辑</div>
                                            <div className="mt-2 text-sm leading-6 text-white/45">
                                                先让 AI 使用 `ffmpeg_edit` 生成基础视频，再在 Remotion 中叠加标题、字幕和图形动画。
                                            </div>
                                        </div>
                                    )}
                                </div>
                                {showPreviewTransport ? (
                                    <div className="w-full max-w-[1080px]">
                                        <RemotionTransportBar
                                            fps={previewFps}
                                            durationInFrames={previewDurationInFrames}
                                            currentFrame={previewCurrentFrame}
                                            playing={previewPlaying}
                                            onTogglePlayback={togglePreviewPlayback}
                                            onSeekFrame={seekPreviewFrame}
                                            onStepFrame={stepPreviewFrame}
                                        />
                                    </div>
                                ) : null}
                            </div>
                            <div className="border-t border-white/10 px-5 py-3 text-xs text-white/45">
                                {hasCompositionPreview
                                    ? '当前 Preview 会直接显示基础视频与 Remotion 动画图层，播放控制已移动到画布外底部。'
                                    : '当前 Preview 会直接显示基础素材，并按素材尺寸自适应画布；播放控制位于画布外底部。'}
                            </div>
                        </div>
                    ) : null}

                    {activeTab === 'script' ? (
                        <div className="flex h-full min-h-0 flex-col bg-[#0f1115]">
                            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3 text-sm text-white/60">
                                <div>{statusLabel(scriptApproval)}</div>
                                <div>
                                    {scriptApproval?.confirmedAt
                                        ? `确认时间 ${new Date(scriptApproval.confirmedAt).toLocaleString()}`
                                        : '请先阅读并确认脚本，再执行 AI 剪辑与导出'}
                                </div>
                            </div>
                            <div className="min-h-0 flex-1 overflow-hidden">
                                <CodeMirrorEditor value={editorBody} onChange={onEditorBodyChange} className="h-full" />
                            </div>
                        </div>
                    ) : null}

                    {activeTab === 'remotion' ? (
                        <div className="flex h-full min-h-0 flex-col bg-[#090b10]">
                            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3 text-sm text-white/60">
                                <div>Remotion 预览直接读取当前 `remotion.scene.json`</div>
                                <div>{composition ? `${(effectiveComposition || composition).width}×${(effectiveComposition || composition).height} · ${composition.fps}fps` : '未生成动画结构'}</div>
                            </div>
                            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 p-6">
                                {composition ? (
                                    <div
                                        className="overflow-hidden rounded-[28px] border border-white/10 bg-black shadow-[0_20px_60px_rgba(0,0,0,0.35)]"
                                        style={previewStageIsLandscape
                                            ? { width: 'min(100%, 1080px)', aspectRatio: `${previewStageWidth} / ${previewStageHeight}` }
                                            : { height: 'min(100%, 820px)', maxWidth: '100%', aspectRatio: `${previewStageWidth} / ${previewStageHeight}` }}
                                    >
                                        <RemotionVideoPreview composition={effectiveComposition || composition} playerRef={remotionPlayerRef} />
                                    </div>
                                ) : (
                                    <div className="flex h-full items-center justify-center rounded-[28px] border border-dashed border-white/10 text-white/45">
                                        还没有 Remotion 场景，可让 AI 基于当前脚本生成。
                                    </div>
                                )}
                                {composition ? (
                                    <div className="w-full max-w-[1080px]">
                                        <RemotionTransportBar
                                            fps={previewFps}
                                            durationInFrames={previewDurationInFrames}
                                            currentFrame={previewCurrentFrame}
                                            playing={previewPlaying}
                                            onTogglePlayback={togglePreviewPlayback}
                                            onSeekFrame={seekPreviewFrame}
                                            onStepFrame={stepPreviewFrame}
                                        />
                                    </div>
                                ) : null}
                            </div>
                            {renderOutputUrl ? (
                                <div className="border-t border-white/10 px-5 py-3 text-xs text-white/45">
                                    最新导出：{renderOutputPath}
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            </main>

            <aside className="min-h-0 border-l border-white/10 bg-[#0f1217]">
                <Suspense fallback={<div className="flex h-full items-center justify-center text-white/45">聊天工作台加载中...</div>}>
                    <ChatWorkspace
                        isActive={isActive}
                        fixedSessionId={editorChatSessionId}
                        showClearButton={false}
                        showWelcomeShortcuts={false}
                        showComposerShortcuts
                        fixedSessionContextIndicatorMode="corner-ring"
                        embeddedTheme="auto"
                        contentLayout="wide"
                        contentWidthPreset="default"
                        allowFileUpload
                        welcomeTitle="AI 剪辑助手"
                        welcomeSubtitle="先确认脚本，再让 AI 生成基础视频与 Remotion 动画图层。默认只生成动画主体。"
                        shortcuts={[
                            { label: '读取工程', text: '请先使用 redbox_editor 的 project_read 读取当前视频工程，然后总结脚本状态、基础视频状态和当前 Remotion 结构。' },
                            { label: '生成基础剪辑', text: '请先读取当前脚本和工程，然后用 redbox_editor 的 ffmpeg_edit 生成基础视频，并说明你执行了哪些剪辑步骤。' },
                            { label: '生成动画', text: '请先读取当前 project_read 和 remotion_read，基于已确认脚本生成一版 Remotion 对象动画方案。除非脚本明确要求文字层，否则不要添加标题、字幕或说明。' },
                        ]}
                        fixedSessionBannerText="视频 AI 工作台"
                    />
                </Suspense>
            </aside>
        </div>
    );
}
