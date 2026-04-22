import { useEffect, useMemo, useRef, useState } from 'react';
import { Thumbnail } from '@remotion/player';
import clsx from 'clsx';
import { AudioLines, Clapperboard, Image as ImageIcon, Pause, Play, Type } from 'lucide-react';
import { resolveSubtitlePreset } from './subtitles/subtitlePresets';
import { resolveTextPreset } from './texts/textPresets';
import { resolveTransitionPreset } from './transitions/transitionPresets';
import { resolveAssetUrl } from '../../utils/pathManager';
import { VideoMotionComposition } from './remotion/VideoMotionComposition';
import type { RemotionCompositionConfig, RemotionScene } from './remotion/types';
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
    subtitleStyle?: {
        position?: 'top' | 'center' | 'bottom';
        fontSize?: number;
        color?: string;
        backgroundColor?: string;
        emphasisColor?: string;
        align?: 'left' | 'center' | 'right';
        presetId?: string;
        animation?: 'fade-up' | 'fade-in' | 'pop' | 'slide-left';
        fontWeight?: number;
        textTransform?: 'none' | 'uppercase';
        letterSpacing?: number;
        borderRadius?: number;
        paddingX?: number;
        paddingY?: number;
        emphasisWords?: string[];
        segmentationMode?: 'punctuationOrPause' | 'time' | 'singleWord';
        linesPerCaption?: number;
    };
    textStyle?: {
        presetId?: string;
        fontSize?: number;
        color?: string;
        backgroundColor?: string;
        align?: 'left' | 'center' | 'right';
        fontWeight?: number;
        animation?: 'fade-up' | 'fade-in' | 'pop' | 'slide-left';
    };
    transitionStyle?: {
        presetId?: string;
        kind?: 'none' | 'fade' | 'slide' | 'wipe' | 'flip' | 'clock-wipe' | 'star' | 'circle' | 'rectangle';
        direction?: 'from-left' | 'from-right' | 'from-top' | 'from-bottom';
        durationMs?: number;
    };
};

type TrackUiStateLike = {
    hidden?: boolean;
    muted?: boolean;
    solo?: boolean;
    volume?: number;
};

type SceneLayerKind = 'asset' | 'overlay' | 'title' | 'text' | 'subtitle';

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
    trackOrder: string[];
    trackUi: Record<string, TrackUiStateLike>;
    assetsById: Record<string, MediaAssetLike>;
    motionComposition: RemotionCompositionConfig | null;
    selectedScene: RemotionScene | null;
    selectedSceneItemId: string | null;
    selectedSceneItemIds: string[];
    selectedSceneItemKind: SceneLayerKind | null;
    guidesVisible: boolean;
    safeAreaVisible: boolean;
    itemTransforms: Record<string, SceneItemTransform>;
    itemVisibility: Record<string, boolean>;
    itemOrder: string[];
    itemLocks: Record<string, boolean>;
    itemGroups: Record<string, string>;
    focusedGroupId: string | null;
    onTogglePlayback: () => void;
    onSeekFrame: (frame: number) => void;
    onStepFrame: (deltaFrames: number) => void;
    onChangeRatioPreset: (preset: VideoEditorRatioPreset) => void;
    onSelectSceneItem: (kind: SceneLayerKind, id: string, options?: { additive?: boolean; preserveSelection?: boolean }) => void;
    onUpdateItemTransform: (id: string, patch: Partial<SceneItemTransform>) => void;
    onDeleteSceneItem: (kind: SceneLayerKind, id: string) => void;
    onDeleteSceneItems: (items: Array<{ kind: SceneLayerKind; id: string }>) => void;
    onAlignSceneItems: (mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => void;
    onDistributeSceneItems: (axis: 'horizontal' | 'vertical') => void;
    onSetSceneSelection: (ids: string[], primaryId: string | null) => void;
    onDuplicateSceneItems: (ids: string[]) => void;
};

type EditableStageItem = {
    id: string;
    kind: SceneLayerKind;
    label: string;
    contentType: 'video' | 'image' | 'audio' | 'text';
    src?: string;
    text?: string;
    textStyle?: TimelineClipLike['textStyle'];
    subtitleLayer?: {
        lines: string[];
        position: 'top' | 'center' | 'bottom';
        fontSize: number;
        color: string;
        backgroundColor: string;
        emphasisColor: string;
        align: 'left' | 'center' | 'right';
        animation: 'fade-up' | 'fade-in' | 'pop' | 'slide-left';
        fontWeight: number;
        textTransform: 'none' | 'uppercase';
        letterSpacing: number;
        borderRadius: number;
        paddingX: number;
        paddingY: number;
        emphasisWords: Set<string>;
        segmentationMode: 'punctuationOrPause' | 'time' | 'singleWord';
        segmentCount: number;
        activeSegmentIndex: number;
        activeWordIndex: number;
        words: string[];
    };
    progress?: number;
    transform: SceneItemTransform;
};

type InteractionState = {
    itemId: string;
    mode: 'drag' | 'resize';
    handle?: string;
    startClientX: number;
    startClientY: number;
    initialTransform: SceneItemTransform;
    selectedTransforms?: Record<string, SceneItemTransform>;
};

type MarqueeState = {
    startClientX: number;
    startClientY: number;
    currentClientX: number;
    currentClientY: number;
    additive: boolean;
};

