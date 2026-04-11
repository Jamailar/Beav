import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { AudioLines, Check, ChevronsUpDown, Clapperboard, Image as ImageIcon, Type } from 'lucide-react';
import { RemotionTransportBar } from './remotion/RemotionTransportBar';
import { resolveAssetUrl } from '../../utils/pathManager';
import type { RemotionScene } from './remotion/types';
import type { SceneItemTransform, VideoEditorRatioPreset } from '../../features/video-editor/store/useVideoEditorStore';

type MediaAssetLike = {
    id: string;
    title?: string;
    relativePath?: string;
    absolutePath?: string;
    previewUrl?: string;
    mimeType?: string;
};

type TimelineClipLike = {
    clipId?: string;
    assetId?: string;
    name?: string;
    track?: string;
    durationMs?: number;
    trimInMs?: number;
    enabled?: boolean;
    assetKind?: string;
    startSeconds?: number;
    endSeconds?: number;
    mediaPath?: string;
    mimeType?: string;
};

type SceneLayerKind = 'asset' | 'overlay' | 'title';

type TimelinePreviewCompositionProps = {
    currentFrame: number;
    durationInFrames: number;
    fps: number;
    currentTime: number;
    isPlaying: boolean;
    stageWidth: number;
    stageHeight: number;
    ratioPreset: VideoEditorRatioPreset;
    timelineClips: TimelineClipLike[];
    assetsById: Record<string, MediaAssetLike>;
    selectedScene: RemotionScene | null;
    selectedSceneItemId: string | null;
    selectedSceneItemKind: SceneLayerKind | null;
    guidesVisible: boolean;
    safeAreaVisible: boolean;
    itemTransforms: Record<string, SceneItemTransform>;
    onTogglePlayback: () => void;
    onSeekFrame: (frame: number) => void;
    onStepFrame: (deltaFrames: number) => void;
    onChangeRatioPreset: (preset: VideoEditorRatioPreset) => void;
    onSelectSceneItem: (kind: SceneLayerKind, id: string) => void;
    onUpdateItemTransform: (id: string, patch: Partial<SceneItemTransform>) => void;
    onDeleteSceneItem: (kind: SceneLayerKind, id: string) => void;
};

type EditableStageItem = {
    id: string;
    kind: SceneLayerKind;
    label: string;
    contentType: 'video' | 'image' | 'audio' | 'text';
    src?: string;
    text?: string;
    transform: SceneItemTransform;
};

type InteractionState = {
    itemId: string;
    mode: 'drag' | 'resize';
    handle?: string;
    startClientX: number;
    startClientY: number;
    initialTransform: SceneItemTransform;
};

function isActiveAtTime(clip: TimelineClipLike, time: number) {
    const start = Number(clip.startSeconds || 0);
    const end = Number(clip.endSeconds || 0);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    if (time < start) return false;
    if (time > end) return false;
    return true;
}

function normalizeAssetKind(clip: TimelineClipLike) {
    const value = String(clip.assetKind || '').trim().toLowerCase();
    if (value === 'video' || value === 'image' || value === 'audio') return value;
    const mimeType = String(clip.mimeType || '').trim().toLowerCase();
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'unknown';
}

function trackPriority(track: string) {
    const normalized = String(track || '').trim().toUpperCase();
    if (normalized.startsWith('V')) return 0;
    if (normalized.startsWith('S') || normalized.startsWith('T') || normalized.startsWith('C')) return 1;
    if (normalized.startsWith('A')) return 2;
    return 3;
}

function buildOverlayText(scene: RemotionScene | null): string {
    if (!scene) return '';
    const explicitText = String(scene.overlays?.[0]?.text || '').trim();
    if (explicitText) return explicitText;
    return String(scene.overlayBody || '').trim();
}

function clampNumber(value: number, min: number, max: number) {
    if (!Number.isFinite(value)) return min;
    return Math.min(Math.max(value, min), max);
}

