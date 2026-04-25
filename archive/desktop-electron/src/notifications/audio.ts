import type { NotificationSettings, NotificationSound } from './types';

export const RUNTIME_SUCCESS_SOUND_ASSET_URL = '/sounds/notifications/runtime-complete.wav';

let audioContextPromise: Promise<AudioContext> | null = null;
let lastPlayedAtByKind: Partial<Record<NotificationSound, number>> = {};

function getAudioContext(): Promise<AudioContext> {
  if (!audioContextPromise) {
    audioContextPromise = Promise.resolve().then(() => {
      const Ctor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        throw new Error('Web Audio API is not supported');
      }
      return new Ctor();
    });
  }
  return audioContextPromise;
}

async function ensureRunningContext(): Promise<AudioContext> {
  const context = await getAudioContext();
  if (context.state === 'suspended') {
    await context.resume();
  }
  return context;
}

function scheduleTone(
  context: AudioContext,
  startAt: number,
  frequency: number,
  duration: number,
  volume: number,
  type: OscillatorType,
): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), startAt + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

async function playPattern(kind: NotificationSound, volume: number): Promise<void> {
  const context = await ensureRunningContext();
  const baseTime = context.currentTime + 0.01;
  if (kind === 'success') {
    scheduleTone(context, baseTime, 784, 0.08, volume * 0.65, 'sine');
    scheduleTone(context, baseTime + 0.1, 988, 0.1, volume * 0.7, 'sine');
    return;
  }
  if (kind === 'failure') {
    scheduleTone(context, baseTime, 440, 0.12, volume * 0.7, 'triangle');
    scheduleTone(context, baseTime + 0.16, 294, 0.16, volume * 0.8, 'triangle');
    return;
  }
  if (kind === 'attention') {
    scheduleTone(context, baseTime, 880, 0.07, volume * 0.75, 'square');
    scheduleTone(context, baseTime + 0.12, 880, 0.07, volume * 0.75, 'square');
  }
}

async function playAudioAsset(assetUrl: string, volume: number): Promise<void> {
  const audio = new Audio(assetUrl);
  audio.preload = 'auto';
  audio.volume = Math.max(0, Math.min(1, volume));
  await audio.play();
}

export async function playNotificationSound(
  kind: NotificationSound,
  settings: NotificationSettings,
  options?: { force?: boolean; assetUrl?: string },
): Promise<void> {
  if (kind === 'none') return;
  if (!settings.sound.enabled && !options?.force) return;

  const lastPlayedAt = lastPlayedAtByKind[kind] || 0;
  const now = Date.now();
  if (!options?.force && (now - lastPlayedAt) < 500) {
    return;
  }

  if (!options?.force) {
    if (kind === 'success' && !settings.sound.success) return;
    if (kind === 'failure' && !settings.sound.failure) return;
    if (kind === 'attention' && !settings.sound.attention) return;
  }

  lastPlayedAtByKind[kind] = now;
  try {
    if (options?.assetUrl) {
      await playAudioAsset(options.assetUrl, settings.sound.volume);
      return;
    }
    await playPattern(kind, settings.sound.volume);
  } catch (error) {
    console.warn('[notifications] failed to play sound', error);
  }
}

export async function playTestNotificationSound(
  kind: NotificationSound,
  volume = 0.7,
): Promise<void> {
  await playPattern(kind, volume);
}
