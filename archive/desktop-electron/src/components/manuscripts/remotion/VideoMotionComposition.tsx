import React from 'react';
import {
    AbsoluteFill,
    Audio,
    Html5Video,
    Img,
    OffthreadVideo,
    interpolate,
    Sequence,
    spring,
    useCurrentFrame,
    useVideoConfig,
} from 'remotion';
import {
    extractLocalAssetPathCandidate,
    isLocalAssetSource,
} from '../../../../shared/localAsset';
import { resolveAssetUrl } from '../../../utils/pathManager';
import type {
    RemotionCompositionConfig,
    RemotionEntityAnimation,
    MotionPreset,
    OverlayAnimation,
    OverlayPosition,
    RemotionOverlay,
    RemotionScene,
    RemotionSceneEntity,
    RemotionTransition,
} from './types';

type RuntimeMode = 'preview' | 'render';

type SceneClip = {
    id: string;
    from: number;
    durationInFrames: number;
    scene: RemotionScene;
};

type SceneTransitionWindow = {
    transition: RemotionTransition;
    leftClip: SceneClip;
    rightClip: SceneClip;
    cutPoint: number;
    startFrame: number;
    endFrame: number;
    durationInFrames: number;
    leftPortion: number;
    rightPortion: number;
};

export interface VideoMotionCompositionProps {
    composition: RemotionCompositionConfig;
    runtime?: RuntimeMode;
}

function clampFrame(frame: number, durationInFrames: number) {
    return Math.max(0, Math.min(frame, Math.max(0, durationInFrames - 1)));
}

function resolveLocalRenderSource(source: string): string {
    const candidate = extractLocalAssetPathCandidate(source);
    if (!candidate) return source;
    return candidate;
}

function resolveSceneSource(source: string, runtime: RuntimeMode) {
    const raw = String(source || '').trim();
    if (!raw) return '';
    if (!isLocalAssetSource(raw)) return raw;
    if (runtime === 'render') return resolveLocalRenderSource(raw);
    return resolveAssetUrl(raw);
}

function getMotionValues(frame: number, durationInFrames: number, preset: MotionPreset) {
    const safeDuration = Math.max(1, durationInFrames);
    const progress = interpolate(frame, [0, safeDuration], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
    });

    switch (preset) {
        case 'slow-zoom-in':
            return {
                scale: interpolate(progress, [0, 1], [1, 1.12]),
                translateX: 0,
                translateY: 0,
            };
        case 'slow-zoom-out':
            return {
                scale: interpolate(progress, [0, 1], [1.14, 1]),
                translateX: 0,
                translateY: 0,
            };
        case 'pan-left':
            return {
                scale: 1.06,
                translateX: interpolate(progress, [0, 1], [60, -60]),
                translateY: 0,
            };
        case 'pan-right':
            return {
                scale: 1.06,
                translateX: interpolate(progress, [0, 1], [-60, 60]),
                translateY: 0,
            };
        case 'slide-up':
            return {
                scale: 1.02,
                translateX: 0,
                translateY: interpolate(progress, [0, 1], [38, -20]),
            };
        case 'slide-down':
            return {
                scale: 1.02,
                translateX: 0,
                translateY: interpolate(progress, [0, 1], [-24, 40]),
            };
        default:
            return {
                scale: 1,
                translateX: 0,
                translateY: 0,
            };
    }
}

function overlayPositionStyles(position: OverlayPosition | undefined): React.CSSProperties {
    switch (position) {
        case 'top':
            return {
                top: 72,
                left: 64,
                right: 64,
                justifyContent: 'flex-start',
            };
        case 'center':
            return {
                inset: 0,
                justifyContent: 'center',
                padding: '0 72px',
            };
        default:
            return {
                bottom: 72,
                left: 64,
                right: 64,
                justifyContent: 'flex-end',
            };
    }
}

function overlayAnimationStyles(
    frame: number,
    fps: number,
    durationInFrames: number,
    animation: OverlayAnimation | undefined,
): React.CSSProperties {
    const inSpring = spring({
        fps,
        frame,
        config: {
            damping: 200,
            stiffness: 120,
            mass: 0.9,
        },
    });
    const outWindow = Math.max(0, durationInFrames - Math.round(fps * 0.28));
    const outProgress = interpolate(frame, [outWindow, durationInFrames], [1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
    });
    const opacity = Math.min(inSpring, outProgress);

    switch (animation) {
        case 'slide-left':
            return {
                opacity,
                transform: `translate3d(${interpolate(inSpring, [0, 1], [42, 0])}px, 0, 0)`,
            };
        case 'pop':
            return {
                opacity,
                transform: `scale(${interpolate(inSpring, [0, 1], [0.92, 1])})`,
            };
        case 'fade-in':
            return {
                opacity,
            };
        default:
            return {
                opacity,
                transform: `translate3d(0, ${interpolate(inSpring, [0, 1], [20, 0])}px, 0)`,
            };
    }
}