type SnapGuide = {
    orientation: 'vertical' | 'horizontal';
    position: number;
    tone?: 'center' | 'safe' | 'edge' | 'object';
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

function buildTrackOrderIndex(trackOrder: string[], timelineClips: TimelineClipLike[]): Map<string, number> {
    const ordered = new Map<string, number>();
    const appendTrack = (value: unknown) => {
        const normalized = String(value || '').trim();
        if (!normalized || ordered.has(normalized)) return;
        ordered.set(normalized, ordered.size);
    };
    trackOrder.forEach(appendTrack);
    timelineClips.forEach((clip) => appendTrack(clip.track));
    return ordered;
}

function trackOrderValue(trackId: string, trackOrderIndex: Map<string, number>): number {
    return trackOrderIndex.get(String(trackId || '').trim()) ?? Number.MAX_SAFE_INTEGER;
}

function isSubtitleClip(clip: TimelineClipLike) {
    const assetKind = String(clip.assetKind || '').trim().toLowerCase();
    const track = String(clip.track || '').trim().toUpperCase();
    return assetKind === 'subtitle' || assetKind === 'caption' || assetKind === 'text' || track.startsWith('S') || track.startsWith('T') || track.startsWith('C');
}

function isTextClip(clip: TimelineClipLike) {
    return String(clip.assetKind || '').trim().toLowerCase() === 'text';
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

function applyAxisSnap(
    value: number,
    targets: Array<{ value: number; guide: SnapGuide }>,
    threshold: number
): { value: number; guide: SnapGuide | null } {
    let best: { value: number; guide: SnapGuide } | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    targets.forEach((target) => {
        const distance = Math.abs(value - target.value);
        if (distance <= threshold && distance < bestDistance) {
            best = target;
            bestDistance = distance;
        }
    });
    if (!best) {
        return { value, guide: null };
    }
    return { value: best.value, guide: best.guide };
}

function buildObjectSnapTargets(
    items: EditableStageItem[],
    activeItemId: string,
    itemSize: { width: number; height: number }
): {
    dragX: Array<{ value: number; guide: SnapGuide }>;
    dragY: Array<{ value: number; guide: SnapGuide }>;
    left: Array<{ value: number; guide: SnapGuide }>;
    right: Array<{ value: number; guide: SnapGuide }>;
    top: Array<{ value: number; guide: SnapGuide }>;
    bottom: Array<{ value: number; guide: SnapGuide }>;
} {
    const result = {
        dragX: [] as Array<{ value: number; guide: SnapGuide }>,
        dragY: [] as Array<{ value: number; guide: SnapGuide }>,
        left: [] as Array<{ value: number; guide: SnapGuide }>,
        right: [] as Array<{ value: number; guide: SnapGuide }>,
        top: [] as Array<{ value: number; guide: SnapGuide }>,
        bottom: [] as Array<{ value: number; guide: SnapGuide }>,
    };

    items.forEach((item) => {
        if (item.id === activeItemId) return;
        const leftEdge = item.transform.x;
        const centerX = item.transform.x + item.transform.width / 2;
        const rightEdge = item.transform.x + item.transform.width;
        const topEdge = item.transform.y;
        const centerY = item.transform.y + item.transform.height / 2;
        const bottomEdge = item.transform.y + item.transform.height;

        result.dragX.push(
            { value: leftEdge, guide: { orientation: 'vertical', position: leftEdge, tone: 'object' } },
            { value: centerX - itemSize.width / 2, guide: { orientation: 'vertical', position: centerX, tone: 'object' } },
            { value: rightEdge - itemSize.width, guide: { orientation: 'vertical', position: rightEdge, tone: 'object' } }
        );
        result.dragY.push(
            { value: topEdge, guide: { orientation: 'horizontal', position: topEdge, tone: 'object' } },
            { value: centerY - itemSize.height / 2, guide: { orientation: 'horizontal', position: centerY, tone: 'object' } },
            { value: bottomEdge - itemSize.height, guide: { orientation: 'horizontal', position: bottomEdge, tone: 'object' } }
        );
        result.left.push(
            { value: leftEdge, guide: { orientation: 'vertical', position: leftEdge, tone: 'object' } },
            { value: centerX, guide: { orientation: 'vertical', position: centerX, tone: 'object' } },
            { value: rightEdge, guide: { orientation: 'vertical', position: rightEdge, tone: 'object' } }
        );
        result.right.push(
            { value: leftEdge, guide: { orientation: 'vertical', position: leftEdge, tone: 'object' } },
            { value: centerX, guide: { orientation: 'vertical', position: centerX, tone: 'object' } },
            { value: rightEdge, guide: { orientation: 'vertical', position: rightEdge, tone: 'object' } }
        );
        result.top.push(
            { value: topEdge, guide: { orientation: 'horizontal', position: topEdge, tone: 'object' } },
            { value: centerY, guide: { orientation: 'horizontal', position: centerY, tone: 'object' } },
            { value: bottomEdge, guide: { orientation: 'horizontal', position: bottomEdge, tone: 'object' } }
        );
        result.bottom.push(
            { value: topEdge, guide: { orientation: 'horizontal', position: topEdge, tone: 'object' } },
            { value: centerY, guide: { orientation: 'horizontal', position: centerY, tone: 'object' } },
            { value: bottomEdge, guide: { orientation: 'horizontal', position: bottomEdge, tone: 'object' } }
        );
    });

    return result;
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
    if (kind === 'subtitle') {
        return {
            x: stageWidth * 0.12,
            y: stageHeight * 0.78,
            width: stageWidth * 0.76,
            height: stageHeight * 0.12,
            lockAspectRatio: false,
            minWidth: 240,
            minHeight: 56,
        };
    }
    if (kind === 'text') {
        return {
            x: stageWidth * 0.14,
            y: stageHeight * 0.22,
            width: stageWidth * 0.56,
            height: stageHeight * 0.12,
            lockAspectRatio: false,
            minWidth: 220,
            minHeight: 56,
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

function subtitleAnimationStyle(
    animation: 'fade-up' | 'fade-in' | 'pop' | 'slide-left' | undefined,
    progress: number
): React.CSSProperties {
    const eased = Math.min(Math.max(progress, 0), 1);
    switch (animation) {
        case 'slide-left':
            return {
                opacity: eased,
                transform: `translate3d(${(1 - eased) * 28}px, 0, 0)`,
            };
        case 'pop':
            return {
                opacity: eased,
                transform: `scale(${0.92 + eased * 0.08})`,
            };
        case 'fade-in':
            return {
                opacity: eased,
            };
        default:
            return {
                opacity: eased,
                transform: `translate3d(0, ${(1 - eased) * 14}px, 0)`,
            };
    }
}

function normalizeEmphasisWords(words?: string[] | null): Set<string> {
    if (!Array.isArray(words)) return new Set();
    return new Set(words.map((word) => String(word || '').trim().toLowerCase()).filter(Boolean));
}

function subtitleTokens(text: string): string[] {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return [];
    const matches = normalized.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*|[\u4e00-\u9fff]|[^\s]/g);
    return (matches || []).map((token) => token.trim()).filter(Boolean);
}

function buildSubtitleSegments(
    words: string[],
    mode: 'punctuationOrPause' | 'time' | 'singleWord',
    linesPerCaption: number,
    durationSeconds: number
): string[][] {
    if (words.length === 0) return [];
    if (mode === 'singleWord') return words.map((word) => [word]);

    if (mode === 'time') {
        const targetSegments = Math.max(1, Math.min(words.length, Math.round(Math.max(0.5, durationSeconds) / 0.8)));
        const wordsPerSegment = Math.max(1, Math.ceil(words.length / targetSegments));
        const segments: string[][] = [];
        for (let index = 0; index < words.length; index += wordsPerSegment) {
            segments.push(words.slice(index, index + wordsPerSegment));
        }
        return segments;
    }

    const segments: string[][] = [];
    let buffer: string[] = [];
    const softLimit = Math.max(3, linesPerCaption * 4);
    words.forEach((word) => {
        buffer.push(word);
        const punctuationBreak = /[.,!?;:，。！？；：]/.test(word);
        if (punctuationBreak || buffer.length >= softLimit) {
            segments.push(buffer);
            buffer = [];
        }
    });
    if (buffer.length > 0) {
        segments.push(buffer);
    }
    return segments;
}

function segmentToLines(words: string[], linesPerCaption: number): string[] {
    if (words.length === 0) return [];
    const safeLines = Math.max(1, linesPerCaption);
    const wordsPerLine = Math.max(1, Math.ceil(words.length / safeLines));
    const lines: string[] = [];
    for (let index = 0; index < words.length; index += wordsPerLine) {
        lines.push(words.slice(index, index + wordsPerLine).join(' '));
    }
    return lines;
}

function transitionAnimationStyle(
    kind: 'none' | 'fade' | 'slide' | 'wipe' | 'flip' | 'clock-wipe' | 'star' | 'circle' | 'rectangle',
    progress: number,
    direction?: 'from-left' | 'from-right' | 'from-top' | 'from-bottom'
): React.CSSProperties {
    const eased = Math.min(Math.max(progress, 0), 1);
    switch (kind) {
        case 'slide': {
            if (direction === 'from-left') {
                return { transform: `translate3d(${(eased - 1) * 42}px,0,0)`, opacity: eased };
            }
            if (direction === 'from-right') {
                return { transform: `translate3d(${(1 - eased) * 42}px,0,0)`, opacity: eased };
            }
            if (direction === 'from-top') {
                return { transform: `translate3d(0,${(eased - 1) * 32}px,0)`, opacity: eased };
            }
            return { transform: `translate3d(0,${(1 - eased) * 32}px,0)`, opacity: eased };
        }
        case 'wipe': {
            if (direction === 'from-left') {
                return { clipPath: `inset(0 ${Math.max(0, (1 - eased) * 100)}% 0 0 round 12px)` };
            }
            if (direction === 'from-right') {
                return { clipPath: `inset(0 0 0 ${Math.max(0, (1 - eased) * 100)}% round 12px)` };
            }
            if (direction === 'from-top') {
                return { clipPath: `inset(${Math.max(0, (1 - eased) * 100)}% 0 0 0 round 12px)` };
            }
            return { clipPath: `inset(0 0 ${Math.max(0, (1 - eased) * 100)}% 0 round 12px)` };
        }
        case 'flip':
            return {
                opacity: Math.max(0.35, eased),
                transform: `perspective(1200px) rotateY(${(1 - eased) * 72}deg) scale(${0.96 + eased * 0.04})`,
                transformOrigin: 'center center',
            };
        case 'clock-wipe':
            return {
                clipPath: `circle(${Math.max(8, eased * 82)}% at 50% 50%)`,
                opacity: eased,
            };
        case 'star':
            return {
                clipPath: 'polygon(50% 0%, 61% 36%, 98% 36%, 68% 57%, 79% 91%, 50% 69%, 21% 91%, 32% 57%, 2% 36%, 39% 36%)',
                transform: `scale(${0.24 + eased * 0.8})`,
                transformOrigin: 'center center',
                opacity: eased,
            };
        case 'circle':
            return {
                clipPath: `circle(${Math.max(6, eased * 80)}% at 50% 50%)`,
                opacity: eased,
            };
        case 'rectangle':
            return {
                clipPath: `inset(${Math.max(0, (1 - eased) * 44)}% ${Math.max(0, (1 - eased) * 28)}% round ${Math.max(12, eased * 28)}px)`,
                opacity: eased,
            };
        case 'fade':
            return { opacity: eased };
        default:
            return {};
    }
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
    trackOrder,
    trackUi,
    assetsById,
    motionComposition,
    selectedScene,
    selectedSceneItemId,
    selectedSceneItemIds,
    selectedSceneItemKind,
    guidesVisible,
    safeAreaVisible,
    itemTransforms,
    itemVisibility,
    itemOrder,
    itemLocks,
    itemGroups,
    focusedGroupId,
    onTogglePlayback,
    onSeekFrame,
    onStepFrame,
    onChangeRatioPreset,
    onSelectSceneItem,
    onUpdateItemTransform,
    onDeleteSceneItem,
    onDeleteSceneItems,
    onAlignSceneItems,
    onDistributeSceneItems,
    onSetSceneSelection,
    onDuplicateSceneItems,
}: TimelinePreviewCompositionProps) {
    const visualVideoRef = useRef<HTMLVideoElement | null>(null);
    const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
    const stageViewportRef = useRef<HTMLDivElement | null>(null);
    const stageRef = useRef<HTMLDivElement | null>(null);
    const [interaction, setInteraction] = useState<InteractionState | null>(null);
    const [marquee, setMarquee] = useState<MarqueeState | null>(null);
    const [stageRenderSize, setStageRenderSize] = useState({ width: 0, height: 0 });
    const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
    const trackOrderIndex = useMemo(
        () => buildTrackOrderIndex(trackOrder, timelineClips),
        [timelineClips, trackOrder]
    );
    const compareActiveClips = (left: TimelineClipLike, right: TimelineClipLike) => {
        const trackDelta = trackOrderValue(String(left.track || '').trim(), trackOrderIndex)
            - trackOrderValue(String(right.track || '').trim(), trackOrderIndex);
        if (trackDelta !== 0) return trackDelta;
        const startDelta = Number(left.startSeconds || 0) - Number(right.startSeconds || 0);
        if (Math.abs(startDelta) > 0.0001) return startDelta;
        return String(left.clipId || '').localeCompare(String(right.clipId || ''), 'zh-CN');
    };

    const visibleClips = useMemo(
        () => timelineClips.filter((clip) => {
            const trackId = String(clip.track || '').trim();
            return clip.enabled !== false && !trackUi[trackId]?.hidden;
        }),
        [timelineClips, trackUi]
    );

    const activeClips = useMemo(
        () => visibleClips.filter((clip) => isActiveAtTime(clip, currentTime)),
        [currentTime, visibleClips]
    );

    const activeAudioClips = useMemo(
        () => activeClips.filter((clip) => normalizeAssetKind(clip) === 'audio'),
        [activeClips]
    );
    const activeSubtitleClips = useMemo(
        () => activeClips.filter((clip) => isSubtitleClip(clip)),
        [activeClips]
    );
    const activeTextClips = useMemo(
        () => activeClips.filter((clip) => isTextClip(clip)),
        [activeClips]
    );

    const activeSoloAudioClips = useMemo(
        () => activeAudioClips.filter((clip) => {
            const trackId = String(clip.track || '').trim();
            return !!trackUi[trackId]?.solo;
        }),
        [activeAudioClips, trackUi]
    );

    const activeAudibleClips = useMemo(() => {
        const source = activeSoloAudioClips.length > 0 ? activeSoloAudioClips : activeAudioClips;
        return source.filter((clip) => {
            const trackId = String(clip.track || '').trim();
            return !trackUi[trackId]?.muted;
        });
    }, [activeAudioClips, activeSoloAudioClips, trackUi]);

    const activeVisualClip = useMemo(
        () =>
            [...activeClips]
                .filter((clip) => {
                    const kind = normalizeAssetKind(clip);
                    return (kind === 'video' || kind === 'image') && !isSubtitleClip(clip);
                })
                .sort(compareActiveClips)[0] || null,
        [activeClips, trackOrderIndex]
    );

    const previousVisualClip = useMemo(() => {
        if (!activeVisualClip) return null;
        const activeStart = Number(activeVisualClip.startSeconds || 0);
        const candidates = visibleClips
            .filter((clip) => {
                const kind = normalizeAssetKind(clip);
                const start = Number(clip.startSeconds || 0);
                return (kind === 'video' || kind === 'image') && !isSubtitleClip(clip) && start < activeStart;
            })
            .sort((left, right) => Number(right.startSeconds || 0) - Number(left.startSeconds || 0));
        return candidates[0] || null;
    }, [activeVisualClip, visibleClips]);

    const activeAudioClip = useMemo(
        () =>
            [...activeAudibleClips]
                .sort(compareActiveClips)[0] || null,
        [activeAudibleClips, trackOrderIndex]
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
    const previousVisualAssetId = String(previousVisualClip?.assetId || '').trim();
    const previousVisualAsset = previousVisualAssetId ? assetsById[previousVisualAssetId] || null : null;
    const previousVisualAssetUrl = resolveAssetUrl(
        previousVisualAsset?.previewUrl
        || previousVisualAsset?.absolutePath
        || previousVisualAsset?.relativePath
        || String(previousVisualClip?.mediaPath || '')
    );
    const audioAssetId = String(activeAudioClip?.assetId || '').trim();
    const audioAsset = audioAssetId ? assetsById[audioAssetId] || null : null;
    const audioAssetUrl = resolveAssetUrl(
        audioAsset?.previewUrl
        || audioAsset?.absolutePath
        || audioAsset?.relativePath
        || String(activeAudioClip?.mediaPath || '')
    );
    const activeAudioTrackId = String(activeAudioClip?.track || '').trim();
    const activeAudioTrackVolume = clampNumber(Number(trackUi[activeAudioTrackId]?.volume ?? 1), 0, 1);
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
    const activeTransition = useMemo(() => {
        if (!activeVisualClip) return null;
        const preset = resolveTransitionPreset(activeVisualClip.transitionStyle?.presetId);
        const style = {
            ...preset,
            ...(activeVisualClip.transitionStyle || {}),
        };
        const durationMs = Math.max(0, Number(style.durationMs || preset.durationMs || 0));
        if (!durationMs || !previousVisualClip) return null;
        const start = Number(activeVisualClip.startSeconds || 0);
        const progress = (currentTime - start) / Math.max(0.1, durationMs / 1000);
        if (progress < 0 || progress > 1) return null;
        return {
            kind: (style.kind || preset.kind || 'none') as 'none' | 'fade' | 'slide' | 'wipe' | 'flip' | 'clock-wipe' | 'star' | 'circle' | 'rectangle',
            direction: (style.direction || preset.direction || undefined) as 'from-left' | 'from-right' | 'from-top' | 'from-bottom' | undefined,
            progress,
            label: preset.label,
            accent: preset.accent,
            durationMs,
        };
    }, [activeVisualClip, currentTime, previousVisualClip]);
    const previewMotionComposition = useMemo<RemotionCompositionConfig | null>(() => {
        if (!motionComposition?.scenes?.length) return null;
        return {
            ...motionComposition,
            renderMode: 'motion-layer',
        };
    }, [motionComposition]);
    const hasMotionPreviewLayer = !!previewMotionComposition?.scenes?.length;
    const remotionFrame = Math.max(
        0,
        Math.min(currentFrame, Math.max(0, (previewMotionComposition?.durationInFrames || 1) - 1))
    );

    const subtitleLayers = useMemo(() => {
        return activeSubtitleClips
            .map((clip, index) => {
                const text = String(clip.name || '').trim();
                if (!text) return null;
                const preset = resolveSubtitlePreset(clip.subtitleStyle?.presetId);
                const style = {
                    ...preset,
                    ...(clip.subtitleStyle || {}),
                };
                const position = style.position || preset.position || 'bottom';
                const bottom = position === 'top' ? undefined : position === 'center' ? undefined : 72 + index * 54;
                const top = position === 'top' ? 72 + index * 54 : position === 'center' ? '50%' : undefined;
                const clipStart = Number(clip.startSeconds || 0);
                const clipEnd = Number(clip.endSeconds || 0);
                const duration = Math.max(0.1, clipEnd - clipStart);
                const progress = (currentTime - clipStart) / duration;
                const words = subtitleTokens(text);
                const segmentationMode = (style.segmentationMode || 'punctuationOrPause') as 'punctuationOrPause' | 'time' | 'singleWord';
                const linesPerCaption = Math.max(1, Number(style.linesPerCaption || 1));
                const segments = buildSubtitleSegments(words, segmentationMode, linesPerCaption, duration);
                const normalizedProgress = clampNumber(progress, 0, 0.999);
                const activeSegmentIndex = segments.length > 0
                    ? Math.min(segments.length - 1, Math.max(0, Math.floor(normalizedProgress * segments.length)))
                    : -1;
                const activeSegmentWords = activeSegmentIndex >= 0 ? segments[activeSegmentIndex] : words;
                const localSegmentProgress = activeSegmentIndex >= 0
                    ? clampNumber(normalizedProgress * Math.max(1, segments.length) - activeSegmentIndex, 0, 0.999)
                    : normalizedProgress;
                const activeWordIndex = activeSegmentWords.length > 0
                    ? Math.min(activeSegmentWords.length - 1, Math.max(0, Math.floor(localSegmentProgress * activeSegmentWords.length)))
                    : -1;
                return {
                    clipId: String(clip.clipId || `subtitle-${index}`),
                    id: `${String(clip.clipId || `subtitle-${index}`)}:subtitle`,
                    text,
                    words: activeSegmentWords,
                    lines: segmentToLines(activeSegmentWords, linesPerCaption),
                    bottom,
                    top,
                    position,
                    fontSize: Number(style.fontSize || preset.fontSize || 34),
                    color: String(style.color || preset.color || '#ffffff'),
                    backgroundColor: String(style.backgroundColor || preset.backgroundColor || 'rgba(6, 8, 12, 0.58)'),
                    emphasisColor: String(style.emphasisColor || preset.emphasisColor || '#facc15'),
                    align: style.align || preset.align || 'center',
                    animation: style.animation || preset.animation || 'fade-up',
                    fontWeight: Number(style.fontWeight || preset.fontWeight || 700),
                    textTransform: style.textTransform || preset.textTransform || 'none',
                    letterSpacing: Number(style.letterSpacing || preset.letterSpacing || 0),
                    borderRadius: Number(style.borderRadius || preset.borderRadius || 22),
                    paddingX: Number(style.paddingX || preset.paddingX || 20),
                    paddingY: Number(style.paddingY || preset.paddingY || 12),
                    emphasisWords: normalizeEmphasisWords(style.emphasisWords),
                    segmentationMode,
                    linesPerCaption,
                    segmentCount: segments.length || 1,
                    activeSegmentIndex,
                    activeWordIndex,
                    progress,
                };
            })
            .filter(Boolean) as Array<{
                clipId: string;
                id: string;
                text: string;
                words: string[];
                lines: string[];
                bottom?: number;
                top?: number | string;
                position: 'top' | 'center' | 'bottom';
                fontSize: number;
                color: string;
                backgroundColor: string;
                emphasisColor: string;
                align: 'left' | 'center' | 'right';
                animation: 'fade-up' | 'fade-in' | 'pop' | 'slide-left';
                fontWeight: number;
                textTransform: 'none' | 'uppercase';
                letterSpacing: number;
                borderRadius: number;
                paddingX: number;
                paddingY: number;
                emphasisWords: Set<string>;
                segmentationMode: 'punctuationOrPause' | 'time' | 'singleWord';
                linesPerCaption: number;
                segmentCount: number;
                activeSegmentIndex: number;
                activeWordIndex: number;
                progress: number;
            }>;
    }, [activeSubtitleClips, currentTime]);

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
        if (selectedScene?.overlayTitle && titleId && !hasMotionPreviewLayer) {
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
        if (overlayText && overlayId && !hasMotionPreviewLayer) {
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
        activeTextClips.forEach((clip, index) => {
            const clipId = String(clip.clipId || '').trim();
            const text = String(clip.name || '').trim();
            if (!clipId || !text) return;
            const clipStart = Number(clip.startSeconds || 0);
            const clipEnd = Number(clip.endSeconds || 0);
            const duration = Math.max(0.1, clipEnd - clipStart);
            items.push({
                id: `${clipId}:text`,
                kind: 'text',
                label: `文本 ${index + 1}`,
                contentType: 'text',
                text,
                textStyle: clip.textStyle || {},
                progress: (currentTime - clipStart) / duration,
                transform: itemTransforms[`${clipId}:text`] || getDefaultTransform({
                    kind: 'text',
                    stageWidth: safeStageWidth,
                    stageHeight: safeStageHeight,
                    lockAspectRatio: false,
                }),
            });
        });
        subtitleLayers.forEach((layer, index) => {
            items.push({
                id: layer.id,
                kind: 'subtitle',
                label: `字幕 ${index + 1}`,
                contentType: 'text',
                text: layer.text,
                subtitleLayer: {
                    lines: layer.lines,
                    position: layer.position,
                    fontSize: layer.fontSize,
                    color: layer.color,
                    backgroundColor: layer.backgroundColor,
                    emphasisColor: layer.emphasisColor,
                    align: layer.align,
                    animation: layer.animation,
                    fontWeight: layer.fontWeight,
                    textTransform: layer.textTransform,
                    letterSpacing: layer.letterSpacing,
                    borderRadius: layer.borderRadius,
                    paddingX: layer.paddingX,
                    paddingY: layer.paddingY,
                    emphasisWords: layer.emphasisWords,
                    segmentationMode: layer.segmentationMode,
                    segmentCount: layer.segmentCount,
                    activeSegmentIndex: layer.activeSegmentIndex,
                    activeWordIndex: layer.activeWordIndex,
                    words: layer.words,
                },
                progress: layer.progress,
                transform: itemTransforms[layer.id] || getDefaultTransform({
                    kind: 'subtitle',
                    stageWidth: safeStageWidth,
                    stageHeight: safeStageHeight,
                    lockAspectRatio: false,
                }),
            });
        });
        return items;
    }, [activeAudioClip, activeClipId, activeTextClips, activeVisualClip, audioAssetUrl, currentTime, hasMotionPreviewLayer, itemTransforms, overlayId, overlayText, safeStageHeight, safeStageWidth, selectedScene, subtitleLayers, titleId, visualAsset, visualAssetUrl, visualKind]);

    const selectedStageItem = useMemo(
        () => stageItems.find((item) => item.id === selectedSceneItemId) || null,
        [selectedSceneItemId, stageItems]
    );
    const selectedStageItemIds = useMemo(
        () => Array.from(new Set(selectedSceneItemIds.filter((id) => stageItems.some((item) => item.id === id)))),
        [selectedSceneItemIds, stageItems]
    );
    const selectedStageItemIdSet = useMemo(
        () => new Set(selectedStageItemIds),
        [selectedStageItemIds]
    );
    const selectedStageItems = useMemo(
        () => stageItems.filter((item) => selectedStageItemIdSet.has(item.id)),
        [selectedStageItemIdSet, stageItems]
    );
    const stageOrderIndex = useMemo(
        () => new Map(itemOrder.map((id, index) => [id, index])),
        [itemOrder]
    );
    const sortedStageItems = useMemo(
        () => [...stageItems].sort((left, right) => (stageOrderIndex.get(right.id) ?? -1) - (stageOrderIndex.get(left.id) ?? -1)),
        [stageItems, stageOrderIndex]
    );
    const visibleStageItems = useMemo(
        () => sortedStageItems.filter((item) => {
            if (itemVisibility[item.id] === false) return false;
            if (focusedGroupId && itemGroups[item.id] !== focusedGroupId) return false;
            return true;
        }),
        [focusedGroupId, itemGroups, itemVisibility, sortedStageItems]
    );
    const lockedStageItemIdSet = useMemo(
        () => new Set(Object.entries(itemLocks).filter(([, locked]) => locked).map(([id]) => id)),
        [itemLocks]
    );
    const marqueeBox = useMemo(() => {
        if (!marquee || !stageRef.current) return null;
        const rect = stageRef.current.getBoundingClientRect();
        const left = Math.max(0, Math.min(marquee.startClientX, marquee.currentClientX) - rect.left);
        const top = Math.max(0, Math.min(marquee.startClientY, marquee.currentClientY) - rect.top);
        const right = Math.min(rect.width, Math.max(marquee.startClientX, marquee.currentClientX) - rect.left);
        const bottom = Math.min(rect.height, Math.max(marquee.startClientY, marquee.currentClientY) - rect.top);
        return {
            left,
            top,
            width: Math.max(0, right - left),
            height: Math.max(0, bottom - top),
        };
    }, [marquee]);

    const activeAudioLayers = useMemo(() => {
        return activeAudibleClips
            .map((clip) => {
                const clipId = String(clip.clipId || '').trim();
                if (!clipId) return null;
                const assetId = String(clip.assetId || '').trim();
                const asset = assetId ? assetsById[assetId] || null : null;
                const src = resolveAssetUrl(
                    asset?.previewUrl
                    || asset?.absolutePath
                    || asset?.relativePath
                    || String(clip.mediaPath || '')
                );
                if (!src) return null;
                const trackId = String(clip.track || '').trim();
                return {
                    clipId,
                    src,
                    localTime: Math.max(0, currentTime - Number(clip.startSeconds || 0) + Number(clip.trimInMs || 0) / 1000),
                    volume: clampNumber(Number(trackUi[trackId]?.volume ?? 1), 0, 1),
                };
            })
            .filter(Boolean) as Array<{ clipId: string; src: string; localTime: number; volume: number }>;
    }, [activeAudibleClips, assetsById, currentTime, trackUi]);

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
        const activeIds = new Set(activeAudioLayers.map((layer) => layer.clipId));
        Object.entries(audioRefs.current).forEach(([clipId, element]) => {
            if (!element) return;
            if (!activeIds.has(clipId)) {
                element.pause();
                delete audioRefs.current[clipId];
            }
        });

        activeAudioLayers.forEach((layer) => {
            const audio = audioRefs.current[layer.clipId];
            if (!audio) return;
            if (Math.abs((audio.currentTime || 0) - layer.localTime) > 0.08) {
                audio.currentTime = layer.localTime;
            }
            audio.volume = layer.volume;
            if (isPlaying) {
                void audio.play().catch(() => undefined);
            } else {
                audio.pause();
            }
        });
    }, [activeAudioLayers, isPlaying]);

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
        const safeInsetX = safeStageWidth * 0.08;
        const safeInsetY = safeStageHeight * 0.08;
        const snapThreshold = Math.max(8, Math.min(safeStageWidth, safeStageHeight) * 0.012);
        const objectTargets = buildObjectSnapTargets(stageItems, interaction.itemId, {
            width: interaction.initialTransform.width,
            height: interaction.initialTransform.height,
        });

        const snapTransform = (
            transform: SceneItemTransform,
            resizeHandle?: string
        ): { next: SceneItemTransform; guides: SnapGuide[] } => {
            const next = { ...transform };
            const guides: SnapGuide[] = [];
            const handle = resizeHandle || '';

            if (!resizeHandle || interaction.mode === 'drag') {
                const xSnap = applyAxisSnap(next.x, [
                    { value: 0, guide: { orientation: 'vertical', position: 0, tone: 'edge' } },
                    { value: safeInsetX, guide: { orientation: 'vertical', position: safeInsetX, tone: 'safe' } },
                    { value: safeStageWidth / 2 - next.width / 2, guide: { orientation: 'vertical', position: safeStageWidth / 2, tone: 'center' } },
                    { value: safeStageWidth - safeInsetX - next.width, guide: { orientation: 'vertical', position: safeStageWidth - safeInsetX, tone: 'safe' } },
                    { value: safeStageWidth - next.width, guide: { orientation: 'vertical', position: safeStageWidth, tone: 'edge' } },
                    ...objectTargets.dragX,
                ], snapThreshold);
                next.x = xSnap.value;
                if (xSnap.guide) guides.push(xSnap.guide);

                const ySnap = applyAxisSnap(next.y, [
                    { value: 0, guide: { orientation: 'horizontal', position: 0, tone: 'edge' } },
                    { value: safeInsetY, guide: { orientation: 'horizontal', position: safeInsetY, tone: 'safe' } },
                    { value: safeStageHeight / 2 - next.height / 2, guide: { orientation: 'horizontal', position: safeStageHeight / 2, tone: 'center' } },
                    { value: safeStageHeight - safeInsetY - next.height, guide: { orientation: 'horizontal', position: safeStageHeight - safeInsetY, tone: 'safe' } },
                    { value: safeStageHeight - next.height, guide: { orientation: 'horizontal', position: safeStageHeight, tone: 'edge' } },
                    ...objectTargets.dragY,
                ], snapThreshold);
                next.y = ySnap.value;
                if (ySnap.guide) guides.push(ySnap.guide);
                return { next, guides };
            }

            if (handle.includes('e')) {
                const rightSnap = applyAxisSnap(next.x + next.width, [
                    { value: safeInsetX, guide: { orientation: 'vertical', position: safeInsetX, tone: 'safe' } },
                    { value: safeStageWidth / 2, guide: { orientation: 'vertical', position: safeStageWidth / 2, tone: 'center' } },
                    { value: safeStageWidth - safeInsetX, guide: { orientation: 'vertical', position: safeStageWidth - safeInsetX, tone: 'safe' } },
                    { value: safeStageWidth, guide: { orientation: 'vertical', position: safeStageWidth, tone: 'edge' } },
                    ...objectTargets.right,
                ], snapThreshold);
                if (rightSnap.guide) {
                    next.width = Math.max(next.minWidth, rightSnap.value - next.x);
                    guides.push(rightSnap.guide);
                }
            }
            if (handle.includes('w')) {
                const leftSnap = applyAxisSnap(next.x, [
                    { value: 0, guide: { orientation: 'vertical', position: 0, tone: 'edge' } },
                    { value: safeInsetX, guide: { orientation: 'vertical', position: safeInsetX, tone: 'safe' } },
                    { value: safeStageWidth / 2, guide: { orientation: 'vertical', position: safeStageWidth / 2, tone: 'center' } },
                    { value: safeStageWidth - safeInsetX, guide: { orientation: 'vertical', position: safeStageWidth - safeInsetX, tone: 'safe' } },
                    ...objectTargets.left,
                ], snapThreshold);
                if (leftSnap.guide) {
                    const right = next.x + next.width;
                    next.x = leftSnap.value;
                    next.width = Math.max(next.minWidth, right - next.x);
                    guides.push(leftSnap.guide);
                }
            }
            if (handle.includes('s')) {
                const bottomSnap = applyAxisSnap(next.y + next.height, [
                    { value: safeInsetY, guide: { orientation: 'horizontal', position: safeInsetY, tone: 'safe' } },
                    { value: safeStageHeight / 2, guide: { orientation: 'horizontal', position: safeStageHeight / 2, tone: 'center' } },
                    { value: safeStageHeight - safeInsetY, guide: { orientation: 'horizontal', position: safeStageHeight - safeInsetY, tone: 'safe' } },
                    { value: safeStageHeight, guide: { orientation: 'horizontal', position: safeStageHeight, tone: 'edge' } },
                    ...objectTargets.bottom,
                ], snapThreshold);
                if (bottomSnap.guide) {
                    next.height = Math.max(next.minHeight, bottomSnap.value - next.y);
                    guides.push(bottomSnap.guide);
                }
            }
            if (handle.includes('n')) {
                const topSnap = applyAxisSnap(next.y, [
                    { value: 0, guide: { orientation: 'horizontal', position: 0, tone: 'edge' } },
                    { value: safeInsetY, guide: { orientation: 'horizontal', position: safeInsetY, tone: 'safe' } },
                    { value: safeStageHeight / 2, guide: { orientation: 'horizontal', position: safeStageHeight / 2, tone: 'center' } },
                    { value: safeStageHeight - safeInsetY, guide: { orientation: 'horizontal', position: safeStageHeight - safeInsetY, tone: 'safe' } },
                    ...objectTargets.top,
                ], snapThreshold);
                if (topSnap.guide) {
                    const bottom = next.y + next.height;
                    next.y = topSnap.value;
                    next.height = Math.max(next.minHeight, bottom - next.y);
                    guides.push(topSnap.guide);
                }
            }

            return { next, guides };
        };

        const handlePointerMove = (event: PointerEvent) => {
            const deltaX = (event.clientX - interaction.startClientX) * scaleX;
            const deltaY = (event.clientY - interaction.startClientY) * scaleY;
            const next = { ...interaction.initialTransform };

            if (interaction.mode === 'drag') {
                if (interaction.selectedTransforms && Object.keys(interaction.selectedTransforms).length > 1) {
                    const guides: SnapGuide[] = [];
                    Object.entries(interaction.selectedTransforms).forEach(([itemId, initialTransform], index) => {
                        const candidate = {
                            ...initialTransform,
                            x: clampNumber(
                                initialTransform.x + deltaX,
                                -initialTransform.width * 0.35,
                                safeStageWidth - initialTransform.width * 0.65
                            ),
                            y: clampNumber(
                                initialTransform.y + deltaY,
                                -initialTransform.height * 0.35,
                                safeStageHeight - initialTransform.height * 0.65
                            ),
                        };
                        if (itemId === interaction.itemId) {
                            const snapped = snapTransform(candidate);
                            guides.push(...snapped.guides);
                            onUpdateItemTransform(itemId, snapped.next);
                            return;
                        }
                        onUpdateItemTransform(itemId, candidate);
                    });
                    setSnapGuides(guides);
                    return;
                }
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
                const snapped = snapTransform(next);
                setSnapGuides(snapped.guides);
                onUpdateItemTransform(interaction.itemId, snapped.next);
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
            const snapped = snapTransform(next, handle);
            setSnapGuides(snapped.guides);
            onUpdateItemTransform(interaction.itemId, snapped.next);
        };

        const handlePointerUp = () => {
            setSnapGuides([]);
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
    }, [interaction, onUpdateItemTransform, safeStageHeight, safeStageWidth, visibleStageItems]);

    useEffect(() => {
        if (!marquee || !stageRef.current) return;

        const handlePointerMove = (event: PointerEvent) => {
            setMarquee((current) => current ? {
                ...current,
                currentClientX: event.clientX,
                currentClientY: event.clientY,
            } : current);
        };

        const handlePointerUp = () => {
            const rect = stageRef.current?.getBoundingClientRect();
            if (!rect) {
                setMarquee(null);
                return;
            }
            const left = Math.min(marquee.startClientX, marquee.currentClientX) - rect.left;
            const top = Math.min(marquee.startClientY, marquee.currentClientY) - rect.top;
            const right = Math.max(marquee.startClientX, marquee.currentClientX) - rect.left;
            const bottom = Math.max(marquee.startClientY, marquee.currentClientY) - rect.top;
            const width = Math.max(0, right - left);
            const height = Math.max(0, bottom - top);

            if (width < 4 && height < 4) {
                if (!marquee.additive) {
                    onSetSceneSelection([], null);
                }
                setMarquee(null);
                return;
            }

            const hits = visibleStageItems.filter((item) => {
                const itemLeft = (item.transform.x / safeStageWidth) * rect.width;
                const itemTop = (item.transform.y / safeStageHeight) * rect.height;
                const itemRight = ((item.transform.x + item.transform.width) / safeStageWidth) * rect.width;
                const itemBottom = ((item.transform.y + item.transform.height) / safeStageHeight) * rect.height;
                return itemLeft <= right && itemRight >= left && itemTop <= bottom && itemBottom >= top;
            }).map((item) => item.id);

            const nextIds = marquee.additive
                ? Array.from(new Set([...selectedStageItemIds, ...hits]))
                : hits;
            onSetSceneSelection(nextIds, nextIds[0] || null);
            setMarquee(null);
        };

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);
        window.addEventListener('pointercancel', handlePointerUp);
        return () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
            window.removeEventListener('pointercancel', handlePointerUp);
        };
    }, [marquee, onSetSceneSelection, safeStageHeight, safeStageWidth, selectedStageItemIds, visibleStageItems]);

    useEffect(() => {
        if (!stageRef.current || !selectedSceneItemId || !selectedSceneItemKind) return;

        const handleKeyDown = (event: KeyboardEvent) => {
            const activeElement = document.activeElement as HTMLElement | null;
            if (!activeElement || !stageRef.current?.contains(activeElement)) return;
            const tagName = activeElement.tagName.toLowerCase();
            const isTyping = tagName === 'input' || tagName === 'textarea' || activeElement.isContentEditable;
            if (isTyping) return;
            if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                onDeleteSceneItems(
                    selectedStageItems
                        .filter((item) => !lockedStageItemIdSet.has(item.id))
                        .map((item) => ({ kind: item.kind, id: item.id }))
                );
                return;
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
                event.preventDefault();
                onDuplicateSceneItems(selectedStageItems.filter((item) => !lockedStageItemIdSet.has(item.id)).map((item) => item.id));
                return;
            }
            const editableSelectedStageItems = selectedStageItems.filter((item) => !lockedStageItemIdSet.has(item.id));
            if (!editableSelectedStageItems.length) return;
            const step = event.shiftKey ? 10 : 1;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault();
                if (event.altKey) {
                    const widthDelta = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
                    const heightDelta = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
                    editableSelectedStageItems.forEach((item) => {
                        onUpdateItemTransform(item.id, {
                            width: Math.max(item.transform.minWidth, item.transform.width + widthDelta),
                            height: Math.max(item.transform.minHeight, item.transform.height + heightDelta),
                        });
                    });
                    return;
                }
                const deltaX = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
                const deltaY = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
                editableSelectedStageItems.forEach((item) => {
                    onUpdateItemTransform(item.id, {
                        x: clampNumber(item.transform.x + deltaX, -item.transform.width * 0.35, safeStageWidth - item.transform.width * 0.65),
                        y: clampNumber(item.transform.y + deltaY, -item.transform.height * 0.35, safeStageHeight - item.transform.height * 0.65),
                    });
                });
            }
        };

        document.addEventListener('keydown', handleKeyDown, true);
        return () => {
            document.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [lockedStageItemIdSet, onDeleteSceneItems, onDuplicateSceneItems, onUpdateItemTransform, safeStageHeight, safeStageWidth, selectedSceneItemId, selectedSceneItemKind, selectedStageItems]);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
                <div ref={stageViewportRef} className="flex h-full w-full items-center justify-center">
                    <div
                        ref={stageRef}
                        tabIndex={0}
                        className="relative overflow-hidden rounded-[18px] bg-[#050505]"
                        onPointerDown={(event) => {
                            if (event.target !== event.currentTarget) return;
                            stageRef.current?.focus({ preventScroll: true });
                            setMarquee({
                                startClientX: event.clientX,
                                startClientY: event.clientY,
                                currentClientX: event.clientX,
                                currentClientY: event.clientY,
                                additive: event.metaKey || event.ctrlKey || event.shiftKey,
                            });
                        }}
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
                                {snapGuides.map((guide, index) => (
                                    <div
                                        key={`${guide.orientation}-${guide.position}-${index}`}
                                        className={clsx(
                                            'pointer-events-none absolute z-20',
                                            guide.orientation === 'vertical'
                                                ? 'inset-y-0 w-[2px] -translate-x-1/2'
                                                : 'inset-x-0 h-[2px] -translate-y-1/2',
                                            guide.tone === 'center'
                                                ? 'bg-cyan-300/80 shadow-[0_0_0_1px_rgba(103,232,249,0.18)]'
                                                : guide.tone === 'safe'
                                                    ? 'bg-emerald-300/75 shadow-[0_0_0_1px_rgba(110,231,183,0.18)]'
                                                    : guide.tone === 'object'
                                                        ? 'bg-fuchsia-300/75 shadow-[0_0_0_1px_rgba(232,121,249,0.18)]'
                                                    : 'bg-amber-300/70 shadow-[0_0_0_1px_rgba(252,211,77,0.18)]'
                                        )}
                                        style={guide.orientation === 'vertical' ? { left: `${(guide.position / safeStageWidth) * 100}%` } : { top: `${(guide.position / safeStageHeight) * 100}%` }}
                                    />
                                ))}
                            </>
                        ) : null}
                        {safeAreaVisible ? (
                            <div className="pointer-events-none absolute inset-[8%] z-10 rounded-[18px] border border-dashed border-cyan-300/25" />
                        ) : null}

                        {activeAudioLayers.map((layer) => (
                            <audio
                                key={layer.clipId}
                                ref={(element) => {
                                    if (element) {
                                        audioRefs.current[layer.clipId] = element;
                                    } else {
                                        delete audioRefs.current[layer.clipId];
                                    }
                                }}
                                src={layer.src}
                                className="hidden"
                                preload="auto"
                            />
                        ))}

                        {previewMotionComposition ? (
                            <div className="pointer-events-none absolute inset-0 z-[25] overflow-hidden">
                                <Thumbnail
                                    component={VideoMotionComposition as unknown as React.ComponentType<Record<string, unknown>>}
                                    frameToDisplay={remotionFrame}
                                    durationInFrames={previewMotionComposition.durationInFrames}
                                    compositionWidth={previewMotionComposition.width}
                                    compositionHeight={previewMotionComposition.height}
                                    fps={previewMotionComposition.fps}
                                    style={{
                                        width: '100%',
                                        height: '100%',
                                    }}
                                    inputProps={{
                                        composition: previewMotionComposition,
                                        runtime: 'preview',
                                    }}
                                />
                            </div>
                        ) : null}

                        {visibleStageItems.length === 0 && !hasMotionPreviewLayer ? (
                            <div className="absolute inset-0 z-20 flex items-center justify-center text-center text-white/55">
                                <div>
                                    <Clapperboard className="mx-auto h-10 w-10 text-white/35" />
                                    <div className="mt-3 text-sm">{focusedGroupId ? '当前组内没有可编辑对象' : '时间轴里还没有可预览片段'}</div>
                                    <div className="mt-1 text-xs text-white/35">{focusedGroupId ? '退出组内编辑后可继续查看全部对象。' : '先添加轨道，再把素材拖入时间轴。'}</div>
                                </div>
                            </div>
                        ) : null}

                        {marqueeBox ? (
                            <div
                                className="pointer-events-none absolute z-30 rounded-[14px] border border-cyan-300/55 bg-cyan-400/12 shadow-[0_0_0_1px_rgba(103,232,249,0.14)]"
                                style={{
                                    left: marqueeBox.left,
                                    top: marqueeBox.top,
                                    width: marqueeBox.width,
                                    height: marqueeBox.height,
                                }}
                            />
                        ) : null}

                        {selectedStageItems.length > 1 ? (
                            <div className="absolute left-4 top-4 z-40 flex items-center gap-2 rounded-full border border-white/10 bg-black/72 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/82 shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
                                <span>{selectedStageItems.length} objects</span>
                                {([
                                    ['left', 'L'],
                                    ['center', 'C'],
                                    ['right', 'R'],
                                    ['top', 'T'],
                                    ['middle', 'M'],
                                    ['bottom', 'B'],
                                ] as const).map(([mode, label]) => (
                                    <button
                                        key={mode}
                                        type="button"
                                        onClick={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            onAlignSceneItems(mode);
                                        }}
                                        className="pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-[10px] text-white/80 transition hover:border-cyan-300/45 hover:bg-cyan-400/14 hover:text-cyan-100"
                                    >
                                        {label}
                                    </button>
                                ))}
                                <button
                                    type="button"
                                    onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        onDistributeSceneItems('horizontal');
                                    }}
                                    className="pointer-events-auto inline-flex rounded-full border border-white/10 bg-white/[0.05] px-2 py-1 text-[10px] text-white/80 transition hover:border-cyan-300/45 hover:bg-cyan-400/14 hover:text-cyan-100"
                                >
                                    DX
                                </button>
                                <button
                                    type="button"
                                    onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        onDistributeSceneItems('vertical');
                                    }}
                                    className="pointer-events-auto inline-flex rounded-full border border-white/10 bg-white/[0.05] px-2 py-1 text-[10px] text-white/80 transition hover:border-cyan-300/45 hover:bg-cyan-400/14 hover:text-cyan-100"
                                >
                                    DY
                                </button>
                            </div>
                        ) : null}

                        {visibleStageItems.map((item) => {
                            const inFocusedGroup = !focusedGroupId || itemGroups[item.id] === focusedGroupId;
                            const isSelected = selectedStageItemIdSet.has(item.id) || (selectedSceneItemKind === item.kind && selectedSceneItemId === item.id);
                            const isLocked = lockedStageItemIdSet.has(item.id);
                            const groupId = itemGroups[item.id];
                            const groupedIds = groupId
                                ? visibleStageItems.filter((candidate) => itemGroups[candidate.id] === groupId).map((candidate) => candidate.id)
                                : [item.id];
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
                                        !inFocusedGroup && 'pointer-events-none opacity-18 grayscale',
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
                                            if (!inFocusedGroup) return;
                                            if (isLocked) {
                                                onSetSceneSelection(groupedIds, item.id);
                                                return;
                                            }
                                            const additive = event.metaKey || event.ctrlKey || event.shiftKey;
                                            const preserveSelection = !additive && selectedStageItemIdSet.has(item.id) && selectedStageItems.length > 1;
                                            const selectionSeed = groupedIds.length > 1 ? groupedIds : [item.id];
                                            const activeSelectionIds = selectedStageItemIdSet.has(item.id)
                                                ? selectedStageItemIds
                                                : [...selectedStageItemIds, ...selectionSeed];
                                            if (groupedIds.length > 1) {
                                                const nextIds = additive
                                                    ? Array.from(new Set([...selectedStageItemIds, ...groupedIds]))
                                                    : groupedIds;
                                                onSetSceneSelection(nextIds, item.id);
                                            } else {
                                                onSelectSceneItem(
                                                    item.kind,
                                                    item.id,
                                                    additive ? { additive: true } : preserveSelection ? { preserveSelection: true } : undefined
                                                );
                                            }
                                            setInteraction({
                                                itemId: item.id,
                                                mode: 'drag',
                                                startClientX: event.clientX,
                                                startClientY: event.clientY,
                                                initialTransform: item.transform,
                                                selectedTransforms: Object.fromEntries(
                                                    activeSelectionIds
                                                        .map((id) => {
                                                            const selectedItem = visibleStageItems.find((candidate) => candidate.id === id);
                                                            return selectedItem ? [id, selectedItem.transform] : null;
                                                        })
                                                        .filter((entry): entry is [string, SceneItemTransform] => !!entry)
                                                ),
                                            });
                                        }}
                                        className={clsx(
                                            'group relative h-full w-full rounded-[14px] border bg-transparent transition',
                                            isLocked && 'cursor-not-allowed opacity-85',
                                            isSelected
                                                ? 'border-cyan-300/80 shadow-[0_0_0_1px_rgba(103,232,249,0.45)]'
                                                : 'border-transparent hover:border-white/20'
                                        )}
                                    >
                                        {item.contentType === 'video' || item.contentType === 'image' ? (
                                            <div className="relative h-full w-full overflow-hidden rounded-[12px]">
                                                {item.id === activeClipId && activeTransition ? (
                                                    <div
                                                        className="absolute left-3 top-3 z-[2] inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/90 shadow-[0_12px_30px_rgba(15,23,42,0.35)]"
                                                        style={{
                                                            borderColor: `${activeTransition.accent}66`,
                                                            background: `linear-gradient(135deg, ${activeTransition.accent}2b, rgba(15,23,42,0.78))`,
                                                        }}
                                                    >
                                                        <span>{activeTransition.label}</span>
                                                        <span className="text-white/55">{Math.round(activeTransition.durationMs)}ms</span>
                                                    </div>
                                                ) : null}
                                                {item.id === activeClipId && previousVisualAssetUrl && activeTransition ? (
                                                    previousVisualClip && normalizeAssetKind(previousVisualClip) === 'video' ? (
                                                        <video
                                                            src={previousVisualAssetUrl}
                                                            className="absolute inset-0 h-full w-full rounded-[12px] object-contain"
                                                            muted
                                                            playsInline
                                                            preload="auto"
                                                        />
                                                    ) : (
                                                        <img
                                                            src={previousVisualAssetUrl}
                                                            alt=""
                                                            className="absolute inset-0 h-full w-full rounded-[12px] object-contain"
                                                        />
                                                    )
                                                ) : null}
                                                {item.contentType === 'video' ? (
                                                    <video
                                                        ref={item.id === activeClipId ? visualVideoRef : undefined}
                                                        key={item.id}
                                                        src={item.src}
                                                        className="absolute inset-0 h-full w-full rounded-[12px] object-contain"
                                                        style={item.id === activeClipId && activeTransition ? transitionAnimationStyle(activeTransition.kind, activeTransition.progress, activeTransition.direction) : undefined}
                                                        controls={false}
                                                        playsInline
                                                        preload="auto"
                                                    />
                                                ) : (
                                                    <img
                                                        src={item.src}
                                                        alt={item.label}
                                                        className="absolute inset-0 h-full w-full rounded-[12px] object-contain"
                                                        style={item.id === activeClipId && activeTransition ? transitionAnimationStyle(activeTransition.kind, activeTransition.progress, activeTransition.direction) : undefined}
                                                    />
                                                )}
                                            </div>
                                        ) : item.contentType === 'audio' ? (
                                            <div className="flex h-full w-full items-center justify-center rounded-[12px] bg-[radial-gradient(circle_at_top,rgba(217,70,239,0.2),transparent_55%)] text-white/75">
                                                <AudioLines className="h-8 w-8" />
                                            </div>
                                        ) : item.kind === 'subtitle' && item.subtitleLayer ? (
                                            <div
                                                className="flex h-full w-full flex-col justify-center rounded-[12px] border border-white/10 shadow-[0_16px_40px_rgba(0,0,0,0.28)]"
                                                style={{
                                                    fontSize: `${item.subtitleLayer.fontSize}px`,
                                                    color: item.subtitleLayer.color,
                                                    background: item.subtitleLayer.backgroundColor,
                                                    textAlign: item.subtitleLayer.align,
                                                    fontWeight: item.subtitleLayer.fontWeight,
                                                    textTransform: item.subtitleLayer.textTransform,
                                                    letterSpacing: `${item.subtitleLayer.letterSpacing}px`,
                                                    borderRadius: `${item.subtitleLayer.borderRadius}px`,
                                                    paddingLeft: `${item.subtitleLayer.paddingX}px`,
                                                    paddingRight: `${item.subtitleLayer.paddingX}px`,
                                                    paddingTop: `${item.subtitleLayer.paddingY}px`,
                                                    paddingBottom: `${item.subtitleLayer.paddingY}px`,
                                                    ...subtitleAnimationStyle(item.subtitleLayer.animation, item.progress || 0),
                                                }}
                                            >
                                                <div className="mb-2 flex items-center justify-between gap-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/55">
                                                    <span>{item.subtitleLayer.segmentationMode === 'singleWord' ? 'word' : item.subtitleLayer.segmentationMode === 'time' ? 'time' : 'pause'}</span>
                                                    <span>{item.subtitleLayer.activeSegmentIndex + 1}/{item.subtitleLayer.segmentCount}</span>
                                                </div>
                                                <div className="space-y-1.5">
                                                    {item.subtitleLayer.lines.map((line, lineIndex) => {
                                                        const lineWords = subtitleTokens(line);
                                                        let consumedWords = 0;
                                                        for (let index = 0; index < lineIndex; index += 1) {
                                                            consumedWords += subtitleTokens(item.subtitleLayer?.lines[index] || '').length;
                                                        }
                                                        return (
                                                            <div key={`${item.id}-line-${lineIndex}`} className="flex flex-wrap justify-center gap-x-[6px] gap-y-[4px]">
                                                                {lineWords.map((word, index) => {
                                                                    const absoluteIndex = consumedWords + index;
                                                                    const normalizedWord = word.replace(/[^\p{L}\p{N}_-]+/gu, '').toLowerCase();
                                                                    const emphasized = normalizedWord && item.subtitleLayer?.emphasisWords.has(normalizedWord);
                                                                    const activeWord = absoluteIndex === item.subtitleLayer?.activeWordIndex;
                                                                    return (
                                                                        <span
                                                                            key={`${item.id}-word-${lineIndex}-${index}`}
                                                                            style={{
                                                                                color: emphasized || activeWord ? item.subtitleLayer?.emphasisColor : undefined,
                                                                                display: 'inline-block',
                                                                                transform: activeWord ? 'translateY(-1px) scale(1.04)' : undefined,
                                                                                transition: 'color 120ms ease, transform 120ms ease, background-color 120ms ease',
                                                                                background: activeWord ? `${item.subtitleLayer?.emphasisColor}22` : undefined,
                                                                                borderRadius: activeWord ? 10 : undefined,
                                                                                padding: activeWord ? '0 4px' : undefined,
                                                                            }}
                                                                        >
                                                                            {word}
                                                                        </span>
                                                                    );
                                                                })}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        ) : (
                                            (() => {
                                                const resolvedTextStyle = item.kind === 'text'
                                                    ? {
                                                        ...resolveTextPreset(item.textStyle?.presetId),
                                                        ...(item.textStyle || {}),
                                                    }
                                                    : null;
                                                return (
                                            <div className={clsx(
                                                'flex h-full w-full items-center justify-center rounded-[12px] px-3 text-center',
                                                item.kind === 'title'
                                                    ? 'bg-black/38 text-lg font-semibold text-white'
                                                    : item.kind === 'text'
                                                        ? ''
                                                        : 'bg-black/45 text-sm leading-6 text-white/90'
                                            )}
                                            style={item.kind === 'text' && resolvedTextStyle
                                                ? {
                                                    background: resolvedTextStyle.backgroundColor || 'rgba(15, 23, 42, 0.42)',
                                                    color: resolvedTextStyle.color || '#ffffff',
                                                    textAlign: resolvedTextStyle.align || 'center',
                                                    fontSize: `${resolvedTextStyle.fontSize || 42}px`,
                                                    fontWeight: Number(resolvedTextStyle.fontWeight || 700),
                                                    ...subtitleAnimationStyle(resolvedTextStyle.animation, item.progress ?? 1),
                                                } : undefined}
                                            >
                                                {item.text}
                                            </div>
                                                );
                                            })()
                                        )}
                                        {isSelected && selectedStageItems.length <= 1 && !isLocked ? (
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
                                        {(isLocked || groupId) ? (
                                            <div className="absolute right-2 top-2 z-[2] flex items-center gap-1">
                                                {groupId ? (
                                                    <span className="rounded-full border border-fuchsia-300/35 bg-fuchsia-400/14 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-fuchsia-100">
                                                        group
                                                    </span>
                                                ) : null}
                                                {isLocked ? (
                                                    <span className="rounded-full border border-amber-300/35 bg-amber-400/14 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-amber-100">
                                                        lock
                                                    </span>
                                                ) : null}
                                            </div>
                                        ) : null}
                                    </button>
                                </div>
                            );
                        })}

                    </div>
                </div>
            </div>
            <div className="flex items-center justify-center pt-3">
                <button
                    type="button"
                    onClick={onTogglePlayback}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/58 text-white/88 transition hover:bg-black/72 hover:text-white"
                    title={isPlaying ? '暂停' : '播放'}
                >
                    {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="ml-0.5 h-3.5 w-3.5" />}
                </button>
            </div>
        </div>
    );
}
