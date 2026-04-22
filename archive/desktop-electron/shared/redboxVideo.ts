export type RedBoxOfficialVideoMode =
  | 'text-to-video'
  | 'reference-guided'
  | 'first-last-frame'
  | 'continuation';

export const REDBOX_OFFICIAL_VIDEO_BASE_URL = 'https://api.ziz.hk/redbox/v1';

export const REDBOX_OFFICIAL_VIDEO_MODELS = {
  'text-to-video': 'wan2.7-t2v-video',
  'reference-guided': 'wan2.7-r2v-video',
  'first-last-frame': 'wan2.7-i2v-video',
  'continuation': 'wan2.7-i2v-video',
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
