export interface AudioCaptureCapability {
  success?: boolean;
  available?: boolean;
  activeRecording?: boolean;
  platform?: string;
  reason?: string | null;
  message?: string;
  error?: string;
  deviceName?: string;
  sampleRate?: number;
  channels?: number;
  sampleFormat?: string;
}

export interface AudioRecordingClip {
  audioBase64: string;
  mimeType: string;
  fileName: string;
  durationMs?: number;
  byteLength?: number;
  sampleRate?: number;
  channels?: number;
  deviceName?: string;
  strategy?: string;
}

type AudioCaptureActionResult = {
  success?: boolean;
  error?: string;
  reason?: string;
  message?: string;
};

type AudioCaptureStopResult = AudioCaptureActionResult & {
  clip?: AudioRecordingClip;
  discarded?: boolean;
  durationMs?: number;
};

export async function getAudioCaptureCapability(): Promise<AudioCaptureCapability> {
  return window.ipcRenderer.audio.getCaptureCapability();
}

export async function startHostAudioRecording(): Promise<void> {
  const result = await window.ipcRenderer.audio.startRecording();
  if (!result?.success) {
    throw new Error(describeAudioCaptureFailure(result));
  }
}

export async function stopHostAudioRecording(): Promise<AudioRecordingClip> {
  const result = await window.ipcRenderer.audio.stopRecording() as AudioCaptureStopResult;
  if (!result?.success || !result.clip) {
    throw new Error(describeAudioCaptureFailure(result));
  }
  return result.clip;
}

export async function cancelHostAudioRecording(): Promise<void> {
  const result = await window.ipcRenderer.audio.cancelRecording();
  if (!result?.success) {
    throw new Error(describeAudioCaptureFailure(result));
  }
}

export async function openMicrophonePrivacySettings(): Promise<void> {
  const result = await window.ipcRenderer.audio.openMicrophoneSettings();
  if (!result?.success) {
    throw new Error(result?.error || '无法打开系统麦克风设置');
  }
}

export function buildAudioDataUrl(clip: AudioRecordingClip): string {
  return `data:${clip.mimeType};base64,${clip.audioBase64}`;
}

export function describeAudioCaptureFailure(
  error: unknown,
  capability?: AudioCaptureCapability | null,
): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : (error && typeof error === 'object' && 'error' in error && typeof (error as { error?: unknown }).error === 'string')
        ? String((error as { error?: string }).error)
        : '';
  if (message) {
    return normalizeAudioCaptureMessage(message);
  }

  const reason = String(capability?.reason || '').trim().toLowerCase();
  if (reason === 'no_input_device') {
    return '未检测到可用麦克风设备';
  }
  if (reason === 'permission_denied') {
    return '系统未授予麦克风权限，请在系统设置中允许 RedBox 使用麦克风';
  }
  return '麦克风录音不可用，请检查设备和系统权限';
}

function normalizeAudioCaptureMessage(message: string): string {
  const normalized = String(message || '').trim().toLowerCase();
  if (!normalized) return '麦克风录音不可用';
  if (normalized.includes('already_recording')) {
    return '已有录音任务正在进行';
  }
  if (normalized.includes('not_recording')) {
    return '当前没有进行中的录音';
  }
  if (normalized.includes('permission')) {
    return '系统未授予麦克风权限，请在系统设置中允许 RedBox 使用麦克风';
  }
  if (normalized.includes('no_input_device') || normalized.includes('未检测到可用麦克风设备')) {
    return '未检测到可用麦克风设备';
  }
  return message;
}
