import { APP_BRAND } from '../src/config/brand';

export type RedBoxOfficialVideoMode =
  | 'text-to-video'
  | 'reference-guided'
  | 'first-last-frame'
  | 'continuation';

export const REDBOX_OFFICIAL_VIDEO_BASE_URL = `https://api.ziz.hk/${APP_BRAND.variant}/v1`;

export const REDBOX_OFFICIAL_VIDEO_MODELS = {
  'text-to-video': 'seedance-2.0',
  'reference-guided': 'seedance-2.0',
  'first-last-frame': 'seedance-2.0',
  'continuation': 'seedance-2.0',
} as const;

export const REDBOX_OFFICIAL_VIDEO_MODEL_LIST = [
  REDBOX_OFFICIAL_VIDEO_MODELS['text-to-video'],
  REDBOX_OFFICIAL_VIDEO_MODELS['reference-guided'],
  REDBOX_OFFICIAL_VIDEO_MODELS['first-last-frame'],
] as const;

export function getRedBoxOfficialVideoModel(mode: RedBoxOfficialVideoMode): string {
  return REDBOX_OFFICIAL_VIDEO_MODELS[mode];
}

export function isRedBoxOfficialVideoModel(model: string): boolean {
  const normalized = String(model || '').trim();
  return REDBOX_OFFICIAL_VIDEO_MODEL_LIST.includes(normalized as typeof REDBOX_OFFICIAL_VIDEO_MODEL_LIST[number]);
}
