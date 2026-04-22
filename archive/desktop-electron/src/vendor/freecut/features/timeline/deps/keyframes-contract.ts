import { type ReactNode } from 'react';
import type {
  AnimatableProperty,
  EasingType,
  ItemKeyframes,
  Keyframe,
  EasingConfig,
} from '@/types/keyframe';
import type { TimelineItem } from '@/types/timeline';
import type { ResolvedTransform, TransformProperties } from '@/types/transform';

export type AutoKeyframeOperation = {
  itemId: string;
  property: AnimatableProperty;
  frame: number;
  value: number;
  easing?: EasingType;
  easingConfig?: EasingConfig;
};

function keyframesForProperty(
  itemKeyframes: ItemKeyframes | undefined,
  property: AnimatableProperty,
): Keyframe[] {
  return itemKeyframes?.properties.find((entry) => entry.property === property)?.keyframes ?? [];
}

export function resolveAnimatedTransform(
  item: TimelineItem,
  itemKeyframes?: ItemKeyframes,
): ResolvedTransform {
  const base = item.transform || {};
  const readValue = (property: AnimatableProperty, fallback: number) => {
    const keyframes = keyframesForProperty(itemKeyframes, property);
    return keyframes[0]?.value ?? fallback;
  };

  return {
    x: readValue('x', base.x ?? 0),
    y: readValue('y', base.y ?? 0),
    width: readValue('width', base.width ?? 0),
    height: readValue('height', base.height ?? 0),
    rotation: readValue('rotation', base.rotation ?? 0),
    opacity: readValue('opacity', base.opacity ?? 1),
    cornerRadius: readValue('cornerRadius', base.cornerRadius ?? 0),
  };
}

export function interpolatePropertyValue(
  itemKeyframes: ItemKeyframes | undefined,
  property: AnimatableProperty,
  frame: number,
  fallback = 0,
): number {
  const keyframes = keyframesForProperty(itemKeyframes, property);
  if (keyframes.length === 0) return fallback;
  const previous = [...keyframes].reverse().find((entry) => entry.frame <= frame) ?? keyframes[0];
  return previous?.value ?? fallback;
}

export function getAnimatablePropertiesForItem(item: TimelineItem): AnimatableProperty[] {
  const base: AnimatableProperty[] = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'cornerRadius'];
  return item.type === 'audio' ? ['volume'] : base;
}

export function getBezierPresetForEasing(easing: EasingType) {
  if (easing === 'ease-in') return { x1: 0.42, y1: 0, x2: 1, y2: 1 };
  if (easing === 'ease-out') return { x1: 0, y1: 0, x2: 0.58, y2: 1 };
  if (easing === 'ease-in-out') return { x1: 0.42, y1: 0, x2: 0.58, y2: 1 };
  return null;
}

export function isFrameInTransitionRegion(): boolean {
  return false;
}

export function getTransitionBlockedRanges(): Array<{ start: number; end: number }> {
  return [];
}

export function ValueGraphEditor(_: { children?: ReactNode; transform?: TransformProperties }) {
  return null;
}

export function DopesheetEditor(_: { children?: ReactNode }) {
  return null;
}
