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
}

export interface RemotionCompositionConfig {
    version?: number;
    title?: string;
    width: number;
    height: number;
    fps: number;
    durationInFrames: number;
    backgroundColor?: string;
    scenes: RemotionScene[];
    sceneItemTransforms?: Record<string, RemotionSceneItemTransform>;
    render?: RemotionRenderResult;
}
