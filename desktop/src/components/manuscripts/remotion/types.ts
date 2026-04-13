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
    outputPath?: string;
    renderedAt?: number;
    durationInFrames?: number;
    renderMode?: RemotionRenderMode;
}

export interface RemotionCompositionConfig {
    version?: number;
    title?: string;
    width: number;
    height: number;
    fps: number;
    durationInFrames: number;
    backgroundColor?: string;
    renderMode?: RemotionRenderMode;
    scenes: RemotionScene[];
    sceneItemTransforms?: Record<string, RemotionSceneItemTransform>;
    render?: RemotionRenderResult;
}
