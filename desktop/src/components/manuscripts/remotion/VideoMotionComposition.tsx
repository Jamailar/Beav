import React from 'react';
import {
    AbsoluteFill,
    Audio,
    Img,
    OffthreadVideo,
    Sequence,
    interpolate,
    spring,
    useCurrentFrame,
    useVideoConfig,
} from 'remotion';
import {
    coerceToRedboxAssetUrl,
    extractLocalAssetPathCandidate,
    isLocalAssetSource,
} from '../../../../shared/localAsset';
import type {
    MotionPreset,
    OverlayAnimation,
    OverlayPosition,
    RemotionCompositionConfig,
    RemotionOverlay,
    RemotionScene,
} from './types';

type RuntimeMode = 'preview' | 'render';

export interface VideoMotionCompositionProps {
    composition: RemotionCompositionConfig;
    runtime?: RuntimeMode;
}

function clampFrame(frame: number, durationInFrames: number) {
    return Math.max(0, Math.min(frame, Math.max(0, durationInFrames - 1)));
}

function toFileUrl(source: string): string {
    const candidate = extractLocalAssetPathCandidate(source);
    if (!candidate) return source;
    const normalized = candidate.replace(/\\/g, '/');
    if (/^[a-zA-Z]:\//.test(normalized)) {
        return `file:///${encodeURI(normalized)}`;
    }
    return `file://${encodeURI(normalized)}`;
}

function resolveSceneSource(source: string, runtime: RuntimeMode) {
    const raw = String(source || '').trim();
    if (!raw) return '';
    if (!isLocalAssetSource(raw)) return raw;
    if (runtime === 'render') return toFileUrl(raw);
    return coerceToRedboxAssetUrl(raw);
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
    animation: OverlayAnimation | undefined
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

function SceneOverlay({
    overlay,
}: {
    overlay: RemotionOverlay;
}) {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const overlayFrame = clampFrame(frame - overlay.startFrame, overlay.durationInFrames);
    const style = overlayAnimationStyles(
        overlayFrame,
        fps,
        overlay.durationInFrames,
        overlay.animation
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

function MotionSceneLayer({
    scene,
    runtime,
}: {
    scene: RemotionScene;
    runtime: RuntimeMode;
}) {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const source = resolveSceneSource(scene.src, runtime);
    const localFrame = clampFrame(frame, scene.durationInFrames);
    const motion = getMotionValues(
        localFrame,
        scene.durationInFrames,
        scene.motionPreset || 'static'
    );
    const baseOpacity = interpolate(
        localFrame,
        [0, Math.max(6, Math.round(fps * 0.25)), Math.max(0, scene.durationInFrames - Math.round(fps * 0.25)), scene.durationInFrames],
        [0, 1, 1, 0],
        {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
        }
    );

    const contentStyle: React.CSSProperties = {
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        transform: `translate3d(${motion.translateX}px, ${motion.translateY}px, 0) scale(${motion.scale})`,
        opacity: baseOpacity,
    };

    const overlayItems: RemotionOverlay[] = [...(scene.overlays || [])];
    if (scene.overlayTitle) {
        overlayItems.push({
            id: `${scene.id}-title`,
            text: scene.overlayTitle,
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

    return (
        <AbsoluteFill
            style={{
                backgroundColor: 'transparent',
                overflow: 'hidden',
            }}
        >
            {scene.assetKind === 'audio' ? (
                <Audio src={source} />
            ) : null}
            {scene.assetKind === 'image' ? (
                <Img src={source} style={contentStyle} />
            ) : scene.assetKind === 'video' ? (
                <OffthreadVideo
                    src={source}
                    style={contentStyle}
                    muted
                    startFrom={scene.trimInFrames || 0}
                    endAt={(scene.trimInFrames || 0) + scene.durationInFrames}
                />
            ) : (
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
            )}
            {overlayItems.map((overlay) => (
                <Sequence
                    key={overlay.id}
                    from={overlay.startFrame}
                    durationInFrames={overlay.durationInFrames}
                >
                    <SceneOverlay overlay={overlay} />
                </Sequence>
            ))}
        </AbsoluteFill>
    );
}

export function VideoMotionComposition({
    composition,
    runtime = 'preview',
}: VideoMotionCompositionProps) {
    const { width, height, backgroundColor, scenes } = composition;

    return (
        <AbsoluteFill
            style={{
                background: backgroundColor || '#05070b',
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
                    <MotionSceneLayer scene={scene} runtime={runtime} />
                </Sequence>
            ))}
        </AbsoluteFill>
    );
}