function getDefaultTransform(options: {
    kind: SceneLayerKind;
    stageWidth: number;
    stageHeight: number;
    lockAspectRatio?: boolean;
}): SceneItemTransform {
    const { kind, stageWidth, stageHeight, lockAspectRatio = kind === 'asset' } = options;
    if (kind === 'title') {
        return {
            x: stageWidth * 0.1,
            y: stageHeight * 0.12,
            width: stageWidth * 0.42,
            height: stageHeight * 0.12,
            lockAspectRatio: false,
            minWidth: 180,
            minHeight: 48,
        };
    }
    if (kind === 'overlay') {
        return {
            x: stageWidth * 0.22,
            y: stageHeight * 0.72,
            width: stageWidth * 0.56,
            height: stageHeight * 0.14,
            lockAspectRatio: false,
            minWidth: 220,
            minHeight: 64,
        };
    }
    const width = Math.min(stageWidth * 0.24, 320);
    return {
        x: (stageWidth - width) / 2,
        y: stageHeight * 0.35,
        width,
        height: width * 1.35,
        lockAspectRatio,
        minWidth: 96,
        minHeight: 96,
    };
}

export function TimelinePreviewComposition({
    currentFrame,
    durationInFrames,
    fps,
    currentTime,
    isPlaying,
    stageWidth,
    stageHeight,
    ratioPreset,
    timelineClips,
    assetsById,
    selectedScene,
    selectedSceneItemId,
    selectedSceneItemKind,
    guidesVisible,
    safeAreaVisible,
    itemTransforms,
    onTogglePlayback,
    onSeekFrame,
    onStepFrame,
    onChangeRatioPreset,
    onSelectSceneItem,
    onUpdateItemTransform,
    onDeleteSceneItem,
}: TimelinePreviewCompositionProps) {
    const visualVideoRef = useRef<HTMLVideoElement | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const stageViewportRef = useRef<HTMLDivElement | null>(null);
    const stageRef = useRef<HTMLDivElement | null>(null);
    const [ratioMenuOpen, setRatioMenuOpen] = useState(false);
    const [interaction, setInteraction] = useState<InteractionState | null>(null);
    const [stageRenderSize, setStageRenderSize] = useState({ width: 0, height: 0 });

    const activeClips = useMemo(
        () => timelineClips.filter((clip) => clip.enabled !== false && isActiveAtTime(clip, currentTime)),
        [currentTime, timelineClips]
    );

    const activeVisualClip = useMemo(
        () =>
            [...activeClips]
                .filter((clip) => {
                    const kind = normalizeAssetKind(clip);
                    return kind === 'video' || kind === 'image';
                })
                .sort((left, right) => {
                    const priorityDelta = trackPriority(String(left.track || '')) - trackPriority(String(right.track || ''));
                    if (priorityDelta !== 0) return priorityDelta;
                    return Number(left.startSeconds || 0) - Number(right.startSeconds || 0);
                })[0] || null,
        [activeClips]
    );

    const activeAudioClip = useMemo(
        () =>
            [...activeClips]
                .filter((clip) => normalizeAssetKind(clip) === 'audio')
                .sort((left, right) => {
                    const priorityDelta = trackPriority(String(left.track || '')) - trackPriority(String(right.track || ''));
                    if (priorityDelta !== 0) return priorityDelta;
                    return Number(left.startSeconds || 0) - Number(right.startSeconds || 0);
                })[0] || null,
        [activeClips]
    );

    const activeClip = activeVisualClip || activeAudioClip || null;
    const activeClipId = String(activeClip?.clipId || '').trim() || null;
    const visualKind = activeVisualClip ? normalizeAssetKind(activeVisualClip) : (activeAudioClip ? 'audio' : 'unknown');
    const visualAssetId = String(activeVisualClip?.assetId || activeAudioClip?.assetId || '').trim();
    const visualAsset = visualAssetId ? assetsById[visualAssetId] || null : null;
    const visualAssetUrl = resolveAssetUrl(
        visualAsset?.previewUrl
        || visualAsset?.absolutePath
        || visualAsset?.relativePath
        || String(activeVisualClip?.mediaPath || activeAudioClip?.mediaPath || '')
    );
    const audioAssetId = String(activeAudioClip?.assetId || '').trim();
    const audioAsset = audioAssetId ? assetsById[audioAssetId] || null : null;
    const audioAssetUrl = resolveAssetUrl(
        audioAsset?.previewUrl
        || audioAsset?.absolutePath
        || audioAsset?.relativePath
        || String(activeAudioClip?.mediaPath || '')
    );
    const visualLocalTime = activeVisualClip
        ? Math.max(0, currentTime - Number(activeVisualClip.startSeconds || 0) + Number(activeVisualClip.trimInMs || 0) / 1000)
        : 0;
    const audioLocalTime = activeAudioClip
        ? Math.max(0, currentTime - Number(activeAudioClip.startSeconds || 0) + Number(activeAudioClip.trimInMs || 0) / 1000)
        : 0;
    const overlayText = buildOverlayText(selectedScene);
    const overlayId = selectedScene ? `${selectedScene.id}:overlay` : null;
    const titleId = selectedScene ? `${selectedScene.id}:title` : null;
    const safeStageWidth = Math.max(1, stageWidth || 1080);
    const safeStageHeight = Math.max(1, stageHeight || 1920);
    const stageAspectRatio = `${safeStageWidth} / ${safeStageHeight}`;
    const stageAspectRatioValue = safeStageWidth / safeStageHeight;
    const ratioOptions: Array<{ preset: VideoEditorRatioPreset; label: string }> = [
        { preset: '16:9', label: '16:9（横屏）' },
        { preset: '9:16', label: '9:16（竖屏）' },
    ];

    const stageItems = useMemo<EditableStageItem[]>(() => {
        const items: EditableStageItem[] = [];
        if (activeClipId && (activeVisualClip || activeAudioClip)) {
            items.push({
                id: activeClipId,
                kind: 'asset',
                label: visualAsset?.title || activeVisualClip?.name || activeAudioClip?.name || '素材',
                contentType: visualKind === 'video' || visualKind === 'image'
                    ? visualKind
                    : 'audio',
                src: visualAssetUrl || audioAssetUrl || undefined,
                transform: itemTransforms[activeClipId] || getDefaultTransform({
                    kind: 'asset',
                    stageWidth: safeStageWidth,
                    stageHeight: safeStageHeight,
                }),
            });
        }
        if (selectedScene?.overlayTitle && titleId) {
            items.push({
                id: titleId,
                kind: 'title',
                label: '标题',
                contentType: 'text',
                text: selectedScene.overlayTitle,
                transform: itemTransforms[titleId] || getDefaultTransform({
                    kind: 'title',
                    stageWidth: safeStageWidth,
                    stageHeight: safeStageHeight,
                    lockAspectRatio: false,
                }),
            });
        }
        if (overlayText && overlayId) {
            items.push({
                id: overlayId,
                kind: 'overlay',
                label: '文案层',
                contentType: 'text',
                text: overlayText,
                transform: itemTransforms[overlayId] || getDefaultTransform({
                    kind: 'overlay',
                    stageWidth: safeStageWidth,
                    stageHeight: safeStageHeight,
                    lockAspectRatio: false,
                }),
            });
        }
        return items;
    }, [activeAudioClip, activeClipId, activeVisualClip, audioAssetUrl, itemTransforms, overlayId, overlayText, safeStageHeight, safeStageWidth, selectedScene, titleId, visualAsset, visualAssetUrl, visualKind]);

    useEffect(() => {
        const video = visualVideoRef.current;
        if (!video || !activeVisualClip || normalizeAssetKind(activeVisualClip) !== 'video') return;
        if (Math.abs((video.currentTime || 0) - visualLocalTime) > 0.08) {
            video.currentTime = visualLocalTime;
        }
        if (isPlaying) {
            void video.play().catch(() => undefined);
        } else {
            video.pause();
        }
    }, [activeVisualClip, isPlaying, visualLocalTime]);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio || !activeAudioClip || !audioAssetUrl) return;
        if (Math.abs((audio.currentTime || 0) - audioLocalTime) > 0.08) {
            audio.currentTime = audioLocalTime;
        }
        if (isPlaying) {
            void audio.play().catch(() => undefined);
        } else {
            audio.pause();
        }
    }, [activeAudioClip, audioAssetUrl, audioLocalTime, isPlaying]);

    useEffect(() => {
        if (!stageViewportRef.current) return;

        const updateStageSize = () => {
            const viewport = stageViewportRef.current;
            if (!viewport) return;
            const availableWidth = Math.max(0, viewport.clientWidth - 12);
            const availableHeight = Math.max(0, viewport.clientHeight - 12);
            if (availableWidth <= 0 || availableHeight <= 0) return;

            let width = availableWidth;
            let height = width / stageAspectRatioValue;

            if (height > availableHeight) {
                height = availableHeight;
                width = height * stageAspectRatioValue;
            }

            setStageRenderSize({
                width,
                height,
            });
        };

        updateStageSize();
        const observer = new ResizeObserver(() => updateStageSize());
        observer.observe(stageViewportRef.current);
        return () => observer.disconnect();
    }, [stageAspectRatioValue]);

    useEffect(() => {
        if (!interaction || !stageRef.current) return;

        const stageRect = stageRef.current.getBoundingClientRect();
        const scaleX = safeStageWidth / Math.max(1, stageRect.width);
        const scaleY = safeStageHeight / Math.max(1, stageRect.height);

        const handlePointerMove = (event: PointerEvent) => {
            const deltaX = (event.clientX - interaction.startClientX) * scaleX;
            const deltaY = (event.clientY - interaction.startClientY) * scaleY;
            const next = { ...interaction.initialTransform };

            if (interaction.mode === 'drag') {
                next.x = clampNumber(
                    interaction.initialTransform.x + deltaX,
                    -next.width * 0.35,
                    safeStageWidth - next.width * 0.65
                );
                next.y = clampNumber(
                    interaction.initialTransform.y + deltaY,
                    -next.height * 0.35,
                    safeStageHeight - next.height * 0.65
                );
                onUpdateItemTransform(interaction.itemId, next);
                return;
            }

            const handle = interaction.handle || 'se';
            const movingLeft = handle.includes('w');
            const movingRight = handle.includes('e');
            const movingTop = handle.includes('n');
            const movingBottom = handle.includes('s');
            let nextWidth = interaction.initialTransform.width + (movingRight ? deltaX : 0) - (movingLeft ? deltaX : 0);
            let nextHeight = interaction.initialTransform.height + (movingBottom ? deltaY : 0) - (movingTop ? deltaY : 0);

            nextWidth = Math.max(interaction.initialTransform.minWidth, nextWidth);
            nextHeight = Math.max(interaction.initialTransform.minHeight, nextHeight);

            if (interaction.initialTransform.lockAspectRatio) {
                const ratio = interaction.initialTransform.width / Math.max(1, interaction.initialTransform.height);
                if (Math.abs(deltaX) >= Math.abs(deltaY)) {
                    nextHeight = nextWidth / ratio;
                } else {
                    nextWidth = nextHeight * ratio;
                }
            }

            next.width = nextWidth;
            next.height = nextHeight;

            if (movingLeft) {
                next.x = interaction.initialTransform.x + (interaction.initialTransform.width - nextWidth);
            }
            if (movingTop) {
                next.y = interaction.initialTransform.y + (interaction.initialTransform.height - nextHeight);
            }

            next.x = clampNumber(next.x, -next.width * 0.35, safeStageWidth - next.width * 0.65);
            next.y = clampNumber(next.y, -next.height * 0.35, safeStageHeight - next.height * 0.65);
            onUpdateItemTransform(interaction.itemId, next);
        };

        const handlePointerUp = () => {
            setInteraction(null);
        };

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);
        window.addEventListener('pointercancel', handlePointerUp);
        return () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
            window.removeEventListener('pointercancel', handlePointerUp);
        };
    }, [interaction, onUpdateItemTransform, safeStageHeight, safeStageWidth]);

    useEffect(() => {
        if (!stageRef.current || !selectedSceneItemId || !selectedSceneItemKind) return;

        const handleKeyDown = (event: KeyboardEvent) => {
            const activeElement = document.activeElement as HTMLElement | null;
            if (!activeElement || !stageRef.current?.contains(activeElement)) return;
            const tagName = activeElement.tagName.toLowerCase();
            const isTyping = tagName === 'input' || tagName === 'textarea' || activeElement.isContentEditable;
            if (isTyping) return;
            if (event.key !== 'Delete' && event.key !== 'Backspace') return;
            event.preventDefault();
            onDeleteSceneItem(selectedSceneItemKind, selectedSceneItemId);
        };

        document.addEventListener('keydown', handleKeyDown, true);
        return () => {
            document.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [onDeleteSceneItem, selectedSceneItemId, selectedSceneItemKind]);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1 bg-[linear-gradient(180deg,#1b1b1c,#121213)] px-4 py-2">
                <div ref={stageViewportRef} className="flex h-full w-full items-center justify-center">
                    <div
                        ref={stageRef}
                        tabIndex={0}
                        className="relative overflow-hidden rounded-[18px] border border-white/10 bg-[#050505] shadow-[0_20px_60px_rgba(0,0,0,0.4)]"
                        style={{
                            aspectRatio: stageAspectRatio,
                            width: stageRenderSize.width > 0 ? `${stageRenderSize.width}px` : '100%',
                            height: stageRenderSize.height > 0 ? `${stageRenderSize.height}px` : '100%',
                            maxWidth: '100%',
                            maxHeight: '100%',
                        }}
                    >
                        {guidesVisible ? (
                            <>
                                <div className="pointer-events-none absolute inset-y-0 left-1/2 z-10 w-px -translate-x-1/2 bg-white/10" />
                                <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 h-px -translate-y-1/2 bg-white/10" />
                            </>
                        ) : null}
                        {safeAreaVisible ? (
                            <div className="pointer-events-none absolute inset-[8%] z-10 rounded-[18px] border border-dashed border-cyan-300/25" />
                        ) : null}

                        {audioAssetUrl ? (
                            <audio ref={audioRef} src={audioAssetUrl} className="hidden" preload="auto" />
                        ) : null}

                        {stageItems.length === 0 ? (
                            <div className="absolute inset-0 z-20 flex items-center justify-center text-center text-white/55">
                                <div>
                                    <Clapperboard className="mx-auto h-10 w-10 text-white/35" />
                                    <div className="mt-3 text-sm">时间轴里还没有可预览片段</div>
                                    <div className="mt-1 text-xs text-white/35">先添加轨道，再把素材拖入时间轴。</div>
                                </div>
                            </div>
                        ) : null}

                        {stageItems.map((item) => {
                            const isSelected = selectedSceneItemKind === item.kind && selectedSceneItemId === item.id;
                            const style = {
                                left: `${(item.transform.x / safeStageWidth) * 100}%`,
                                top: `${(item.transform.y / safeStageHeight) * 100}%`,
                                width: `${(item.transform.width / safeStageWidth) * 100}%`,
                                height: `${(item.transform.height / safeStageHeight) * 100}%`,
                            };
                            return (
                                <div
                                    key={item.id}
                                    className={clsx(
                                        'absolute z-20',
                                        isSelected && 'z-30'
                                    )}
                                    style={style}
                                >
                                    <button
                                        type="button"
                                        onPointerDown={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            stageRef.current?.focus({ preventScroll: true });
                                            onSelectSceneItem(item.kind, item.id);
                                            setInteraction({
                                                itemId: item.id,
                                                mode: 'drag',
                                                startClientX: event.clientX,
                                                startClientY: event.clientY,
                                                initialTransform: item.transform,
                                            });
                                        }}
                                        className={clsx(
                                            'group relative h-full w-full rounded-[14px] border bg-transparent transition',
                                            isSelected
                                                ? 'border-cyan-300/80 shadow-[0_0_0_1px_rgba(103,232,249,0.45)]'
                                                : 'border-transparent hover:border-white/20'
                                        )}
                                    >
                                        {item.contentType === 'video' ? (
                                            <video
                                                ref={item.id === activeClipId ? visualVideoRef : undefined}
                                                key={item.id}
                                                src={item.src}
                                                className="h-full w-full rounded-[12px] object-contain"
                                                controls={false}
                                                playsInline
                                                preload="auto"
                                            />
                                        ) : item.contentType === 'image' ? (
                                            <img
                                                src={item.src}
                                                alt={item.label}
                                                className="h-full w-full rounded-[12px] object-contain"
                                            />
                                        ) : item.contentType === 'audio' ? (
                                            <div className="flex h-full w-full items-center justify-center rounded-[12px] bg-[radial-gradient(circle_at_top,rgba(217,70,239,0.2),transparent_55%)] text-white/75">
                                                <AudioLines className="h-8 w-8" />
                                            </div>
                                        ) : (
                                            <div className={clsx(
                                                'flex h-full w-full items-center justify-center rounded-[12px] px-3 text-center',
                                                item.kind === 'title'
                                                    ? 'bg-black/38 text-lg font-semibold text-white'
                                                    : 'bg-black/45 text-sm leading-6 text-white/90'
                                            )}>
                                                {item.text}
                                            </div>
                                        )}
                                        {isSelected ? (
                                            <>
                                                {['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((handle) => {
                                                    const handleStyle: Record<string, string> = {
                                                        nw: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2',
                                                        n: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2',
                                                        ne: 'right-0 top-0 translate-x-1/2 -translate-y-1/2',
                                                        e: 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2',
                                                        se: 'right-0 bottom-0 translate-x-1/2 translate-y-1/2',
                                                        s: 'left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2',
                                                        sw: 'left-0 bottom-0 -translate-x-1/2 translate-y-1/2',
                                                        w: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2',
                                                    };
                                                    return (
                                                        <span
                                                            key={handle}
                                                            className={clsx(
                                                                'absolute h-4 w-4 rounded-full border border-white bg-white shadow-[0_2px_6px_rgba(0,0,0,0.35)]',
                                                                handleStyle[handle]
                                                            )}
                                                            onPointerDown={(event) => {
                                                                event.preventDefault();
                                                                event.stopPropagation();
                                                                setInteraction({
                                                                    itemId: item.id,
                                                                    mode: 'resize',
                                                                    handle,
                                                                    startClientX: event.clientX,
                                                                    startClientY: event.clientY,
                                                                    initialTransform: item.transform,
                                                                });
                                                            }}
                                                        />
                                                    );
                                                })}
                                            </>
                                        ) : null}
                                    </button>
                                </div>
                            );
                        })}

                        <div className="absolute bottom-3 right-3 z-40 flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => setRatioMenuOpen((open) => !open)}
                                className="inline-flex items-center gap-2 rounded-lg border border-white/12 bg-black/55 px-3 py-1.5 text-xs font-medium text-white/85 backdrop-blur"
                            >
                                <span>{ratioPreset}</span>
                                <ChevronsUpDown className="h-3.5 w-3.5" />
                            </button>
                            {ratioMenuOpen ? (
                                <div className="absolute bottom-11 right-0 min-w-[170px] overflow-hidden rounded-xl border border-white/10 bg-[#2a2a2b] shadow-[0_16px_40px_rgba(0,0,0,0.45)]">
                                    {ratioOptions.map((option) => (
                                        <button
                                            key={option.preset}
                                            type="button"
                                            onClick={() => {
                                                onChangeRatioPreset(option.preset);
                                                setRatioMenuOpen(false);
                                            }}
                                            className="flex w-full items-center justify-between px-4 py-3 text-sm text-white/88 transition hover:bg-white/8"
                                        >
                                            <span>{option.label}</span>
                                            {ratioPreset === option.preset ? <Check className="h-4 w-4 text-cyan-300" /> : null}
                                        </button>
                                    ))}
                                </div>
                            ) : null}
                            {selectedSceneItemId && selectedSceneItemKind ? (
                                <button
                                    type="button"
                                    onClick={() => onDeleteSceneItem(selectedSceneItemKind, selectedSceneItemId)}
                                    className="inline-flex items-center gap-1 rounded-lg border border-red-400/25 bg-red-500/12 px-3 py-1.5 text-xs font-medium text-red-100 transition hover:border-red-300/40 hover:bg-red-500/18"
                                >
                                    删除
                                </button>
                            ) : null}
                        </div>
                    </div>
                </div>
            </div>
            <div className="border-t border-white/10 px-4 py-3">
                <RemotionTransportBar
                    fps={fps}
                    durationInFrames={durationInFrames}
                    currentFrame={currentFrame}
                    playing={isPlaying}
                    onTogglePlayback={onTogglePlayback}
                    onSeekFrame={onSeekFrame}
                    onStepFrame={onStepFrame}
                    disabled={!timelineClips.length}
                />
            </div>
        </div>
    );
}