function normalizeEntityFrame(frame: number, startFrame: number | undefined, durationInFrames: number | undefined) {
    const localFrame = Math.max(0, frame - (startFrame || 0));
    return clampFrame(localFrame, durationInFrames || Number.MAX_SAFE_INTEGER);
}

function mergeAnimationStyles(
    frame: number,
    fps: number,
    animations: RemotionEntityAnimation[] | undefined,
    scaleX = 1,
    scaleY = 1,
): React.CSSProperties {
    if (!animations?.length) return {};
    return animations.reduce<React.CSSProperties>((style, animation) => {
        const duration = Math.max(1, animation.durationInFrames || 1);
        const localFrame = normalizeEntityFrame(frame, animation.fromFrame, duration);
        const progress = interpolate(localFrame, [0, duration], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
        });
        const currentOpacity = typeof style.opacity === 'number' ? style.opacity : 1;
        const params = animation.params || {};
        const baseTransform = typeof style.transform === 'string' ? style.transform : '';
        switch (animation.kind) {
            case 'fade-in':
                return { ...style, opacity: currentOpacity * progress };
            case 'fade-out':
                return { ...style, opacity: currentOpacity * (1 - progress) };
            case 'slide-in-left':
                return {
                    ...style,
                    opacity: currentOpacity * progress,
                    transform: `${baseTransform} translate3d(${interpolate(progress, [0, 1], [Number(params.fromX ?? -120) * scaleX, 0])}px, 0, 0)`,
                };
            case 'slide-in-right':
                return {
                    ...style,
                    opacity: currentOpacity * progress,
                    transform: `${baseTransform} translate3d(${interpolate(progress, [0, 1], [Number(params.fromX ?? 120) * scaleX, 0])}px, 0, 0)`,
                };
            case 'slide-up':
                return {
                    ...style,
                    opacity: currentOpacity * progress,
                    transform: `${baseTransform} translate3d(0, ${interpolate(progress, [0, 1], [Number(params.fromY ?? 120) * scaleY, 0])}px, 0)`,
                };
            case 'slide-down':
                return {
                    ...style,
                    opacity: currentOpacity * progress,
                    transform: `${baseTransform} translate3d(0, ${interpolate(progress, [0, 1], [Number(params.fromY ?? -120) * scaleY, 0])}px, 0)`,
                };
            case 'pop': {
                const popSpring = spring({
                    fps,
                    frame: localFrame,
                    config: { damping: 200, stiffness: 140, mass: 0.9 },
                });
                return {
                    ...style,
                    opacity: currentOpacity * Math.min(1, popSpring),
                    transform: `${baseTransform} scale(${interpolate(popSpring, [0, 1], [Number(params.fromScale ?? 0.82), 1])})`,
                };
            }
            case 'fall-bounce': {
                const bounceCount = Math.max(1, Number(params.bounces ?? 3));
                const floorY = Number(params.floorY ?? 0) * scaleY;
                const startY = Number(params.fromY ?? -320) * scaleY;
                const bounceDecay = Number(params.decay ?? 0.38);
                let translateY = 0;
                if (progress < 0.65) {
                    const fallProgress = progress / 0.65;
                    translateY = interpolate(fallProgress, [0, 1], [startY, floorY], {
                        extrapolateLeft: 'clamp',
                        extrapolateRight: 'clamp',
                    });
                } else {
                    const bounceProgress = (progress - 0.65) / 0.35;
                    const wave = Math.sin(bounceProgress * Math.PI * bounceCount);
                    const amplitude = (1 - bounceProgress) * Math.abs(startY - floorY) * bounceDecay;
                    translateY = floorY - Math.max(0, wave) * amplitude;
                }
                return {
                    ...style,
                    transform: `${baseTransform} translate3d(0, ${translateY}px, 0)`,
                };
            }
            case 'float':
                return {
                    ...style,
                    transform: `${baseTransform} translate3d(0, ${Math.sin(progress * Math.PI * 2) * Number(params.amplitude ?? 14) * scaleY}px, 0)`,
                };
            default:
                return style;
        }
    }, {});
}

