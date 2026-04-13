import type { TimelineItem } from '@/types/timeline';
import type { ResolvedTransform, SourceDimensions, TransformProperties } from '@/types/transform';

const DEFAULT_RESOLVED_TRANSFORM: ResolvedTransform = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  rotation: 0,
  opacity: 1,
  cornerRadius: 0,
};

export function resolveTransform(transform?: TransformProperties | null): ResolvedTransform {
  return {
    ...DEFAULT_RESOLVED_TRANSFORM,
    ...transform,
  };
}

export function getSourceDimensions(item: TimelineItem): SourceDimensions {
  if ('sourceWidth' in item && typeof item.sourceWidth === 'number' && 'sourceHeight' in item && typeof item.sourceHeight === 'number') {
    return {
      width: item.sourceWidth,
      height: item.sourceHeight,
    };
  }

  if (item.type === 'composition') {
    return {
      width: item.compositionWidth,
      height: item.compositionHeight,
    };
  }

  return { width: 0, height: 0 };
}

export function needsCustomAudioDecoder(): boolean {
  return false;
}

export async function getOrDecodeAudioSliceForPlayback(): Promise<null> {
  return null;
}

export function startPreviewAudioConform(): void {}

export function startPreviewAudioStartupWarm(): void {}

export function prewarmPreviewAudioElement(): void {}
