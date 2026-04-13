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
    RemotionEntityAnimation,
    MotionPreset,
    OverlayAnimation,
    OverlayPosition,
    RemotionCompositionConfig,
    RemotionSceneEntity,
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

function normalizeEntityFrame(frame: number, startFrame: number | undefined, durationInFrames: number | undefined) {
    const localFrame = Math.max(0, frame - (startFrame || 0));
    return clampFrame(localFrame, durationInFrames || Number.MAX_SAFE_INTEGER);
}

function mergeAnimationStyles(
    frame: number,
    fps: number,
    animations: RemotionEntityAnimation[] | undefined
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
                    transform: `${baseTransform} translate3d(${interpolate(progress, [0, 1], [Number(params.fromX ?? -120), 0])}px, 0, 0)`,
                };
            case 'slide-in-right':
                return {
                    ...style,
                    opacity: currentOpacity * progress,
                    transform: `${baseTransform} translate3d(${interpolate(progress, [0, 1], [Number(params.fromX ?? 120), 0])}px, 0, 0)`,
                };
            case 'slide-up':
                return {
                    ...style,
                    opacity: currentOpacity * progress,
                    transform: `${baseTransform} translate3d(0, ${interpolate(progress, [0, 1], [Number(params.fromY ?? 120), 0])}px, 0)`,
                };
            case 'slide-down':
                return {
                    ...style,
                    opacity: currentOpacity * progress,
                    transform: `${baseTransform} translate3d(0, ${interpolate(progress, [0, 1], [Number(params.fromY ?? -120), 0])}px, 0)`,
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
                const floorY = Number(params.floorY ?? 0);
                const startY = Number(params.fromY ?? -320);
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
                    transform: `${baseTransform} translate3d(0, ${Math.sin(progress * Math.PI * 2) * Number(params.amplitude ?? 14)}px, 0)`,
                };
            default:
                return style;
        }
    }, {});
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

function SceneEntity({
    entity,
    sceneFrame,
}: {
    entity: RemotionSceneEntity;
    sceneFrame: number;
}) {
    const { fps } = useVideoConfig();
    const entityFrame = normalizeEntityFrame(sceneFrame, entity.startFrame, entity.durationInFrames);
    const animationStyle = mergeAnimationStyles(entityFrame, fps, entity.animations);
    const opacity = typeof entity.opacity === 'number' ? entity.opacity : 1;
    const scale = typeof entity.scale === 'number' ? entity.scale : 1;
    const rotation = typeof entity.rotation === 'number' ? entity.rotation : 0;
    const visible = entity.visible !== false;
    if (!visible) return null;
    const baseStyle: React.CSSProperties = {
        position: 'absolute',
        left: entity.x,
        top: entity.y,
        width: entity.width,
        height: entity.height,
        opacity,
        transform: `rotate(${rotation}deg) scale(${scale})`,
        transformOrigin: 'center center',
        ...animationStyle,
    };

    if (entity.type === 'group') {
        return (
            <div style={baseStyle}>
                {(entity.children || []).map((child) => (
                    <SceneEntity key={child.id} entity={child} sceneFrame={sceneFrame} />
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
                    fontSize: entity.fontSize || 48,
                    fontWeight: entity.fontWeight || 700,
                    lineHeight: entity.lineHeight || 1.2,
                    textAlign: entity.align || 'center',
                    whiteSpace: 'pre-wrap',
                }}
            >
                {entity.text || ''}
            </div>
        );
    }

    if (entity.type === 'shape') {
        const fill = entity.fill || '#ffffff';
        const strokeWidth = entity.strokeWidth || 0;
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
                        : entity.borderRadius !== undefined
                            ? entity.borderRadius
                            : entity.radius !== undefined
                                ? entity.radius
                                : 12,
                }}
            />
        );
    }

    if (entity.type === 'image' && entity.src) {
        return <Img src={entity.src} style={{ ...baseStyle, objectFit: 'contain' }} />;
    }

    if (entity.type === 'video' && entity.src) {
        return <OffthreadVideo src={entity.src} style={{ ...baseStyle, objectFit: 'contain' }} muted />;
    }

    if (entity.type === 'svg' && entity.svgMarkup) {
        return <div style={baseStyle} dangerouslySetInnerHTML={{ __html: entity.svgMarkup }} />;
    }

    return null;
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
    renderMode,
}: {
    scene: RemotionScene;
    runtime: RuntimeMode;
    renderMode: 'full' | 'motion-layer';
}) {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const source = resolveSceneSource(scene.src, runtime);
    const showBaseMedia = renderMode !== 'motion-layer';
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
    const entities = Array.isArray(scene.entities) ? scene.entities : [];
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
            {showBaseMedia && scene.assetKind === 'audio' ? (
                <Audio src={source} />
            ) : null}
            {showBaseMedia && scene.assetKind === 'image' ? (
                <Img src={source} style={contentStyle} />
            ) : showBaseMedia && scene.assetKind === 'video' ? (
                <OffthreadVideo
                    src={source}
                    style={contentStyle}
                    muted
                    startFrom={scene.trimInFrames || 0}
                    endAt={(scene.trimInFrames || 0) + scene.durationInFrames}
                />
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
                <SceneEntity key={entity.id} entity={entity} sceneFrame={localFrame} />
            ))}
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
    const { width, height, backgroundColor, scenes, renderMode = 'full' } = composition;

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
                    <MotionSceneLayer scene={scene} runtime={runtime} renderMode={renderMode} />
                </Sequence>
            ))}
        </AbsoluteFill>
    );
}