function safeReferenceDimension(value: number | undefined | null, fallback: number) {
    return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function resolveEntityLayoutMetrics(
    entity: RemotionSceneEntity,
    canvasWidth: number,
    canvasHeight: number,
    baseMediaWidth: number,
    baseMediaHeight: number,
) {
    const positionMode = entity.positionMode === 'video-space' ? 'video-space' : 'canvas-space';
    const referenceWidth = safeReferenceDimension(
        entity.referenceWidth,
        positionMode === 'video-space' ? baseMediaWidth : canvasWidth,
    );
    const referenceHeight = safeReferenceDimension(
        entity.referenceHeight,
        positionMode === 'video-space' ? baseMediaHeight : canvasHeight,
    );
    if (positionMode === 'video-space') {
        const coverScale = Math.max(canvasWidth / referenceWidth, canvasHeight / referenceHeight);
        return {
            scaleX: coverScale,
            scaleY: coverScale,
            visualScale: coverScale,
            offsetX: (canvasWidth - referenceWidth * coverScale) / 2,
            offsetY: (canvasHeight - referenceHeight * coverScale) / 2,
        };
    }
    const scaleX = canvasWidth / referenceWidth;
    const scaleY = canvasHeight / referenceHeight;
    return {
        scaleX,
        scaleY,
        visualScale: Math.min(scaleX, scaleY),
        offsetX: 0,
        offsetY: 0,
    };
}

function renderAppleShape(fill: string, stroke: string | undefined, strokeWidth: number) {
    return (
        <svg viewBox="0 0 100 120" width="100%" height="100%" aria-hidden>
            <path
                d="M49 25c-8-8-7-19 2-25 4 9-2 18-2 25Zm-6 8c13 0 20 8 20 8s8-8 20-8c13 0 17 11 17 20 0 25-20 52-37 52-7 0-10-4-17-4s-10 4-17 4C12 105-8 78-8 53-8 44-4 33 7 33c12 0 20 8 20 8s7-8 16-8Z"
                fill={fill}
                stroke={stroke}
                strokeWidth={strokeWidth}
            />
            <path d="M62 18c8-9 18-8 26-2-10 3-18 9-22 17-3-5-4-10-4-15Z" fill="#2d8f3b" />
        </svg>
    );
}

function buildSceneOverlays(
    scene: RemotionScene,
    fps: number,
    compositionTitle?: string,
): RemotionOverlay[] {
    const overlayItems: RemotionOverlay[] = [...(scene.overlays || [])];
    const overlayTitle = String(scene.overlayTitle || '').trim();
    const normalizedCompositionTitle = String(compositionTitle || '').trim();
    const shouldRenderOverlayTitle = overlayTitle
        && overlayTitle !== normalizedCompositionTitle
        && overlayTitle !== '未命名';
    if (shouldRenderOverlayTitle) {
        overlayItems.push({
            id: `${scene.id}-title`,
            text: overlayTitle,
            startFrame: 0,
            durationInFrames: Math.min(scene.durationInFrames, Math.max(40, Math.round(fps * 2.8))),
            position: 'top',
            animation: 'fade-up',
            fontSize: 54,
        });
    }
    if (scene.overlayBody) {
        overlayItems.push({
            id: `${scene.id}-body`,
            text: scene.overlayBody,
            startFrame: Math.min(scene.durationInFrames - 1, Math.round(fps * 0.5)),
            durationInFrames: Math.max(24, scene.durationInFrames - Math.round(fps * 0.6)),
            position: 'bottom',
            animation: 'fade-up',
            fontSize: 36,
            backgroundColor: 'rgba(3, 7, 18, 0.62)',
        });
    }
    return overlayItems;
}

function calculateTransitionPortions(durationInFrames: number, alignment: number | undefined) {
    const safeDuration = Math.max(1, Math.floor(durationInFrames));
    const clampedAlignment = Math.max(0, Math.min(1, alignment ?? 0.5));
    const leftPortion = Math.floor(safeDuration * clampedAlignment);
    const rightPortion = safeDuration - leftPortion;
    return { leftPortion, rightPortion };
}

function solveClipTransitionPressure(clipDuration: number, incomingPortion: number, outgoingPortion: number) {
    const available = Math.max(0, Math.floor(clipDuration));
    const startUse = Math.max(0, Math.floor(incomingPortion));
    const endUse = Math.max(0, Math.floor(outgoingPortion));
    const totalUse = startUse + endUse;

    if (totalUse <= available) {
        return { incomingPortion: startUse, outgoingPortion: endUse };
    }
    if (available === 0) {
        return { incomingPortion: 0, outgoingPortion: 0 };
    }

    const scale = available / totalUse;
    let nextIncoming = Math.floor(startUse * scale);
    let nextOutgoing = Math.floor(endUse * scale);
    let remaining = available - (nextIncoming + nextOutgoing);
    while (remaining > 0) {
        const incomingGain = startUse - nextIncoming;
        const outgoingGain = endUse - nextOutgoing;
        if (incomingGain === 0 && outgoingGain === 0) {
            break;
        }
        if (incomingGain >= outgoingGain && incomingGain > 0) {
            nextIncoming += 1;
        } else if (outgoingGain > 0) {
            nextOutgoing += 1;
        } else if (incomingGain > 0) {
            nextIncoming += 1;
        }
        remaining -= 1;
    }
    return { incomingPortion: nextIncoming, outgoingPortion: nextOutgoing };
}

function resolveSceneTransitionWindows(
    transitions: RemotionTransition[],
    clipsById: Map<string, SceneClip>,
): SceneTransitionWindow[] {
    const resolvedByTransitionId = new Map<string, SceneTransitionWindow>();
    const incomingTransitionByClipId = new Map<string, string>();
    const outgoingTransitionByClipId = new Map<string, string>();

    for (const transition of transitions) {
        const leftClip = clipsById.get(transition.leftClipId);
        const rightClip = clipsById.get(transition.rightClipId);
        if (!leftClip || !rightClip) {
            continue;
        }
        const leftEnd = leftClip.from + leftClip.durationInFrames;
        const cutPoint = rightClip.from;
        const { leftPortion, rightPortion } = calculateTransitionPortions(
            transition.durationInFrames,
            transition.alignment,
        );
        resolvedByTransitionId.set(transition.id, {
            transition,
            leftClip,
            rightClip,
            cutPoint,
            startFrame: cutPoint - Math.max(0, leftPortion),
            endFrame: cutPoint + Math.max(0, rightPortion),
            durationInFrames: Math.max(1, leftPortion + rightPortion),
            leftPortion,
            rightPortion,
        });
        outgoingTransitionByClipId.set(leftClip.id, transition.id);
        incomingTransitionByClipId.set(rightClip.id, transition.id);
        if (Math.abs(leftEnd - rightClip.from) > 1) {
            const overlapDuration = Math.max(1, leftEnd - rightClip.from);
            resolvedByTransitionId.set(transition.id, {
                transition,
                leftClip,
                rightClip,
                cutPoint: leftEnd,
                startFrame: rightClip.from,
                endFrame: leftEnd,
                durationInFrames: overlapDuration,
                leftPortion: overlapDuration,
                rightPortion: overlapDuration,
            });
        }
    }

    for (const [clipId, incomingTransitionId] of incomingTransitionByClipId.entries()) {
        const outgoingTransitionId = outgoingTransitionByClipId.get(clipId);
        if (!outgoingTransitionId) {
            continue;
        }
        const incomingTransition = resolvedByTransitionId.get(incomingTransitionId);
        const outgoingTransition = resolvedByTransitionId.get(outgoingTransitionId);
        const clip = clipsById.get(clipId);
        if (!incomingTransition || !outgoingTransition || !clip) {
            continue;
        }
        const adjusted = solveClipTransitionPressure(
            clip.durationInFrames,
            incomingTransition.rightPortion,
            outgoingTransition.leftPortion,
        );
        incomingTransition.rightPortion = adjusted.incomingPortion;
        outgoingTransition.leftPortion = adjusted.outgoingPortion;
        incomingTransition.durationInFrames = Math.max(1, incomingTransition.leftPortion + incomingTransition.rightPortion);
        outgoingTransition.durationInFrames = Math.max(1, outgoingTransition.leftPortion + outgoingTransition.rightPortion);
        incomingTransition.startFrame = incomingTransition.cutPoint - incomingTransition.leftPortion;
        incomingTransition.endFrame = incomingTransition.cutPoint + incomingTransition.rightPortion;
        outgoingTransition.startFrame = outgoingTransition.cutPoint - outgoingTransition.leftPortion;
        outgoingTransition.endFrame = outgoingTransition.cutPoint + outgoingTransition.rightPortion;
    }

    return [...resolvedByTransitionId.values()].sort((left, right) => {
        if (left.startFrame !== right.startFrame) return left.startFrame - right.startFrame;
        if (left.cutPoint !== right.cutPoint) return left.cutPoint - right.cutPoint;
        return left.transition.id.localeCompare(right.transition.id);
    });
}

function applyTransitionTiming(progress: number, transition: RemotionTransition) {
    const clamped = Math.max(0, Math.min(1, progress));
    switch (transition.timing) {
        case 'spring':
            return Math.max(0, Math.min(1, 1 - Math.exp(-6 * clamped) * Math.cos(clamped * 4.5 * Math.PI)));
        case 'ease-in':
            return clamped * clamped;
        case 'ease-out':
            return 1 - Math.pow(1 - clamped, 2);
        case 'ease-in-out':
            return clamped < 0.5
                ? 2 * clamped * clamped
                : 1 - Math.pow(-2 * clamped + 2, 2) / 2;
        case 'cubic-bezier': {
            const points = transition.bezierPoints;
            if (!points) {
                return clamped;
            }
            const t = clamped;
            const mt = 1 - t;
            return (
                3 * mt * mt * t * points.y1
                + 3 * mt * t * t * points.y2
                + t * t * t
            );
        }
        default:
            return clamped;
    }
}

function calculateTransitionStylesForScene(
    transition: RemotionTransition,
    progress: number,
    isOutgoing: boolean,
    canvasWidth: number,
    canvasHeight: number,
): React.CSSProperties {
    const timedProgress = applyTransitionTiming(progress, transition);
    switch (transition.presentation) {
        case 'wipe': {
            const p = Math.max(0, Math.min(1, timedProgress));
            const inverse = 1 - p;
            const direction = transition.direction || 'from-left';
            const clipPath = direction === 'from-right'
                ? (isOutgoing ? `inset(0 ${p * 100}% 0 0)` : `inset(0 0 0 ${inverse * 100}%)`)
                : direction === 'from-top'
                    ? (isOutgoing ? `inset(${p * 100}% 0 0 0)` : `inset(0 0 ${inverse * 100}% 0)`)
                    : direction === 'from-bottom'
                        ? (isOutgoing ? `inset(0 0 ${p * 100}% 0)` : `inset(${inverse * 100}% 0 0 0)`)
                        : (isOutgoing ? `inset(0 0 0 ${p * 100}%)` : `inset(0 ${inverse * 100}% 0 0)`);
            return { clipPath, WebkitClipPath: clipPath } as React.CSSProperties;
        }
        case 'slide': {
            const direction = transition.direction || 'from-left';
            const slideProgress = isOutgoing ? timedProgress : timedProgress - 1;
            const transform = direction === 'from-right'
                ? `translateX(${-slideProgress * canvasWidth}px)`
                : direction === 'from-top'
                    ? `translateY(${slideProgress * canvasHeight}px)`
                    : direction === 'from-bottom'
                        ? `translateY(${-slideProgress * canvasHeight}px)`
                        : `translateX(${slideProgress * canvasWidth}px)`;
            return { transform };
        }
        case 'flip': {
            const direction = transition.direction || 'from-left';
            const axis = direction === 'from-left' || direction === 'from-right' ? 'Y' : 'X';
            const sign = direction === 'from-right' || direction === 'from-bottom' ? -1 : 1;
            const midpoint = 0.5;
            const rotation = isOutgoing
                ? Math.min(timedProgress / midpoint, 1) * 90
                : -90 + Math.max((timedProgress - midpoint) / midpoint, 0) * 90;
            return {
                transform: `perspective(1000px) rotate${axis}(${sign * rotation}deg)`,
                opacity: isOutgoing ? (timedProgress < midpoint ? 1 : 0) : (timedProgress >= midpoint ? 1 : 0),
            };
        }
        case 'clockWipe': {
            if (!isOutgoing) {
                return {};
            }
            const degrees = timedProgress * 360;
            const maskImage = `conic-gradient(from 0deg, transparent ${degrees}deg, black ${degrees}deg)`;
            return {
                maskImage,
                WebkitMaskImage: maskImage,
                maskSize: '100% 100%',
                WebkitMaskSize: '100% 100%',
            } as React.CSSProperties;
        }
        case 'iris': {
            if (!isOutgoing) {
                return {};
            }
            const radius = timedProgress * 120;
            const maskImage = `radial-gradient(circle, transparent ${radius}%, black ${radius}%)`;
            return {
                maskImage,
                WebkitMaskImage: maskImage,
                maskSize: '100% 100%',
                WebkitMaskSize: '100% 100%',
            } as React.CSSProperties;
        }
        case 'fade':
        default:
            return {
                opacity: isOutgoing
                    ? Math.cos((timedProgress * Math.PI) / 2)
                    : Math.sin((timedProgress * Math.PI) / 2),
            };
    }
}

function buildSceneTransitionWindows(
    scenes: RemotionScene[],
    transitions: RemotionTransition[] | undefined,
): SceneTransitionWindow[] {
    if (!transitions?.length) return [];
    const clipsById = new Map<string, SceneClip>();
    for (const scene of scenes) {
        const clipId = scene.clipId?.trim();
        if (!clipId || scene.assetKind === 'audio') continue;
        clipsById.set(clipId, {
            id: clipId,
            from: scene.startFrame,
            durationInFrames: scene.durationInFrames,
            scene,
        });
    }
    const supportedTransitions = transitions.filter((transition) => (
        transition.leftClipId?.trim()
        && transition.rightClipId?.trim()
        && clipsById.has(transition.leftClipId)
        && clipsById.has(transition.rightClipId)
        && Number(transition.durationInFrames) > 0
    ));
    return resolveSceneTransitionWindows(supportedTransitions, clipsById);
}

function buildTransitionWindowLookup(windows: SceneTransitionWindow[]) {
    const lookup = new Map<string, SceneTransitionWindow[]>();
    for (const window of windows) {
        const leftSceneId = window.leftClip.scene.id;
        const rightSceneId = window.rightClip.scene.id;
        lookup.set(leftSceneId, [...(lookup.get(leftSceneId) || []), window]);
        lookup.set(rightSceneId, [...(lookup.get(rightSceneId) || []), window]);
    }
    return lookup;
}

function isFrameCoveredByTransition(absoluteFrame: number, windows: SceneTransitionWindow[] | undefined) {
    return (windows || []).some((window) => absoluteFrame >= window.startFrame && absoluteFrame < window.endFrame);
}

function SceneEntity({
    entity,
    sceneFrame,
    runtime,
    canvasWidth,
    canvasHeight,
    baseMediaWidth,
    baseMediaHeight,
}: {
    entity: RemotionSceneEntity;
    sceneFrame: number;
    runtime: RuntimeMode;
    canvasWidth: number;
    canvasHeight: number;
    baseMediaWidth: number;
    baseMediaHeight: number;
}) {
    const { fps } = useVideoConfig();
    const entityStartFrame = Math.max(0, entity.startFrame || 0);
    const entityDurationInFrames = Math.max(1, entity.durationInFrames || Number.MAX_SAFE_INTEGER);
    if (sceneFrame < entityStartFrame || sceneFrame >= entityStartFrame + entityDurationInFrames) {
        return null;
    }
    const entityFrame = normalizeEntityFrame(sceneFrame, entity.startFrame, entity.durationInFrames);
    const layoutMetrics = resolveEntityLayoutMetrics(
        entity,
        canvasWidth,
        canvasHeight,
        baseMediaWidth,
        baseMediaHeight,
    );
    const animationStyle = mergeAnimationStyles(
        entityFrame,
        fps,
        entity.animations,
        layoutMetrics.scaleX,
        layoutMetrics.scaleY,
    );
    const mediaSource = resolveSceneSource(entity.src || '', runtime);
    const opacity = typeof entity.opacity === 'number' ? entity.opacity : 1;
    const scale = typeof entity.scale === 'number' ? entity.scale : 1;
    const rotation = typeof entity.rotation === 'number' ? entity.rotation : 0;
    const visible = entity.visible !== false;
    if (!visible) return null;
    const resolvedX = layoutMetrics.offsetX + entity.x * layoutMetrics.scaleX;
    const resolvedY = layoutMetrics.offsetY + entity.y * layoutMetrics.scaleY;
    const resolvedWidth = entity.width * layoutMetrics.scaleX;
    const resolvedHeight = entity.height * layoutMetrics.scaleY;
    const resolvedFontSize = entity.fontSize ? entity.fontSize * layoutMetrics.visualScale : undefined;
    const resolvedLineHeight = entity.lineHeight ? entity.lineHeight : undefined;
    const resolvedStrokeWidth = entity.strokeWidth ? entity.strokeWidth * layoutMetrics.visualScale : 0;
    const resolvedBorderRadius = entity.borderRadius !== undefined
        ? entity.borderRadius * layoutMetrics.visualScale
        : undefined;
    const resolvedRadius = entity.radius !== undefined
        ? entity.radius * layoutMetrics.visualScale
        : undefined;
    const baseStyle: React.CSSProperties = {
        position: 'absolute',
        left: resolvedX,
        top: resolvedY,
        width: resolvedWidth,
        height: resolvedHeight,
        opacity,
        transform: `rotate(${rotation}deg) scale(${scale})`,
        transformOrigin: 'center center',
        ...animationStyle,
    };

    if (entity.type === 'group') {
        return (
            <div style={baseStyle}>
                {(entity.children || []).map((child) => (
                    <SceneEntity
                        key={child.id}
                        entity={child}
                        sceneFrame={sceneFrame}
                        runtime={runtime}
                        canvasWidth={canvasWidth}
                        canvasHeight={canvasHeight}
                        baseMediaWidth={baseMediaWidth}
                        baseMediaHeight={baseMediaHeight}
                    />
                ))}
            </div>
        );
    }

    if (entity.type === 'text') {
        return (
            <div
                style={{
                    ...baseStyle,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: entity.align === 'left' ? 'flex-start' : entity.align === 'right' ? 'flex-end' : 'center',
                    color: entity.color || '#ffffff',
                    fontSize: resolvedFontSize || 48,
                    fontWeight: entity.fontWeight || 700,
                    lineHeight: resolvedLineHeight || 1.2,
                    textAlign: entity.align || 'center',
                    whiteSpace: 'pre-wrap',
                }}
            >
                {entity.text || ''}
            </div>
        );
    }

    if (entity.type === 'shape') {
        const fill = entity.fill || entity.color || '#ffffff';
        const strokeWidth = resolvedStrokeWidth || 0;
        if (entity.shape === 'apple') {
            return <div style={baseStyle}>{renderAppleShape(fill, entity.stroke, strokeWidth)}</div>;
        }
        return (
            <div
                style={{
                    ...baseStyle,
                    background: fill,
                    border: entity.stroke ? `${strokeWidth}px solid ${entity.stroke}` : undefined,
                    borderRadius: entity.shape === 'circle'
                        ? '999px'
                        : resolvedBorderRadius !== undefined
                            ? resolvedBorderRadius
                            : resolvedRadius !== undefined
                                ? resolvedRadius
                                : 12,
                }}
            />
        );
    }

    if (entity.type === 'image' && mediaSource) {
        return <Img src={mediaSource} style={{ ...baseStyle, objectFit: 'contain' }} />;
    }

    if (entity.type === 'video' && mediaSource) {
        if (runtime === 'preview') {
            return <Html5Video src={mediaSource} style={{ ...baseStyle, objectFit: 'contain' }} muted />;
        }
        return <OffthreadVideo src={mediaSource} style={{ ...baseStyle, objectFit: 'contain' }} muted />;
    }

    if (entity.type === 'svg' && entity.svgMarkup) {
        return <div style={baseStyle} dangerouslySetInnerHTML={{ __html: entity.svgMarkup }} />;
    }

    return null;
}

function SceneOverlay({
    overlay,
    sceneFrame,
}: {
    overlay: RemotionOverlay;
    sceneFrame: number;
}) {
    const { fps } = useVideoConfig();
    const overlayFrame = sceneFrame - overlay.startFrame;
    if (overlayFrame < 0 || overlayFrame >= overlay.durationInFrames) {
        return null;
    }
    const style = overlayAnimationStyles(
        clampFrame(overlayFrame, overlay.durationInFrames),
        fps,
        overlay.durationInFrames,
        overlay.animation,
    );

    return (
        <AbsoluteFill
            style={{
                pointerEvents: 'none',
                display: 'flex',
                ...overlayPositionStyles(overlay.position),
            }}
        >
            <div
                style={{
                    maxWidth: '82%',
                    alignSelf: overlay.position === 'center' ? 'center' : undefined,
                    padding: '18px 24px',
                    borderRadius: 28,
                    background: overlay.backgroundColor || 'rgba(6, 8, 12, 0.58)',
                    boxShadow: '0 18px 56px rgba(0,0,0,0.28)',
                    color: overlay.color || '#ffffff',
                    textAlign: overlay.align || 'left',
                    fontSize: overlay.fontSize || 42,
                    fontWeight: 700,
                    lineHeight: 1.2,
                    whiteSpace: 'pre-wrap',
                    ...style,
                }}
            >
                {overlay.text}
            </div>
        </AbsoluteFill>
    );
}

function SceneLayerContent({
    scene,
    sceneFrame,
    runtime,
    renderMode,
    compositionTitle,
    canvasWidth,
    canvasHeight,
    baseMediaWidth,
    baseMediaHeight,
}: {
    scene: RemotionScene;
    sceneFrame: number;
    runtime: RuntimeMode;
    renderMode: 'full' | 'motion-layer';
    compositionTitle?: string;
    canvasWidth: number;
    canvasHeight: number;
    baseMediaWidth: number;
    baseMediaHeight: number;
}) {
    const { fps } = useVideoConfig();
    const source = resolveSceneSource(scene.src, runtime);
    const showBaseMedia = renderMode !== 'motion-layer';
    const enableMediaAudio = renderMode === 'full';
    const localFrame = clampFrame(sceneFrame, scene.durationInFrames);
    const motion = getMotionValues(
        localFrame,
        scene.durationInFrames,
        scene.motionPreset || 'static',
    );
    const baseOpacity = interpolate(
        localFrame,
        [0, Math.max(6, Math.round(fps * 0.25)), Math.max(0, scene.durationInFrames - Math.round(fps * 0.25)), scene.durationInFrames],
        [0, 1, 1, 0],
        {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
        },
    );
    const overlayItems = buildSceneOverlays(scene, fps, compositionTitle);
    const entities = Array.isArray(scene.entities) ? scene.entities : [];

    const contentStyle: React.CSSProperties = {
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        transform: `translate3d(${motion.translateX}px, ${motion.translateY}px, 0) scale(${motion.scale})`,
        opacity: baseOpacity,
    };

    return (
        <AbsoluteFill
            style={{
                backgroundColor: 'transparent',
                overflow: 'hidden',
            }}
        >
            {showBaseMedia && scene.assetKind === 'audio' ? (
                <Audio src={source} />
            ) : null}
            {showBaseMedia && scene.assetKind === 'image' ? (
                <Img src={source} style={contentStyle} />
            ) : showBaseMedia && scene.assetKind === 'video' ? (
                runtime === 'preview' ? (
                    <Html5Video
                        src={source}
                        style={contentStyle}
                        muted={!enableMediaAudio}
                        startFrom={scene.trimInFrames || 0}
                        endAt={(scene.trimInFrames || 0) + scene.durationInFrames}
                    />
                ) : (
                    <OffthreadVideo
                        src={source}
                        style={contentStyle}
                        muted={!enableMediaAudio}
                        startFrom={scene.trimInFrames || 0}
                        endAt={(scene.trimInFrames || 0) + scene.durationInFrames}
                    />
                )
            ) : showBaseMedia ? (
                <AbsoluteFill
                    style={{
                        alignItems: 'center',
                        justifyContent: 'center',
                        background:
                            'radial-gradient(circle at 20% 20%, rgba(34,211,238,0.28), transparent 40%), #0b1017',
                        color: '#d2f2ff',
                        fontSize: 40,
                        fontWeight: 600,
                    }}
                >
                    {scene.overlayTitle || 'RedBox Motion Scene'}
                </AbsoluteFill>
            ) : null}
            {entities.map((entity) => (
                <SceneEntity
                    key={entity.id}
                    entity={entity}
                    sceneFrame={localFrame}
                    runtime={runtime}
                    canvasWidth={canvasWidth}
                    canvasHeight={canvasHeight}
                    baseMediaWidth={baseMediaWidth}
                    baseMediaHeight={baseMediaHeight}
                />
            ))}
            {overlayItems.map((overlay) => (
                <SceneOverlay key={overlay.id} overlay={overlay} sceneFrame={localFrame} />
            ))}
        </AbsoluteFill>
    );
}

function MotionSceneLayer({
    scene,
    runtime,
    renderMode,
    transitionWindows,
    compositionTitle,
    canvasWidth,
    canvasHeight,
    baseMediaWidth,
    baseMediaHeight,
}: {
    scene: RemotionScene;
    runtime: RuntimeMode;
    renderMode: 'full' | 'motion-layer';
    transitionWindows?: SceneTransitionWindow[];
    compositionTitle?: string;
    canvasWidth: number;
    canvasHeight: number;
    baseMediaWidth: number;
    baseMediaHeight: number;
}) {
    const frame = useCurrentFrame();
    const sceneFrame = clampFrame(frame, scene.durationInFrames);
    const absoluteFrame = scene.startFrame + sceneFrame;
    if (isFrameCoveredByTransition(absoluteFrame, transitionWindows)) {
        return null;
    }
    return (
        <SceneLayerContent
            scene={scene}
            sceneFrame={sceneFrame}
            runtime={runtime}
            renderMode={renderMode}
            compositionTitle={compositionTitle}
            canvasWidth={canvasWidth}
            canvasHeight={canvasHeight}
            baseMediaWidth={baseMediaWidth}
            baseMediaHeight={baseMediaHeight}
        />
    );
}

function TransitionSequenceLayer({
    window,
    runtime,
    renderMode,
    width,
    height,
    compositionTitle,
    baseMediaWidth,
    baseMediaHeight,
}: {
    window: SceneTransitionWindow;
    runtime: RuntimeMode;
    renderMode: 'full' | 'motion-layer';
    width: number;
    height: number;
    compositionTitle?: string;
    baseMediaWidth: number;
    baseMediaHeight: number;
}) {
    const frame = useCurrentFrame();
    const absoluteFrame = window.startFrame + frame;
    const progress = interpolate(frame, [0, Math.max(1, window.durationInFrames - 1)], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
    });
    const outgoingStyle = calculateTransitionStylesForScene(window.transition, progress, true, width, height);
    const incomingStyle = calculateTransitionStylesForScene(window.transition, progress, false, width, height);
    const outgoingFrame = clampFrame(absoluteFrame - window.leftClip.scene.startFrame, window.leftClip.scene.durationInFrames);
    const incomingFrame = clampFrame(absoluteFrame - window.rightClip.scene.startFrame, window.rightClip.scene.durationInFrames);

    return (
        <AbsoluteFill style={{ overflow: 'hidden' }}>
            <div
                style={{
                    position: 'absolute',
                    inset: 0,
                    willChange: 'transform, opacity, clip-path, mask-image',
                    ...outgoingStyle,
                }}
            >
                <SceneLayerContent
                    scene={window.leftClip.scene}
                    sceneFrame={outgoingFrame}
                    runtime={runtime}
                    renderMode={renderMode}
                    compositionTitle={compositionTitle}
                    canvasWidth={width}
                    canvasHeight={height}
                    baseMediaWidth={baseMediaWidth}
                    baseMediaHeight={baseMediaHeight}
                />
            </div>
            <div
                style={{
                    position: 'absolute',
                    inset: 0,
                    willChange: 'transform, opacity, clip-path, mask-image',
                    ...incomingStyle,
                }}
            >
                <SceneLayerContent
                    scene={window.rightClip.scene}
                    sceneFrame={incomingFrame}
                    runtime={runtime}
                    renderMode={renderMode}
                    compositionTitle={compositionTitle}
                    canvasWidth={width}
                    canvasHeight={height}
                    baseMediaWidth={baseMediaWidth}
                    baseMediaHeight={baseMediaHeight}
                />
            </div>
        </AbsoluteFill>
    );
}

