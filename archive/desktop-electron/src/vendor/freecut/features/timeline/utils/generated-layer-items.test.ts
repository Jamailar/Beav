import { describe, expect, it } from 'vitest';
import {
  createTimelineTemplateItem,
  getTemplateEffectsForDirectApplication,
} from './generated-layer-items';

describe('getTemplateEffectsForDirectApplication', () => {
  it('returns effects for adjustment templates with effects', () => {
    const effects = [{
      type: 'gpu-effect' as const,
      gpuEffectType: 'gpu-brightness',
      params: { brightness: 0.2 },
    }];

    expect(getTemplateEffectsForDirectApplication({
      type: 'timeline-template',
      itemType: 'adjustment',
      label: 'Brightness',
      effects,
    })).toEqual(effects);
  });

  it('ignores blank adjustment templates', () => {
    expect(getTemplateEffectsForDirectApplication({
      type: 'timeline-template',
      itemType: 'adjustment',
      label: 'Adjustment Layer',
    })).toBeNull();
  });
});

describe('createTimelineTemplateItem', () => {
  it('creates an adjustment item with carried effects', () => {
    const item = createTimelineTemplateItem({
      template: {
        type: 'timeline-template',
        itemType: 'adjustment',
        label: 'Glow Preset',
        effects: [{
          type: 'gpu-effect',
          gpuEffectType: 'gpu-glow',
          params: { intensity: 0.5 },
        }],
      },
      placement: {
        trackId: 'track-1',
        from: 10,
        durationInFrames: 120,
        canvasWidth: 1920,
        canvasHeight: 1080,
      },
    });

    expect(item).toMatchObject({
      type: 'adjustment',
      trackId: 'track-1',
      from: 10,
      durationInFrames: 120,
      label: 'Glow Preset',
    });
    expect(item.effects).toHaveLength(1);
    expect(item.effects?.[0]).toMatchObject({
      enabled: true,
      effect: {
        type: 'gpu-effect',
        gpuEffectType: 'gpu-glow',
      },
    });
  });
});
