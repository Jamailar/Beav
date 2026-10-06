export interface AudioTranscriptionResponse {
  success?: boolean;
  text?: string;
  error?: string;
  reason?: string;
  diagnostic?: string;
}

const NON_USER_TRANSCRIPT_PATTERNS = [
  /音频已接收，但转写接口不可用/i,
  /文件类型：/i,
  /transcription\s+endpoint/i,
  /转写接口不可用/i,
  /未配置音频转写服务/i,
];

const SILENT_TRANSCRIPTION_REASONS = new Set([
  'empty_transcript',
  'no_speech',
  'transcription_unavailable',
]);

const TRANSCRIPTION_UNAVAILABLE_ERROR_PATTERNS = [
  /program not found/i,
  /未找到\s*curl/i,
  /转写接口不可用/i,
  /audio transcription failed:\s*program not found/i,
];

export function resolveUsableTranscript(
  response: AudioTranscriptionResponse | null | undefined,
): { text: string | null; error: string | null } {
  const reason = String(response?.reason || '').trim().toLowerCase();
  const text = String(response?.text || '').trim();
  const error = String(response?.error || '').trim();

  if (text && NON_USER_TRANSCRIPT_PATTERNS.some((pattern) => pattern.test(text))) {
    return { text: null, error: null };
  }

  if (response?.success && text) {
    return { text, error: null };
  }

  if (SILENT_TRANSCRIPTION_REASONS.has(reason)) {
    return { text: null, error: null };
  }

  if (error && TRANSCRIPTION_UNAVAILABLE_ERROR_PATTERNS.some((pattern) => pattern.test(error))) {
    return { text: null, error: null };
  }

  if (!response?.success && error) {
    return { text: null, error };
  }

  if (!text) {
    return { text: null, error: null };
  }

  return { text, error: null };
}
