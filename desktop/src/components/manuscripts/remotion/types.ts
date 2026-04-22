export type MotionPreset =
    | 'static'
    | 'slow-zoom-in'
    | 'slow-zoom-out'
    | 'pan-left'
    | 'pan-right'
    | 'slide-up'
    | 'slide-down';

export type OverlayAnimation = 'fade-up' | 'fade-in' | 'slide-left' | 'pop';

export type OverlayPosition = 'top' | 'center' | 'bottom';
export type RemotionRenderMode = 'full' | 'motion-layer';
export type RemotionEntityType = 'text' | 'shape' | 'image' | 'svg' | 'video' | 'group';
export type RemotionShapeKind = 'rect' | 'circle' | 'apple';
export type RemotionEntityPositionMode = 'canvas-space' | 'video-space';
export type RemotionTransitionPresentation = 'fade' | 'wipe' | 'slide' | 'flip' | 'clockWipe' | 'iris' | string;
export type RemotionTransitionTiming = 'linear' | 'spring' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'cubic-bezier';
export type RemotionTransitionDirection = 'from-left' | 'from-right' | 'from-top' | 'from-bottom';
export type RemotionEntityAnimationKind =
    | 'fade-in'
    | 'fade-out'
    | 'slide-in-left'
    | 'slide-in-right'
    | 'slide-up'
    | 'slide-down'
    | 'pop'
    | 'fall-bounce'
    | 'float';

export interface RemotionOverlay {
    id: string;
    text: string;
    startFrame: number;
    durationInFrames: number;
    position?: OverlayPosition;
    animation?: OverlayAnimation;
    fontSize?: number;
    color?: string;
    backgroundColor?: string;
    align?: 'left' | 'center' | 'right';
}

export interface RemotionEntityAnimation {
    id: string;
    kind: RemotionEntityAnimationKind;
    fromFrame: number;
    durationInFrames: number;
    params?: Record<string, unknown>;
}

export interface RemotionSceneEntity {
    id: string;
    type: RemotionEntityType;
    positionMode?: RemotionEntityPositionMode;
    referenceWidth?: number | null;
    referenceHeight?: number | null;
    startFrame?: number;
    durationInFrames?: number;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
    scale?: number;
    opacity?: number;
    visible?: boolean;
    text?: string;
    fontSize?: number;
    fontWeight?: number | string;
    color?: string;
    align?: 'left' | 'center' | 'right';
    lineHeight?: number;
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    radius?: number;
    shape?: RemotionShapeKind;
    src?: string;
    svgMarkup?: string;
    borderRadius?: number;
    animations?: RemotionEntityAnimation[];
    children?: RemotionSceneEntity[];
}

export interface RemotionScene {
    id: string;
    clipId?: string;
    assetId?: string;
    assetKind?: 'video' | 'image' | 'audio' | 'unknown';
    src: string;
    startFrame: number;
    durationInFrames: number;
    trimInFrames?: number;
    motionPreset?: MotionPreset;
    overlayTitle?: string;
    overlayBody?: string;
    overlays?: RemotionOverlay[];
    entities?: RemotionSceneEntity[];
}

export interface RemotionTransition {
    id: string;
    type?: 'crossfade';
    presentation: RemotionTransitionPresentation;
    timing?: RemotionTransitionTiming;
    leftClipId: string;
    rightClipId: string;
    trackId?: string;
    durationInFrames: number;
    direction?: RemotionTransitionDirection;
    alignment?: number;
    bezierPoints?: {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
    };
    presetId?: string;
    properties?: Record<string, unknown>;
}

export interface RemotionSceneItemTransform {
    x: number;
    y: number;
    width: number;
    height: number;
    lockAspectRatio?: boolean;
    minWidth?: number;
    minHeight?: number;
}

export interface RemotionRenderResult {
    defaultOutName?: string;
    outputPath?: string;
    renderedAt?: number;
    durationInFrames?: number;
    renderMode?: RemotionRenderMode;
    compositionId?: string;
    codec?: string;
    imageFormat?: 'jpeg' | 'png';
    pixelFormat?: string;
    proResProfile?: string;
    sampleRate?: number;
}

export interface RemotionBaseMedia {
    sourceAssetIds?: string[];
    outputPath?: string | null;
    durationMs?: number;
    width?: number | null;
    height?: number | null;
    status?: string;
    updatedAt?: number | null;
}

export interface RemotionFfmpegRecipe {
    operations?: Array<Record<string, unknown>>;
    artifacts?: Array<Record<string, unknown>>;
    summary?: string | null;
    updatedAt?: number | null;
}

export interface RemotionCompositionConfig {
    version?: number;
    title?: string;
    entryCompositionId?: string;
    width: number;
    height: number;
    fps: number;
    durationInFrames: number;
    backgroundColor?: string;
    renderMode?: RemotionRenderMode;
    scenes: RemotionScene[];
    transitions?: RemotionTransition[];
    sceneItemTransforms?: Record<string, RemotionSceneItemTransform>;
    baseMedia?: RemotionBaseMedia;
    ffmpegRecipe?: RemotionFfmpegRecipe;
    render?: RemotionRenderResult;
}
