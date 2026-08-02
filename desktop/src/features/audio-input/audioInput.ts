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
  strategy?: string;
}

export interface AudioRecordingClip {
  audioBase64: string;
  mimeType: string;
  fileName: string;
  durationMs?: number;
  capturedDurationMs?: number;
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

type LocalRecording = {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  startedAt: number;
  mimeType: string;
  stopped: Promise<Blob>;
};

let localRecording: LocalRecording | null = null;

function browserRecordingSupported(): boolean {
  return typeof navigator !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof MediaRecorder !== 'undefined';
}

function localRecordingMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
}

function extensionForAudioMimeType(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4')) return 'm4a';
  return 'webm';
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

async function startLocalRecording(): Promise<void> {
  if (!browserRecordingSupported()) {
    throw new Error('当前 Electron 环境不支持浏览器录音');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = localRecordingMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  const stopped = new Promise<Blob>((resolve, reject) => {
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener('error', () => reject(new Error('浏览器录音失败')));
    recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })));
  });
  recorder.start(250);
  localRecording = {
    recorder,
    stream,
    chunks,
    startedAt: Date.now(),
    mimeType: recorder.mimeType || mimeType || 'audio/webm',
    stopped,
  };
}

async function stopLocalRecording(): Promise<AudioRecordingClip> {
  const current = localRecording;
  if (!current) throw new Error('当前没有进行中的录音');
  localRecording = null;
  if (current.recorder.state !== 'inactive') current.recorder.stop();
  current.stream.getTracks().forEach((track) => track.stop());
  const blob = await current.stopped;
  const buffer = await blob.arrayBuffer();
  const durationMs = Math.max(0, Date.now() - current.startedAt);
  return {
    audioBase64: arrayBufferToBase64(buffer),
    mimeType: blob.type || current.mimeType,
    fileName: `recording-${Date.now()}.${extensionForAudioMimeType(blob.type || current.mimeType)}`,
    durationMs,
    capturedDurationMs: durationMs,
    byteLength: buffer.byteLength,
    channels: 1,
    strategy: 'renderer-media-recorder',
  };
}

async function cancelLocalRecording(): Promise<void> {
  const current = localRecording;
  if (!current) return;
  localRecording = null;
  if (current.recorder.state !== 'inactive') current.recorder.stop();
  current.stream.getTracks().forEach((track) => track.stop());
  await current.stopped.catch(() => undefined);
}

export async function getAudioCaptureCapability(): Promise<AudioCaptureCapability> {
  if (localRecording) {
    return { success: true, available: true, activeRecording: true, platform: 'electron-renderer', strategy: 'renderer-media-recorder' };
  }
  const native = await window.ipcRenderer.audio.getCaptureCapability().catch(() => null);
  if (native?.available || native?.activeRecording) return native;
  return {
    success: true,
    available: browserRecordingSupported(),
    activeRecording: false,
    platform: 'electron-renderer',
    reason: browserRecordingSupported() ? null : 'unsupported',
    strategy: 'renderer-media-recorder',
  };
}

export async function startHostAudioRecording(): Promise<void> {
  if (localRecording) throw new Error('已有录音任务正在进行');
  const native = await window.ipcRenderer.audio.startRecording().catch(() => null);
  if (native?.success) return;
  await startLocalRecording();
}

export async function stopHostAudioRecording(): Promise<AudioRecordingClip> {
  if (localRecording) return stopLocalRecording();
  const result = await window.ipcRenderer.audio.stopRecording() as AudioCaptureStopResult;
  if (!result?.success || !result.clip) {
    throw new Error(describeAudioCaptureFailure(result));
  }
  return result.clip;
}

export async function cancelHostAudioRecording(): Promise<void> {
  if (localRecording) {
    await cancelLocalRecording();
    return;
  }
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
    return `系统未授予麦克风权限，请在系统设置中允许 ${APP_BRAND.displayName} 使用麦克风`;
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
    return `系统未授予麦克风权限，请在系统设置中允许 ${APP_BRAND.displayName} 使用麦克风`;
  }
  if (normalized.includes('no_input_device') || normalized.includes('未检测到可用麦克风设备')) {
    return '未检测到可用麦克风设备';
  }
  return message;
}
import { APP_BRAND } from '../../config/brand';
