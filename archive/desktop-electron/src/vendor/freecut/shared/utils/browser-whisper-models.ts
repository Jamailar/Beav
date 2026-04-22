import type { MediaTranscriptModel } from '@/types/storage';

export const DEFAULT_BROWSER_WHISPER_MODEL: MediaTranscriptModel = 'whisper-tiny';

export const BROWSER_WHISPER_MODEL_LABELS: Record<MediaTranscriptModel, string> = {
  'whisper-tiny': 'Tiny',
  'whisper-base': 'Base',
  'whisper-small': 'Small',
  'whisper-large': 'Large v3 Turbo',
};

export const BROWSER_WHISPER_MODEL_OPTIONS = [
  { value: 'whisper-tiny', label: BROWSER_WHISPER_MODEL_LABELS['whisper-tiny'] },
  { value: 'whisper-base', label: BROWSER_WHISPER_MODEL_LABELS['whisper-base'] },
  { value: 'whisper-small', label: BROWSER_WHISPER_MODEL_LABELS['whisper-small'] },
  { value: 'whisper-large', label: BROWSER_WHISPER_MODEL_LABELS['whisper-large'] },
] as const satisfies ReadonlyArray<{
  value: MediaTranscriptModel;
  label: string;
}>;