export function VideoMotionComposition({
    composition,
    runtime = 'preview',
}: VideoMotionCompositionProps) {
    const {
        width,
        height,
        backgroundColor,
        scenes,
        transitions,
        renderMode = 'full',
        baseMedia,
    } = composition;
    const baseMediaWidth = safeReferenceDimension(baseMedia?.width, width);
    const baseMediaHeight = safeReferenceDimension(baseMedia?.height, height);
    const transitionWindows = buildSceneTransitionWindows(scenes, transitions);
    const transitionLookup = buildTransitionWindowLookup(transitionWindows);

    return (
        <AbsoluteFill
            style={{
                background: renderMode === 'motion-layer' ? 'transparent' : (backgroundColor || '#05070b'),
                width,
                height,
                overflow: 'hidden',
            }}
        >
            {scenes.map((scene) => (
                <Sequence
                    key={scene.id}
                    from={scene.startFrame}
                    durationInFrames={scene.durationInFrames}
                >
                    <MotionSceneLayer
                        scene={scene}
                        runtime={runtime}
                        renderMode={renderMode}
                        transitionWindows={transitionLookup.get(scene.id)}
                        compositionTitle={composition.title}
                        canvasWidth={width}
                        canvasHeight={height}
                        baseMediaWidth={baseMediaWidth}
                        baseMediaHeight={baseMediaHeight}
                    />
                </Sequence>
            ))}
            {transitionWindows.map((window) => (
                <Sequence
                    key={window.transition.id}
                    from={window.startFrame}
                    durationInFrames={window.durationInFrames}
                >
                    <TransitionSequenceLayer
                        window={window}
                        runtime={runtime}
                        renderMode={renderMode}
                        width={width}
                        height={height}
                        compositionTitle={composition.title}
                        baseMediaWidth={baseMediaWidth}
                        baseMediaHeight={baseMediaHeight}
                    />
                </Sequence>
            ))}
        </AbsoluteFill>
    );
}
